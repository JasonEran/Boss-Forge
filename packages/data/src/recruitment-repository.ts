import { randomUUID } from "node:crypto";
import { recruitmentConfigSchema, type RecruitmentAssessment, type RecruitmentConfig } from "@boss-forge/contracts";
import { assessRecruitmentCandidate, recruitmentInputHash, semanticProviderReadinessFromEnvironment } from "@boss-forge/semantic-engine";
import type { Database } from "./client.js";
import type { RuleConfig } from "./types.js";

export async function enqueueRecruitmentAssessment(sql: Database, input: { stateId: string; taskId: string; ruleVersionId: string; ruleConfig: RuleConfig; resumeText: string; decision: string }): Promise<void> {
  const config = "recruitment" in input.ruleConfig ? input.ruleConfig.recruitment : undefined;
  // Invalidated résumé results cannot retain a score from an earlier read.
  await sql`DELETE FROM recruitment_assessments WHERE candidate_position_state_id = ${input.stateId}`;
  if (!config?.aiEnabled || input.decision !== "matched") return;
  const parsed = recruitmentConfigSchema.parse(config);
  await sql`
    INSERT INTO recruitment_assessments (candidate_position_state_id, task_id, rule_version_id, config, resume_text, input_hash)
    VALUES (${input.stateId}, ${input.taskId}, ${input.ruleVersionId}, ${sql.json(parsed)}, ${input.resumeText}, ${recruitmentInputHash(parsed, input.resumeText)})
  `;
}

export class RecruitmentRepository {
  constructor(private readonly sql: Database) {}

  async retry(stateId: string, actorId: string): Promise<void> {
    await this.sql.begin(async tx => {
      const rows = await tx`
        UPDATE recruitment_assessments a SET status = 'queued', result = NULL, error = NULL,
          claim_token = NULL, claimed_at = NULL, updated_at = now()
        FROM candidate_position_states c, tasks t
        WHERE a.candidate_position_state_id = ${stateId} AND c.id = a.candidate_position_state_id
          AND t.id = a.task_id AND t.status NOT IN ('cancelled', 'failed')
          AND c.is_current AND c.rule_decision = 'matched' AND c.resume_screening_status = 'screened'
          AND a.status = 'failed'
        RETURNING a.candidate_position_state_id
      `;
      if (!rows[0]) throw new Error("只有 AI 分析失败且简历仍有效的候选人可以重试，请刷新。旧任务需要使用当时保存的岗位目标。");
      await tx`INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, payload)
        VALUES (${randomUUID()}, ${actorId}, 'candidate.ai.retry', 'candidate_position_state', ${stateId}, '{}'::jsonb)`;
    });
  }

  async processOne(environment: NodeJS.ProcessEnv = process.env, assess = assessRecruitmentCandidate): Promise<boolean> {
    await this.sql`
      UPDATE recruitment_assessments a SET status = 'cancelled', error = '任务已取消或候选人已进入新的筛选任务',
        claim_token = NULL, claimed_at = NULL, updated_at = now()
      FROM candidate_position_states c, tasks t
      WHERE c.id = a.candidate_position_state_id AND t.id = a.task_id
        AND a.status IN ('queued', 'processing') AND (NOT c.is_current OR t.status IN ('cancelled', 'failed'))
    `;
    if (!semanticProviderReadinessFromEnvironment(environment).ready) return false;
    const token = randomUUID();
    const job = await this.sql.begin(async tx => {
      const rows = await tx<Array<{ state_id: string; config: RecruitmentConfig; resume_text: string; input_hash: string }>>`
        SELECT a.candidate_position_state_id AS state_id, a.config, a.resume_text, a.input_hash
        FROM recruitment_assessments a
        JOIN candidate_position_states c ON c.id = a.candidate_position_state_id
        JOIN tasks t ON t.id = a.task_id
        WHERE (a.status = 'queued' OR (a.status = 'processing' AND a.claimed_at < now() - interval '5 minutes'))
          AND c.is_current AND c.rule_decision = 'matched' AND c.resume_screening_status = 'screened'
          AND c.rule_version_id = a.rule_version_id AND t.status NOT IN ('cancelled', 'failed')
        ORDER BY a.created_at, a.candidate_position_state_id
        FOR UPDATE OF a SKIP LOCKED LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      await tx`UPDATE recruitment_assessments SET status = 'processing', claim_token = ${token}, claimed_at = now(), updated_at = now() WHERE candidate_position_state_id = ${row.state_id}`;
      return row;
    });
    if (!job) return false;
    let result: RecruitmentAssessment | null = null;
    let error: string | null = null;
    try {
      result = await assess({ config: job.config, resumeText: job.resume_text }, environment);
      if (result.inputHash !== job.input_hash) throw new Error("AI 分析输入发生变化，请重试。");
    } catch (failure) {
      error = failure instanceof Error ? failure.message.slice(0, 500) : "AI 分析失败，请重试。";
      const secret = environment.BOSS_FORGE_SEMANTIC_API_KEY?.trim();
      if (secret) error = error.replaceAll(secret, "[redacted]");
    }
    // Neither low scores nor model failures change the HR's decision. The inbox
    // filters low-score suggestions reversibly and always exposes a review route.
    await this.sql`
      UPDATE recruitment_assessments a SET status = ${error ? "failed" : "completed"},
        result = ${result && !error ? this.sql.json(result) : null}, error = ${error},
        claim_token = NULL, claimed_at = NULL, updated_at = now()
      FROM candidate_position_states c, tasks t
      WHERE a.candidate_position_state_id = ${job.state_id} AND a.claim_token = ${token}
        AND c.id = a.candidate_position_state_id AND c.is_current AND c.rule_version_id = a.rule_version_id
        AND c.resume_screening_status = 'screened' AND c.rule_decision = 'matched'
        AND t.id = a.task_id AND t.status NOT IN ('cancelled', 'failed')
    `;
    return true;
  }
}
