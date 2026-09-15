import type { DepartmentRole } from '../workspace-navigation';

type GuideLink = { href: string; label: string };
export type GuideStep = {
  id: string;
  phase: string;
  title: string;
  summary: string;
  minutes: number;
  purpose: string;
  steps: { title: string; detail: string }[];
  outcome: string;
  example: { label: string; value: string }[];
  question: string;
  answer: string;
  target: GuideLink;
  related?: GuideLink[];
  quiz?: {
    question: string;
    options: string[];
    correct: number;
    explanation: string;
  };
};

const overview: GuideStep = {
  id: 'overview',
  phase: '认识工作空间',
  title: '先看懂一条招聘流程',
  summary: '知道每件事该去哪里做',
  minutes: 1,
  purpose:
    'Boss Forge 把 BOSS 上的候选人、岗位要求和团队审核连在一起。系统负责按规则整理简历证据，HR 负责判断是否合适、发起联系和推进招聘。',
  steps: [
    {
      title: '先找工作入口',
      detail:
        '左侧是主要模块，页面顶部的页签是同一模块下的不同工作。工作台汇总招聘进度；岗位、任务和候选人页面承接每天的筛选工作。',
    },
    {
      title: '记住“岗位 → 任务 → 候选人”',
      detail:
        '岗位保存招聘要求；任务是一次使用这些要求的筛选；候选人名单属于具体任务。查看名单前，先核对顶部选择的岗位和任务。',
    },
    {
      title: '把判断和跟进接起来',
      detail:
        '在候选人页面做人工审核，在联系页面处理打招呼或消息，在招聘流程里记录后续阶段、面试和反馈。',
    },
  ],
  outcome: '能说清楚：我要招谁、正在看哪次筛选、下一步到哪个页面处理。',
  example: [
    { label: '岗位', value: '运营专员' },
    { label: '任务', value: '今天的一次筛选' },
    { label: '候选人', value: '本次找到的简历' },
  ],
  question: '同一个人为什么会出现多次？',
  answer:
    '同一个人可能出现在不同岗位或不同筛选任务中。请结合岗位和任务查看本次证据与审核记录；不要只按姓名判断是否重复。',
  target: { href: '/', label: '去认识工作台' },
};

const preparation: GuideStep = {
  id: 'preparation',
  phase: '准备招聘',
  title: '确认账号与招聘准备',
  summary: '让第一次筛选顺利开始',
  minutes: 1,
  purpose:
    '开始前，先确认平台能使用 BOSS 账号，并且你能看到负责的岗位。登录 Boss Forge 和登录 BOSS 是两件事。',
  steps: [
    {
      title: '确认自己的身份',
      detail:
        '页面右上角显示姓名和角色。招聘专员处理岗位规则、筛选、审核与联系；招聘负责人和管理员还可以管理账号、发布规则和配置团队。',
    },
    {
      title: '查看 BOSS 登录状态',
      detail:
        '进入“系统设置 → BOSS 扫码登录”，按页面提示扫码，等待页面确认已登录。登录失效时，也回到这里处理。',
    },
    {
      title: '核对负责的岗位',
      detail:
        '在“岗位设置”查看岗位列表。如果缺少需要的岗位或协作范围，请在“团队与权限”核对岗位协作者。',
    },
  ],
  outcome: 'BOSS 账号已登录，自己能看到要招聘的岗位；需要谁协助也已明确。',
  example: [
    { label: '内部账号', value: '进入团队工作台' },
    { label: 'BOSS 账号', value: '读取招聘页面' },
    { label: '岗位协作', value: '看到负责的招聘工作' },
  ],
  question: '扫码完成后仍显示等待，怎么办？',
  answer:
    '先等页面更新状态，再按页面提示处理过期二维码或验证。确认“已登录”后再开始筛选；不要同时反复扫码或启动多次任务。',
  target: { href: '/boss-login', label: '去确认 BOSS 登录' },
  related: [{ href: '/team', label: '查看团队与权限' }],
};

