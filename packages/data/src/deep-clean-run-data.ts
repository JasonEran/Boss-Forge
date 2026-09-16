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
      const wipe = async (label: string, run: () => Promise<{ count: number }>) => {
        const result = await run();
        return [label, Number(result.count ?? 0)] as const;
      };

      // Detach optional policy snapshot FKs before wiping run-state tables.
      await tx`UPDATE positions SET contact_policy_snapshot_id = NULL WHERE contact_policy_snapshot_id IS NOT NULL`;
      await tx`UPDATE tasks SET contact_policy_snapshot_id = NULL WHERE contact_policy_snapshot_id IS NOT NULL`;

      const pairs = [
        await wipe("recruitmentInterviewFeedback", () => tx`DELETE FROM recruitment_interview_feedback`),
        await wipe("recruitmentInterviews", () => tx`DELETE FROM recruitment_interviews`),
        await wipe("recruitmentOffers", () => tx`DELETE FROM recruitment_offers`),
        await wipe("recruitmentOnboardingItems", () => tx`DELETE FROM recruitment_onboarding_items`),
        await wipe("recruitmentOnboarding", () => tx`DELETE FROM recruitment_onboarding`),
        await wipe("recruitmentDeliveries", () => tx`DELETE FROM recruitment_deliveries`),
        await wipe("recruitmentCaseEvents", () => tx`DELETE FROM recruitment_case_events`),
        await wipe("recruitmentCases", () => tx`DELETE FROM recruitment_cases`),
        await wipe("communicationWechat", () => tx`DELETE FROM communication_wechat_actions`),
        await wipe("communicationReads", () => tx`DELETE FROM communication_reads`),
        await wipe("communicationMessages", () => tx`DELETE FROM communication_messages`),
        await wipe("communicationOnlineResumes", () => tx`DELETE FROM communication_online_resumes`),
        await wipe("communicationThreads", () => tx`DELETE FROM communication_threads`),
        await wipe("communicationBrowserLeases", () => tx`DELETE FROM communication_browser_leases`),
        await wipe("interviewFeedback", () => tx`DELETE FROM interview_feedback`),
        await wipe("interviewParticipants", () => tx`DELETE FROM interview_participants`),
        await wipe("interviews", () => tx`DELETE FROM interviews`),
        await wipe("workItems", () => tx`DELETE FROM work_items`),
        await wipe("candidateAttachments", () => tx`DELETE FROM candidate_attachments`),
        await wipe("candidateNotes", () => tx`DELETE FROM candidate_notes`),
        await wipe("candidateActivities", () => tx`DELETE FROM candidate_activities`),
        await wipe("candidateTalentTags", () => tx`DELETE FROM candidate_talent_tags`),
        await wipe("inboundMessages", () => tx`DELETE FROM inbound_messages`),
        await wipe("doNotContact", () => tx`DELETE FROM do_not_contact`),
        await wipe("contactQuotaReservations", () => tx`DELETE FROM contact_quota_reservations`),
        await wipe("contactAttempts", () => tx`DELETE FROM contact_attempts`),
        await wipe("outbox", () => tx`DELETE FROM outbox_events`),
        await wipe("contactIntents", () => tx`DELETE FROM contact_intents`),
        await wipe("contactAuthorizations", () => tx`DELETE FROM contact_authorizations`),
        await wipe("contactPolicySnapshots", () => tx`DELETE FROM contact_policy_snapshots`),
        await wipe("contactApprovalRequests", () => tx`DELETE FROM contact_approval_requests`),
        await wipe("taskContactControls", () => tx`DELETE FROM contact_controls WHERE scope_type = 'task'`),
        await wipe("quotaCounters", () => tx`DELETE FROM quota_counters`),
        await wipe("recruitmentAssessments", () => tx`DELETE FROM recruitment_assessments`),
        await wipe("semanticEvaluations", () => tx`DELETE FROM semantic_evaluations`),
        await wipe("reviews", () => tx`DELETE FROM reviews`),
        await wipe("matchEvidence", () => tx`DELETE FROM match_evidence`),
        await wipe("ruleReplayRuns", () => tx`DELETE FROM rule_replay_runs`),
        await wipe("operationalAlerts", () => tx`DELETE FROM operational_alerts`),
        await wipe("candidatePositionStates", () => tx`DELETE FROM candidate_position_states`),
        await wipe("candidateSnapshots", () => tx`DELETE FROM candidate_snapshots`),
        await wipe("taskCommands", () => tx`DELETE FROM task_commands`),
        await wipe("tasks", () => tx`DELETE FROM tasks`),
        await wipe("schedules", () => tx`DELETE FROM schedules`),
        await wipe("candidates", () => tx`DELETE FROM candidates`),
        await wipe(
          "auditLogs",
          () => tx`
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
          `,
        ),
      ];

      return Object.fromEntries(pairs);
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
