import { describe, expect, it } from "vitest";
import { evaluateContactPolicy, type ContactPolicyInput } from "./index.js";

function validInput(mode: ContactPolicyInput["mode"]): ContactPolicyInput {
  return {
    mode,
    switches: {
      emergencyStop: false,
      globalAutomatic: true,
      positionAutomatic: true,
      taskAutomatic: true
    },
    runtime: { healthy: true, circuitOpen: false },
    candidate: {
      reviewStatus: mode === "manual" ? "approved" : "not_required",
      ruleDecision: "matched",
      ruleConfidence: 0.99,
      samePositionAlreadyContacted: false,
      lastCrossPositionContactAt: null,
      previousSendState: "none"
    },
    limits: {
      account: { used: 2, limit: 100 },
      position: { used: 2, limit: 30 },
      task: { used: 2, limit: 20 }
    },
    schedule: {
      now: "2026-08-31T03:00:00.000Z",
      localMinuteOfDay: 11 * 60,
      allowedStartMinute: 9 * 60,
      allowedEndMinute: 18 * 60,
      crossPositionCooldownHours: 72
    },
    minimumAutomaticConfidence: 0.95
  };
}

describe("contact safety policy", () => {
  it("allows a manually approved candidate without requiring automatic switches", () => {
    const input = validInput("manual");
    input.switches.globalAutomatic = false;
    input.switches.positionAutomatic = false;
    input.switches.taskAutomatic = false;
    expect(evaluateContactPolicy(input)).toEqual({ allowed: true, mode: "manual", reasons: [] });
  });

  it("blocks manual contact before HR approval", () => {
    const input = validInput("manual");
    input.candidate.reviewStatus = "pending";
    expect(evaluateContactPolicy(input).reasons).toContain("manual_review_required");
  });

  it.each([
    ["globalAutomatic", "global_auto_disabled"],
    ["positionAutomatic", "position_auto_disabled"],
    ["taskAutomatic", "task_auto_disabled"]
  ] as const)("fails closed when %s is disabled", (key, reason) => {
    const input = validInput("automatic");
    input.switches[key] = false;
    expect(evaluateContactPolicy(input)).toEqual({
      allowed: false,
      mode: "automatic",
      reasons: [reason]
    });
  });

  it("requires an unambiguous high-confidence rule match for automation", () => {
    const input = validInput("automatic");
    input.candidate.ruleDecision = "ambiguous";
    input.candidate.ruleConfidence = 0.6;
    expect(evaluateContactPolicy(input).reasons).toEqual([
      "rule_not_matched",
      "confidence_too_low"
    ]);
  });

  it("blocks duplicates, cooldowns, uncertain sends, limits and unhealthy runtime", () => {
    const input = validInput("automatic");
    input.runtime.healthy = false;
    input.runtime.circuitOpen = true;
    input.candidate.samePositionAlreadyContacted = true;
    input.candidate.lastCrossPositionContactAt = "2026-08-30T03:00:00.000Z";
    input.candidate.previousSendState = "uncertain";
    input.limits.account.used = 100;
    input.limits.position.used = 30;
    input.limits.task.used = 20;
    const result = evaluateContactPolicy(input);
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "runtime_unhealthy",
        "circuit_open",
        "same_position_already_contacted",
        "cross_position_cooldown",
        "uncertain_previous_send",
        "account_daily_limit",
        "position_daily_limit",
        "task_limit"
      ])
    );
  });

  it("supports an allowed window that crosses midnight", () => {
    const input = validInput("automatic");
    input.schedule.allowedStartMinute = 22 * 60;
    input.schedule.allowedEndMinute = 2 * 60;
    input.schedule.localMinuteOfDay = 23 * 60;
    expect(evaluateContactPolicy(input).allowed).toBe(true);
  });

  it("treats malformed cooldown timestamps as unsafe", () => {
    const input = validInput("automatic");
    input.candidate.lastCrossPositionContactAt = "not-a-date";
    expect(evaluateContactPolicy(input).reasons).toContain("cross_position_cooldown");
  });
});