const positions: GuideStep = {
  id: 'positions',
  phase: '准备招聘',
  title: '同步要招聘的 BOSS 岗位',
  summary: '从 BOSS 选择真实的招聘岗位',
  minutes: 1,
  purpose:
    '岗位是后续规则、筛选任务、候选人和消息模板的共同归属。先把岗位认清，后面的操作就不容易串到另一条招聘线。',
  steps: [
    {
      title: '先检查有没有现成岗位',
      detail:
        '进入“岗位设置”，从岗位列表选择已有岗位。管理员已经同步并分配时，直接选择对应岗位即可。',
    },
    {
      title: '管理员点击“同步 BOSS 岗位”',
      detail:
        '先确认 BOSS 已登录，再同步 BOSS 上现有的招聘岗位。平台会显示岗位状态；新开通的岗位也从这里同步，不需要手填岗位或关键词。',
    },
    {
      title: '继续填写岗位规则',
      detail:
        '选择一个岗位，点击“添加岗位规则”或“编辑岗位规则”。每个岗位可以有不同的筛选条件。管理员可在“团队与权限”把岗位分配给相应 HR。',
    },
  ],
  outcome: '确认同步的 BOSS 岗位，理解每个岗位都有独立规则和对应的推荐牛人列表。',
  example: [
    { label: 'BOSS 岗位', value: '海外运营专员' },
    { label: '筛选来源', value: '该岗位对应的推荐牛人' },
    { label: '负责人', value: '负责本次招聘的 HR' },
  ],
  question: '切换岗位后，推荐牛人什么时候切换？',
  answer:
    '平台切换岗位时会切换对应的规则和任务视图。开始筛选后，后台会先在 BOSS 推荐牛人右上角切换到绑定岗位，再读取候选人。同一 BOSS 账号的任务依次执行。',
  target: { href: '/positions', label: '去查看岗位设置' },
};

const rules: GuideStep = {
  id: 'rules',
  phase: '准备招聘',
  title: '把要求变成生效规则',
  summary: '学会条件组合、缺失信息和发布',
  minutes: 2,
  purpose:
    '规则决定系统按哪些要求寻找证据。先整理岗位真正需要的能力，再选择条件；简历没有写清楚的地方，也要约定如何处理。',
  steps: [
    {
      title: '按岗位要求选择条件',
      detail:
        '在岗位规则中设置学历、经验、技能、地点、证书或简历关键词等需要的条件。“全部条件都满足”要求全部成立，“任一条件满足”满足其中一个即可；多项关键词也要核对组合方式。',
    },
    {
      title: '明确缺失信息怎么处理',
      detail:
        '简历未提及不等于候选人不会。核对“信息缺失”的处理方式；需要补充判断时交给人工审核。智能识别是可选项，目前试运行结果用于参考，不直接改变正式规则结论。',
    },
    {
      title: '保存后确认“当前生效”版本',
      detail:
        '负责人和管理员可以保存并立即生效；招聘专员提交后，需要负责人发布。回到岗位页面，看到“当前生效 · v…”才可用于新任务。',
    },
  ],
  outcome: '岗位有“当前生效”的规则版本；理解待发布规则还不会用于新筛选。',
  example: [
    { label: '岗位需求', value: '有活动运营经验' },
    { label: '规则设置', value: '经验条件 + 相关技能' },
    { label: '原文不充分', value: '留给 HR 核实' },
  ],
  question: '修改规则后，旧任务会重新判定吗？',
  answer:
    '不会。每个任务保留创建时使用的规则版本。新版本发布后用于新任务；核对结果时，要看任务自己的规则版本。',
  target: { href: '/positions', label: '去配置岗位规则' },
  quiz: {
    question: '规则已经保存，状态是“等待负责人发布”，可以用于新任务吗？',
    options: ['可以，保存就会生效', '还不可以，要确认规则已发布并生效'],
    correct: 1,
    explanation: '保存和生效是两个状态。以岗位页面的“当前生效”版本为准。',
  },
};

