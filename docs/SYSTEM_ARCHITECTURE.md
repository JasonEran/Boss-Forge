# Boss-Forge 系统架构

> 架构版本：2026-09-04 修复版
>
> 范围：当前纯自研 R1–R6 内网控制面；生产 release `audit-events-20260904-1614cst` 已包含双动作真实联系交付，runtime real、全局/部门控制 safe-off；运行事实以 [CURRENT_STATUS.md](CURRENT_STATUS.md) 为准

## 1. 架构结论

Boss-Forge 是一个模块化单体加独立 Worker 的内网系统：

- Web 是唯一 HR 控制面。
- Control API 是唯一面向浏览器的业务写入口；Worker 通过同一数据层 Repository 回写执行结果。
- PostgreSQL 是岗位、规则、任务、候选人、审核、联系和审计的事实来源。
- BOSS Worker 是唯一 BOSS 页面读取/简历预览执行面。
- Contact Worker 只消费联系 Outbox；Fake Worker 仅供显式隔离演练。Real Worker 仅能由已认证的 `boss-login` supervisor 在全部门禁一致时启动，并通过私有 Unix socket 串行复用同一浏览器会话。
- `boss-cli` 仍负责候选人列表、简历预览等页面操作；Boss-Forge 负责 Chromium 生命周期、只读 CDP/DOM 会话探针、二维码截图和 Worker 监督，不另写候选人抓取选择器。

当前不使用 Odoo、Redis、Kafka、对象存储或微服务编排。

## 2. 组件图

```text
HR Browser
    |
    | HTTP :3000
    v
Web (Vinext/React)
    |
    | JSON HTTP :3100
    v
Control API (Node.js)
    |
    +-----------------------------+
    |                             |
    v                             v
PostgreSQL                    BOSS/Contact queues
    ^                             |
    |                             +---- BOSS Worker ---- boss-cli/Chromium
    |                             |                         |
    |                             |                         +---- BOSS
    |                             |                         +---- Tencent OCR
    |                             |
    +-----------------------------+---- Contact Worker
                                      +-- Fake（隔离演练）
                                      +-- Real（受控 greet/message，经 supervisor 私有 IPC）
```

## 3. 代码模块

| 路径 | 职责 |
|---|---|
| `apps/web` | 7 个角色化一级模块、14 个可深链接页面路由；相关能力通过模块 Tab 分组 |
| `apps/control-api` | HTTP API、请求校验、错误映射、E2E 和种子数据 |
| `apps/boss-worker` | M0 诊断、M1 任务/计划 Worker、简历 OCR、联系 Worker |
| `packages/boss-cli-adapter` | 命令构建、风险分类、版本检查和 stdout 解析 |
| `packages/rule-engine` | TEM8/英语等级、院校目录、确定性条件与基础证据归一 |
| `packages/m1-core` | 候选人规则评估和组合规则执行 |
| `packages/semantic-engine` | 同义词归一、OpenAI 兼容事实提取、严格 Schema/证据校验和失败关闭 |
| `packages/contact-policy` | 联系开关、时段、限额、冷却和熔断判定 |
| `packages/data` | PostgreSQL 迁移、Repository、租约、幂等、Outbox 和审计 |
| `packages/contracts` | Worker 心跳、BOSS 结果和内部事件类型 |

## 4. 运行流程

### 4.1 岗位与规则

1. Web 通过 API 创建岗位。
2. Web 将结构化表单转换为 schema 1.0 确定性规则树；存在语义叶子时使用 schema 1.1。
3. API 严格校验规则字段、深度、节点数、取值和目录快照。
4. Repository 创建 Draft；负责人/管理员审批后才把 `rule_sets.active_version_id` 指向 Published 版本。
5. 已发布配置由数据库触发器禁止原地修改；任务保存创建时的规则版本 ID。

普通 HR 在 `/positions` 的岗位规则弹窗使用业务字段；旧 `/rules`、`/semantic` 保留兼容跳转。后端仍保留嵌套 AND/OR/NOT、模板、回放和回滚能力，低频治理不单独占据主导航。

### 4.2 立即与定时筛选

