import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createDatabase } from "./client.js";
import { assertIsolatedTestDatabase } from "./test-safety.js";

const migrationsUrl = new URL("../migrations/", import.meta.url);

async function applyThrough(prefix: string, sql: ReturnType<typeof createDatabase>): Promise<void> {
  const names = (await readdir(migrationsUrl))
    .filter((name) => name.endsWith(".sql") && name.slice(0, 3) <= prefix)
    .sort();
  for (const name of names) {
    const migration = await readFile(new URL(name, migrationsUrl), "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(migration);
    });
  }
}

async function main(): Promise<void> {
  assertIsolatedTestDatabase(process.env, { contactSideEffects: false });
  const sql = createDatabase();
  try {
    const existing = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_tables
      WHERE schemaname = 'public'
    `;
    assert.equal(
      existing[0]?.count,
      0,
      "Migration-history test requires a new, empty disposable database."
    );
    await applyThrough("022", sql);

    const departmentId = randomUUID();
    const adminId = randomUUID();
    const positionId = randomUUID();
    const ruleSetId = randomUUID();
    const ruleVersion1 = randomUUID();
    const ruleVersion2 = randomUUID();
    const task1 = randomUUID();
    const task2 = randomUUID();
    const emptyTask = randomUUID();
    const templateId = randomUUID();
    const templateVersionId = randomUUID();
    await sql`
      INSERT INTO departments (id, slug, name)
      VALUES (${departmentId}, ${`history-${departmentId}`}, 'History migration test')
    `;
    await sql`
      INSERT INTO users (id, department_id, email, display_name, role)
      VALUES (${adminId}, ${departmentId}, 'history@example.invalid', 'History Admin', 'admin')
    `;
    await sql`
      INSERT INTO positions (
        id, boss_account_id, name, owner_name, department_id, owner_user_id
      ) VALUES (
        ${positionId}, 'history-test-account', 'History Position', 'History Admin',
        ${departmentId}, ${adminId}
      )
    `;
    await sql`
      INSERT INTO position_members (position_id, user_id, member_role)
      VALUES (${positionId}, ${adminId}, 'owner')
    `;
    await sql`
      INSERT INTO rule_sets (id, position_id, name)
      VALUES (${ruleSetId}, ${positionId}, 'History rules')
    `;
    await sql`
      INSERT INTO rule_versions (
        id, rule_set_id, version, config, dictionary_version, created_by
      ) VALUES
        (${ruleVersion1}, ${ruleSetId}, 1,
          ${sql.json({ requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.8 }] })},
          'history.1', ${adminId}),
        (${ruleVersion2}, ${ruleSetId}, 2,
          ${sql.json({ requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.9 }] })},
          'history.2', ${adminId})
    `;
    await sql`UPDATE rule_sets SET active_version_id = ${ruleVersion2} WHERE id = ${ruleSetId}`;
    await sql`
      INSERT INTO tasks (
        id, idempotency_key, position_id, rule_version_id, execution_mode,
        source, status, created_by, candidate_count, created_at
      ) VALUES
        (${task1}, 'history-task-1', ${positionId}, ${ruleVersion1}, 'immediate',
          'recommend', 'waiting_review', ${adminId}, 15, '2026-01-01T00:00:00Z'),
        (${task2}, 'history-task-2', ${positionId}, ${ruleVersion2}, 'immediate',
          'recommend', 'waiting_review', ${adminId}, 9, '2026-02-01T00:00:00Z'),
        (${emptyTask}, 'history-empty-task', ${positionId}, ${ruleVersion1}, 'immediate',
          'recommend', 'completed', ${adminId}, 99, '2026-03-01T00:00:00Z')
    `;
    await sql`
      INSERT INTO message_templates (id, position_id, name)
      VALUES (${templateId}, ${positionId}, 'History template')
    `;
    await sql`
      INSERT INTO template_versions (id, template_id, version, body, created_by)
      VALUES (${templateVersionId}, ${templateId}, 1, 'Synthetic preview only', ${adminId})
    `;
    await sql`
      UPDATE message_templates SET active_version_id = ${templateVersionId}
      WHERE id = ${templateId}
    `;

    const stateIds: string[] = [];
    for (let index = 1; index <= 15; index += 1) {
      const candidateId = randomUUID();
      const task1Snapshot = randomUUID();
      const stateId = randomUUID();
      stateIds.push(stateId);
      await sql`
        INSERT INTO candidates (id, fingerprint, display_name)
        VALUES (${candidateId}, ${`history-fingerprint-${index}`}, ${`Candidate ${index}`})
      `;
      await sql`
        INSERT INTO candidate_snapshots (
          id, task_id, candidate_id, source_reference, source, source_locator,
          raw_fields, source_evidence, raw_text, collected_at
        ) VALUES (
          ${task1Snapshot}, ${task1}, ${candidateId}, ${`recommend:${index}:Candidate ${index}`},
          'recommend', ${sql.json({ kind: "boss_geek_id", value: `geek-${index}` })},
          ${sql.json({ credential: index % 2 === 0 ? "TEM-8" : "CET-6" })},
          ${sql.json([])}, '', '2026-01-01T00:00:00Z'
        )
      `;
      await sql`
        INSERT INTO candidate_position_states (
          id, position_id, candidate_id, latest_task_id, latest_snapshot_id,
          rule_version_id, rule_decision, rule_confidence
        ) VALUES (
          ${stateId}, ${positionId}, ${candidateId}, ${task1}, ${task1Snapshot},
          ${ruleVersion1}, 'matched', 0.9
        )
      `;
      if (index === 1) {
        await sql`
          INSERT INTO reviews (
            id, candidate_position_state_id, idempotency_key, decision, note,
            reviewer_id, previous_status, resulting_version, created_at
          ) VALUES (
            ${randomUUID()}, ${stateId}, 'history-review-1', 'approved',
            'Synthetic historical review', ${adminId}, 'pending', 2,
            '2026-01-15T00:00:00Z'
          )
        `;
        await sql`
          INSERT INTO contact_intents (
            id, idempotency_key, candidate_position_state_id, task_id,
            template_version_id, rendered_message, status, policy_snapshot,
            created_by, transport_mode, created_at
          ) VALUES (
            ${randomUUID()}, 'history-contact-1', ${stateId}, ${task1},
            ${templateVersionId}, 'Synthetic preview only', 'simulated',
            ${sql.json({ mode: "manual", synthetic: true })}, ${adminId}, 'fake',
            '2026-01-20T00:00:00Z'
          )
        `;
      }
      if (index <= 9) {
        const task2Snapshot = randomUUID();
        await sql`
          INSERT INTO candidate_snapshots (
            id, task_id, candidate_id, source_reference, source, source_locator,
            raw_fields, source_evidence, raw_text, collected_at
          ) VALUES (
            ${task2Snapshot}, ${task2}, ${candidateId}, ${`recommend:${index}:Candidate ${index}`},
            'recommend', ${sql.json({ kind: "boss_geek_id", value: `geek-${index}` })},
            ${sql.json({ credential: "CET-6" })}, ${sql.json([])}, '',
            '2026-02-01T00:00:00Z'
          )
        `;
        // This reproduces the legacy upsert bug: the original task-1 state was
        // moved to task 2 and carried its human/contact outcome with it.
        await sql`
          UPDATE candidate_position_states
          SET latest_task_id = ${task2}, latest_snapshot_id = ${task2Snapshot},
            rule_version_id = ${ruleVersion2}, rule_decision = 'not_matched',
            review_status = 'approved', contact_status = 'simulated'
          WHERE id = ${stateId}
        `;
      }
    }
    // Reproduce a pre-023 stale active pointer.  Retiring the version was legal,
    // but the old system did not clear rule_sets.active_version_id.
    await sql`
      UPDATE rule_versions SET lifecycle_status = 'retired', retired_at = now()
      WHERE id = ${ruleVersion2}
    `;

    const migration023 = await readFile(
      new URL("023_task_candidate_history_and_recovery.sql", migrationsUrl),
      "utf8"
    );
    await sql.begin(async (transaction) => {
      await transaction.unsafe(migration023);
    });

    const taskCounts = await sql<
      Array<{
        id: string;
        candidate_count: number;
        new_candidate_count: number;
        repeat_candidate_count: number;
        states: number;
      }>
    >`
      SELECT t.id, t.candidate_count, t.new_candidate_count, t.repeat_candidate_count,
        count(cps.id)::int AS states
      FROM tasks t
      LEFT JOIN candidate_position_states cps ON cps.latest_task_id = t.id
      WHERE t.id IN (${task1}, ${task2})
      GROUP BY t.id
      ORDER BY t.created_at
    `;
    assert.deepEqual(taskCounts.map((row) => ({
      count: row.candidate_count,
      newCount: row.new_candidate_count,
      repeatCount: row.repeat_candidate_count,
      states: row.states
    })), [
      { count: 15, newCount: 15, repeatCount: 0, states: 15 },
      { count: 9, newCount: 0, repeatCount: 9, states: 9 }
    ]);
    const emptyTaskCount = await sql<
      Array<{ candidate_count: number; new_candidate_count: number; repeat_candidate_count: number }>
    >`
      SELECT candidate_count, new_candidate_count, repeat_candidate_count
      FROM tasks WHERE id = ${emptyTask}
    `;
    assert.deepEqual(emptyTaskCount[0], {
      candidate_count: 0,
      new_candidate_count: 0,
      repeat_candidate_count: 0
    });
    const restored = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM candidate_position_states
      WHERE latest_task_id = ${task1}
        AND resume_screening_error_code = 'historical_result_needs_recheck'
        AND NOT is_current
    `;
    assert.equal(restored[0]?.count, 9);
    const restoredHistoricalOutcome = await sql<
      Array<{ review_status: string; contact_status: string }>
    >`
      SELECT state.review_status, state.contact_status
      FROM candidate_position_states state
      JOIN candidates candidate ON candidate.id = state.candidate_id
      WHERE state.latest_task_id = ${task1}
        AND candidate.fingerprint = 'history-fingerprint-1'
    `;
    assert.deepEqual(restoredHistoricalOutcome[0], {
      review_status: "approved",
      contact_status: "simulated"
    });
    const currentTaskOutcomes = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM candidate_position_states
      WHERE latest_task_id = ${task2}
        AND review_status = 'not_required'
        AND contact_status = 'not_contacted'
        AND is_current
    `;
    assert.equal(currentTaskOutcomes[0]?.count, 9);
    const historicalIntent = await sql<
      Array<{ intent_task_id: string; state_task_id: string }>
    >`
      SELECT intent.task_id AS intent_task_id, state.latest_task_id AS state_task_id
      FROM contact_intents intent
      JOIN candidate_position_states state
        ON state.id = intent.candidate_position_state_id
      WHERE intent.idempotency_key = 'history-contact-1'
    `;
    assert.equal(historicalIntent[0]?.intent_task_id, task1);
    assert.equal(historicalIntent[0]?.state_task_id, task1);
    const alerts = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM operational_alerts
      WHERE alert_type = 'resume_screening_failed'
        AND message LIKE '历史任务候选人归属已恢复%'
    `;
    assert.equal(alerts[0]?.count, 9);
    const activePointer = await sql<Array<{ active_version_id: string | null }>>`
      SELECT active_version_id FROM rule_sets WHERE id = ${ruleSetId}
    `;
    assert.equal(activePointer[0]?.active_version_id, null);
    const restoredState = await sql<Array<{ id: string }>>`
      SELECT id FROM candidate_position_states
      WHERE latest_task_id = ${task1}
        AND resume_screening_error_code = 'historical_result_needs_recheck'
      LIMIT 1
    `;
    await assert.rejects(
      sql`
        UPDATE candidate_position_states SET latest_task_id = ${task2}
        WHERE id = ${restoredState[0]!.id}
      `,
      /candidate task state must use its task position and rule version/u
    );
    await assert.rejects(
      sql`
        INSERT INTO tasks (
          id, idempotency_key, position_id, rule_version_id, execution_mode,
          source, status, created_by
        ) VALUES (
          ${randomUUID()}, 'history-retired-rule-task', ${positionId}, ${ruleVersion2},
          'immediate', 'recommend', 'queued', ${adminId}
        )
      `,
      /task rule version must be published/u
    );
    const task2Candidate = await sql<Array<{ id: string }>>`
      SELECT id FROM candidate_position_states WHERE latest_task_id = ${task2} LIMIT 1
    `;
    await assert.rejects(
      sql`
        INSERT INTO contact_intents (
          id, idempotency_key, candidate_position_state_id, task_id,
          template_version_id, rendered_message, status, policy_snapshot,
          created_by, transport_mode
        ) VALUES (
          ${randomUUID()}, 'history-mismatched-contact', ${task2Candidate[0]!.id}, ${task1},
          ${templateVersionId}, 'Synthetic preview only', 'simulated',
          ${sql.json({ mode: "manual", synthetic: true })}, ${adminId}, 'fake'
        )
      `,
      /contact intent task must match its candidate task state/u
    );
    const duplicateDepartmentId = randomUUID();
    await sql`
      INSERT INTO departments (id, slug, name)
      VALUES (${duplicateDepartmentId}, ${`duplicate-${duplicateDepartmentId}`}, 'Duplicate email test')
    `;
    await assert.rejects(
      sql`
        INSERT INTO users (id, department_id, email, display_name, role)
        VALUES (${randomUUID()}, ${duplicateDepartmentId}, 'HISTORY@example.invalid', 'Duplicate', 'admin')
      `,
      /user email must be globally unique/u
    );
    await sql`UPDATE users SET status = 'disabled' WHERE id = ${adminId}`;
    const disabledOwnerAssignment = await sql<Array<{ assignment_status: string }>>`
      SELECT assignment_status FROM positions WHERE id = ${positionId}
    `;
    assert.equal(disabledOwnerAssignment[0]?.assignment_status, "needs_admin_assignment");
    await sql`UPDATE users SET status = 'active' WHERE id = ${adminId}`;
    const activeOwnerAssignment = await sql<Array<{ assignment_status: string }>>`
      SELECT assignment_status FROM positions WHERE id = ${positionId}
    `;
    assert.equal(activeOwnerAssignment[0]?.assignment_status, "assigned");
    assert.equal(stateIds.length, 15);
    console.log(JSON.stringify({
      ok: true,
      task1SnapshotsRestored: 15,
      task2StatesRetained: 9,
      restoredRowsNeedingRecheck: 9,
      historicalReviewAndContactReattached: true,
      newerTaskOutcomeReset: true,
      emptyTaskCountReset: true,
      staleActiveRuleCleared: true,
      ownershipTriggersVerified: true,
      globalLoginEmailGuardVerified: true,
      isolatedContactFixtures: true,
      externalContactExecuted: false,
      contactWorkerStarted: false
    }));
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
