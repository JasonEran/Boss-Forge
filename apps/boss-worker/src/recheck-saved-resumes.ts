import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BossForgeRepository, createDatabase, type ResumeScreeningJob, type RuleConfig } from '@boss-forge/data';
import { collectSemanticRules, evaluateCandidate, candidateRuleText } from '@boss-forge/m1-core';
import { applySemanticCatalogEntries, evaluateSemanticRules, semanticProviderFromEnvironment } from '@boss-forge/semantic-engine';
import { recognizeResumeWithTencentOcr, resumeOcrLooksUsable } from './tencent-ocr.js';

/** Re-evaluate saved evidence only. This command never connects to BOSS, opens
 * a resume, creates a task or approves a candidate. Dry run is the default. */
export async function recheckSavedResumes(taskIds: string[], apply = false) {
  if (!taskIds.length || taskIds.some(id => !/^[\da-f-]{36}$/iu.test(id))) throw new Error('Specify explicit task UUIDs.');
  const sql = createDatabase();
  const repository = new BossForgeRepository(sql);
  try {
    const rows = await sql`
      SELECT cps.id, cps.candidate_id, cps.latest_task_id, cps.version, cps.rule_decision,
        cps.resume_screenshot_path, cps.resume_screening_attempts,
        c.display_name, p.boss_account_id, p.semantic_mode, scv.id AS catalog_id, scv.entries,
        t.source, t.search_keyword, t.source_boss_filters, rv.config, COALESCE(rv.external_version_id, rv.id::text) AS rule_version_id,
        cs.source_reference, cs.source_locator, cs.raw_fields, cs.source_evidence, cs.raw_text
      FROM candidate_position_states cps JOIN candidates c ON c.id = cps.candidate_id
      JOIN positions p ON p.id = cps.position_id JOIN tasks t ON t.id = cps.latest_task_id
      JOIN rule_versions rv ON rv.id = cps.rule_version_id
      JOIN candidate_snapshots cs ON cs.id = cps.latest_snapshot_id
      LEFT JOIN semantic_catalog_versions scv ON scv.id = p.semantic_active_catalog_version_id
      WHERE cps.latest_task_id = ANY(${taskIds}::uuid[]) AND t.status IN ('screening','waiting_review','completed')
        AND cps.resume_screening_status = 'screened' AND cps.resume_screenshot_path IS NOT NULL
      ORDER BY t.created_at, cps.id
    `;
    const summary = { selected: rows.length, evaluated: 0, applied: 0, errors: 0, decisions: {} as Record<string, number> };
    for (const row of rows) {
      try {
        const ocr = await recognizeResumeWithTencentOcr(row.resume_screenshot_path as string);
        if (!resumeOcrLooksUsable(ocr.text)) throw new Error('Saved screenshot has no usable resume content.');
        const job: ResumeScreeningJob = {
          stateId: row.id as string, candidateId: row.candidate_id as string, taskId: row.latest_task_id as string,
          ruleVersionId: row.rule_version_id as string, candidateName: row.display_name as string,
          bossAccountId: row.boss_account_id as string, bossJobKeyword: null,
          source: row.source as 'recommend' | 'search', searchKeyword: row.search_keyword as string | null,
          sourceBossFilters: (row.source_boss_filters as ResumeScreeningJob['sourceBossFilters']) ?? null,
          ruleConfig: row.config as RuleConfig, semanticMode: row.semantic_mode as ResumeScreeningJob['semanticMode'],
          semanticCatalogVersionId: row.catalog_id as string | null, semanticCatalogEntries: row.entries,
          resumeScreeningAttempts: row.resume_screening_attempts as number,
          candidate: { index: Number(String(row.source_reference).match(/^[^:]+:(\d+):/u)?.[1] ?? 1),
            name: row.display_name as string, source: row.source as 'recommend' | 'search',
            ...(row.source_locator ? { sourceLocator: row.source_locator as NonNullable<ResumeScreeningJob['candidate']['sourceLocator']> } : {}),
            fields: row.raw_fields as Record<string,string>, evidence: row.source_evidence as string[], raw: row.raw_text as string }
        };
        const rules = applySemanticCatalogEntries(collectSemanticRules(job.ruleConfig), job.semanticCatalogEntries);
        const semantics = await evaluateSemanticRules({ rules, candidateText: `${candidateRuleText(job.candidate)}\n完整简历：${ocr.text}`,
          provider: job.semanticMode === 'off' ? null : semanticProviderFromEnvironment(), runtimeMode: job.semanticMode, catalogVersion: job.semanticCatalogVersionId });
        const record = evaluateCandidate(job.candidate, job.ruleConfig, ocr.text, semantics, job.sourceBossFilters);
        if (apply) {
          await repository.completeResumeScreening({ job, record, screenshotPath: row.resume_screenshot_path as string,
            resumeTextHash: createHash('sha256').update(ocr.text).digest('hex'), workerId: 'saved-resume-recheck',
            ocrProvider: 'tencent', ocrLineCount: ocr.lineCount, ocrAverageConfidence: ocr.averageConfidence, ocrRequestId: ocr.requestId,
            recheckExpectedVersion: row.version as number });
          summary.applied++;
        }
        summary.evaluated++;
        summary.decisions[record.decision] = (summary.decisions[record.decision] ?? 0) + 1;
        console.log(JSON.stringify({ stateId: job.stateId, previous: row.rule_decision, decision: record.decision, applied: apply,
          ocrLines: ocr.lineCount, reasons: record.reasonCodes }));
      } catch (error) {
        summary.errors++;
        console.error(JSON.stringify({ stateId: row.id, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    console.log(JSON.stringify({ event: 'saved-resume-recheck.completed', ...summary }));
    return summary;
  } finally { await sql.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  recheckSavedResumes(process.argv.slice(2).filter(arg => arg !== '--apply'), process.argv.includes('--apply'))
    .then(result => { if (result.errors) process.exitCode = 1; })
    .catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
