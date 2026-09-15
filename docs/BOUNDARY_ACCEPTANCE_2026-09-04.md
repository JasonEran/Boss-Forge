# Boss-Forge 三条安全边界验收

> 验收日期：2026-09-04（Asia/Shanghai）
>
> 验收对象：当前本地共享工作树，以及严格受控的生产三简历只读 canary
>
> 验收方式：代码链路复核、自动化测试、类型检查、脚本语法检查，以及分阶段采集和严格限额的三次生产简历查看；未创建、批准或执行任何真实联系任务，未调用 BOSS 打招呼/发送接口
>
> 结论口径：各边界分别判定；生产三简历 canary 和最终 release 的 API/Web 验收通过；联系的精确预览与一次性许可链已通过 mock/数据库幂等验收，真实单条 transport 未通过且保持编译关闭

## 1. 最终结论

| 边界 | 代码/模拟结论 | 生产结论 |
|---|---|---|
| 登录状态与三份只读简历验收 | 安全边界通过。登录目录持久化、采集/简历分段模式、启动/运行期策略一致性、3 次硬上限、恢复与错误码均有 fail-closed 保护 | **通过**。worker 重启后仍为 `authenticated`；collection-only 采集 15 名且 0 次查看；resume-only 严格记录 3/3 并退出 0，无第四次。2 份完成 OCR/规则判断，1 份 `target_missing` 无重试 |
| 联系消息预览许可 | **精确许可链与零发送保护通过**。API、repository、worker 的短效签名已绑定操作者、发件 BOSS 账号、来源、稳定目标 locator 哈希、候选人、岗位、任务、模板与正文；mock 与数据库验收覆盖一次性消费和幂等 | **真实单条 transport 未通过且保持编译关闭**。三名生产样本均未合格或失败，没有人工改判，因而没有候选人级消息预览或许可；联系页显示“仅预览，发送未启动”，approved/record/intent/attempt/sent 均为 0 |
| 语义判断 | 通过。当前只允许 off/shadow；配置、凭据和端点不合格时 fail-closed，失败降级为 unknown，不参与最终放行 | **真实模型连通性与质量待试运行验证**。当前生产配置不应启用主动语义决策 |

当前共享代码只能按不同边界分别判定：最终 release 已部署；登录持久化、采集不打开简历、三次硬上限、`target_missing` 安全停止，以及两份真实 OCR/规则判断均有生产证据；语义 shadow 已落库展示但真实模型仍有待验项；联系能力的精确许可链和“不会真实发送”检查已通过，不能据此认定真实传输链路可用。完整逐份结果见 [生产三简历全路径验收](THREE_RESUME_ACCEPTANCE_2026-09-04.md)。

## 2. 边界一：登录状态与三份只读简历查看

### 2.1 已通过的代码边界

- BOSS 浏览器目录和 boss-cli 数据使用外部持久卷；部署流程不得删除或重建这些卷。
- worker 只有在显式 `1` 或 `true` 时才启用简历查看/OCR 开关，部署预检只接受明确的 `0/1` 配置。
- 简历策略使用统一规则计算小时额度、每日软额度、绝对每日上限、批次休息和工作时段。软额度重置不会清空小时窗口或绝对每日计数。
- 候选人目标改变、候选人歧义、来源不匹配、风控和 OCR 不可恢复错误不会自动重新打开简历；只有 `content_empty` 和 `preview_not_opened` 可由 worker 自动重试。
- 手动重试仍需写入候选人级 `resume_screening.retry_authorized` 审计记录，不能通过候选人、任务或通用 API 绕过非重试错误。
- API 与 worker 在启动时校验 release/policy；Supervisor 运行中约每 5 秒持续复核。API 不可用或 release/policy 漂移时，先记录错误，再停止全部 worker。
- 前端、repository 与 worker 对 target changed、ambiguous、OCR、风控和内容为空等错误使用同一组业务含义，并向 HR 给出对应下一步。

### 2.2 生产受控 canary 结果

本轮在不清理、不重建 BOSS 登录目录的前提下完成了严格受控的三简历只读 canary：

