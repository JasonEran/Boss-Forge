# Boss-Forge 真实消息发送开启复核

> **历史记录 · 2026-09-04**：下文保留当时的版本、验证和限制，不代表当前生产状态。现行说明见[文档索引](README.md)、[当前状态](CURRENT_STATUS.md)与[运维手册](OPERATIONS_RUNBOOK.md)。

> 复核日期：2026-09-04（Asia/Shanghai）
>
> 用户请求：开启消息发送功能
>
> 执行边界：保留 BOSS 登录；不创建真实联系任务；不点击打招呼或发送；没有向候选人发送消息

> 历史结论说明：本文第 1–5 节原样保留首次开启复核时的证据，不能作为当前 release 状态。当前生产交付见第 6 节；操作要求以 [Ubuntu 内网部署](INTRANET_DEPLOYMENT.md) 为准。

## 1. 结论

**生产真实消息发送未开启。** 当前 `@joohw/boss-cli 0.6.6` 的真实联系路径不满足本产品已经确定的逐条预览许可、单次外部写入、权威送达回执和故障后安全去重要求。直接把环境变量改成 real 会产生误发、双消息、假成功或重复发送风险，因此编译期总闸继续保持 `REAL_CONTACT_TRANSPORT_AVAILABLE=false`，生产仍为 `BOSS_FORGE_CONTACT_DISPATCH_MODE=disabled`、`BOSS_FORGE_REAL_GREET_ENABLED=0`。

本次没有部署，也没有重启生产服务或 worker。生产持久化浏览器目录未改动，既有登录状态与干净队列保持不变，真实发送数为 0。

## 2. 阻断证据

当前 worker 的真实路径依次执行：

1. `greet`：点击 BOSS“打招呼”，这是第一次不可逆外部写入。
2. `chat-by-name`：进入候选人会话。
3. `send`：输入 HR 审核正文并按 Enter，这是第二次不可逆外部写入。

底层 `greet` 和 `send` 均只返回本地生成的中文字符串。`send` 在按 Enter 后短暂等待，然后直接返回“已发送消息”；它没有核验 BOSS 的网络响应、消息 DOM、会话 ID、消息 ID或服务端接收时间。现有 worker 又把这段 stdout 保存为 `externalMessage`，不能据此证明消息已被 BOSS 接收。

因此存在四个无法靠开关修复的风险：

- 一次人工许可可能触发“系统打招呼 + 自定义正文”两条真实消息。
- 按 Enter 后进程超时或崩溃时，系统无法判断是否已经送达。
- BOSS 页面拒绝、风控或提示失败时，CLI 仍可能正常退出并被误记为成功。
- 没有 BOSS 权威消息 ID 和幂等键，故障重试可能重复联系同一候选人。

官方 BossHi 开放平台的消息接口虽然提供请求 `uuid` 去重和 `message_id`，但官方调用说明明确将其定义为向企业内部员工发送消息的 `hi-open.zhipin.com` 能力，不是 BOSS 招聘候选人会话接口，不能替代本产品所需的招聘消息 transport。

## 3. 已完成的安全补强

这些改动为未来接入合格 transport 做准备，但不等于真实发送已经可用：

- 真实模式预览增加逐条勾选确认，明确绑定候选人、BOSS 发件账号、岗位、任务和最终正文；关闭、重载或对象变化后确认自动失效。
- 真实发送结果为 `uncertain` 时保守计入已用额度，避免消息可能已送达后继续超额发送。
- stale real dispatch 恢复为 `uncertain` 时同样消费此前预留额度，并锁定后续发送。
- worker 完成结果只能更新精确的 `processing` intent 与 attempt；迟到结果不能覆盖已进入 terminal/uncertain 的状态。
- 只有招聘负责人或管理员在 BOSS 中人工核验确实未发送后，才能原子解除锁定并返还对应额度，全程写审计日志。

## 4. 允许开闸的最小验收条件

不需要增加大型 ATS 模块；只需补齐一个小而可靠的发送适配器，并同时满足以下条件：

