import type { DepartmentRole } from '../workspace-navigation';

export type SpotlightStep = {
  id: string;
  page: string | null;
  target: string;
  title: string;
  body: string;
  tip: string;
  chapter: string;
};

export function spotlightSteps(role: DepartmentRole): SpotlightStep[] {
  const manager = role === 'admin' || role === 'recruiting_lead';
  const hr = role !== 'interviewer';
  return [
    {
      id: 'welcome',
      page: null,
      target: 'nav-home',
      title: '从这里开始一天的招聘',
      body: '工作台汇总任务进度和待审核候选人。接下来花约 3 分钟，跟着高亮区域走一遍：准备岗位 → 筛选 → 审核 → 联系 → 面试跟进。',
      tip: '点击“下一步”只切换讲解，不会启动筛选或发送消息。',
      chapter: 'overview',
    },
    ...(hr
      ? [
          {
            id: 'account',
            page: manager ? '/boss-login' : '/operations',
            target: manager ? 'page-heading' : 'account-health',
            title: '先确认 BOSS 账号可用',
            body: manager
              ? '平台登录和 BOSS 登录是两件事。在这里按提示扫码，等状态变为已登录，再开始筛选。后续登录失效也回到这里处理。'
              : '在招聘运营查看 BOSS 账号状态。若未登录或状态异常，请招聘负责人完成扫码；招聘专员可以继续准备岗位要求。',
            tip: '无需为了看完导览而扫码，先认识这个入口即可。',
            chapter: 'preparation',
          },
          {
            id: 'position',
            page: '/positions',
            target: 'create-position',
            title: '第一步：明确要招谁',
            body: manager ? '点击“同步 BOSS 岗位”，读取这个 BOSS 账号现有的招聘岗位。选择岗位后，为它配置独立的筛选规则；旧岗位的规则和历史会保留。' : '选择管理员分配给你的 BOSS 岗位。每个岗位都有自己的规则和候选人；缺少岗位时，请负责人在“团队与权限”添加你为协作者。',
            tip: '开始筛选时，后台会在 BOSS 推荐牛人右上角切换到所选岗位。',
            chapter: 'positions',
          },
          {
            id: 'rules',
            page: '/positions',
            target: 'position-rules',
            title: '把招聘要求变成规则',
            body: '先设置 BOSS 官方筛选，学历、经验等由 BOSS 处理；再补充证书、具体技能等需要读简历核验的要求。第二步只设置额外条件，保存后确认“当前生效”的版本。',
            tip: '招聘专员提交后由负责人发布。新规则用于新任务，旧任务保留原版本。',
            chapter: 'rules',
          },
          {
            id: 'task',
            page: '/tasks',
            target: 'start-screening',
            title: '第二步：开始一次筛选',
            body: '先选岗位并核对生效规则，再点击“开始筛选”。任务会采集候选人、逐份读取简历，最后交给 HR 审核；创建后可以离开页面等进度更新。',
            tip: '排队中、处理中表示还在进行，不需要反复新建任务。',
            chapter: 'tasks',
          },
          {
            id: 'schedule',
            page: '/tasks',
            target: 'schedule-screening',
            title: '日常重复工作，交给计划',
            body: '“定时筛选”支持一次、每日、工作日和每周。核对执行时间再保存；下方定时计划中可以查看或停用，任务列表保留每次执行记录。',
            tip: '第一次先做一次筛选，确认岗位和规则合适后再设定计划。',
            chapter: 'tasks',
          },
        ]
      : []),
    {
      id: 'scope',
      page: '/candidates',
      target: 'page-actions',
      title: '先确认你正在看哪次名单',
      body: '候选人属于具体岗位和筛选任务。用这里的岗位、任务选择器定位名单，再查看待审核、已通过或精筛异常。同一个人可能出现在不同任务中。',
      tip: '核对岗位与任务，避免把不同批次的结果混在一起。',
      chapter: 'review',
    },
    {
      id: 'review',
      page: '/candidates',
      target: 'candidate-review',
      title: hr ? '第三步：看证据，再做决定' : '查看候选人的简历证据',
      body: hr
        ? '打开候选人详情，核对规则结论和原文。信息不足不等于不符合。淘汰要写原因；人工改判通过还要选纠错类型。可以连续审核下一位。'
        : '打开候选人详情，阅读规则结论和原文证据。将需要核实的经历与能力记录下来，面试后反馈给岗位 HR。',
      tip: '名单为空时先完成一次筛选；导览仍可继续。',
      chapter: 'review',
    },
    ...(hr
      ? [
          {
            id: 'recovery',
            page: '/candidates',
            target: 'candidate-status',
            title: '遇到精筛异常，从这里处理',
            body: '“候选人已不在当前 BOSS 列表”时，在精筛异常中打开详情，尝试“重新精筛简历”。系统会恢复来源并重新定位；已取消任务先回任务页恢复。',
            tip: '候选人确实下线时，可重新采集；无法保证历史简历仍可打开。',
            chapter: 'review',
          },
          {
            id: 'contact',
            page: '/contacts',
            target: 'contact-approved',
            title: '第四步：预览后再联系',
            body: '人工审核通过的候选人会出现在这里。先核对对象、模板和最终内容；打招呼与发消息分别预览、分别确认，执行后查看各自的联系记录。',
            tip: '留意当前执行模式；预览或模拟成功不代表已真实发送。',
            chapter: 'contact',
          },
        ]
      : []),
    {
      id: 'pipeline',
      page: '/pipeline',
      target: 'page-heading',
      title: '让后续跟进有记录',
      body: hr
        ? '在招聘流程中更新阶段、记录备注和待办，安排面试并收集反馈。团队可以从候选人时间线了解历史，继续跟进下一步。'
        : '在招聘流程中核对面试安排，面试后填写建议、评分、优势和顾虑，让 HR 能结合事实继续推进。',
      tip: '保存面试安排是团队记录，仍需按团队流程确认通知已送达。',
      chapter: 'pipeline',
    },
    ...(hr
      ? [
          {
            id: 'operations',
            page: '/operations',
            target: 'module-tabs',
            title: '用运营和数据安排日常工作',
            body: '运营工作台集中查看已记录的回复、人才库标签、账号状态与告警。切到“数据分析”查看招聘漏斗，再结合具体审核原因改进岗位规则。',
            tip: '每天先看待审核，再跟进回复和面试，最后检查异常。',
            chapter: 'operations',
          },
        ]
      : []),
    ...(manager
      ? [
          {
            id: 'team',
            page: '/team',
            target: 'module-tabs',
            title: '负责人在这里准备团队环境',
            body: '团队与权限管理成员和岗位协作；BOSS 扫码登录维护账号状态；审计与安全帮助追溯操作。岗位规则发布、消息模板也由负责人维护。',
            tip: '同事看不到岗位时，先核对角色和岗位协作范围。',
            chapter: 'team',
          },
        ]
      : []),
    {
      id: 'finish',
      page: null,
      target: 'guide-entry',
      title: '准备好了，开始你的招聘工作',
      body: '这就是完整的招聘路径。需要时随时点击“新手导览”再次走一遍；更详细的步骤、示例和常见问题，可以在详细手册里查看。',
      tip: '关闭后即可操作当前页面，导览不会改动任何招聘记录。',
      chapter: 'overview',
    },
  ];
}

