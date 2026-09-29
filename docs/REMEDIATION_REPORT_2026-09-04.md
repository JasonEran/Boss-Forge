# Boss-Forge 修复与复验报告

> **历史记录 · 2026-09-04**：下文保留当时的版本、验证和限制，不代表当前生产状态。现行说明见[文档索引](README.md)、[当前状态](CURRENT_STATUS.md)与[运维手册](OPERATIONS_RUNBOOK.md)。

> 日期：2026-09-04（Asia/Shanghai）
>
> 范围：`/Users/jasoneran/Boss-Forge` 当前工作树，以及生产受控发布/边界复验
>
> 安全边界：真实联系执行数为 0；未退出 BOSS、未清理登录数据、未刷新二维码、未绕过风控或额度
>
> 最终生产 release：`audit-events-20260904-1614cst`，镜像 `sha256:5d60b806884766926c27db401f2ecf92e224c0a8eaa8a14a1abbd3434f89354a`；最终部署与保留边界见第十二节
>
> 历史说明：第一至十一节保留各轮修复证据，其中“真实联系编译关闭”“worker 停止”等描述已经被第十二节取代。

## 1. 最终结论

**基本够用。**

修复后的交付版本已经能够完成小团队 HR 的人工主闭环：创建/编辑岗位和模板、用 HR 可理解的表单发布规则、创建任务、查看逐任务候选人、检查规则证据、人工审核，以及生成最终联系消息预览并取消。任务等待、取消、重试和恢复状态也有明确动作。核心数据、权限、幂等、历史任务归属和 Dashboard 口径已通过隔离数据库或自动化回归；最终 release 的 API/Web/HTTPS/Safari 已完成生产验收，原 BOSS 登录卷保持不变，worker 则按安全边界保持停止。

最新三条边界的验收口径与证据见 [三条安全边界验收](BOUNDARY_ACCEPTANCE_2026-09-04.md)。最终 release 的 API/Web、公开 HTTPS 和 Safari 页面加载已经通过；生产受控 canary 仅查看 1 次，目标失效后以 `target_missing` 停止且未重试。最终部署没有启动 worker，因此没有新的在线 BOSS 会话探测或完整简历/OCR 成功 canary；本轮没有发送任何消息。

这个结论有三项明确限制：

1. 真实联系传输在编译期固定不可用，环境变量、页面开关和审批都不能解锁。本轮浏览器验收停在最终消息预览后取消；如团队需要在 Boss-Forge 内直接发送，仍需单独交付并验收“只发送人工确认正文、没有额外打招呼副作用”的传输实现。
2. 生产登录持久化和 Worker 心跳已验证；受控 canary 严格停在 1 次查看。该样本因候选人卡片失效返回 `target_missing`，没有自动重试，因此证明了单次节奏与失败停止，但没有证明简历正文加载和 OCR 的成功路径。风控、简历不完整和 OCR 失败等其他真实样本仍需在平台安全工作时段自然出现后复验。
3. 生产语义连接保持 off，凭据为空。诊断中暴露过的提供方凭据必须先轮换；如果恢复，也只能从 shadow 开始，不影响招聘结论。

因此，目前适合进入**真实联系额度为 0 的内网试运行**；不适合把“系统内真实发送”或“无人值守真实 BOSS 故障恢复”算作已验收能力。

## 2. 当前真实业务流程

本地浏览器与远端运行联合验证的流程是：

```text
登录内网控制台
  -> 创建或编辑岗位、负责人和消息模板
  -> 以自然语言业务字段设置规则并发布不可变版本
  -> 创建立即任务或计划，冻结岗位与规则版本
  -> Worker 在一致的登录/运行状态下领取任务
  -> BOSS 卡片读取、可选简历预览/OCR、确定性规则判断
  -> 语义结果仅以 shadow 影子方式记录，不改变通过/淘汰
  -> 每个任务保存独立候选人状态、快照、证据和审核结果
  -> HR 查看原因并人工通过、拒绝或有理由地覆盖机器判断
  -> 服务端使用当前模板重新生成最终消息预览
  -> 本轮验收取消并退出预览，不创建联系数据、不发送消息
```

任务异常时，系统按真实原因区分等待工作时段、等待 Worker、运行不一致、卡片失效、简历不完整、OCR 失败和重试耗尽。取消与重试要求幂等键及状态版本；没有可恢复工作时拒绝“看起来成功”的重试。

联系能力分为三层：