```text
Web 创建任务/计划
  -> API 校验幂等键、岗位和来源
  -> PostgreSQL 保存规则版本快照
  -> M1 Worker 物化到期计划
  -> Worker 使用 FOR UPDATE SKIP LOCKED + 租约领取任务
  -> boss-cli recommend/search
  -> 解析、稳定指纹去重、卡片规则初筛
  -> 命中/歧义/信息不足候选人排入简历精筛
  -> 可选 boss-cli preview + OCR
  -> 同义词归一；未解决的语义条件可调用服务端模型并保存 shadow 结果
  -> 严格校验结构、原文证据和置信度
  -> 组合规则重评估并保存叶子证据
  -> waiting_review 或 completed
```

简历预览由 `BOSS_FORGE_RESUME_PREVIEW_ENABLED=1` 单独开启。使用腾讯云时，Worker 读取 `boss-cli` 生成的截图并调用 `GeneralBasicOCR`；使用 boss 模式时由 `boss-cli` 自己执行 OCR。

### 4.3 人工审核

1. Web 获取候选人详情和当前 `stateVersion`。
2. HR 查看卡片原文、OCR、规则证据、英语等级和历史审核。
3. 提交审核时携带幂等键与 `expectedVersion`。
4. Repository 锁定候选人岗位状态；版本不一致返回 409。
5. 保存 `reviews`、更新岗位状态并写入 `audit_logs`。
6. 审核通过时将筛选中/待审核申请同步推进到“已通过”；审核拒绝时同步进入“已淘汰”。待审核申请不能绕过审核推进到后续阶段。

### 4.4 联系

当前工作树的产品流程是：

1. 仅审核通过且具有稳定 BOSS locator 的候选人可以进入联系预览。
2. “一键打招呼”从当前 BOSS 岗位读取精确招呼语；“发送消息”按当前岗位模板版本重新渲染正文，两者互不触发。
3. 服务端分别签发候选人级短效许可，绑定动作、操作者、BOSS 发件账号、浏览器 profile、候选人 locator、岗位、任务、模板/provider 标识和精确正文哈希。
4. HR 对当前动作的候选人、账号和完整正文逐字核对并确认后，API 才能建立该动作的单次意图。
5. Worker 在全局 fence 内再次核对许可、对象、登录、四级开关、DNC、额度、时段、冷却和历史/并发意图，只执行一次外部写。
6. greet 必须核验 BOSS start-chat 响应与请求正文；message 必须核验 Vue 消息流中本次 client/server message ID 和 delivered 状态。无法确认时进入 `uncertain`，不自动重试。

Fake 联系状态机仍用于显式隔离且允许 mock contact fixture 的测试：创建时会重验 candidate、position、task、模板、DNC 和 locator，一次性 Fake Worker 记录 `simulated`。它不是默认 E2E 的必经步骤。

当前编译能力 `REAL_CONTACT_TRANSPORT_AVAILABLE=true` 只表示代码路径存在，不等于运行授权。默认 `disabled`；真实运行还必须同时启用精确 real 模式、兼容总闸、至少 32 字节部署签名密钥、supervisor 启动确认以及候选人级短效许可。M0 不提供绕过许可的 greet/send 命令。

## 5. 规则模型

当前兼容两种配置：

- Legacy：`requiredCapabilities: [{ capability: "tem8", minimumConfidence }]`。
- Composite schema 1.0：根规则组 + 确定性叶子节点。
- Composite schema 1.1：兼容 1.0，并增加 `semantic` 叶子节点。

叶子类型包括：

- `tem8` 或 `capability/tem8`。
- `range/yearsOfExperience`。
- `keyword`、`enum`、`text`。
- `education_level`。
- `institution_category`。
- `semantic`：`normalized_entity` 或 `semantic_rubric`，包含稳定条件 ID、事实类型、阈值和缺失策略。

组节点支持 `AND`、`OR`、`NOT` 及兼容的 `all/any`。缺失字段策略为 `manual_review`、`fail` 或 `ignore`。

BOSS `985`、`211`、`双一流`使用 `enum(field=bossPlatformTags)`，只匹配适配器从候选人卡片提取的显式标签。

### 5.1 通用语义层

通用语义层位于 OCR/卡片解析与规则引擎之间，将跨岗位的自然语言表达转换为可审计事实：