export type SpotlightProgress = {
  stepId: string;
  active: boolean;
  finished: boolean;
};
export function readSpotlightProgress(
  raw: string | null,
  role: DepartmentRole,
): SpotlightProgress {
  const initial = { stepId: 'welcome', active: false, finished: false };
  try {
    const data: unknown = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== 'object') return initial;
    const value = data as Partial<SpotlightProgress>;
    if (!spotlightSteps(role).some((step) => step.id === value.stepId))
      return initial;
    return {
      stepId: value.stepId!,
      active: value.active === true,
      finished: value.finished === true,
    };
  } catch {
    return initial;
  }
}

export function spotlightFromUrl(url: URL, role: DepartmentRole) {
  return (
    spotlightSteps(role).find(
      (step) =>
        step.id === url.searchParams.get('tour') &&
        (!step.page || step.page === url.pathname),
    ) ?? null
  );
}

export function spotlightHref(step: SpotlightStep, current: string) {
  const url = new URL(current, 'https://boss-forge.internal');
  if (step.page && step.page !== url.pathname) {
    url.pathname = step.page;
    url.search = '';
    url.hash = '';
  }
  url.searchParams.delete('guide');
  url.searchParams.set('tour', step.id);
  return `${url.pathname}${url.search}${url.hash}`;
}

export type SpotlightRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export function spotlightPlacement(
  target: SpotlightRect | null,
  viewport: { width: number; height: number },
  popupHeight: number,
) {
  const margin = 12,
    gap = 16;
  const width = Math.max(0, Math.min(368, viewport.width - margin * 2));
  const height = Math.min(
    popupHeight,
    Math.max(0, viewport.height - margin * 2),
  );
  const clampX = (x: number) =>
    Math.max(margin, Math.min(x, viewport.width - width - margin));
  const clampY = (y: number) =>
    Math.max(margin, Math.min(y, viewport.height - height - margin));
  if (!target)
    return {
      left: clampX((viewport.width - width) / 2),
      top: clampY((viewport.height - height) / 2),
      width,
      maxHeight: viewport.height - margin * 2,
      side: 'center' as const,
    };
  if (target.left + target.width + gap + width <= viewport.width - margin)
    return {
      left: target.left + target.width + gap,
      top: clampY(target.top),
      width,
      maxHeight: viewport.height - margin * 2,
      side: 'right' as const,
    };
  if (target.left - gap - width >= margin)
    return {
      left: target.left - gap - width,
      top: clampY(target.top),
      width,
      maxHeight: viewport.height - margin * 2,
      side: 'left' as const,
    };
  if (target.top + target.height + gap + height <= viewport.height - margin)
    return {
      left: clampX(target.left),
      top: target.top + target.height + gap,
      width,
      maxHeight: viewport.height - margin * 2,
      side: 'bottom' as const,
    };
  if (target.top - gap - height >= margin)
    return {
      left: clampX(target.left),
      top: target.top - gap - height,
      width,
      maxHeight: viewport.height - margin * 2,
      side: 'top' as const,
    };
  return {
    left: clampX(target.left),
    top:
      target.top < viewport.height / 2
        ? clampY(viewport.height - height - margin)
        : margin,
    width,
    maxHeight: viewport.height - margin * 2,
    side: 'center' as const,
  };
}
