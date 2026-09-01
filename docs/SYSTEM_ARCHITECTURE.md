# Boss-Forge 系统架构

> 架构版本：2026-09-01 代码同步版
>
> 范围：当前纯自研控制面，不含路线图能力

## 1. 架构结论

Boss-Forge 是一个模块化单体加独立 Worker 的内网系统：

- Web 是唯一 HR 控制面。
- Control API 是唯一面向浏览器的业务写入口；Worker 通过同一数据层 Repository 回写执行结果。
- PostgreSQL 是岗位、规则、任务、候选人、审核、联系和审计的事实来源。
- BOSS Worker 是唯一 BOSS 页面读取/简历预览执行面。
- Contact Worker 只消费联系 Outbox；内网部署仅提供 Fake Worker。
- `boss-cli` 是唯一页面自动化层，Boss-Forge 不重写 BOSS 选择器和登录流程。

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
    +-----------------------------+---- Fake Contact Worker
```

## 3. 代码模块

| 路径 | 职责 |
|---|---|
| `apps/web` | 六页 Dashboard、结构化规则表单、审核和联系交互 |
| `apps/control-api` | HTTP API、请求校验、错误映射、E2E 和种子数据 |
| `apps/boss-worker` | M0 诊断、M1 任务/计划 Worker、简历 OCR、联系 Worker |
| `packages/boss-cli-adapter` | 命令构建、风险分类、版本检查和 stdout 解析 |
| `packages/rule-engine` | TEM8/英语等级、院校目录、确定性条件与基础证据归一 |
| `packages/m1-core` | 候选人规则评估和组合规则执行 |
| `packages/contact-policy` | 联系开关、时段、限额、冷却和熔断判定 |
| `packages/data` | PostgreSQL 迁移、Repository、租约、幂等、Outbox 和审计 |
| `packages/contracts` | Worker 心跳、BOSS 结果和内部事件类型 |

## 4. 运行流程

### 4.1 岗位与规则

1. Web 通过 API 创建岗位。
2. Web 将结构化表单转换为 schema 1.0 规则树。
3. API 严格校验规则字段、深度、节点数、取值和目录快照。
4. Repository 创建新 `rule_versions` 记录，并把 `rule_sets.active_version_id` 指向新版本。
5. 已存在版本不被覆盖；任务保存创建时的规则版本 ID。

当前 UI 只生成根节点 AND/OR 和常用叶子；规则引擎支持更丰富的嵌套节点。

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

### 4.4 联系

当前唯一产品流程为 Fake：

1. 仅审核通过的候选人可以预览消息。
2. 创建联系意图时重新核对当前模板版本和消息长度。
3. Repository 执行人工模式联系策略，固定写入 `transport_mode=fake`。
4. Fake Worker 领取 Outbox，记录 `contact_attempts` 并完成为 `simulated`。

Real 相关代码存在双重许可和发送前重验，但由于缺少权威 BOSS 账号健康源，Repository 固定加入阻断原因；内网 Compose 也没有 Real Worker。因此 Dashboard 产品路径不能真实发送。

M0 的显式 `greet` 命令是独立技术诊断通道，不经过 Dashboard 联系闭环。

## 5. 规则模型

当前兼容两种配置：

- Legacy：`requiredCapabilities: [{ capability: "tem8", minimumConfidence }]`。
- Composite schema 1.0：根规则组 + 叶子节点。

叶子类型包括：

- `tem8` 或 `capability/tem8`。
- `range/yearsOfExperience`。
- `keyword`、`enum`、`text`。
- `education_level`。
- `institution_category`。

组节点支持 `AND`、`OR`、`NOT` 及兼容的 `all/any`。缺失字段策略为 `manual_review`、`fail` 或 `ignore`。

BOSS `985`、`211`、`双一流`使用 `enum(field=bossPlatformTags)`，只匹配适配器从候选人卡片提取的显式标签。

### 5.1 规划中的通用语义层

以下能力尚未写入当前运行链路，属于下一阶段架构，不应被视为已经实现。

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

规划中的规范化事实至少包含：

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

`ready -> processing -> simulated`

模型还保留 `sent`、`failed`、`uncertain`、`cancelled`，但当前产品创建的意图均为 Fake，正常终态是 `simulated`。

## 7. 数据模型

### 7.1 核心业务表

| 聚合 | 表 |
|---|---|
| 岗位/规则 | `positions`、`rule_sets`、`rule_versions` |
| 任务/候选人 | `tasks`、`candidates`、`candidate_snapshots`、`candidate_position_states` |
| 证据/审核 | `match_evidence`、`reviews` |
| 简历精筛 | `candidate_position_states` 的精筛列和截图引用 |
| 定时计划 | `schedules` |
| 消息/联系 | `message_templates`、`template_versions`、`contact_settings`、`contact_intents`、`contact_attempts` |
| 限额/队列 | `quota_counters`、`contact_quota_reservations`、`outbox_events` |
| 审计 | `audit_logs` |

### 7.2 身份与去重

`candidates.fingerprint` 全局唯一；`candidate_position_states(position_id, candidate_id)` 唯一。同一自然人在多个岗位共享候选人身份，但保留独立规则、审核和联系状态。

### 7.3 历史兼容

迁移 `006`–`012` 曾为外部控制面试验增加集成 Inbox/Outbox、映射和可空外部 ID。运行时已删除相应 API 和同步 Worker，但不能重写已经执行过的迁移。清理必须通过未来的新迁移完成。

## 8. HTTP API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 数据库健康检查 |
| GET | `/api/dashboard` | Dashboard 聚合快照 |
| GET/POST | `/api/positions` | 查询/创建岗位 |
| POST | `/api/positions/:id/rules` | 创建并激活规则版本 |
| POST | `/api/tasks` | 创建立即任务 |
| POST | `/api/schedules` | 创建定时计划 |
| POST | `/api/schedules/:id/cancel` | 乐观锁停用计划 |
| GET | `/api/candidate-position-states/:id` | 候选人详情 |
| POST | `/api/candidate-position-states/:id/resume-screenings` | 重排简历精筛 |
| POST | `/api/candidate-position-states/:id/reviews` | 审核候选人 |
| GET | `/api/candidate-position-states/:id/message-preview` | 预览消息 |
| POST | `/api/candidate-position-states/:id/contact-intents` | 创建 Fake 联系意图 |

除 GET 外的重要创建请求使用 `Idempotency-Key`。当前 API 没有认证和授权中间件，这是进入部门使用前的最高优先级缺口。

## 9. 并发与恢复

- 任务使用数据库行锁、`FOR UPDATE SKIP LOCKED`、租约、claim token 和 fencing。
- 候选人审核、计划取消使用版本号和行锁。
- 候选人快照、任务、计划和联系意图具有幂等唯一键。
- 联系通过事务性 Outbox 解耦浏览器请求和 Worker 副作用。
- Fake stale 任务可恢复；Real 超时结果不得自动重发，应进入 `uncertain`。

## 10. 部署

Ubuntu 内网 Compose 默认包含：

- `postgres`
- `migrate`
- `api`
- `web`
- `contact-worker-fake`

`boss-worker` 通过 profile 显式启用。PostgreSQL 无主机端口，Web/API 默认绑定回环地址，可由运维改为固定私网 IP。部署文件固定关闭 Real greet。

## 11. 安全现状

已实现：

- 简历预览与联系开关分离。
- 外部命令参数化执行，不拼接 Shell。
- 账号级本地锁、Worker 租约和候选人身份重验。
- 联系时段、限额、冷却、幂等和不确定结果状态。
- `.env` 与浏览器数据目录不进 Git。

尚未实现：

- 用户认证、角色权限、部门数据隔离和 CSRF 策略。
- 权威账号健康状态、集中告警和正式密钥管理。
- 产品级 Real Worker 的安全验收。

因此当前系统只适合受控内网单团队使用，不能因“仅内网”而假设已有用户隔离。

## 12. 测试分层

- 单元/契约：Vitest，当前 14 文件、149 测试。
- 数据集成：`pnpm test:integration:data`，使用真实 PostgreSQL。
- 用户 E2E：`pnpm test:e2e:user`，调用与 Dashboard 相同的 API，固定无真实发送。
- Web：类型、Oxlint 和生产构建。
- 部署：Compose 渲染、服务列表和 Real Worker 缺失检查。