```text
Card/OCR text
  -> deterministic parser + alias catalog
  -> model extractor for unresolved/ambiguous text
  -> JSON Schema validator
  -> normalized facts + evidence
  -> versioned rule/rubric evaluator
  -> matched | not_matched | unknown
```

岗位条件按执行方式分为 `platform_tag`、`deterministic`、`normalized_entity` 和 `semantic_rubric`。大模型不替代规则树：它为 `normalized_entity` 补充事实提取，并按版本化 rubric 评估只能通过上下文判断的条件。数值、学历、平台标签等硬条件仍由确定性规则执行。

当前持久化的规范化评估至少包含：

```json
{
  "criterionId": "criterion-id",
  "factType": "team_management",
  "normalizedValue": { "teamSize": 12 },
  "qualifier": "led",
  "evidence": ["负责12人研发团队的排期、绩效和交付"],
  "confidence": 0.93,
  "sourceSnapshotId": "snapshot-id",
  "extractor": "llm",
  "extractorVersion": "model/prompt/catalog version"
}
```

执行边界：

- 模型仅接收完成筛选所需的卡片/OCR文本，输出必须通过严格 Schema 校验。
- 无证据、低置信度、冲突或解析失败统一降级为 `unknown/manual_review`。
- 原文快照、模型、提示词、语义目录、rubric 和最终规则版本必须一起留存，保证回放。
- HR 纠正写入审核事实和评估数据集，不在线自学习、不静默修改已发布规则。
- 大模型不得生成或覆盖 BOSS 985/211/双一流标签，也不得推断岗位无关的敏感属性。
- 部署只允许管理员配置的内网模型端点；凭据只进入 Worker/服务端，不进入 Web。

模型连接总开关为 `BOSS_FORGE_SEMANTIC_ENABLED`；岗位只允许 `off` 或 `shadow`，并与已发布目录版本一起进入任务快照。Worker 不再读取全局模式环境变量。已发布目录中的常见写法可补充确定性别名；shadow 结果保存供核对但不影响通过/淘汰，off 也不会让纯语义条件误判为通过。`SEMANTIC_ACTIVE_DECISIONS_AVAILABLE=false`，migration 024 将存量 active 降为 shadow 并收紧数据库约束。模型不可用、格式错误或证据不在原文时统一降级为 `unknown`。

部门目录审批、固定历史评估集、规则回放和模型效果指标已实现。仓库没有真实模型端点和岗位金标数据；旧 alias substring 分数也不代表 production criterion/rubric。因此控制面与 shadow 可用不等于真实模型效果已验收，更不允许恢复 active。

## 6. 状态机

### 6.1 任务

`queued -> running -> screening -> waiting_review -> completed`

异常终态为 `failed` 或 `cancelled`。旧迁移最初没有 `screening`，后续迁移已经补充。

### 6.2 简历精筛

`not_requested -> queued -> processing -> screened`

异常终态为 `no_text` 或 `failed`；HR 可以重新排队失败项。

### 6.3 候选人审核

`pending -> approved | rejected`

被规则直接筛除的 Dashboard 记录可显示为兼容状态 `not_required`。

### 6.4 联系意图

隔离 Fake 状态机为 `ready -> processing -> simulated`。真实 greet/message 分别使用 `ready -> processing -> sent | failed | uncertain`，另保留 `cancelled`；两个动作按 `candidate_position_state_id + action_kind` 独立去重。常规隔离 E2E 不创建真实联系意图。

## 7. 数据模型

### 7.1 核心业务表

