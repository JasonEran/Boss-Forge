export type ContactRuntimeState =
  | 'loading'
  | 'preview'
  | 'fake'
  | 'real'
  | 'blocked';

export type ContactRuntimePresentation = {
  state: ContactRuntimeState;
  label: string;
  detail: string;
  allowsRealContact: boolean;
};

const realModes = new Set(['real_enabled', 'real_greet_enabled']);

export function contactRuntimePresentation(input: {
  loaded: boolean;
  realGreetingEnabled?: unknown;
  contactDispatchMode?: unknown;
  sideEffectsMode?: unknown;
  requestFailed?: boolean;
}): ContactRuntimePresentation {
  if (!input.loaded && !input.requestFailed) {
    return {
      state: 'loading',
      label: '正在读取联系模式',
      detail: '状态确认前，系统不允许进入真实联系。',
      allowsRealContact: false,
    };
  }

  if (input.requestFailed) {
    return {
      state: 'blocked',
      label: '联系模式无法确认',
      detail: '未能读取服务端真实状态，已按安全策略阻止真实联系。',
      allowsRealContact: false,
    };
  }

  const flag = input.realGreetingEnabled;
  const mode =
    typeof input.sideEffectsMode === 'string' ? input.sideEffectsMode : '';
  const dispatchMode =
    typeof input.contactDispatchMode === 'string'
      ? input.contactDispatchMode
      : '';
  const consistentReal =
    flag === true && dispatchMode === 'real' && realModes.has(mode);
  const consistentFake =
    flag === false && dispatchMode === 'fake' && mode === 'fake_only';
  const consistentPreview =
    flag === false && dispatchMode === 'disabled' && mode === 'preview_only';

  if (consistentReal) {
    return {
      state: 'real',
      label: '真实联系已启用',
      detail: '只有人工确认且发送前全部安全检查通过时，才允许执行。',
      allowsRealContact: true,
    };
  }

  if (consistentFake) {
    return {
      state: 'fake',
      label: '模拟联系模式',
      detail: '可以预览和演练，不会向 BOSS 或候选人发送消息。',
      allowsRealContact: false,
    };
  }

  if (consistentPreview) {
    return {
      state: 'preview',
      label: '仅预览，发送未启动',
      detail:
        '可以查看最终消息；联系发送处理程序未启动，不会创建或执行发送任务。',
      allowsRealContact: false,
    };
  }

  return {
    state: 'blocked',
    label: '联系配置不一致',
    detail: '环境开关与运行模式不一致，已阻止真实联系，请管理员检查服务配置。',
    allowsRealContact: false,
  };
}

const statusLabels: Record<string, string> = {
  queued: '等待处理',
  ready: '等待执行',
  running: '正在采集候选人',
  screening: '正在读取并筛选简历',
  waiting_review: '等待人工审核',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  pending: '待人工审核',
  approved: '人工审核通过',
  rejected: '人工审核未通过',
  not_required: '规则未通过，可人工改判',
  matched: '符合',
  not_matched: '不符合',
  ambiguous: '需人工判断',
  insufficient: '信息不足',
  not_requested: '尚未安排',
  processing: '正在处理',
  screened: '已完成精筛',
  no_text: '未识别到简历正文',
  sent: '已联系',
  simulated: '模拟完成',
  uncertain: '需人工核验',
  not_contacted: '未联系',
  healthy: '正常',
  degraded: '不稳定',
  blocked: '已受限',
  unknown: '状态未知',
  active: '已启用',
  disabled: '已停用',
  admin: '系统管理员',
  recruiting_lead: '招聘负责人',
  recruiter: 'HR',
  interviewer: '面试官',
  viewer: '只读成员',
  owner: '岗位负责人',
  recommend: 'BOSS 推荐',
  search: 'BOSS 搜索',
};

export function hrStatusLabel(value: unknown, fallback = '待确认'): string {
  if (typeof value !== 'string' || !value) return fallback;
  return statusLabels[value] ?? fallback;
}

