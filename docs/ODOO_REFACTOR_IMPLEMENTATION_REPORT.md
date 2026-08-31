# Boss-Forge Odoo 重构实施报告

> 实施日期：2026-08-31
>
> 交付范围：Odoo 19 Community Recruitment + Boss-Forge R0-R4 内网基础版
>
> 真实打招呼执行数：**0**

## 1. 交付结论

本轮完成了重构文档中 R0-R4 的工程基础和 Fake 联系闭环：Odoo 成为 HR 主控制面，Boss-Forge 保留渠道执行、OCR、规则判定、异步任务、联系策略、幂等与审计能力。旧 Dashboard、M0/M1/M2 及 `boss-cli` 适配没有删除，可继续用于运维诊断和渐进迁移。

本轮没有配置公网域名、TLS、CDN、WAF 或公网数据库；部署文件只面向公司内网 Ubuntu。数据库不映射主机端口，Odoo 与 API 默认绑定 `127.0.0.1`，需要办公室访问时由运维显式改为服务器固定私网 IP。

真实联系没有启用、没有测试，也没有定义常驻真实联系容器。默认联系执行器只消费 `transport_mode=fake`，结果记为 `simulated`，不调用 BOSS 或 `boss-cli`，也不占用真实额度和冷却统计。

## 2. 已交付能力

### 2.1 Odoo HR 控制面

- 四个独立 Addon：Connector、规则、招聘扩展和权限。
- 复用 Odoo Community 的用户、部门、岗位、候选人、Kanban、Chatter、活动、面试协作和基础报表，不重复开发通用 ATS。
- 岗位可绑定负责人、协作 HR、BOSS 账号、已发布规则和联系策略。
- 支持立即执行和计划执行，运行状态及候选人筛选结果回写 Odoo。
- 候选人审核支持“通过并联系”“通过但暂不联系”和“不通过”。
- 审核后生成不可变联系授权；重复点击和重复事件保持幂等。
- 招聘 HR、团队负责人、审核员、批准人和系统运维员分组，并配置岗位范围 Record Rules。

### 2.2 规则与证据

- 保留 TEM8 语义归一化，兼容 `TEM8`、`TEM-8`、`英语专业八级`、`英语8级` 等写法。
- 未达到 TEM8 时保留候选人识别出的当前英语级别，例如 TEM4、CET4/6、IELTS、TOEFL、BEC。
- 规则树支持 AND、OR、NOT、工作年限范围、关键词、枚举、文本、学历层级、TEM8 和院校类别叶子。
- 每个叶子保存原文、归一化值、置信度、词典/目录版本和原因码，不只保存最终布尔结果。
- 985、211、双一流和自定义院校集合使用不可变目录快照与内容哈希；多义、OCR 冲突和信息不足进入人工复核。
- 未内置一份来源不明的“权威院校名单”。正式目录需要 HR 使用批准来源导入、复核并发布。

### 2.3 Boss-Forge 执行面

- 复用既有 `boss-cli` 登录态、岗位读取、推荐/搜索、简历预览、截图和 OCR 链路。
- 多岗位、多 BOSS 账号任务显式路由；Worker 只能领取配置账号对应的任务。
- 候选人按稳定身份去重，任务候选人数按逻辑候选人统计，不再把重复采集记录计为多人。
- 任务领取使用可过期租约、claim token 和 fencing；崩溃任务可恢复，旧 Worker 不能覆盖新 Worker 结果。
- 岗位配置、筛选请求和审核结果保存聚合版本与不可变快照；旧事件忽略，同版本不同内容失败关闭。
- 任务取消、失败和人工审核完成会向 Odoo 发送对应终态；取消同时释放 Worker 租约。
- Odoo 与 Boss-Forge 使用独立 PostgreSQL，通过版本化事件、Inbox/Outbox、相关 ID 和聚合版本同步，禁止跨库直写。
- 同一事件 ID 内容完全相同才视为幂等重放；相同 ID 不同内容会失败关闭。
- 同一业务聚合的 Outbox 严格按版本发送，前序失败时后序事件不会越过；不同聚合互不形成持久队头阻塞。

### 2.4 联系安全闭环

- 联系授权携带候选人、岗位、BOSS 账号、审核版本、规则版本、模板版本、策略版本、消息正文、到期时间和禁止联系状态的快照。
- Dispatch 前重新检查授权未撤销/未过期、候选人版本、BOSS 账号、全局/账号/岗位停止、时间窗、额度、冷却和不确定熔断。
- 临时时段、额度、冷却、暂停和熔断阻断进入 `deferred` 并自动重排；永久阻断才进入 `failed`。
- Fake stale 任务可安全重排且不会制造 `uncertain`；Real stale 任务保持 `uncertain` 并要求人工核验。
- 在任何真实 greet 前重新读取原岗位候选人列表，并按稳定指纹和姓名唯一性校验；同名多条或信息变化时失败关闭。
- Fake 与 Real 意图、领取和结果状态分离；Fake 只能变为 `simulated`，Real 不能伪装为模拟成功。
- 外部副作用成功但数据库落库失败时不会自动二次发送；任务保持处理中，恢复后进入 `uncertain` 等待人工核验。
- M0 真实 greet 同时要求命令行显式批准和环境开关；内网 Compose 把环境开关固定为 `0`。