- 消息模板与最终预览：本地浏览器已验证。
- 模拟联系状态机：仅用于显式隔离、允许 mock 联系数据的测试；默认数据 E2E 不创建联系记录。
- 真实联系：本版本不可用，`REAL_CONTACT_TRANSPORT_AVAILABLE=false` 是不可被环境变量绕过的能力总闸。

## 3. 功能矩阵

| 功能 | 修复后状态 | 证据与边界 |
|---|---|---|
| 登录、角色和岗位权限 | 可用（本地） | 未认证返回 401；已认证但无权返回 403；部门与岗位范围在服务端校验，写操作先鉴权后入库。 |
| 岗位新增、编辑 | 可用（本地） | 浏览器完成岗位创建；编辑保留业务 ID、版本和引用。 |
| 岗位消息模板 | 可用（本地） | 浏览器保存并显示模板 v1；变量仍受控，保存模板不会创建联系意图。 |
| HR 规则编辑 | 可用（本地） | 浏览器发布“CET-6 或 TEM-8、22–35 岁、本科、毕业年份不晚于 2026”；创建与发布由服务端事务完成。 |
| 应届、年龄、毕业年份、性别、学历 | 可用（代码/测试） | 支持直接的应届状态、年龄与毕业年份；识别 `2026届`、合理展开两位数年份；不猜测缺失性别。 |
| CET-6/TEM-8 任一满足 | 可用（本地） | 规则表单明确展示 OR；确定性解析覆盖别名、否定与上下文。 |
| 985/211/双一流 | 可用但保守 | 只采用 BOSS 卡片显式标签；缺失或冲突进入人工处理，不按学校名或 LLM 推断。 |
| 同义词生成、预览、应用/取消 | 部分可用（控制面已实现，生产 off） | 生产模型连接当前不可用；先轮换提供方凭据并配置经批准的内网模型后才能恢复。生成结果仍必须由 HR 预览后才进入新规则版本。 |
| 语义影子结果 | 部分可用（控制面已实现，生产 off） | 凭据轮换后只能恢复 shadow；UI 会将原因翻译为 HR 文案并保留技术详情，结果不影响通过/淘汰。 |
| 语义 active 决策 | 不可用（有意关闭） | 旧别名 substring 评估不能代表真实 criterion/rubric，编译期常量和迁移 024 均禁止 active。 |
| 立即任务、计划 | 可用（本地） | 幂等创建并冻结规则版本；页面说明工作时段外的实际等待行为。 |
| 任务等待、取消、重试 | 可用（本地） | 浏览器完成等待、取消和重试；API 使用幂等键、乐观版本和合法状态转换。 |
| 从 BOSS 获取候选人 | 部分可用 | 读取适配器、稳定 locator 和恢复逻辑已修；本轮未在远端真实 BOSS 会话重新跑采集。 |
| 新人优先与重复候选人 | 部分可用 | 稳定 BOSS geek locator 去重，任务分别统计新/重复并优先精筛新人；重复出现不再挪走历史任务记录。是否能从 BOSS 翻页获得更多新人仍需远端复验。 |
| 按安全节奏查看简历 | 部分可用 | `/health` 当前额度为每日 120、每小时 20；单次 canary 已验证计数和 `target_missing` 无重试。最终部署为保护 17 份队列未启动 worker，完整简历读取和连续查看仍未验收。 |
| 简历加载/OCR 恢复 | 部分可用 | 卡片失效、空截图、OCR 失败具有限次恢复和 HR 下一步提示；未对远端失败样本完成修复后复跑。 |
| 规则证据与解释 | 可用（本地） | 候选人卡片显示 HR 文案；原因码、OCR 原文与版本进入折叠技术详情。 |
| 候选人按任务分组 | 可用（隔离数据） | migration 023 将状态改为逐任务事实，历史与新任务候选人不再互相迁移。 |
| 人工审核与改判 | 可用（本地） | 模拟候选人完成审核；人工覆盖要求备注和纠错类型，不改写机器原始证据。 |
| 最终消息预览与取消 | 可用（本地） | 浏览器使用模板 v1 生成最终预览后取消；未调用联系创建或发送。 |
| 模拟联系 | 仅隔离测试可用 | 只有显式开启隔离 contact fixture 时验证状态机；日常 E2E、浏览器复验均保持联系表为 0。 |
| 真实联系 | 不可用（安全门） | 编译期总闸为 false；API、Repository、Worker、审批和 UI 多层失败关闭。 |
| BOSS 登录持久化 | 可用 | 远端沿用原 browser/boss-cli external volume，受控重启后仍为 `authenticated`；CDP 只读确认 BOSS 推荐页，本次启动新心跳为 fresh。 |
| 风控与运行一致性 | 部分可用 | 登录/验证/风险页面会停止 Worker；release、简历策略、心跳不一致会失败关闭。最终部署的 BOSS 状态页如实显示 worker 未启动和一致性阻断；真实风控/其他失败样本尚未主动触发。 |
| Dashboard 与分析 | 可用（隔离数据） | 指标按可访问岗位过滤；当前岗位/任务不串联；今日已联系只计算真实 sent，任务快照与唯一候选人口径分开说明。 |
| 备份和受控部署 | 部分可用 | 受控部署、每日备份与 `pg_restore --list` 校验已通过；完整灾难恢复仍待维护窗口实机恢复演练。 |
| 375px 基本可用性 | 可用 | 浏览器复验无横向溢出；桌面内网仍是主要使用形态。 |
| 旧 `/rules`、`/semantic` 入口 | 重复入口已收口 | 保留 URL 兼容跳转到岗位设置，不再作为普通 HR 的第二套编辑入口。 |
| 流程、分析、面试、附件、自动化治理 | 保留但低频 | 能力本身合理，不建议删除；通过角色和模块 Tab 收纳，后续按真实使用频率决定默认展开。 |