1. 先运行 `collection-only`，为海外运营专员规则 v3 的任务 `8e1e9ed2-34ca-451b-9923-bc91e54ac61c` 采集 15 名新候选人；该阶段简历查看为 0；
2. 切换为 `resume-only` 并将查看尝试硬上限设为 3；worker 重启后会话仍为 `authenticated`；
3. 12:55:38 CST，周锴返回 `target_missing`，没有自动重试；
4. 12:56:38 CST，李子音完成 OCR 193 行，逐行置信度均为 100，识别 CET-4；因英语证书不符，规则结论为 `not_matched`、置信度 0.98；
5. 12:58:08 CST，刘梦莎完成 OCR 31 行，逐行置信度均为 100，识别 TEM-4/CET-4；因毕业年份 2027 且英语证书不符，规则结论为 `not_matched`、置信度 1.0；
6. canary 与 supervisor 均记录 3/3 并退出 0，日志与数据库没有第四次查看；全过程联系 intent 和 attempt 均为 0。

两份成功样本均保留 2 项语义 shadow 结果；shadow 不改变规则结论，模型未配置的项目在页面显示“待复核”。这次 canary 同时验证了登录保留、采集/查看隔离、精确尝试上限、失效目标 fail-closed、OCR 落库和规则解释。

验收后任务通过正式 API 取消；剩余 12 条 `queued` 已停放为 `not_requested`，2 条 `screened` 与 1 条 `failed` 作为证据保留。全库 actionable resume 和 actionable contact 均为 0，contact attempt 为 0。migration 025 同时把历史取消任务遗留的 17 条 `queued` 安全转换为 `not_requested`。

## 3. 边界二：联系消息预览许可

### 3.1 已通过：预览 → API → repository → worker 的精确许可链

- API 仅在预览确认阶段签发短时效许可。许可绑定操作者、配置的发件 BOSS 账号、来源、规范化稳定 locator 的 SHA-256、候选人 ID/姓名、岗位 ID/名称、任务、模板、消息正文 SHA-256、签发时间和过期时间；原始 locator 不进入 token。
- 签名使用 `BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY`，密钥必须至少 32 字节；缺失、过短或不一致时拒绝创建联系任务。
- repository 在创建联系意图时重新校验 HMAC、时效和全部绑定字段，并保存已验证 claim。原始许可只保存在内部策略快照中，不通过列表或审计 API 返回。
- worker 在任何外部动作之前，再次用当前候选人、发件账号、来源、稳定 locator、任务、岗位、模板和正文校验许可。篡改、过期、对象变化或状态变化均在外部写操作前失败。
- 永久性的许可/策略失败记为确定失败，不记为可能已发送的 `uncertain`，避免误导 HR 再次尝试。
- mock 与隔离数据库验收覆盖正文或对象篡改、候选人/账号/来源/locator 换绑、许可过期、双击并发和重复领取；同一许可只能得到同一幂等键，数据库唯一约束和原子领取共同阻止产生第二次有效执行。
- 编译期能力开关 `REAL_CONTACT_TRANSPORT_AVAILABLE=false`，环境变量不能把真实联系能力打开。

预览页同时显示候选人唯一记录、脱敏 BOSS 定位、发件账号、完整正文、模板版本、正文短指纹、许可编号/有效期，以及候选人级审核、DNC、历史联系、控制、时段、额度和账号健康检查。上述结论仍不是对真实 transport 的通过结论。

### 3.2 未通过：真实单条 transport

当前还有两个真实传输阻断，任何一个未解决都不得启用真实联系：

1. **仍是多动作路径**：旧版 transport 可能依次执行 `greet`、按姓名进入会话和 `send`。这不能证明“一次人工许可只产生一个外部写动作”，也不能排除额外打招呼副作用。
2. **没有可核对的发送 receipt**：现有成功状态没有绑定不可变的外部消息/会话 ID、发送账号、目标 locator、正文哈希和提供方时间。发生超时、进程崩溃或连接中断时，无法用权威回执证明消息究竟未发、发了一次还是可能重复。

许可现已绑定配置中的 BOSS 账号和稳定 locator；真正启用前仍需证明当前浏览器登录身份与该账号一致，并将这项运行时证明纳入同一发布闸门。

因此，当前联系结论只能写为：**许可骨架/零发送通过，真实单条 transport 未通过且保持关闭。**