const waitingReasonLabels: Record<string, string> = {
  outside_working_hours: '当前不在允许查看简历的时段内',
  daily_quota_reached: '今日简历查看软额度已用完',
  daily_limit_reached: '今日简历查看软额度已用完',
  daily_hard_limit_reached: '今日简历查看安全上限已用完',
  hourly_quota_reached: '最近一小时查看达到上限',
  hourly_limit_reached: '最近一小时查看达到上限',
  batch_break: '连续查看后正在按安全节奏休息',
  scheduled_break: '连续查看后正在按安全节奏休息',
  cooldown: '正在等待安全间隔',
  worker_unavailable: '处理程序暂未连接',
  login_required: 'BOSS 登录已失效',
  risk_control: 'BOSS 风控已触发，系统已停止操作',
  account_unhealthy: 'BOSS 账号状态未通过安全检查',
  resume_retry_scheduled: '简历加载或识别失败，正等待自动重试',
  resume_retry: '简历加载或识别失败，正等待自动重试',
  no_new_candidates: '本轮未发现新候选人',
};

export function waitingReasonLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return waitingReasonLabels[value] ?? '系统正在等待可继续的条件';
}

export function taskNeedsFilterUpdate(input: {
  status?: unknown;
  errorMessage?: unknown;
}): boolean {
  return (
    input.status === 'failed' &&
    typeof input.errorMessage === 'string' &&
    input.errorMessage.includes('BOSS_FILTER_UNAVAILABLE')
  );
}

export function taskNextAction(input: {
  status?: unknown;
  waitingReason?: unknown;
  nextAction?: unknown;
  retryAt?: unknown;
  errorMessage?: unknown;
}): string | null {
  if (taskNeedsFilterUpdate(input)) {
    const selection = String(input.errorMessage).match(/「([^」]+)」/u)?.[1];
    return `BOSS 当前不支持${selection ? `「${selection}」` : '部分已选筛选条件'}。请在岗位规则中获取最新 BOSS VIP 筛选并调整，再创建新任务；旧任务保留原规则，直接重试仍会失败。`;
  }
  const explicit =
    typeof input.nextAction === 'string' ? input.nextAction.trim() : '';
  if (explicit) return explicit;
  const retryAt =
    typeof input.retryAt === 'string' ? new Date(input.retryAt) : null;
  const retryTime =
    retryAt && !Number.isNaN(retryAt.getTime())
      ? retryAt.toLocaleString('zh-CN')
      : null;
  const reason = waitingReasonLabel(input.waitingReason);
  if (reason)
    return retryTime
      ? `${reason}；预计 ${retryTime} 后自动继续。`
      : `${reason}，系统会在条件恢复后自动继续。`;
  if (input.status === 'queued') return '已进入队列，等待处理程序领取。';
  if (input.status === 'screening')
    return '系统正按安全节奏查看简历，无需反复创建任务。';
  if (input.status === 'failed') {
    return typeof input.errorMessage === 'string' && input.errorMessage
      ? '任务未完成，请查看错误原因后再重试。'
      : '任务未完成，请联系管理员查看后台处理状态。';
  }
  return null;
}

export function safeIdentifierLabel(value: unknown): string {
  if (typeof value !== 'string' || !value) return '未知对象';
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(value)) return '系统内部对象';
  return value;
}

const missingProfileFieldMessages: Record<string, string> = {
  age: '未识别到年龄信息',
  年龄: '未识别到年龄信息',
  候选人年龄: '未识别到年龄信息',
  gender: '未识别到性别信息',
  sex: '未识别到性别信息',
  性别: '未识别到性别信息',
  graduationyear: '未识别到毕业年份信息',
  graduateyear: '未识别到毕业年份信息',
  毕业年份: '未识别到毕业年份信息',
  毕业年度: '未识别到毕业年份信息',
  应届年份: '未识别到毕业年份信息',
  educationlevel: '未识别到学历信息',
  学历: '未识别到学历信息',
  最高学历: '未识别到学历信息',
  学历层次: '未识别到学历信息',
  学位: '未识别到学历信息',
  yearsofexperience: '未识别到工作经验信息',
  experienceyears: '未识别到工作经验信息',
  经验: '未识别到工作经验信息',
  工作经验: '未识别到工作经验信息',
  工作年限: '未识别到工作经验信息',
  从业年限: '未识别到工作经验信息',
  经验年限: '未识别到工作经验信息',
  skills: '未识别到技能信息',
  skill: '未识别到技能信息',
  技能: '未识别到技能信息',
  专业技能: '未识别到技能信息',
  核心技能: '未识别到技能信息',
  技能特长: '未识别到技能信息',
  技术栈: '未识别到技能信息',
  location: '未识别到所在地或期望地点信息',
  地点: '未识别到所在地或期望地点信息',
  城市: '未识别到所在地或期望地点信息',
  工作地点: '未识别到所在地或期望地点信息',
  期望地点: '未识别到所在地或期望地点信息',
  期望城市: '未识别到所在地或期望地点信息',
  status: '未识别到求职状态信息',
  状态: '未识别到求职状态信息',
  求职状态: '未识别到求职状态信息',
  在职状态: '未识别到求职状态信息',
  bossplatformtags: '未识别到 BOSS 院校标签',
  boss平台标签: '未识别到 BOSS 院校标签',
  平台标签: '未识别到 BOSS 院校标签',
  boss标签: '未识别到 BOSS 院校标签',
  院校标签: '未识别到 BOSS 院校标签',
  学校标签: '未识别到 BOSS 院校标签',
  标签: '未识别到 BOSS 院校标签',
};