“不可用”不都代表遗漏：真实联系和语义 active 是在证据不足时主动关闭的高风险能力，不应通过增加开关或提示绕开。

## 4. 已修复问题

### P0：阻断与安全风险

| 原问题 | 交付修复与复验结果 |
|---|---|
| 真实联系可能被环境、审批或独立诊断路径重新武装 | 新增编译期能力总闸；环境变量不能解锁；API、Repository、Worker、自动化页面和部署预检均拒绝开启或批准真实联系；旧 M0 `greet` 也受同一能力门限制。 |
| 预览许可可能在 API 后被替换、篡改或复用 | 新增短时效 HMAC 许可；绑定操作者、候选人/岗位/任务/模板/正文/状态；API 签发后，Repository 落库前和 Worker 外部动作前分别重新验证，签名密钥不进入业务审计或列表 API。 |
| 同一候选人重复出现会迁走旧任务状态，历史人数和规则证据失真 | migration 023 为每个任务建立独立候选人状态，回填历史任务事实，修复唯一约束、任务计数和跨表归属触发器。 |
| 登录健康可能由 URL/心跳假绿，登录失效后仍继续 Worker | 会话检查限定精确 zhipin.com 域名/子域名，并读取页面 DOM 信号；登录、验证、风控、浏览器或心跳异常都会停止 Worker，不自动刷新二维码或尝试重新登录。 |
| 部署可能并发争用或重建浏览器登录目录 | 浏览器 profile 与 boss-cli 数据改为必须显式指定的 external volume；预检验证占位值、卷存在、实际挂载名、多个 boss-login、legacy boss-worker、独立 fake worker 和其他 profile 使用者。 |
| 远端曾因内存/PID 无界和开发服务器运行发生 OOM | Compose 为各服务设置内存/PID 上限，Web 使用生产构建/启动；远端已新增并持久化 3 GiB swap，预检和发布均通过。 |
| 旧 heartbeat 可能让重启初期假绿或假失败 | Supervisor 只接受晚于本次 `workerStartedAt` 的新心跳；startup 状态不再冒充 authenticated，并统一处理退出码、信号和 spawn error。 |

### P1：错误判断、权限和恢复