| 聚合 | 表 |
|---|---|
| 岗位/规则 | `positions`、`rule_sets`、`rule_versions` |
| 任务/候选人 | `tasks`、`task_commands`、`candidates`、`candidate_snapshots`、`candidate_position_states` |
| 证据/审核 | `match_evidence`、`semantic_evaluations`、`reviews` |
| 简历精筛 | `candidate_position_states` 的精筛列和截图引用 |
| 定时计划 | `schedules` |
| 消息/联系 | `message_templates`、`template_versions`、`contact_settings`、`contact_intents`（含 `action_kind`）、`contact_attempts` |
| 限额/队列 | `quota_counters`、`contact_quota_reservations`、`outbox_events` |
| 审计 | `audit_logs` |
| 部门身份/权限 | `departments`、`users`、`user_sessions`、`position_members` |
| 招聘管道/协作 | `pipeline_stages`、`candidate_activities`、`candidate_notes`、`candidate_attachments`、`work_items`、`interviews`、`interview_feedback` |
| 规则治理 | `rule_templates`、`rule_template_versions`、`rule_replay_runs` 及 `rule_versions.lifecycle_status` |
| 语义治理 | `semantic_catalogs`、`semantic_catalog_versions`、`semantic_evaluation_sets/cases/runs` |
| 招聘运营 | `inbound_messages`、`talent_tags`、`candidate_talent_tags`、`account_health`、`operational_alerts`、`data_export_jobs` |
| 自动联系控制 | `contact_controls`、`contact_approval_requests`、`do_not_contact` |

### 7.2 身份与去重

`candidates.fingerprint` 全局唯一并优先基于稳定 BOSS locator。migration 023 后，`candidate_position_states(latest_task_id, candidate_id)` 唯一；字段 `latest_task_id` 为兼容旧 API 保留名称，语义已经是不可移动的 owning task。部分唯一索引只允许同一岗位/候选人有一个当前任务 state。同一自然人可跨岗位、跨任务共享身份，但每个任务独立保存规则、快照、证据、审核和联系状态。

`message_templates.position_id` 使用部分唯一索引保证每个岗位最多一个模板聚合；模板正文保存在不可变的 `template_versions` 中。消息预览优先选择岗位模板，没有岗位模板时回退到部门默认模板。

### 7.3 历史兼容

迁移 `006`–`012` 曾为外部控制面试验增加集成 Inbox/Outbox、映射和可空外部 ID。运行时已删除相应 API 和同步 Worker，但不能重写已经执行过的迁移。migration 023 修复逐任务历史、计数、归属约束和登录歧义；024 将语义限制为 shadow-only；025 清理取消任务的可执行简历状态；026 拆分 greet/message 并增加动作级 provider 标识与去重。所有已应用 SQL 以 SHA-256 对账，后续修复也只能增加新迁移。

## 8. HTTP API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 数据库健康检查 |
| POST/GET | `/api/auth/login`、`/api/auth/me` | 部门会话 |
| GET/POST | `/api/team/users` | 部门成员管理 |
| GET | `/api/pipeline` | 岗位授权后的分页候选人管道 |
| GET/POST | `/api/collaboration/*` | 时间线、附件、待办、面试和反馈 |
| GET/POST | `/api/rules/*` | 草稿、审批、模板、回放和回滚 |
| GET/POST | `/api/semantic/*` | 目录、评估集、指标和模式门禁 |
| GET/POST | `/api/operations/*` | 回复、人才库、健康、告警和导出 |
| GET/POST | `/api/automation/*` | 多级开关、审批、就绪检查和 Fake 演练 |
| GET | `/api/dashboard` | Dashboard 聚合快照 |
| GET/POST | `/api/positions` | 查询/创建岗位 |
| PATCH | `/api/positions/:id` | 编辑岗位名称、BOSS 岗位关键词和负责人，并增加岗位版本 |
| GET | `/api/message-templates` | 查询当前用户可访问岗位的生效消息模板和继承状态 |
| POST | `/api/positions/:id/message-template` | 为岗位创建并启用新的消息模板版本 |
| POST | `/api/positions/:id/rules` | 兼容入口：只创建规则草稿 |
| POST | `/api/tasks` | 创建立即任务 |
| POST | `/api/tasks/:id/cancel`、`/api/tasks/:id/retry` | 以幂等键和 expectedVersion 取消/恢复任务 |
| POST | `/api/schedules` | 创建定时计划 |
| POST | `/api/schedules/:id/cancel` | 乐观锁停用计划 |
| GET | `/api/candidate-position-states/:id` | 候选人详情 |
| POST | `/api/candidate-position-states/:id/resume-screenings` | 重排简历精筛 |
| POST | `/api/candidate-position-states/:id/reviews` | 审核候选人 |
| GET | `/api/candidate-position-states/:id/greet-preview` | 读取岗位精确招呼语并返回动作级预览/短效许可；读取失败不签发许可 |
| GET | `/api/candidate-position-states/:id/message-preview` | 渲染正文并返回动作级预览/短效许可 |
| POST | `/api/candidate-position-states/:id/contact-intents` | 显式创建一个 greet 或 message 意图；真实模式必须提交匹配该动作当前预览的许可和人工确认 |
| GET | `/api/boss-login/status`、`/api/boss-login/image` | 管理员只读查看登录/Worker 状态与当前一次性画面 |
| POST | `/api/boss-login/refresh` | 管理员显式请求刷新一次二维码；页面不会自动刷新 |