本轮没有创建、发送、批准或重新执行任何真实联系任务，也没有调用 BOSS 打招呼/发送接口。生产联系页明确显示“仅预览，发送未启动”；三名样本均未合格或失败，未人工改判，因此没有生成候选人级预览或请求许可。生产核对结果为 approved 0、record 0、intent 0、actionable 0、attempt 0、sent 0。

### 3.3 启用真实发送前所需的精确证据包

下列证据必须同时齐备；少一项都不得改变 `REAL_CONTACT_TRANSPORT_AVAILABLE=false`：

1. **许可绑定证据**：签名 claim 同时绑定 Boss-Forge 操作者、实际 BOSS 发送账号的稳定非秘密标识、浏览器 profile 标识、候选人稳定 locator/geek 标识、候选人/岗位/任务/模板版本、最终正文哈希、签发时间和过期时间；worker 在外部动作前逐字段二次校验。
2. **单写 transport 证据**：mock/影子命令 transcript 证明每个 intent 只有一个会改变 BOSS 状态的调用；不得隐式执行 `greet`，不得把“按姓名进入会话”当作未审计的写操作；发送正文必须与用户看到的预览逐字一致。
3. **幂等与故障注入证据**：覆盖重复请求、重复领取、worker 重启、发送前崩溃、调用中超时、提供方成功后本地落库前崩溃。测试必须证明确定失败可安全重试，而未知副作用进入不可自动重试状态。
4. **权威 receipt 证据**：成功响应必须取得并持久化不可变 receipt，至少包含外部消息或会话 ID、发送账号、目标 locator、正文哈希、提供方时间和 intent/idempotency 关联。若 BOSS transport 无法提供足以去重和对账的 receipt，就不能把真实发送标为通过。
5. **数据库与 API 证据**：一次性隔离 PostgreSQL 测试证明许可原文和 signing key 不出现在审计/列表/详情响应，唯一约束阻止第二个活动 intent，过期、篡改、换账号、换 locator、换正文和换任务均在外部动作前失败。
6. **发布闸门证据**：构建产物、部署预检、API、repository 和 worker 都报告同一 release 与 transport policy；生产启用前再次确认不存在旧 `queued`、`approved`、`processing` 任务，并保留可立即停止的总闸。
7. **单条生产 canary 证据**：仅在用户看到候选人、发送账号和最终正文并对这一条明确许可后执行；保存脱敏的预览许可记录、一次且仅一次的外部写调用记录、BOSS receipt、数据库状态和 worker 日志。未取得这组证据时不得写成“生产发送验收通过”。

## 4. 边界三：语义判断

- 编译期能力开关 `SEMANTIC_ACTIVE_DECISIONS_AVAILABLE=false`，当前只能使用 off/shadow。
- 只有显式 `1` 或 `true` 才视为启用；端点必须为 HTTPS，不能携带内嵌账号密码、查询参数或 URL fragment。
- endpoint、model、API key、timeout 任一缺失或非法时 readiness 为未就绪，不能伪装成功。
- provider 不可用、超时、返回异常或缺少结果时统一降级为 `unknown`。
- M1 只接受 runtime mode 为 active 的语义评价参与决策；当前 active 编译能力关闭，因此 shadow 结果不会改变候选人通过/不通过。
- migration 024 将历史 active 配置降为 shadow，并用约束限制为 off/shadow。
- 前端使用“模型配置完整；连通性会在试运行时验证”的准确表述，不再把仅有配置误报为已连通。

当前只能验收影子结果展示和失败降级。真实模型连通性、稳定性与业务准确率需要在不影响候选人最终结论的 shadow 试运行中单独验证。

三简历生产样本中，两份成功完成判断的简历各产生 2 项 shadow 结果；这些结果在前端可查看且没有改变硬规则的 `not_matched` 结论。模型未配置项显示“待复核”，符合 fail-closed 预期。

## 5. 验证证据