| 原问题 | 交付修复与复验结果 |
|---|---|
| 岗位创建先写库后鉴权；任务、审核、联系等角色边界不统一 | 写请求统一先鉴权；未认证 401、无权限 403；HR/负责人/管理员与面试官边界有回归测试。 |
| 任务取消/重试可重复执行或进入错误状态 | 新增幂等键、预期版本、状态转换和实际待处理工作检查；`waiting_review` 取消后重试仍回到可审核状态。 |
| contact readiness 可能把另一任务的候选人/locator 套入当前任务 | 同时传 taskId 与 candidateId 时强制 candidate、position、task 三者一致，并从该任务状态读取 locator。 |
| DNC、locator、紧急停止和不确定结果没有统一发送前重验 | contact dispatch 按稳定 locator 定位，发送前重新检查任务/候选人/模板/DNC/控制状态；不确定副作用不得自动重发。真实路径当前仍被编译期总闸完全阻断。 |
| 联系许可错误被误记为可能已发送 | 永久许可/策略错误在 provider 前记为确定失败，不记为 `uncertain`，避免 HR 因状态含糊再次尝试。 |
| 简历非重试错误可能被候选人、任务或通用入口重新打开 | 三层入口都阻止 source/target/风控/OCR 非重试错误；只有安全重试码可恢复，且每个重新排队的 state 都写 `resume_screening.retry_authorized` 审计。 |
| `2026届`、两位数年份、OCR 全文和教育历史容易误判 | 扩展毕业年份/应届解析和 OCR 事实消费；不确定与冲突转人工复核；新增规则失败原因映射。 |
| HR 不能纠正规则误杀 | 支持带必填备注和纠错类型的人工覆盖，保留机器原结论、证据和审计。 |
| 语义 active 可被 1 个 substring 样本虚假开启 | 编译期关闭 active，migration 024 将存量 active 降为 shadow 并把数据库约束收紧为 off/shadow。 |
| 语义配置完整被误报为已连通，或 provider 失败仍影响结论 | readiness 区分“配置完整”和“试运行连通性”；端点、凭据和超时非法时 fail-closed，provider 异常降为 unknown，shadow 不改变通过/淘汰。 |
| Dashboard 混用全局最新任务、跨岗位数据和联系口径 | 查询按授权岗位和部门过滤；岗位/任务配对；保留数据库计算的 sent-only 联系指标。 |
| 规则创建与发布为多请求，可能半成功 | 服务端以一个事务创建并发布/送审新版本；任务始终绑定不可变规则版本。 |
| 候选人卡片失效、简历/OCR 失败只显示技术状态 | 恢复逻辑给出有限重试、原因、下一次动作和人工处理路径；运行不一致时不继续领取外部任务。 |
| worker 启动后 API/release/policy 漂移仍继续工作 | Supervisor 运行中约每 5 秒持续复核；API 不可用或 release/policy 漂移时先记录错误，再停止全部 Worker。 |
| 多条相同邮箱登录可能选中不确定用户 | 登录遇同邮箱多行时拒绝；用户创建使用 advisory lock，迁移为历史异常写运营告警并阻止新增重复。 |
| 工作时段外更新任务等待状态报 `version` 歧义 | `UPDATE tasks ... FROM positions` 的 RHS 明确限定为 `t.version` 与 `t.last_progress_at`；新增回归测试，并在生产观察多个轮询周期无 42702。 |

### P2：普通 HR 体验

| 原问题 | 交付修复与复验结果 |
|---|---|
| 入口多、UUID 和技术状态占据主界面 | 固定 7 个一级模块，以模块 Tab 收纳低频能力；旧规则/语义路由兼容跳转；业务选择器显示岗位/任务名称。 |
| `screening`、`semantic_unknown`、原始 JSON 难理解 | 统一 HR 中文状态与下一步；JSON、原因码、版本和 OCR 原文折叠到技术详情。 |
| 页面加载前闪现 0/Fake/空状态 | 主要异步页面使用真实 loading、错误和恢复状态；安全模式不再靠猜测默认值。 |
| 岗位规则需要理解内部 schema | 年龄、毕业年份、应届、学历、性别与 CET-6/TEM-8 OR 使用业务表单；高级参数折叠。 |
| 移动窄屏出现操作困难 | 375px 浏览器复验无横向溢出；保留桌面优先布局。 |

## 5. 业务逻辑与数据一致性

### 5.1 migration 023/024

- migration 023 在建立新约束前先保存/恢复逐任务候选人事实；将旧的“每岗位一条当前 state”改为“每任务一条 state”，并保留当前任务的部分唯一约束。
- 迁移先把任务候选人、通过、未通过等计数归零，再按新 state 聚合，避免存量错误计数残留。
- task、position、rule version、snapshot、candidate state、evidence 和 contact intent 之间增加归属触发器，未来错误关联会在数据库层失败。
- retirement 会清理无效 active rule pointer；创建任务必须绑定仍可用的已发布版本。
- 历史重复邮箱不会被静默选中，迁移会记录运营告警；未来重复由触发器和创建锁阻断。
- migration 024 把所有存量 `semantic_mode=active` 降为 shadow，并在数据库只允许 off/shadow。

