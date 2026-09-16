export type ContactMode = "manual" | "automatic";

export type ContactBlockReason =
  | "emergency_stop"
  | "runtime_unhealthy"
  | "circuit_open"
  | "global_auto_disabled"
  | "position_auto_disabled"
  | "task_auto_disabled"
  | "manual_review_required"
  | "rule_not_matched"
  | "confidence_too_low"
  | "same_position_already_contacted"
  | "cross_position_cooldown"
  | "outside_allowed_hours"
  | "account_daily_limit"
  | "position_daily_limit"
  | "task_limit"
  | "uncertain_previous_send";

export type UsageLimit = {
  used: number;
  limit: number;
};

export type ContactPolicyInput = {
  mode: ContactMode;
  switches: {
    emergencyStop: boolean;
    globalAutomatic: boolean;
    positionAutomatic: boolean;
    taskAutomatic: boolean;
  };
  runtime: {
    healthy: boolean;
    circuitOpen: boolean;
  };
  candidate: {
    reviewStatus: "pending" | "approved" | "rejected" | "not_required";
    ruleDecision: "matched" | "not_matched" | "ambiguous" | "insufficient";
    ruleConfidence: number;
    samePositionAlreadyContacted: boolean;
    lastCrossPositionContactAt: string | null;
    previousSendState: "none" | "confirmed_success" | "confirmed_failure" | "uncertain";
  };
  limits: {
    account: UsageLimit;
    position: UsageLimit;
    task: UsageLimit;
  };
  schedule: {
    now: string;
    localMinuteOfDay: number;
    allowedStartMinute: number;
    allowedEndMinute: number;
    crossPositionCooldownHours: number;
  };
  minimumAutomaticConfidence: number;
};

export type ContactPolicyDecision = {
  allowed: boolean;
  mode: ContactMode;
  reasons: ContactBlockReason[];
};

function isAtLimit(value: UsageLimit): boolean {
  return value.limit <= 0 || value.used >= value.limit;
}

function isWithinAllowedWindow(now: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

function isInCooldown(now: string, lastContactAt: string | null, cooldownHours: number): boolean {
  if (!lastContactAt || cooldownHours <= 0) return false;
  const nowMs = Date.parse(now);
  const lastMs = Date.parse(lastContactAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastMs)) return true;
  return nowMs - lastMs < cooldownHours * 60 * 60 * 1000;
}

function validateInput(input: ContactPolicyInput): void {
  const dayMinutes = [
    input.schedule.localMinuteOfDay,
    input.schedule.allowedStartMinute
  ];
  if (dayMinutes.some((value) => !Number.isInteger(value) || value < 0 || value > 1439)) {
    throw new Error("Schedule minutes must be integers between 0 and 1439.");
  }
  // End minute is exclusive and may be 1440 (end of day) for unlimited windows.
  if (
    !Number.isInteger(input.schedule.allowedEndMinute) ||
    input.schedule.allowedEndMinute < 1 ||
    input.schedule.allowedEndMinute > 1440
  ) {
    throw new Error("allowedEndMinute must be an integer between 1 and 1440.");
  }
  if (
    !Number.isFinite(input.minimumAutomaticConfidence) ||
    input.minimumAutomaticConfidence < 0 ||
    input.minimumAutomaticConfidence > 1
  ) {
    throw new Error("minimumAutomaticConfidence must be between 0 and 1.");
  }
}

export function evaluateContactPolicy(input: ContactPolicyInput): ContactPolicyDecision {
  validateInput(input);
  const reasons: ContactBlockReason[] = [];

  if (input.switches.emergencyStop) reasons.push("emergency_stop");
  if (!input.runtime.healthy) reasons.push("runtime_unhealthy");
  if (input.runtime.circuitOpen) reasons.push("circuit_open");
  if (input.candidate.samePositionAlreadyContacted) {
    reasons.push("same_position_already_contacted");
  }
  if (
    isInCooldown(
      input.schedule.now,
      input.candidate.lastCrossPositionContactAt,
      input.schedule.crossPositionCooldownHours
    )
  ) {
    reasons.push("cross_position_cooldown");
  }
  if (input.candidate.previousSendState === "uncertain") {
    reasons.push("uncertain_previous_send");
  }
  if (
    !isWithinAllowedWindow(
      input.schedule.localMinuteOfDay,
      input.schedule.allowedStartMinute,
      input.schedule.allowedEndMinute
    )
  ) {
    reasons.push("outside_allowed_hours");
  }
  if (isAtLimit(input.limits.account)) reasons.push("account_daily_limit");
  if (isAtLimit(input.limits.position)) reasons.push("position_daily_limit");
  if (isAtLimit(input.limits.task)) reasons.push("task_limit");

  if (input.mode === "manual") {
    if (input.candidate.reviewStatus !== "approved") reasons.push("manual_review_required");
  } else {
    if (!input.switches.globalAutomatic) reasons.push("global_auto_disabled");
    if (!input.switches.positionAutomatic) reasons.push("position_auto_disabled");
    if (!input.switches.taskAutomatic) reasons.push("task_auto_disabled");
    if (input.candidate.ruleDecision !== "matched") reasons.push("rule_not_matched");
    if (input.candidate.ruleConfidence < input.minimumAutomaticConfidence) {
      reasons.push("confidence_too_low");
    }
  }

  return { allowed: reasons.length === 0, mode: input.mode, reasons };
}
