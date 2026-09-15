export type ContactReadinessCheck = {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type ContactReadinessControl = {
  scopeType: "global" | "department" | "position" | "task";
  label: string;
  exists: boolean;
  enabled: boolean;
  emergencyStop: boolean;
  approvalRequired: boolean;
  approvalValid: boolean;
};

export type ContactReadinessQuota = {
  scopeType: "account" | "position" | "task";
  label: string;
  used: number;
  reserved: number;
  limit: number;
};

export type ExactContactReadinessFacts = {
  realContact: boolean;
  internalQuotasEnabled?: boolean;
  isCurrent: boolean;
  resumeScreeningStatus:
    | "not_requested"
    | "queued"
    | "processing"
    | "screened"
    | "no_text"
    | "failed";
  reviewStatus: "pending" | "approved" | "rejected" | "not_required";
  contactStatus: "not_contacted" | "queued" | "sent" | "simulated" | "failed" | "uncertain";
  doNotContact: boolean;
  samePositionAlreadyContacted: boolean;
  activeIntentStatus: string | null;
  accountHasUncertain: boolean;
  positionStatus: "active" | "paused" | "closed";
  taskStatus: string;
  source: "recommend" | "search";
  stableLocatorPresent: boolean;
  legacyEmergencyStop: boolean;
  withinAllowedHours: boolean;
  crossPositionCooldownActive: boolean;
  accountHealthReady: boolean;
  controls: ContactReadinessControl[];
  quotas: ContactReadinessQuota[];
};

const reviewLabels: Record<ExactContactReadinessFacts["reviewStatus"], string> = {
  pending: "待人工审核",
  approved: "已人工通过",
  rejected: "已人工拒绝",
  not_required: "无需人工审核"
};

const contactLabels: Record<ExactContactReadinessFacts["contactStatus"], string> = {
  not_contacted: "尚未联系",
  queued: "已有等待联系任务",
  sent: "已联系",
  simulated: "仅完成过模拟联系",
  failed: "上次联系任务明确失败",
  uncertain: "存在无法确认是否送达的记录"
};

export function evaluateExactContactReadiness(
  facts: ExactContactReadinessFacts
): { ready: boolean; reasons: string[]; checks: ContactReadinessCheck[] } {
  const checks: ContactReadinessCheck[] = [];
  const add = (
    key: string,
    label: string,
    passed: boolean,
    passedDetail: string,
    failedDetail: string
  ): void => {
    checks.push({ key, label, passed, detail: passed ? passedDetail : failedDetail });
  };

  add(
    "current_candidate_state",
    "候选人记录",
    facts.isCurrent,
    "这是该候选人在当前岗位的最新记录",
    "这是历史任务记录，请返回候选人列表选择当前记录"
  );
  add(
    "manual_review_required",
    "人工审核",
    facts.reviewStatus === "approved",
    "候选人已由 HR 审核通过",
    `候选人当前为“${reviewLabels[facts.reviewStatus]}”`
  );
  add(
    "resume_screening_incomplete",
    "简历处理",
    !["not_requested", "queued", "processing"].includes(
      facts.resumeScreeningStatus
    ),
    facts.resumeScreeningStatus === "screened"
      ? "简历已完整处理"
      : "简历自动识别已结束，HR 已完成人工核对",
    facts.resumeScreeningStatus === "processing"
      ? "简历正在处理，请完成后再联系"
      : "简历尚未完成处理，请先查看并完成审核"
  );
  add(
    "do_not_contact",
    "禁止联系",
    !facts.doNotContact,
    "候选人未被标记为禁止联系",
    "候选人已被标记为禁止联系"
  );
  add(
    "candidate_contact_state",
    "联系记录",
    !["queued", "sent", "uncertain"].includes(facts.contactStatus) &&
      !facts.samePositionAlreadyContacted &&
      !facts.activeIntentStatus,
    contactLabels[facts.contactStatus],
    facts.activeIntentStatus
      ? `已有状态为 ${facts.activeIntentStatus} 的联系任务`
      : contactLabels[facts.contactStatus]
  );
  add(
    "job_not_active",
    "岗位状态",
    facts.positionStatus === "active",
    "岗位正在招聘",
    facts.positionStatus === "paused" ? "岗位已暂停" : "岗位已关闭"
  );
  add(
    "task_not_active",
    "任务状态",
    !["failed", "cancelled"].includes(facts.taskStatus),
    "所属筛选任务可用于本次确认",
    facts.taskStatus === "cancelled" ? "所属任务已取消" : "所属任务已失败"
  );
  add(
    "legacy_emergency_stop",
    "全局紧急停止",
    !facts.legacyEmergencyStop,
    "全局紧急停止未启用",
    "全局紧急停止已启用"
  );
  add(
    "outside_allowed_hours",
    "联系时段",
    facts.withinAllowedHours,
    "当前处于允许联系时段",
    "当前不在允许联系时段"
  );
  add(
    "cross_position_cooldown",
    "跨岗位冷却",
    !facts.crossPositionCooldownActive,
    "没有仍在生效的跨岗位联系冷却",
    "该候选人在其他岗位的联系仍处于冷却期"
  );

  for (const control of facts.controls) {
    add(
      `contact_control_${control.scopeType}`,
      `${control.label}联系开关`,
      control.exists &&
        control.enabled &&
        !control.emergencyStop &&
        (!control.approvalRequired || control.approvalValid),
      "已开启，且没有紧急停止或待审批项",
      !control.exists
        ? "尚未配置"
        : !control.enabled
          ? "当前已关闭"
          : control.emergencyStop
            ? "紧急停止已启用"
            : "所需授权尚未生效"
    );
  }

  for (const quota of facts.quotas) {
    const consumed = quota.used + quota.reserved;
    add(
      `${quota.scopeType}_daily_limit`,
      `${quota.label}今日额度`,
      facts.internalQuotasEnabled === false || (quota.limit > 0 && consumed < quota.limit),
      facts.internalQuotasEnabled === false
        ? `内部数量限额已关闭；已使用 ${quota.used}，已预留 ${quota.reserved}`
        : `已使用 ${quota.used}，已预留 ${quota.reserved}，上限 ${quota.limit}`,
      `已使用 ${quota.used}，已预留 ${quota.reserved}，上限 ${quota.limit}`
    );
  }

  if (facts.realContact) {
    add(
      "real_contact_source",
      "候选人来源",
      facts.source === "recommend",
      "来自推荐列表，支持稳定定位",
      "搜索来源暂不支持安全真实联系"
    );
    add(
      "stable_candidate_locator_missing",
      "候选人唯一标识",
      facts.stableLocatorPresent,
      "稳定 BOSS 标识已绑定",
      "缺少稳定 BOSS 标识"
    );
    add(
      "uncertain_previous_send",
      "账号不确定发送锁",
      !facts.accountHasUncertain,
      "该账号没有待人工核验的不确定发送",
      "该账号存在无法确认的历史发送，已停止后续联系"
    );
    add(
      "authoritative_boss_account_health",
      "BOSS 登录与账号健康",
      facts.accountHealthReady,
      "系统已在有效期内确认账号健康",
      "系统尚未取得有效的账号健康确认"
    );
  }

  return {
    ready: checks.every((check) => check.passed),
    reasons: checks.filter((check) => !check.passed).map((check) => check.key),
    checks
  };
}