隔离历史升级测试使用了 mock contact fixture，以验证旧 contact 关联在迁移后的归属与约束；它明确记录：

```text
isolatedContactFixtures: true
externalContactExecuted: false
contactWorkerStarted: false
```

这不等于生产创建过联系，也不能被写成“测试没有 contact fixture”。

### 5.2 API、幂等与角色

- 登录缺失为 401；已有身份但角色/岗位不允许为 403；数据不存在为 404；乐观版本冲突为 409。
- 岗位、规则、任务、计划、取消/重试、审核和联系意图等 mutation 在写库前完成角色与岗位范围检查。
- 任务取消/重试、审核和计划使用幂等键与 expectedVersion，重复请求不能产生第二次业务动作。
- `contactReadiness` 必须同时验证候选人、岗位、任务、模板和 locator 的一致性。

### 5.3 Dashboard 与真实状态

- Dashboard 的岗位、任务、候选人和联系查询均限定为当前账号有权访问的岗位。
- 当前岗位只配对该岗位的最新任务，不再拼接别的岗位进度。
- 今日联系只计算实际 `sent`，不把预览、ready、processing 或模拟结果计入。
- 任务采集快照数与唯一自然人数分别命名和解释，不混成同一漏斗口径。
- API release、Worker release、简历预览策略、登录 DOM 和心跳不一致时，页面显示阻断原因，外部任务失败关闭。Supervisor 在启动时校验，并在运行中约每 5 秒持续复核；API 不可用或 release/policy 漂移时先记录错误，再停止全部 Worker。

## 6. 关键涉及文件

| 领域 | 关键文件 |
|---|---|
| 真实联系与语义总闸 | `packages/contracts/src/contact-capability.ts`、`packages/contracts/src/contact-preview-approval.ts`、`packages/contracts/src/semantic-capability.ts`、`packages/data/src/department-repository.ts`、`apps/control-api/src/server.ts`、`apps/boss-worker/src/contact-worker.ts`、`apps/boss-worker/src/contact-dispatch.ts` |
| 数据迁移与逐任务事实 | `packages/data/migrations/023_task_candidate_history_and_recovery.sql`、`packages/data/migrations/024_semantic_shadow_only.sql`、`packages/data/src/repository.ts`、`packages/data/src/repository-wait-query.test.ts`、`packages/data/src/m2-repository.ts`、`packages/data/src/task-history-migration.integration.ts` |
| BOSS 登录、风控和恢复 | `apps/boss-worker/src/login-relay.ts`、`apps/boss-worker/src/session-health.ts`、`apps/boss-worker/src/session-supervisor.ts`、`apps/boss-worker/src/session-process.ts`、`apps/boss-worker/src/boss-risk.ts`、`apps/boss-worker/src/resume-recovery.ts`、`apps/boss-worker/src/runtime.ts` |
| 稳定候选人定位 | `packages/contracts/src/boss-results.ts`、`packages/boss-cli-adapter/src/parser.ts`、`packages/boss-cli-adapter/src/command.ts`、`apps/boss-worker/src/candidate-target.ts` |
| 规则与字段判断 | `packages/data/src/rule-config.ts`、`packages/data/src/rule-failure.ts`、`packages/m1-core/src/generic-rules.ts`、`packages/rule-engine/src/tem8.ts`、`packages/semantic-engine/src/index.ts` |
| API 与安全 E2E | `apps/control-api/src/server.ts`、`apps/control-api/src/e2e-user-flow.ts`、`apps/control-api/src/server-safety.test.ts`、`packages/data/src/integration-smoke.ts` |
| HR 界面 | `apps/web/app/dashboard-client.tsx`、`apps/web/app/position-rule-dialog.tsx`、`apps/web/app/candidate-review-dialog.tsx`、`apps/web/app/contact-preview-dialog.tsx`、`apps/web/app/boss-login/boss-login-client.tsx`、`apps/web/app/workspace-navigation.tsx`、`apps/web/app/hr-display.ts` |
| 部署与登录数据保护 | `deploy/compose.intranet.yaml`、`deploy/preflight-intranet.sh`、`deploy/intranet.env.example`、`deploy/docker/Dockerfile.boss-forge`、`deploy/postgres-backup.sh`、`deploy/nginx/boss-forge.conf` |

本报告和同日审计文档记录的是共享工作树的整体验收，不代表以上每个文件都由同一个修改者完成。