const tasks: GuideStep = {
  id: 'tasks',
  phase: '筛选与判断',
  title: '启动一次筛选，读懂进度',
  summary: '立即执行或安排定时计划',
  minutes: 2,
  purpose:
    '任务会先采集候选人，再按节奏读取简历和执行规则。创建成功后可去处理其他工作，稍后回来查看进度。',
  steps: [
    {
      title: '核对岗位和生效规则',
      detail:
        '进入“任务与计划”，选择岗位，确认按钮下方显示的规则版本。首次使用先运行一次，便于检查岗位和规则是否合适。',
    },
    {
      title: '按需要选择立即或定时',
      detail:
        '“开始筛选”会创建真实任务；“定时筛选”支持一次、每日、工作日或每周。核对执行时间，再保存计划。',
    },
    {
      title: '从任务进入本次名单',
      detail:
        '在任务列表中选择本次任务，再查看候选人。排队中、处理中表示尚未结束；已处理进度不等于审核通过人数。定时计划可停用，任务可按页面状态取消或恢复。',
    },
  ],
  outcome:
    '能找到本次任务、使用的规则版本和候选人名单，并区分等待处理与处理失败。',
  example: [
    { label: '采集候选人', value: '建立本次名单' },
    { label: '读取并精筛', value: '逐份整理简历证据' },
    { label: '等待审核', value: '交给 HR 判断' },
  ],
  question: '“开始筛选”不能点击，或者进度暂时没动？',
  answer:
    '先确认已选岗位且规则已生效。任务已创建时，查看状态和提示，等待正在排队的简历；登录异常请处理 BOSS 状态，不要靠连续新建任务催进度。',
  target: { href: '/tasks', label: '去查看任务与计划' },
};

const review: GuideStep = {
  id: 'review',
  phase: '筛选与判断',
  title: '用简历证据完成人工审核',
  summary: '从机器结论走到 HR 判断',
  minutes: 2,
  purpose:
    '机器结论回答“规则有没有证据支持”，人工审核回答“这个人是否值得继续沟通”。两种结果会分别保留。',
  steps: [
    {
      title: '选对任务，再找到候选人',
      detail:
        '进入“候选人”，核对顶部岗位与任务。用“待审核”“已通过”“未通过 / 已淘汰”“精筛异常”等分类缩小范围，也可以搜索姓名、经历或其他列表信息。',
    },
    {
      title: '打开详情，先看原文证据',
      detail:
        '查看完整简历的筛选结果和每条规则的依据。“符合 / 不符合”表示规则结论；“需人工判断 / 信息不足”需要进一步核实。列表卡片摘要不能替代完整简历证据。',
    },
    {
      title: '记录决定，再处理下一位',
      detail:
        '通过或淘汰后记录会保存；淘汰需要填写原因，人工改判为通过需要说明原因并选择规则纠错类型。可使用上一位、下一位，以及“审核后自动下一位”连续处理。',
    },
  ],
  outcome: '能用原文解释审核决定；通过的候选人可在联系页面继续跟进。',
  example: [
    { label: '规则结论', value: '信息不足' },
    { label: '简历证据', value: '只写了项目名' },
    { label: 'HR 判断', value: '核实职责后再决定' },
  ],
  question: '提示“候选人已不在当前 BOSS 列表”怎么办？',
  answer:
    '在“精筛异常”中打开候选人；任务仍可执行时，使用“重新精筛简历”，系统会尝试恢复原岗位来源并重新定位。已取消的任务先到任务页面恢复。若候选人确实下线或来源失效，可重新采集候选人；无法保证每份历史简历仍可打开。',
  target: { href: '/candidates', label: '去查看候选人' },
  quiz: {
    question: '“信息不足”是否就表示候选人不符合要求？',
    options: ['是，可以直接当作不符合', '不是，需要查看原文并进一步核实'],
    correct: 1,
    explanation: '缺少证据与明确不符合不同。结合原文和岗位要求作出人工判断。',
  },
};

