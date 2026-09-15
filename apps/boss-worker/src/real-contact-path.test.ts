import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("real contact product path", () => {
  it("keeps greeting and message as independent single-action paths", () => {
    const worker = source("apps/boss-worker/src/contact-worker.ts");
    expect(worker).toContain('job.actionKind === "greet"');
    expect(worker).toContain('type: "greet"');
    expect(worker).toContain('parseBossContactProviderReceipt(result.stdout, "greet")');
    expect(worker).toContain("providerGreetingId: provider.greetingId");
    expect(worker).toContain("真实消息发送已开始");
    expect(worker).toContain("sourceLocator: verifiedCandidate.sourceLocator");
    expect(worker).not.toContain("requestResume:");
    const safety = source("apps/boss-worker/src/contact-safety.ts");
    expect(safety).toContain("realContactEnabled(environment)");
    expect(safety).toContain("accepted single-action transport");
  });

  it("proves the browser session before publishing authoritative health and preflight", () => {
    const worker = source("apps/boss-worker/src/contact-worker.ts");
    const browserCheck = worker.indexOf("inspectBossBrowserSession");
    const heartbeat = worker.indexOf("recordVerifiedBossAccountHealth", browserCheck);
    const preflight = worker.indexOf("assertContactDispatchAllowed", heartbeat);
    expect(browserCheck).toBeGreaterThan(-1);
    expect(heartbeat).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(heartbeat);
  });

  it("rechecks the exact approval and policy after opening the verified chat and before send", () => {
    const worker = source("apps/boss-worker/src/contact-worker.ts");
    const identityRefresh = worker.indexOf("await refreshContactCandidateTarget(job)");
    const chatOpen = worker.indexOf('type: "chat-by-name"', identityRefresh);
    const finalPreflight = worker.indexOf("assertContactDispatchAllowed", chatOpen);
    const firstWrite = worker.indexOf('type: "send"', finalPreflight);
    expect(identityRefresh).toBeGreaterThan(-1);
    expect(chatOpen).toBeGreaterThan(identityRefresh);
    expect(finalPreflight).toBeGreaterThan(chatOpen);
    expect(firstWrite).toBeGreaterThan(finalPreflight);
  });

  it("holds the contact-global fence before the account lock through write receipt parsing", () => {
    const worker = source("apps/boss-worker/src/contact-worker.ts");
    const globalFence = worker.indexOf("withContactGlobalFence(() =>");
    const accountLock = worker.indexOf("withAccountLock(accountId", globalFence);
    const finalPreflight = worker.lastIndexOf("assertContactDispatchAllowed");
    const messageWrite = worker.indexOf('type: "send"', finalPreflight);
    const receipt = worker.indexOf(
      'parseBossContactProviderReceipt(sendResult.stdout, "message")',
      messageWrite
    );
    expect(globalFence).toBeGreaterThan(-1);
    expect(accountLock).toBeGreaterThan(globalFence);
    expect(finalPreflight).toBeGreaterThan(accountLock);
    expect(messageWrite).toBeGreaterThan(finalPreflight);
    expect(receipt).toBeGreaterThan(messageWrite);
  });

  it("requires candidate and body-bound provider proof before recording real success", () => {
    const dispatch = source("apps/boss-worker/src/contact-dispatch.ts");
    expect(dispatch).toContain("assertVerifiedContactReceipt");
    expect(dispatch).toContain("providerMessageId");
    expect(dispatch).toContain("providerConversationId");
    expect(dispatch).toContain("candidateLocatorSha256");
    expect(dispatch).toContain("renderedMessageSha256");
  });

  it("keeps real dispatch fail-closed on circuit and account health", () => {
    const repository = source("packages/data/src/m2-repository.ts");
    expect(repository).toContain("real_contact_circuit_open");
    expect(repository).toContain("authoritative_boss_account_health_unavailable");
    expect(repository).toContain("authoritative_boss_account_health_stale");
    expect(repository).toContain("stable_candidate_locator_missing");
    expect(repository).toContain("contact_control_${scopeType}_emergency_stop");
    expect(repository).toContain("intent_creator_position_access_revoked");
    expect(repository).toContain("contact_control_${scopeType}_approval_invalid");
    expect(repository).toContain("FROM do_not_contact");
  });

  it("keeps real manual intents behind the shared accepted-transport capability", () => {
    const server = source("apps/control-api/src/server.ts");
    expect(server).toContain('transportMode: realContact ? "real" : "fake"');
    expect(server).toContain('contactDispatchMode === "real"');
    expect(server).toContain("realContactEnabled(process.env)");
    expect(server).toContain('contactDispatchMode === "disabled"');
    const capability = source("packages/contracts/src/contact-capability.ts");
    expect(capability).toContain("REAL_CONTACT_TRANSPORT_AVAILABLE = true");
    expect(capability).toContain('return "preview_only"');
  });

  it("binds any future real intent to one short-lived exact preview approval", () => {
    const server = source("apps/control-api/src/server.ts");
    const repository = source("packages/data/src/m2-repository.ts");
    expect(server).toContain("issueContactPreviewApproval");
    expect(server).toContain("verifyContactPreviewApproval");
    expect(server).toContain(
      "contactPreviewApprovalIdempotencyKey(actionKind, verifiedRealApproval.approvalId)"
    );
    expect(repository).toContain("contact_preview_approval_missing");
    expect(repository).toContain("contact_preview_approval_expired");
    expect(repository).toContain("contact_preview_approval_binding_changed");
    expect(repository).toContain("contact_preview_approval_signature_invalid");
    expect(repository).toContain("contactPreviewApprovalToken");
    expect(repository).toContain("verifyContactPreviewApproval");
    expect(repository).toContain("contactPreviewApprovalSigningKeyFromEnvironment(process.env)");
    expect(repository).toContain("bossAccountId: context.boss_account_id");
    expect(repository).toContain("source: context.source");
    expect(repository).toContain("sourceLocator: context.source_locator");
    expect(repository).toContain('AND ci.rendered_message = ${input.job.renderedMessage}');
    expect(repository).toContain('AND t.source = ${input.job.source}');
    expect(repository).toContain("current_candidate_state");
    expect(repository).toContain("cps.is_current = true");
  });

  it("keeps human account-health observations non-authoritative", () => {
    const departmentRepository = source("packages/data/src/department-repository.ts");
    expect(departmentRepository).toContain("人工记录（非权威）");
    expect(departmentRepository).toContain("account.health.manual_observation");
  });

  it("completes fake dispatch before any BOSS transport and backs off while idle", () => {
    const worker = source("apps/boss-worker/src/contact-worker.ts");
    const fakeReturn = worker.indexOf("FAKE ${job.actionKind} completed");
    const accountLock = worker.indexOf("withAccountLock(accountId");
    expect(fakeReturn).toBeGreaterThan(-1);
    expect(accountLock).toBeGreaterThan(fakeReturn);
    expect(worker).toContain("await runContactWorkerLoop({");
    expect(worker).toContain('await activity.communicationActive(accountId) ? "idle" : runContactDispatchOnce(dispatchStore, transport, workerId)');
  });
});