## 7. 验证证据

### 7.1 自动化与构建

- 最新全量回归：`pnpm test` 共 62 个文件、394 项测试全部通过；联系许可、语义、只读简历和生产 API 同源回退定向回归已计入该数字，不重复相加。
- 最新代码的 `pnpm typecheck` 与 `git diff --check` 通过；部署、备份和证书脚本通过 `sh -n` 语法检查。
- 本轮此前执行的 `pnpm lint:web`、`pnpm web:build` 通过。
- 历史迁移链在一次性隔离 PostgreSQL 从 migration 001 执行到 024 通过；隔离 fixture 未启动 contact worker、未执行外部联系。

隔离数据库、浏览器和远端结果属于各自对应的验收轮次；最终 release 的部署与 Safari 结果见第十一节。最终部署没有启动 worker，因此仍未用先前 canary 冒充新的在线探测，也没有重复操作生产数据库。

### 7.2 本地浏览器主流程

浏览器以普通 HR 视角完成：

1. 创建岗位并编辑岗位信息。
2. 发布规则：CET-6 或 TEM-8、年龄 22–35、本科、毕业年份不晚于 2026。
3. 创建任务，观察等待状态，执行取消和重试。
4. 使用隔离模拟候选人完成审核并查看规则说明。
5. 保存岗位消息模板 v1。
6. 打开最终消息预览，核对正文和运行模式后点击取消。

验收数据库在结束时保持：

| 检查项 | 数量 |
|---|---:|
| `contact_intents` | 0 |
| `contact_attempts` | 0 |
| contact approval | 0 |
| enabled contact controls | 0 |
| processing contact tasks | 0 |

本地浏览器 375px 宽度下无横向溢出。部署前的本地 BOSS 登录页只读显示 Worker 离线/运行状态不一致；远端发布后状态为 `authenticated` 且新 heartbeat fresh。本轮没有点击刷新二维码、退出登录或尝试重新登录。

## 8. 生产发布结果与剩余边界

### 远端受控发布

本节记录既有 release 的历史远端复验结果，本身不作为最终 release 的部署证据；最终部署与生产浏览器结果见第十一节。

- 该历史发布轮次的 release 为 `remediation-20260904-0312cst`；API、Web 与 `boss-login` 使用同一镜像，API `/health`、Web、TLS gateway 和容器健康检查当时均通过。
- migration 001–024 已应用，最新为 `024_semantic_shadow_only.sql`，24 条 checksum 均存在。本次 SQL 歧义属于应用查询，无需制造空的 migration 025。
- 发布前确认原 `boss-forge-intranet_browser_profile` 与 `boss-forge-intranet_boss_cli_data` external volume；受控重启后仍挂载同一卷，登录状态保持 `authenticated`，CDP 只读确认仍在 BOSS 推荐页。
- Supervisor 仅运行 M1 与 fake contact worker，没有 Real Worker。真实联系环境值为 0、编译期能力门为 false；候选人待联系、审批请求、联系意图和发送 attempt 均为 0。数据库保留 1 条历史岗位级 enabled 控制记录，按审计红线未删除；全局与部门均为 disabled + emergency stop，因此它不是可执行联系任务。
- 主机新增并持久化 3 GiB swap；服务资源/PID 限制和预检生效。发布前备份均通过 `pg_restore --list` 校验。
- 远端日常运维目录 `/opt/boss-forge/deploy` 原先仍是旧 Compose，浏览器与 boss-cli 卷未声明为 external，存在后续误操作生成新卷、造成“看似掉登录”的风险。现已先备份旧文件，再同步本 release 的受审计部署资产，并将 build context 指向 `/opt/boss-forge/current`；`docker compose config --quiet` 与登录卷预检均通过，运行中的登录容器未因此重启。
- 两个既有筛选任务共 18 份待精筛简历在 03:xx 正确进入 `outside_working_hours`，下一次为 09:00；热修后没有 BOSS 简历查看，多个轮询周期没有再出现 SQLSTATE 42702。

### 正式使用前必须修复的问题

对“零发送、有人值守的内网试运行”，没有剩余代码级 P0/P1 阻断。最终 release 的部署预检、API/Web/HTTPS 和非本机 Safari/Dashboard 已通过。受控生产 canary 已用 1 次查看验证登录保持、计数和 `target_missing` 不重试，但没有证明完整简历加载/OCR 成功；最终部署也没有启动 worker 做新的在线会话探测，以免领取 17 份排队简历。启动 worker 前仍须先处理这批队列并重新核对在线登录、release、策略和心跳。