const contact: GuideStep = {
  id: 'contact',
  phase: '联系与推进',
  title: '预览内容，再发起联系',
  summary: '分清打招呼、消息和执行结果',
  minutes: 2,
  purpose:
    '人工审核通过后，才进入联系环节。先核对对象和内容，再根据需要选择打招呼或发送消息。',
  steps: [
    {
      title: '从“已通过人工审核”选择对象',
      detail:
        '进入“联系”，确认岗位、任务和候选人。这里没有名单时，先回候选人页面检查本次人工审核结果。',
    },
    {
      title: '核对模板与最终预览',
      detail:
        '查看岗位消息模板。模板中的候选人姓名、岗位名称和 HR 姓名会被替换，务必在预览里核对替换后的完整内容；模板需要调整时由负责人维护。',
    },
    {
      title: '分别确认动作，查看执行记录',
      detail:
        '“打招呼”和“发消息”分别预览、分别确认。确认前看清当前执行模式；预览或模拟结果不代表已经真实送达。执行后查看对应联系记录及结果。',
    },
  ],
  outcome: '知道将联系谁、使用哪个动作、发送什么内容，以及到哪里核对执行结果。',
  example: [
    { label: '人工审核', value: '候选人已通过' },
    { label: '内容预览', value: '核对姓名、岗位、正文' },
    { label: '确认动作', value: '打招呼或发消息' },
  ],
  question: '结果显示不确定，能马上再发一次吗？',
  answer:
    '先查看联系记录，并到 BOSS 核实该动作是否已执行。不确定不等于失败；需要解除锁定时交给负责人依据实际结果处理，避免重复联系。',
  target: { href: '/contacts', label: '去查看联系与模板' },
  quiz: {
    question: '确认“打招呼”后，系统会连带发送另一条消息吗？',
    options: ['会，一次确认就完成两件事', '不会，两种动作分别预览和确认'],
    correct: 1,
    explanation:
      '每次确认只对应预览中的那一个动作；执行结果也应按动作分别核对。',
  },
};

const pipeline: GuideStep = {
  id: 'pipeline',
  phase: '联系与推进',
  title: '把候选人推进到下一阶段',
  summary: '记录跟进、面试与团队反馈',
  minutes: 2,
  purpose:
    '招聘流程承接筛选后的协作，让团队知道候选人走到了哪里、由谁跟进、下一步做什么。',
  steps: [
    {
      title: '找到候选人的岗位申请',
      detail:
        '进入左侧“招聘流程”，按阶段筛选并选择候选人。结合岗位和历史记录确认是这一次申请。',
    },
    {
      title: '更新阶段与跟进记录',
      detail:
        '根据实际进展更新招聘阶段；用备注记录沟通结论，用待办记录负责人和后续事项。候选人详情也支持维护简历附件的文件信息与内网存储路径。',
    },
    {
      title: '安排面试并汇总反馈',
      detail:
        '填写面试时间、地点或线上链接、面试官。面试后记录建议、评分、优势和顾虑，团队可以结合时间线继续推进。',
    },
  ],
  outcome: '候选人的阶段、下一步事项和面试反馈清晰可查，接手的人能继续工作。',
  example: [
    { label: '当前阶段', value: '进入面试' },
    { label: '下一步', value: '确认面试时间' },
    { label: '面试反馈', value: '建议 + 依据 + 顾虑' },
  ],
  question: '录入面试安排，会自动通知候选人吗？',
  answer:
    '这里用于记录团队的面试安排。保存后仍需按团队流程确认候选人与面试官已收到通知；不要把记录成功当作消息已经送达。',
  target: { href: '/pipeline', label: '去查看招聘流程' },
};

const operations: GuideStep = {
  id: 'operations',
  phase: '形成日常习惯',
  title: '每天从待办和异常开始',
  summary: '回复、人才库、告警与数据复盘',
  minutes: 1,
  purpose:
    '熟悉主流程后，用运营和数据页面发现需要跟进的人，以及需要调整的筛选环节。',
  steps: [
    {
      title: '上班先看招聘进度',
      detail:
        '在工作台查看任务与待审核情况，处理需要你判断的候选人；到招聘流程检查跟进事项和面试安排。',
    },
    {
      title: '查看回复、人才库和账号状态',
      detail:
        '“招聘运营”集中展示已记录的 BOSS 回复、人才库标签与重复提醒、账号状态及运行告警。结合实际 BOSS 会话核对回复，不把空列表当作无人回复。',
    },
    {
      title: '用数据检查漏斗',
      detail:
        '打开“数据分析”，查看候选人在筛选、审核与后续环节的分布。结合具体简历和审核原因调整下一版岗位规则，避免只追求通过率。',
    },
  ],
  outcome: '形成“看进度 → 审核 → 跟进回复与面试 → 看异常与复盘”的日常顺序。',
  example: [
    { label: '开始工作', value: '看进度和待审核' },
    { label: '推进招聘', value: '跟进联系和面试' },
    { label: '复盘', value: '看数据和审核原因' },
  ],
  question: '运营页面的高级功能什么时候用？',
  answer:
    '高级区包含联调回复、人工账号观察、导出与数据维护等功能。日常招聘先使用回复、人才库和告警；涉及联调或数据维护时，按团队安排与负责人协作。',
  target: { href: '/operations', label: '去查看招聘运营' },
  related: [{ href: '/analytics', label: '查看数据分析' }],
};

