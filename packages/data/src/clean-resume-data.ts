/**
 * Wipe stored resume screening artifacts and related text so the database and
 * on-disk screenshot backups are empty. Safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=... tsx --env-file-if-exists=.env packages/data/src/clean-resume-data.ts
 *   BOSS_FORGE_SCREENSHOT_DIR=/path tsx ...  # optional screenshot root
 */
import { rm } from "node:fs/promises";
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

async function main(): Promise<void> {
  const sql = createDatabase();
  try {
    const result = await sql.begin(async (tx) => {
      const assessments = await tx`
        DELETE FROM recruitment_assessments RETURNING candidate_position_state_id
      `;
      const semantic = await tx`
        DELETE FROM semantic_evaluations RETURNING id
      `;
      const evidence = await tx`
        DELETE FROM match_evidence
        WHERE candidate_position_state_id IN (
          SELECT id FROM candidate_position_states
          WHERE resume_screenshot_path IS NOT NULL
             OR resume_text_hash IS NOT NULL
             OR resume_screened_at IS NOT NULL
             OR resume_screening_status <> 'not_requested'
        )
        RETURNING id
      `;
      const states = await tx`
        UPDATE candidate_position_states
        SET resume_screening_status = 'not_requested',
          resume_screenshot_path = NULL,
          resume_text_hash = NULL,
          resume_screened_at = NULL,
          resume_screening_error = NULL,
          resume_screening_error_code = NULL,
          resume_screening_attempts = 0,
          resume_screening_claimed_by = NULL,
          resume_screening_claimed_at = NULL,
          resume_screening_next_attempt_at = NULL,
          current_english_level = NULL,
          version = version + 1,
          updated_at = now()
        WHERE resume_screenshot_path IS NOT NULL
           OR resume_text_hash IS NOT NULL
           OR resume_screened_at IS NOT NULL
           OR resume_screening_status <> 'not_requested'
           OR resume_screening_attempts <> 0
           OR resume_screening_claimed_by IS NOT NULL
           OR resume_screening_error IS NOT NULL
        RETURNING id
      `;
      const views = await tx`
        DELETE FROM audit_logs
        WHERE action IN (
          'candidate.resume_viewed',
          'candidate.resume_screened',
          'candidate.resume_view_quota.reset',
          'candidate.resume_screening.cancelled_state_repaired'
        )
        RETURNING id
      `;
      const waits = await tx`
        UPDATE tasks
        SET wait_reason_code = NULL, wait_reason = NULL, next_run_at = NULL,
          version = version + 1, last_progress_at = now()
        WHERE wait_reason_code IN (
          'outside_working_hours',
          'daily_hard_limit_reached',
          'hourly_quota_reached',
          'daily_quota_reached',
          'batch_break'
        )
        RETURNING id
      `;
      return {
        assessments: assessments.length,
        semantic: semantic.length,
        evidence: evidence.length,
        states: states.length,
        viewAudits: views.length,
        clearedWaits: waits.length
      };
    });

    const screenshotRoots = [
      process.env.BOSS_FORGE_SCREENSHOT_DIR?.trim(),
      process.env.BOSS_CLI_DATA_DIR?.trim()
        ? join(process.env.BOSS_CLI_DATA_DIR.trim(), "screenshots")
        : null,
      resolve(process.cwd(), ".boss-forge", "runtime", "screenshots"),
      "/var/lib/boss-forge/screenshots"
    ].filter((value): value is string => Boolean(value));

    let removedTrees = 0;
    for (const root of [...new Set(screenshotRoots)]) {
      removedTrees += await removeScreenshotTree(root);
    }

    console.log(
      JSON.stringify({
        ok: true,
        event: "resume_data.cleaned",
        ...result,
        screenshotTreesRemoved: removedTrees,
        screenshotRoots
      })
    );
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