若正式使用包含“在 Boss-Forge 内真实发送”，当前仍存在明确阻断：`REAL_CONTACT_TRANSPORT_AVAILABLE=false`，且旧传输流程包含多个外部写动作。只有交付单消息 provider、完成幂等/不确定态专项测试并取得用户明确许可后，才应改变这个发布闸门。

### 未修复问题及原因

以下是条件性硬前置，而不是本次必须新增的产品功能：

1. 无人值守采集前，在平台允许的工作时段和额度内自然复验真实候选人只读采集，以及候选人消失、卡片失效、简历加载不完整、OCR 失败和风控停止/恢复；不得发送消息。
2. 恢复 semantic shadow 前，先轮换诊断中暴露过的提供方凭据；当前生产保持 off 且 key 为空，旧值不得从历史环境文件或备份恢复。
3. 如果正式使用定义包含“必须在 Boss-Forge 内发送”，当前版本不满足；真实传输必须另行实现和专项授权验收，不能靠改环境变量开放。

### 可以边使用边优化

- 用真实历史简历扩充字段与 OCR 回归样本，按岗位观察 false positive、false negative 和 unknown，而不是追求单一总准确率。
- 继续把罕见技术详情折叠，将“发生了什么、系统做了什么、HR 下一步做什么”作为错误文案模板。
- 根据一线使用频率决定运营、分析、面试、附件和自动化 Tab 的默认展开层级。
- 在维护窗口完成一次完整备份恢复演练；沿用现有脚本，不引入新的运维平台。

## 9. 产品优化建议

### 保留合理功能，但控制复杂度

现有 7 个一级模块可以保留；岗位/规则/模板、任务/候选人、联系/自动化之间已经通过 Tab 和上下文入口收纳。低频能力不必删除，但应默认折叠或只对相应角色显示，避免让普通 HR 在第一次使用时先理解治理概念。

仍存在一定功能偏多与概念复杂问题，主要集中在运营、分析、团队、审计、面试、附件、自动化和语义治理。它们可以作为高级能力保留，但不应继续增加同义入口。任何能力如果不能给出真实状态或明确下一步，应先隐藏/阻断入口，而不是仅加说明文字。

### 不建议开发

- 微服务拆分、Kafka/消息中间件、通用工作流引擎。
- 更多角色层级、矩阵权限、跨公司多租户和企业级审批链。
- 独立 BI 平台、可配置报表设计器或新的“运营大屏”。
- offer、入职、绩效、编制和人才营销等大型 ATS 模块，除非小团队有已验证的日常需求。
- 自动批准、批量真实联系、风控绕过或用 LLM 猜测学校标签/敏感属性。
- 在有代表性的逐准则金标集建立前恢复语义 active。

### 只有出现真实需求时再补充

- 经单独授权和安全验收的真实联系传输。
- 真实使用证明需要后的附件正文存储或日历集成。
- 依据真实岗位样本建立的 criterion-scoped 语义评估；不是为了“功能完整”而开启。

## 10. 验收判断

| 判断 | 结论 |
|---|---|
| 本地隔离的岗位—规则—任务—候选人—审核—消息预览闭环 | 通过 |
| 默认 E2E 是否创建或执行联系 | 否 |
| 真实联系是否可能被环境变量解锁 | 否 |
| 语义是否会影响招聘结论 | 否，仅 shadow |
| 登录数据保护是否进入部署约束 | 是，external volume + fail-closed 预检 |
| 修复是否已部署远端 | 是，`boundaryfix-20260904-1043cst`；API/Web 精确镜像一致且 healthy，公开 HTTPS 与 Safari 页面验收通过 |
| 登录保持、release、心跳和工作时段等待是否一致 | 先前登录与单次 canary 安全边界已复验；最终部署 worker 保持停止，页面如实显示 release/策略/心跳不一致并阻断，因此没有新的在线一致性通过声明 |
| 三条边界代码/模拟验收 | 通过，详见 `BOUNDARY_ACCEPTANCE_2026-09-04.md` |
| 远端真实 BOSS 采集/恢复是否已做修复后复验 | 部分；1 次 `target_missing` 已验证不重试，完整读取/OCR 与其他失败样本未验收 |
| 最终部署后的生产单份只读 canary | 未执行；为避免领取 17 份排队简历没有启动 worker，不能用先前 `target_missing` canary 冒充完整读取成功 |
| 当前是否适合普通 HR 正式使用 | 适合零发送、有人值守的内网试运行；不含系统内真实发送、完整简历/OCR 成功 canary 和无人值守故障恢复 |
| 总体产品结论 | **基本够用** |