| 检查项 | 当前共享工作树结果 |
|---|---|
| `pnpm test` | 通过：67 个测试文件、447 个测试 |
| `pnpm typecheck` | 通过：根工作区与 web 类型检查均通过 |
| `git diff --check` | 通过 |
| 部署/备份/证书脚本 `sh -n` | 通过 |
| 生产 BOSS 操作 | collection-only 采集 15 名且 0 次查看；resume-only 严格执行 3/3；重启后仍为 `authenticated`，无第四次 |
| 生产联系状态 | intent/actionable/real、attempt、sent、queued-contact、authorization、approval request 全部为 0；未生成候选人级许可，未执行发送 |
| 联系精确预览/HMAC/幂等保护 | mock 与数据库验收通过；不代表真实 transport 通过 |
| 真实单条 transport | 未通过、未执行；编译期能力保持关闭 |
| 当前生产只读 canary | 1 份 `target_missing` 无重试；2 份 OCR/规则判断成功；canary 与 supervisor 均为 3/3、退出 0 |
| 最终 release | `acceptance2-20260904-1315cst`；镜像 `sha256:3a5ac64c166c9e13f1280bf9dd43e92ef85fe0e707cc08f782787e229b346a7c` |
| 最终部署状态 | API/Web 使用精确目标镜像；三简历执行 release 为 `canary3-20260904-1207cst`，后续 release 仅含 UX 修复 |
| 验收后队列 | 任务已取消；剩余 12 条停放为 `not_requested`；全库 actionable resume/contact 与 contact attempt 均为 0 |
| 生产数据 | 25 migrations；migration 025 已将历史取消任务的 17 条 `queued` 转为 `not_requested`；三简历任务保留 2 screened/1 failed |

隔离数据库中的联系幂等测试与生产只读 canary 是两类不同证据：前者不产生真实 BOSS 写入，后者只执行三次受控简历查看。migration 025 已在生产应用，但没有执行任何真实联系迁移或发送测试。

## 6. 部署前必须满足

对“零发送、只读简历查看”的受控内部试用：

1. 已部署构建继续保持项目名、镜像、release、策略、数据库硬约束与外部卷检查一致；
2. 确认浏览器登录卷已持久化，且没有其他 Boss-Forge 实例并发使用同一登录目录；
3. 联系真实传输能力继续保持编译关闭，不配置任何绕过方式；
4. 语义保持 off/shadow；
5. 每次启动 worker 前继续核对 actionable resume/contact 均为预期值、在线登录、release、策略和新鲜心跳；需要追加生产样本时必须设置精确尝试上限，并在完成后取消任务、停放剩余队列。

对“真实联系发送”：当前仍为阻断状态，不得部署启用；只有第 3.3 节的完整证据包通过后才能重新评估。

## 7. 非阻断后续项

- 连续简历查看计数目前包含进程内批次状态；worker 重启可能缩短一次批次休息。持久化小时/每日硬限制和本次 3 次 canary 上限均有效，因此属于 P2，可结合后续自然样本决定是否需要持久化批次节奏。
- Safari 审计页把最新 `resume_viewed`/`failed` 显示为“其他系统操作”；数据库原始事件和安全状态正确。这是 P2 中文事件名称映射，不阻断使用，也不影响审计事实。
- 用一组匿名、固定的金标简历验证 OCR 与 shadow 语义输出质量；不应因此新增复杂审批流或企业级 ATS 模块。

## 8. 明确不作出的声明

- 不把周锴的 `target_missing` 安全停止记作完整简历读取成功；OCR 与规则生产结论只覆盖李子音、刘梦莎两份实际成功样本。
- 不声明当前浏览器登录身份已经与许可中的 BOSS 账号完成平台级证明。
- 不声明真实单条 transport、外部幂等或 receipt 已通过。
- 不声明任何真实联系消息已获许可或已经发送。
- 不声明语义模型已经连通或质量已经达标。
- 不声明真实联系 transport 已因三简历验收而可用；migration 025 的队列清理通过不等于联系发送通过。

**最终口径：生产三简历 canary 已通过安全边界验收。collection-only 采集 15 名且不打开简历；resume-only 在登录重启后仍为 `authenticated`，严格记录 3/3 次并退出 0，无第四次。结果为 1 份 `target_missing` 无重试、2 份 OCR/规则判断成功。验收任务已取消，剩余 12 条队列停放，全库 actionable resume/contact 和 contact attempt 均为 0。最终 release 为 `acceptance2-20260904-1315cst`。精确预览与一次性许可链的 mock/数据库幂等验收通过，但真实 transport 缺少精确单发与平台 receipt，继续编译关闭。产品结论为“基本够用（筛选、审核和预览可用；系统内真实发送仍不可用）”。**