const team: GuideStep = {
  id: 'team',
  phase: '负责人补充',
  title: '为团队准备好工作环境',
  summary: '成员、岗位协作和运行设置',
  minutes: 2,
  purpose:
    '作为负责人，你除了日常招聘，还需要让同事看到正确的岗位、使用已发布的规则，并在遇到账号或执行问题时知道如何处理。',
  steps: [
    {
      title: '维护成员与岗位协作',
      detail:
        '在“团队与权限”管理成员及角色，配置岗位协作者；招聘阶段可按团队流程维护。账号信息和岗位分工确认后，再请同事开始工作。',
    },
    {
      title: '准备日常执行所需配置',
      detail:
        '发布岗位规则、维护消息模板、确认 BOSS 登录状态。“简历查看策略”控制查看节奏；“联系安全设置”显示联系模式与额度，修改时结合团队实际执行安排。',
    },
    {
      title: '遇到问题时追溯具体记录',
      detail:
        '从任务、候选人或联系记录定位问题；“审计与安全”可以查看谁在何时做了什么操作。运营告警与账号状态帮助判断问题发生在哪个环节。',
    },
  ],
  outcome: '团队成员、岗位分工、规则版本和 BOSS 账号状态都已经核对。',
  example: [
    { label: '人员', value: '角色与岗位分工' },
    { label: '招聘配置', value: '规则与消息模板' },
    { label: '日常运行', value: '账号、节奏与记录' },
  ],
  question: '招聘专员说看不到某个入口，应该从哪里查？',
  answer:
    '先确认成员角色与岗位协作配置。负责人管理入口只向对应角色显示；也可以让同事打开新手导览，查看当前角色的操作路径。',
  target: { href: '/team', label: '去查看团队与权限' },
  related: [
    { href: '/automation', label: '查看联系设置' },
    { href: '/audit', label: '查看操作记录' },
  ],
};

export function guideStepsForRole(role: DepartmentRole): GuideStep[] {
  if (role === 'interviewer') {
    return [
      overview,
      {
        ...review,
        title: '阅读候选人与简历证据',
        steps: [
          review.steps[0]!,
          review.steps[1]!,
          {
            title: '将疑问带到面试中核实',
            detail:
              '面试官可以查看分配范围内的候选人及证据；筛选审核与发起联系由 HR 处理。把待核实的问题整理到面试反馈中。',
          },
        ],
        outcome:
          '能读懂候选人的证据与既有审核结果，并整理面试中需要核实的问题。',
        question: '发现简历缺失或筛选异常怎么办？',
        answer:
          '记录需要核实的问题并请负责该岗位的 HR 处理。精筛重试和人工审核由 HR 执行。',
      },
      {
        ...pipeline,
        steps: [
          pipeline.steps[0]!,
          {
            title: '核对面试安排',
            detail:
              '查看面试时间、地点或线上链接和面试官安排；需要调整时与岗位 HR 协调。',
          },
          {
            title: '记录面试反馈',
            detail:
              '面试后填写建议、评分、优势和顾虑，保留支持判断的事实，供岗位 HR 与团队继续推进。',
          },
        ],
      },
    ];
  }
  const isManager = role === 'admin' || role === 'recruiting_lead';
  const ready = isManager
    ? preparation
    : {
        ...preparation,
        steps: [
          preparation.steps[0]!,
          {
            title: '请负责人确认 BOSS 已登录',
            detail:
              '招聘专员无需自行管理扫码登录。可在“招聘运营”查看账号状态；若状态异常，请负责人在“BOSS 扫码登录”中处理。',
          },
          {
            title: '确认自己能看到负责的岗位',
            detail:
              '进入“岗位设置”检查岗位列表。没有预期岗位时，请负责人核对岗位协作范围，再继续筛选。',
          },
        ],
        target: { href: '/operations', label: '去查看账号状态' },
        related: [{ href: '/positions', label: '查看可用岗位' }],
      };
  return [
    overview,
    ready,
    positions,
    rules,
    tasks,
    review,
    contact,
    pipeline,
    operations,
    ...(isManager ? [team] : []),
  ];
}