“基本够用”意味着核心人工筛选闭环与生产运行基础已经可用，仍有少量需人工绕过或等待真实样本证明的能力；不意味着真实发送、语义 active 或全部 BOSS 异常恢复已经通过验收。

## 11. 最终 release 生产验收状态

- release `boundaryfix-20260904-1043cst` 已部署；镜像为 `sha256:9fdcd7f13c70eb29c16df59a7bccf30074d01e011f0abe492805fd245db8cb69`、平台 `linux/amd64`。API/Web 使用精确镜像且 healthy；公开 HTTPS 首页返回 200，`/health` 返回正确 release 和简历额度（每日 120、每小时 20）。部署前 `pre-boundaryfix` dump 已验证。
- Safari 刷新原有会话后直接进入 Dashboard；岗位、任务、候选人、联系、自动联系、运营、设置和审计页面均加载，没有 `Load failed`。
- 联系页明确显示真实联系编译关闭，启用和审批入口禁用。生产没有已批准候选人，因此只展示示例模板；没有生成候选人级预览、没有请求一次性许可、没有发送。联系 intent/actionable/real、attempt、sent、queued-contact、authorization 和 approval request 全部为 0。
- `boss-login` 与 `migrate` 使用精确最终镜像，但保持 Created/停止。原 worker runtime、browser profile、boss-cli data 三卷挂载一致，当前没有运行容器占用 browser profile。为避免领取 17 份 queued 简历，本次没有启动 worker；BOSS 状态页如实显示服务未启动及 release/策略/心跳不一致，阻止自动操作并提示不要刷新二维码或重新登录。
- 先前已经验证登录卷持久化、`authenticated` 和单次 canary 的 `target_missing` 无重试；由于最终部署没有启动 worker，本报告不把先前证据冒充新的在线登录探测，也不声明完整简历正文/OCR 成功 canary 已通过。
- 数据库共有 24 条 migration；今日 `resume_viewed=1`，简历状态 failed 7、queued 17、screened 6；两个 screening 任务均为 `daily_quota_reached`，这是 canary 临时一份额度留下的等待原因，服务停止后不会自动执行。enabled schedule 为 0。
- 审计页把最新 `resume_viewed`/`failed` 显示为“其他系统操作”。原始审计日志和安全状态正确，这是不阻断使用的 P2 中文事件映射问题。
- 最新全量回归为 62 个测试文件、394 项通过，类型检查、Web lint、生产构建和脚本语法通过。

## 12. 双动作真实联系与最终生产收口

- 独立 `greet` / `message` 真实传输、逐候选人短效签名许可、精确正文预览、provider 回执、不确定态禁止自动重试、全局 fence、账号锁和 M1 联系优先门均已交付。UI 使用“打招呼”“发消息”两个独立按钮和确认对话框，`/contacts` 是日常入口，`/automation` 命名为“联系安全设置”并作为低频管理入口。
- release `audit-events-20260904-1614cst` 已受控部署；API、Web、`boss-login` 同一 `linux/amd64` 镜像且 healthy。原三只 BOSS 持久化 volumes 未改变，重启前后均为 `authenticated`，浏览器认证、worker heartbeat 和 runtime 一致性均通过。
- migration 001–026 与 checksum 完整；最终联系 intent、active、attempt、authorization、queued candidate、active approval 和 active outbox 均为 0。全局/部门控制 safe-off，本轮没有真实 BOSS 写入。
- 审计页 `resume_viewed`、精筛失败等事件的中文映射已修复并进入生产 bundle；`/audit` 及 11 个静态资源均为 200。
- 最新全量回归为 79 个测试文件、523 项通过；TypeScript、Web lint、生产构建、部署 preflight 与定向并发/审计回归均通过。

最终产品结论仍为 **基本够用**：核心招聘闭环和真实双动作能力已经是可运行产品，不是 mock；首次真实 canary 仍需等待自然合格且人工审核通过的候选人，并在执行前向用户展示精确候选人、发件账号和完整正文取得许可。真实异常样本和语义模型效果可边使用边补证，不应通过绕过风控、额度或登录保护来测试。