### 2.5 内网 Ubuntu 部署

- 提供 Odoo 19、双 PostgreSQL、数据库迁移、Control API、Odoo 同步、Fake 联系 Worker 和可选读/筛 Worker 的 Compose 拓扑。
- 两个数据库均无主机端口；数据网络设置为 Docker internal network。
- Odoo 和 API 默认只绑定回环地址，也可配置固定私网 IP。
- 读/预览 Worker 使用显式 profile，不会随默认 `up -d` 启动；真实联系 Worker 不存在。
- 提供首次初始化、升级、备份、恢复、回滚、健康检查和 R0-R4 验收步骤。

## 3. 数据库与接口变更

新增迁移覆盖 Odoo 映射、入站/出站事件、集成去重、Fake 模拟状态、聚合顺序、联系策略快照、延期重排、配置/审核版本和任务租约。迁移脚本通过 `schema_migrations` 幂等执行。

入站事件：

- `job.config.published.v1`
- `screening.run.requested.v1`
- `screening.run.cancelled.v1`
- `candidate.review.completed.v1`
- `candidate.contact.authorized.v1`

出站事件包含任务开始/结束、候选人采集/筛选/失败、联系排队/模拟/发送/失败/不确定、回复和账号健康状态。当前 R0-R4 实际闭环使用到候选人、筛选和 Fake 联系相关事件；回复同步属于后续阶段。

## 4. 验证结果

最终提交前对以下项目执行全量复跑并记录结果：

| 验证项 | 结果 |
|---|---|
| TypeScript 全仓类型检查 | 通过 |
| Web 类型检查与生产构建 | 通过；6 个功能路由完成构建 |
| Vitest 单元/契约测试 | 15 个文件、155 个测试全部通过 |
| Boss-Forge 全量数据库迁移 | 当前库无待执行项；全新空库 12 个迁移通过，第二遍执行 0 项 |
| 数据闭环 Integration Smoke | 通过 |
| Odoo 事件 Integration Smoke | 通过；Fake-only，网络调用 0 |
| 用户 E2E | 通过；岗位、规则、任务、筛选、审核、消息预览、联系意图、计划和审计完整闭环 |
| Odoo 19 官方运行时 Addon 测试 | 全新库一次安装四个 Addon；32/32 通过，0 failed、0 errors |
| Compose 渲染与真实联系安全门检查 | 通过；默认 7 个服务、可选读/筛后 8 个，数据库 0 主机端口、Real Worker 0 |
| XML、Python、Manifest 静态检查 | 通过；4 个 Manifest、15 个 XML，Python compileall 通过 |
| 凭据与 Git 忽略检查 | 通过；腾讯云运行凭据仅在被忽略的 `.env`，提交内容无 AKID 模式，`.env` 未被跟踪 |
| Docker 镜像实际构建 | 配置已通过；两次拉取 Docker Hub `node:22-bookworm-slim` token 均因外部网络超时，未完成镜像层构建 |
| 真实打招呼 | 未执行，执行数 0 |

## 5. 本轮明确未交付

- R5 的 BOSS 回复同步、面试活动自动化和跨岗位候选人运营。
- R6 的完整招聘分析、告警、历史数据正式迁移和旧控制面退役。
- 真实自动打招呼的生产启用与真实副作用测试；在接入权威 BOSS 账号健康数据源前继续失败关闭。
- 已投递授权后的撤销/Do-Not-Contact 实时同步与 `candidate.contact.revoked.v1` 执行闭环。
- 拖拽式无代码规则树编辑器；本轮交付的是严格 JSON 校验、Odoo 表单、版本发布和执行闭环。
- 可选规则（`required=false`）的评分权重和录用阈值，仍需 HR 确认产品语义后实现。
- HR 批准的 985/211/双一流正式目录数据。
- 公网域名、TLS、公网反向代理、CDN、WAF 和公网数据库规格。
- 绕过验证码、平台风控或 BOSS 产品限制的任何能力。

## 6. 上线前业务动作

1. HR 在独立内网验收环境创建 2 名 HR、1 名负责人和至少 3 个差异岗位。
2. 导入并发布经过 HR 确认的院校目录版本，不允许开发人员凭记忆补名单。
3. 为每个 BOSS 账号配置独立 Worker 实例和相同的 `BOSS_FORGE_ACCOUNT_ID`。
4. 先用 fixture/Fake 事件完成权限、去重、规则证据、审核和模拟联系验收。
5. 如需简历预览，由业务先确认 BOSS 额度/频率，再单独启用读/筛 Worker；这不等于启用真实联系。
6. R0-R4 验收期间保持 Odoo `contact_transport_mode=fake`、`real_contact_enabled=False` 和 Compose 的真实联系开关为 `0`。

## 7. 关联文档

- [详细重构设计](ODOO_COMMUNITY_REFACTOR_PLAN.md)
- [内网部署、升级与验收运行手册](ODOO_REFACTOR_RUNBOOK.md)
- [boss-cli 能力复用清单](BOSS_CLI_REUSE_MATRIX.md)
- [原 M1/M2 验收清单](M1_M2_ACCEPTANCE.md)
