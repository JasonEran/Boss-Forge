/**
 * Deep-clean run-state so the workbench is pristine while keeping position
 * settings (positions, rules, members, templates, global contact settings).
 *
 * Usage:
 *   DATABASE_URL=... tsx --env-file-if-exists=.env packages/data/src/deep-clean-run-data.ts
 *   BOSS_FORGE_SCREENSHOT_DIR=/path ...  # optional screenshot roots
 *   BOSS_FORGE_BACKUP_DIR=/backups ...   # optional pg dump dir to purge
 */
import { readdir, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDatabase } from "./client.js";

async function removeScreenshotTree(root: string): Promise<number> {
  try {
    await rm(root, { recursive: true, force: true });
    return 1;
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return 0;
    }
    throw error;
  }
}

async function purgeBackupDumps(root: string): Promise<number> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (
        !/^boss-forge-.*\.dump(\.tmp)?$/i.test(entry.name) &&
        !/\.sql(\.gz)?$/i.test(entry.name)
      ) {
        continue;
      }
      await unlink(join(root, entry.name));
      removed += 1;
    }
    return removed;
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return 0;
    }
    throw error;
  }
}

async function countRows(
  sql: ReturnType<typeof createDatabase>,
  table: string,
): Promise<number> {
  const rows = await sql.unsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM ${table}`,
  );
  return rows[0]?.n ?? 0;
}

async function main(): Promise<void> {
  const sql = createDatabase();
  try {
    const before = {
      candidates: await countRows(sql, "candidates"),
      tasks: await countRows(sql, "tasks"),
      schedules: await countRows(sql, "schedules"),
      candidatePositionStates: await countRows(sql, "candidate_position_states"),
      positions: await countRows(sql, "positions"),
      ruleVersions: await countRows(sql, "rule_versions"),
    };

    const deleted = await sql.begin(async (tx) => {
      // Detach optional policy snapshot FKs before wiping run-state tables.
      await tx`UPDATE positions SET contact_policy_snapshot_id = NULL WHERE contact_policy_snapshot_id IS NOT NULL`;
      await tx`UPDATE tasks SET contact_policy_snapshot_id = NULL WHERE contact_policy_snapshot_id IS NOT NULL`;

      // Recruitment lifecycle (leaf → root)
      const recruitmentInterviewFeedback =
        await tx`DELETE FROM recruitment_interview_feedback RETURNING id`;
      const recruitmentInterviews =
        await tx`DELETE FROM recruitment_interviews RETURNING id`;
      const recruitmentOffers =
        await tx`DELETE FROM recruitment_offers RETURNING id`;
      const recruitmentOnboardingItems =
        await tx`DELETE FROM recruitment_onboarding_items RETURNING id`;
      const recruitmentOnboarding =
        await tx`DELETE FROM recruitment_onboarding RETURNING id`;
      const recruitmentDeliveries =
        await tx`DELETE FROM recruitment_deliveries RETURNING id`;
      const recruitmentCaseEvents =
        await tx`DELETE FROM recruitment_case_events RETURNING id`;
      const recruitmentCases =
        await tx`DELETE FROM recruitment_cases RETURNING id`;

      // Communication inbox / resume side-channels
      const communicationWechat =
        await tx`DELETE FROM communication_wechat_actions RETURNING id`;
      const communicationReads =
        await tx`DELETE FROM communication_reads RETURNING candidate_id`;
      const communicationMessages =
        await tx`DELETE FROM communication_messages RETURNING id`;
      const communicationOnlineResumes =
        await tx`DELETE FROM communication_online_resumes RETURNING candidate_id`;
      const communicationThreads =
        await tx`DELETE FROM communication_threads RETURNING candidate_id`;
      const communicationBrowserLeases =
        await tx`DELETE FROM communication_browser_leases RETURNING id`;

      // ATS interview / notes / attachments under candidate states
      const interviewFeedback =
        await tx`DELETE FROM interview_feedback RETURNING id`;
      const interviewParticipants =
        await tx`DELETE FROM interview_participants RETURNING interview_id`;
      const interviews = await tx`DELETE FROM interviews RETURNING id`;
      const workItems = await tx`DELETE FROM work_items RETURNING id`;
      const candidateAttachments =
        await tx`DELETE FROM candidate_attachments RETURNING id`;
      const candidateNotes = await tx`DELETE FROM candidate_notes RETURNING id`;
      const candidateActivities =
        await tx`DELETE FROM candidate_activities RETURNING id`;
      const candidateTalentTags =
        await tx`DELETE FROM candidate_talent_tags RETURNING candidate_id`;
      const inboundMessages =
        await tx`DELETE FROM inbound_messages RETURNING id`;
      const doNotContact =
        await tx`DELETE FROM do_not_contact RETURNING candidate_id`;

      // Contact execution
      const contactQuotaReservations =
        await tx`DELETE FROM contact_quota_reservations RETURNING contact_intent_id`;
      const contactAttempts =
        await tx`DELETE FROM contact_attempts RETURNING id`;
      const outbox = await tx`DELETE FROM outbox_events RETURNING id`;
      const contactIntents = await tx`DELETE FROM contact_intents RETURNING id`;
      const contactAuthorizations =
        await tx`DELETE FROM contact_authorizations RETURNING id`;
      const contactPolicySnapshots =
        await tx`DELETE FROM contact_policy_snapshots RETURNING id`;
      const contactApprovalRequests =
        await tx`DELETE FROM contact_approval_requests RETURNING id`;
      const taskContactControls = await tx`
        DELETE FROM contact_controls WHERE scope_type = 'task' RETURNING scope_id
      `;
      const quotaCounters =
        await tx`DELETE FROM quota_counters RETURNING id`;

      // Screening / review / AI
      const recruitmentAssessments = await tx`
        DELETE FROM recruitment_assessments RETURNING candidate_position_state_id
      `;
      const semanticEvaluations =
        await tx`DELETE FROM semantic_evaluations RETURNING id`;
      const reviews = await tx`DELETE FROM reviews RETURNING id`;
      const matchEvidence = await tx`DELETE FROM match_evidence RETURNING id`;
      const ruleReplayRuns = await tx`DELETE FROM rule_replay_runs RETURNING id`;
      const operationalAlerts =
        await tx`DELETE FROM operational_alerts RETURNING id`;

      // Core candidate / task / plan graph
      const candidatePositionStates =
        await tx`DELETE FROM candidate_position_states RETURNING id`;
      const candidateSnapshots =
        await tx`DELETE FROM candidate_snapshots RETURNING id`;
      const taskCommands = await tx`DELETE FROM task_commands RETURNING id`;
      const tasks = await tx`DELETE FROM tasks RETURNING id`;
      const schedules = await tx`DELETE FROM schedules RETURNING id`;
      const candidates = await tx`DELETE FROM candidates RETURNING id`;

      // Workbench noise in audit trail
      const auditLogs = await tx`
        DELETE FROM audit_logs
        WHERE resource_type IN (
          'task', 'schedule', 'candidate', 'candidate_position_state',
          'contact_intent', 'review', 'resume'
        )
        OR action LIKE 'task.%'
        OR action LIKE 'schedule.%'
        OR action LIKE 'candidate.%'
        OR action LIKE 'contact.%'
        OR actor_id IN ('system:auto-greet', 'system:screening-chunk')
        RETURNING id
      `;

      return {
        recruitmentInterviewFeedback: recruitmentInterviewFeedback.length,
        recruitmentInterviews: recruitmentInterviews.length,
        recruitmentOffers: recruitmentOffers.length,
        recruitmentOnboardingItems: recruitmentOnboardingItems.length,
        recruitmentOnboarding: recruitmentOnboarding.length,
        recruitmentDeliveries: recruitmentDeliveries.length,
        recruitmentCaseEvents: recruitmentCaseEvents.length,
        recruitmentCases: recruitmentCases.length,
        communicationWechat: communicationWechat.length,
        communicationReads: communicationReads.length,
        communicationMessages: communicationMessages.length,
        communicationOnlineResumes: communicationOnlineResumes.length,
        communicationThreads: communicationThreads.length,
        communicationBrowserLeases: communicationBrowserLeases.length,
        interviewFeedback: interviewFeedback.length,
        interviewParticipants: interviewParticipants.length,
        interviews: interviews.length,
        workItems: workItems.length,
        candidateAttachments: candidateAttachments.length,
        candidateNotes: candidateNotes.length,
        candidateActivities: candidateActivities.length,
        candidateTalentTags: candidateTalentTags.length,
        inboundMessages: inboundMessages.length,
        doNotContact: doNotContact.length,
        outbox: outbox.length,
        contactAttempts: contactAttempts.length,
        contactQuotaReservations: contactQuotaReservations.length,
        contactAuthorizations: contactAuthorizations.length,
        contactPolicySnapshots: contactPolicySnapshots.length,
        contactIntents: contactIntents.length,
        contactApprovalRequests: contactApprovalRequests.length,
        taskContactControls: taskContactControls.length,
        quotaCounters: quotaCounters.length,
        recruitmentAssessments: recruitmentAssessments.length,
        semanticEvaluations: semanticEvaluations.length,
        reviews: reviews.length,
        matchEvidence: matchEvidence.length,
        ruleReplayRuns: ruleReplayRuns.length,
        operationalAlerts: operationalAlerts.length,
        candidatePositionStates: candidatePositionStates.length,
        candidateSnapshots: candidateSnapshots.length,
        taskCommands: taskCommands.length,
        tasks: tasks.length,
        schedules: schedules.length,
        candidates: candidates.length,
        auditLogs: auditLogs.length,
      };
    });

    // Keep: positions, rule_sets, rule_versions, users, sessions, departments,
    // position_members, pipeline_stages, contact_settings, non-task contact_controls,
    // message_templates / template_versions, communication_quick_replies, talent_tags,
    // account_health, schema_migrations, semantic catalogs/eval fixtures.

    const after = {
      candidates: await countRows(sql, "candidates"),
      tasks: await countRows(sql, "tasks"),
      schedules: await countRows(sql, "schedules"),
      candidatePositionStates: await countRows(sql, "candidate_position_states"),
      positions: await countRows(sql, "positions"),
      ruleVersions: await countRows(sql, "rule_versions"),
    };

    const screenshotRoots = [
      process.env.BOSS_FORGE_SCREENSHOT_DIR?.trim(),
      process.env.BOSS_CLI_DATA_DIR?.trim()
        ? join(process.env.BOSS_CLI_DATA_DIR.trim(), "screenshots")
        : null,
      resolve(process.cwd(), ".boss-forge", "runtime", "screenshots"),
      "/var/lib/boss-forge/screenshots",
      "/opt/boss-forge/runtime/screenshots",
    ].filter((value): value is string => Boolean(value));

    let screenshotTreesRemoved = 0;
    for (const root of [...new Set(screenshotRoots)]) {
      screenshotTreesRemoved += await removeScreenshotTree(root);
    }

    const backupRoots = [
      process.env.BOSS_FORGE_BACKUP_DIR?.trim(),
      "/backups",
      "/opt/boss-forge/backups/postgres",
      "/var/lib/boss-forge/backups",
    ].filter((value): value is string => Boolean(value));

    let backupDumpsRemoved = 0;
    for (const root of [...new Set(backupRoots)]) {
      backupDumpsRemoved += await purgeBackupDumps(root);
    }

    if (after.positions < 1 || after.ruleVersions < 1) {
      throw new Error(
        `Deep clean aborted safety check failed: positions=${after.positions} ruleVersions=${after.ruleVersions}`,
      );
    }
    if (
      after.candidates !== 0 ||
      after.tasks !== 0 ||
      after.schedules !== 0 ||
      after.candidatePositionStates !== 0
    ) {
      throw new Error(
        `Deep clean incomplete: candidates=${after.candidates} tasks=${after.tasks} schedules=${after.schedules} states=${after.candidatePositionStates}`,
      );
    }

    console.log(
      JSON.stringify({
        ok: true,
        event: "run_data.deep_cleaned",
        before,
        after,
        deleted,
        screenshotTreesRemoved,
        screenshotRoots,
        backupDumpsRemoved,
        backupRoots,
        kept: [
          "positions",
          "rule_sets",
          "rule_versions",
          "users",
          "user_sessions",
          "departments",
          "position_members",
          "pipeline_stages",
          "contact_settings",
          "contact_controls(non-task)",
          "message_templates",
          "template_versions",
          "communication_quick_replies",
          "account_health",
        ],
      }),
    );
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