function normalizedProfileField(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s:：=_\-/]/gu, '')
    .trim();
}

export function candidateRuleEvidenceLabel(input: {
  capabilityId?: unknown;
  canonicalLabel?: unknown;
  normalizedAlias?: unknown;
}): string {
  const capabilityId =
    typeof input.capabilityId === 'string'
      ? input.capabilityId.trim().toLocaleLowerCase()
      : '';
  const canonicalLabel =
    typeof input.canonicalLabel === 'string' ? input.canonicalLabel.trim() : '';

  if (capabilityId === 'enum.gender') return '性别（不参与自动筛选）';
  if (capabilityId === 'enum.bossplatformtags') return 'BOSS 院校标签';

  return canonicalLabel || '岗位条件';
}

export function candidateRuleEvidenceSourceText(input: {
  sourceText?: unknown;
}): string {
  const sourceText =
    typeof input.sourceText === 'string' ? input.sourceText.trim() : '';
  if (!sourceText) return '暂无可核对的原文证据';

  const missingField = sourceText.match(/^未找到字段\s*[：:]\s*(.+)$/u)?.[1];
  if (!missingField) return sourceText;

  return (
    missingProfileFieldMessages[normalizedProfileField(missingField)] ??
    '未识别到该筛选条件所需的信息'
  );
}

export function candidateRuleEvidenceRecognitionLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '未识别到可用信息';
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === 'not_applicable') return '不参与自动筛选';
  if (/^missing(?:_|$)/u.test(normalized)) return '未识别到可用信息';
  return value.trim();
}

const contactScopeLabels: Record<string, string> = {
  global: '全系统',
  department: '当前部门',
  position: '当前岗位',
  task: '当前任务',
};

export function contactBlockReasonLabel(value: unknown): string {
  if (typeof value !== 'string' || !value) return '有一项安全条件未通过';
  const normalized = value.trim().toLocaleLowerCase();
  if (
    normalized === 'global emergency stop' ||
    normalized === 'legacy_emergency_stop'
  )
    return '全局紧急停止已启用';
  const scopeMatch = normalized.match(
    /^(global|department|position|task) (control missing|disabled|emergency stop|approval missing)$/u,
  );
  if (scopeMatch) {
    const scope = contactScopeLabels[scopeMatch[1]!] ?? '当前范围';
    const reason =
      scopeMatch[2] === 'control missing'
        ? '尚未配置联系开关'
        : scopeMatch[2] === 'disabled'
          ? '联系开关已关闭'
          : scopeMatch[2] === 'emergency stop'
            ? '紧急停止已启用'
            : '仍使用旧审批配置，请由负责人重新开启联系开关';
    return `${scope}：${reason}`;
  }
  if (normalized.includes('account health is stale'))
    return 'BOSS 账号健康检查已过期，等待系统重新确认';
  if (normalized.includes('account health is not healthy'))
    return 'BOSS 账号健康状态未通过';
  if (normalized.includes('do-not-contact') || normalized === 'do_not_contact')
    return '候选人已设为禁止联系';
  if (normalized === 'current_candidate_state')
    return '这是历史任务中的候选人记录，请返回列表选择当前记录';
  if (normalized === 'contact_dispatch_disabled')
    return '联系发送处理程序未启动，当前只能预览消息';
  if (normalized === 'contact_dispatch_mode_mismatch')
    return '联系发送模式与任务类型不一致，系统已阻止处理';
  return '有一项服务端安全检查未通过，请联系管理员查看审计记录';
}