业务 API 均要求 Bearer 会话。岗位资源在服务端检查成员关系；招聘负责人/管理员具有部门管理权限。任务、审核、计划和联系等副作用请求继续使用幂等键。

## 9. 并发与恢复

- 任务使用数据库行锁、`FOR UPDATE SKIP LOCKED`、租约、claim token 和 fencing。
- 候选人审核、任务取消/重试、计划取消使用幂等键、版本号和行锁。
- 候选人快照、任务、计划和联系意图具有幂等唯一键。
- 联系通过事务性 Outbox 解耦浏览器请求和 Worker 副作用。
- Fake stale 任务可恢复；Real 超时结果不得自动重发，应进入 `uncertain`。

## 10. 部署

Ubuntu 内网 Compose 默认包含：

- `postgres`
- `postgres-backup`
- `migrate`
- `api`
- `web`

`gateway`、`contact-worker-fake`、`boss-login` 和 legacy `boss-worker` 均通过 profile 显式启用；`boss-login` 是当前受支持的会话监督入口。浏览器 profile 与 boss-cli 数据必须指向预先确认的 external volume。PostgreSQL 无主机端口，Web/API 默认绑定回环地址；可选 TLS gateway 用于跨公网访问。默认部署固定关闭真实联系；real 配置缺任一门禁时预检和 Worker 都失败关闭。

历史 `boundaryfix-20260904-1043cst` 部署曾让 `boss-login` 保持停止，以避免领取当时 17 份 queued 简历；该段只说明此前的页面验收和安全决策。当前 `audit-events-20260904-1614cst` 已部署，沿用原 worker runtime、browser profile 和 boss-cli data volumes，BOSS 为 `authenticated`；真实联系 runtime 已启动但全局/部门控制 safe-off，联系数据为 0。

## 11. 安全现状

已实现：

- 简历预览与联系开关分离。
- 外部命令参数化执行，不拼接 Shell。
- 账号级本地锁、Worker 租约和候选人身份重验。
- 联系时段、限额、冷却、幂等和不确定结果状态。
- `.env` 与浏览器数据目录不进 Git。

新增的部门安全边界包括密码会话、四角色、岗位级数据隔离、账号停用、当前用户审计、多级联系控制、账号健康、DNC、紧急停止、候选人级短效签名许可和跨动作全局写入 fence。会话以精确 zhipin.com 域名、只读 DOM、Chromium/CDP 和 Worker 心跳交叉检查；不一致时停止外部任务。当前定位为内网产品，可选独立 TLS gateway，但不提供公网 SaaS/WAF 规格。Real Worker 已生产部署；当前控制 safe-off、联系数据为 0，尚未执行首次真实 canary。

## 12. 测试分层

- 单元/契约最新全量回归：523 项通过；双动作许可、全局写入 fence、回执、不确定状态、语义、只读简历与 API 同源回退定向回归均已计入，不重复相加。
- 数据集成：`pnpm test:integration:data`，使用真实 PostgreSQL。
- 历史迁移：一次性隔离 PostgreSQL 从 001 到 026；其中 contact fixture 仅验证数据约束，不启动真实 BOSS 浏览器、不执行外部联系。
- 用户 E2E：`pnpm test:e2e:user` 调用与 Dashboard 相同的 API，默认不创建联系数据；浏览器验收到消息预览后取消。
- Web：类型、Oxlint 和生产构建。
- 部署：Compose 的默认/real 渲染、external volume、并发 profile、资源限制、不可变 release、签名密钥和真实联系失败关闭检查。release `audit-events-20260904-1614cst` 已生产部署；BOSS authenticated 且沿用原 volumes，联系控制 safe-off、联系数据为 0，首次真实 canary 未执行。
