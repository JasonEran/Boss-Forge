import assert from "node:assert/strict";
import {
  BossForgeRepository,
  OptimisticLockError,
  createDatabase
} from "./index.js";

async function main(): Promise<void> {
  const sql = createDatabase();
  try {
    const repository = new BossForgeRepository(sql);
    const position = await repository.createPosition({
      bossAccountId: "integration-account",
      name: "Integration Position",
      ownerName: "integration-test"
    });
    await repository.createRuleVersion({
      positionId: position.id,
      name: "Integration TEM8",
      config: { requiredCapabilities: [{ capability: "tem8", minimumConfidence: 0.9 }] },
      dictionaryVersion: "integration.1",
      createdBy: "integration-test"
    });
    await repository.createImmediateTask({
      idempotencyKey: "integration-task-1",
      positionId: position.id,
      source: "recommend",
      createdBy: "integration-test"
    });
    const task = await repository.claimNextTask("integration-worker");
    assert(task);
    await repository.completeTask(task, [
      {
        sourceReference: "recommend:1:Integration Candidate",
        source: "recommend",
        displayName: "Integration Candidate",
        fingerprint: "integration-fingerprint-1",
        rawFields: { experience: "3 years" },
        sourceEvidence: ["TEM-8 certified"],
        rawText: "TEM-8 certified",
        decision: "matched",
        confidence: 0.99,
        capabilityId: "language.english.tem8",
        canonicalLabel: "TEM-8",
        dictionaryVersion: "integration.1",
        reasonCodes: ["confirmed_alias"],
        evidence: [
          {
            sourceText: "TEM-8 certified",
            normalizedAlias: "TEM-8",
            status: "positive",
            confidence: 0.99
          }
        ]
      }
    ]);
    const dashboard = await repository.getDashboard();
    const state = dashboard.candidates[0];
    assert(state);
    const first = await repository.reviewCandidate({
      stateId: state.stateId,
      idempotencyKey: "integration-review-1",
      decision: "approved",
      note: "Evidence confirmed.",
      reviewerId: "integration-reviewer",
      expectedVersion: state.stateVersion
    });
    const replay = await repository.reviewCandidate({
      stateId: state.stateId,
      idempotencyKey: "integration-review-1",
      decision: "approved",
      note: "Evidence confirmed.",
      reviewerId: "integration-reviewer",
      expectedVersion: state.stateVersion
    });
    assert.equal(first.id, replay.id);
    await assert.rejects(
      repository.reviewCandidate({
        stateId: state.stateId,
        idempotencyKey: "integration-review-stale",
        decision: "rejected",
        note: "Stale write",
        reviewerId: "integration-reviewer",
        expectedVersion: state.stateVersion
      }),
      OptimisticLockError
    );
    const detail = await repository.getCandidateDetail(state.stateId);
    assert(detail);
    assert.equal(detail.reviewStatus, "approved");
    assert.equal(detail.stateVersion, state.stateVersion + 1);
    assert.equal(detail.reviews.length, 1);
    console.log(
      JSON.stringify({
        ok: true,
        stateId: state.stateId,
        reviewId: first.id,
        idempotentReplay: first.id === replay.id,
        optimisticLock: true
      })
    );
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