1. 一次人工许可只产生一次外部写入，并发送许可中展示的精确正文；不得隐式追加另一条打招呼消息。
2. BOSS 返回可持久化的 `messageId`、`conversationId`、稳定候选人 ID 和服务端接收时间。
3. transport 接受由本系统生成的稳定幂等键，重试同一请求不会再次发送。
4. 超时、worker 崩溃和数据库写入失败后，可以按幂等键或消息 ID 向 BOSS 对账，而不是猜测结果。
5. 回执能绑定当前 BOSS 发件账号，并能区分送达、明确失败和未知三类结果。
6. mock/fault-injection 覆盖“外部已写入但本地未落库”“BOSS 拒绝但进程正常退出”“迟到成功覆盖 unknown”等场景。
7. 取得用户对具体候选人、账号和最终正文的许可后，只做一条受控 canary；发送前再次展示完整预览，发送后用 BOSS 权威回执和页面人工核验双重验收。

在取得官方 BOSS 招聘候选人消息接口或其他能提供上述语义的受支持 transport 前，不应通过页面、环境变量或直接启动 worker 绕过编译期总闸。

## 5. 验证结果

- `pnpm test`：68 个测试文件、452 项通过。
- `pnpm typecheck`：通过。
- `pnpm lint:web`：通过。
- `pnpm web:build`：通过。
- `git diff --check`：通过。
- 真实联系任务、BOSS 打招呼和候选人消息：均未触发。

## 6. 后续生产交付（取代第 1–4 节对“代码能力不足”的当前判断）

首次复核发现的问题已通过小范围实现收口，没有增加新的平台或审批系统：

- `greet` 与 `message` 已成为两个相互独立的动作、预览、许可、意图和回执；正文发送不会隐式触发打招呼。
- `greet-preview` 只接受当前 BOSS 岗位可唯一核验的招呼语；读取不到精确岗位、招呼语 ID 或正文时不签发许可、不创建任务。
- `message-preview` 使用当前岗位模板版本渲染正文。两类短效 HMAC 许可均逐字绑定动作、操作者、BOSS 发件账号、浏览器 profile、候选人稳定 locator、岗位、任务、模板/provider 标识和正文哈希，不可互换或复用到变更后的对象。
- Real Worker 只通过已认证 `boss-login` supervisor 的私有 `0600` Unix socket 串行复用现有浏览器，不开启第二个浏览器，不提供 M0/CLI 绕过入口。
- greet 核验 BOSS start-chat 请求与响应中的动作、候选人和精确正文；message 在按下唯一一次 Enter 前排除基线中的同正文待发送项，并要求本次 Vue 消息流的 client/server message ID 与 delivered 状态。无法确认、进程中断或落库异常统一进入 `uncertain`，禁止自动重试。
- 全局写入 fence、账号锁、四级联系开关、DNC、账号健康、额度、时段、冷却、历史重复与并发 active intent 会在外部写前再次检查。

验证状态：最新全量为 523 项单元测试通过；migration 001–026、隔离数据集成和隔离用户/联系 E2E 通过，隔离 E2E 明确没有真实 BOSS 写入。类型检查、Web lint 和生产构建通过。这些结果证明代码与失败关闭边界，不代表真实候选人写入已经验收。

release `audit-events-20260904-1614cst` 已生产部署，真实 greet/message runtime 已开启。BOSS 会话沿用原持久化 volumes 且为 `authenticated`；全局和部门联系控制保持 safe-off；联系队列、intent、attempt 和 authorization 均为 0，真实发送仍为 0。当前没有同时满足联系条件和人工审核通过的候选人，因此尚未执行首次真实 canary，不能把“已部署”和“runtime real”表述为真实发送已验收。

首次真实 canary 必须先展示唯一一个具体动作、候选人、BOSS 发件账号、岗位/任务和完整正文，并取得用户对该组合与正文的精确许可；未取得许可时只能预览，不能创建或执行真实联系意图。
