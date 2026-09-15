import { describe, expect, it } from "vitest";
import {
  evaluateExactContactReadiness,
  type ExactContactReadinessFacts
} from "./contact-readiness.js";

function readyFacts(realContact = false): ExactContactReadinessFacts {
  return {
    realContact,
    isCurrent: true,
    resumeScreeningStatus: "screened",
    reviewStatus: "approved",
    contactStatus: "not_contacted",
    doNotContact: false,
    samePositionAlreadyContacted: false,
    activeIntentStatus: null,
    accountHasUncertain: false,
    positionStatus: "active",
    taskStatus: "waiting_review",
    source: "recommend",
    stableLocatorPresent: true,
    legacyEmergencyStop: false,
    withinAllowedHours: true,
    crossPositionCooldownActive: false,
    accountHealthReady: true,
    controls: [
      ["global", "全局"],
      ["department", "当前部门"],
      ["position", "当前岗位"],
      ["task", "当前任务"]
    ].map(([scopeType, label]) => ({
      scopeType: scopeType as "global" | "department" | "position" | "task",
      label: label!,
      exists: true,
      enabled: true,
      emergencyStop: false,
      approvalRequired: false,
      approvalValid: false
    })),
    quotas: [
      { scopeType: "account", label: "BOSS 账号", used: 1, reserved: 1, limit: 20 },
      { scopeType: "position", label: "岗位", used: 1, reserved: 0, limit: 10 },
      { scopeType: "task", label: "任务", used: 1, reserved: 0, limit: 10 }
    ]
  };
}

describe("exact contact preview readiness", () => {
  it("reports an understandable complete pass for the exact candidate", () => {
    const result = evaluateExactContactReadiness(readyFacts());

    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "人工审核", passed: true }),
        expect.objectContaining({ label: "联系记录", passed: true }),
        expect.objectContaining({ label: "BOSS 账号今日额度", passed: true })
      ])
    );
  });

  it("fails closed for candidate, task, control, schedule and quota blockers", () => {
    const facts = readyFacts();
    facts.isCurrent = false;
    facts.resumeScreeningStatus = "processing";
    facts.doNotContact = true;
    facts.contactStatus = "uncertain";
    facts.activeIntentStatus = "processing";
    facts.positionStatus = "paused";
    facts.taskStatus = "cancelled";
    facts.legacyEmergencyStop = true;
    facts.withinAllowedHours = false;
    facts.crossPositionCooldownActive = true;
    facts.controls[2] = {
      ...facts.controls[2]!,
      enabled: false
    };
    facts.quotas[0] = {
      ...facts.quotas[0]!,
      used: 19,
      reserved: 1,
      limit: 20
    };

    const result = evaluateExactContactReadiness(facts);

    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "current_candidate_state",
        "resume_screening_incomplete",
        "do_not_contact",
        "candidate_contact_state",
        "job_not_active",
        "task_not_active",
        "legacy_emergency_stop",
        "outside_allowed_hours",
        "cross_position_cooldown",
        "contact_control_position",
        "account_daily_limit"
      ])
    );
  });

  it("blocks contact while a previously reviewed resume is being reprocessed", () => {
    const facts = readyFacts();
    facts.resumeScreeningStatus = "queued";

    const result = evaluateExactContactReadiness(facts);

    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(["resume_screening_incomplete"]);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "resume_screening_incomplete",
        label: "简历处理",
        passed: false
      })
    );
  });

  it("blocks a historical candidate state even when every other check passes", () => {
    const facts = readyFacts();
    facts.isCurrent = false;

    const result = evaluateExactContactReadiness(facts);

    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(["current_candidate_state"]);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "current_candidate_state",
        label: "候选人记录",
        passed: false
      })
    );
  });

  it("adds recipient locator, source, account uncertainty and health gates only for real mode", () => {
    const facts = readyFacts(true);
    facts.source = "search";
    facts.stableLocatorPresent = false;
    facts.accountHasUncertain = true;
    facts.accountHealthReady = false;

    const result = evaluateExactContactReadiness(facts);

    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "real_contact_source",
        "stable_candidate_locator_missing",
        "uncertain_previous_send",
        "authoritative_boss_account_health"
      ])
    );
    expect(evaluateExactContactReadiness(readyFacts(true)).ready).toBe(true);
  });
});
