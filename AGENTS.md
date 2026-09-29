# AGENTS.md — Boss-Forge

给 **Codex / Cursor 等 AI 代理** 与 **非编程继任运维** 的短操作手册。入口见 [文档索引](docs/README.md)、[当前状态](docs/CURRENT_STATUS.md)和[运维手册](docs/OPERATIONS_RUNBOOK.md)；本文件只写红线与最短路径。

本地 Mac 路径 `/Users/jasoneran/Boss-Forge` **仅开发用**，不是部署目标。

---

## 1. 项目是什么

Boss-Forge：内网 HR 控制面，对接 BOSS 直聘做 **招聘筛简历 + 受控自动打招呼**（以及消息发送）。Web 是唯一 HR 界面；不依赖 Odoo。

---

## 2. 禁止 / 先问人

**默认不要做；必须先问 Jason（或继任负责人）：**

- 对 `main` 随意 force-push、改写历史
- 删除 / 清空生产数据、登录卷、boss-cli 数据卷、deep-clean（除非明确授权）
- 改库表 schema / 新增 migration（先说明影响再动手）
- 绕过或对抗 BOSS 风控、验证码、额度；反复刷二维码「硬恢复」
- 在未授权时把联系模式切到真实发送、或对真人发招呼/消息

**风险 / 扫码 / BOSS 安全验证：必须人处理。** 代理可观察与提示，不可代扫、不可代替人过风控。

不要把 SSH 密码、密钥、`.env` 机密写进仓库或本文件。

---

## 3. 架构速览

| 路径 | 职责 |
| --- | --- |
| `apps/web` | HR 控制面（React），岗位/任务/候选人/联系/登录等 |
| `apps/control-api` | 唯一浏览器业务写入口（HTTP API、校验、审计） |
| `apps/boss-worker` | 筛选 Worker、OCR、联系 Worker、扫码/会话监督（`boss-login`） |
| `packages/data` | PostgreSQL 迁移、Repository、队列/Outbox |
| `packages/contracts` | 共享类型与限额常量（如分块大小、日招呼上限） |
| `packages/rule-engine` / `m1-core` | 确定性规则与候选人评估 |
| `packages/boss-cli-adapter` | 调 boss-cli、账号锁、风险分类 |
| `packages/contact-policy` | 联系开关、时段、限额、熔断 |
| `packages/semantic-engine` | 旧规则语义 off/shadow、招聘 AI 辅助评估 |

事实来源：**PostgreSQL**。同一 BOSS 浏览器会话由 `boss-login` 监督，读写经账号锁串行。

---

## 4. 产品硬规则

- **同账号串行**：同一 BOSS 账号上的筛选/打招呼排队执行，不要假设可并行多开浏览器。
- **`candidate_limit`**：开自动打招呼时 = **成功打招呼数**（`contact_intents` greet + `sent`）；仅筛选时 = 筛通过人数（`matched` + resume `screened`）。失败/未匹配不计。
- **日招呼上限**：默认 **200**/账号·上海自然日（`BOSS_FORGE_AUTO_GREET_DAILY_LIMIT`）。触顶会停筛并停用相关定时；属预期，勿为凑人数清计数。
- **分块**：每波最多 **20** 人（`SCREENING_CHUNK_SIZE`）：筛 →（可选）自动打招呼 → continue。
- **立即开始对话框**：有「自动打招呼」开关，**只影响该次立即任务**；关 = 只筛不招呼。定时计划另有自己的开关。

---

## 5. 部署

| 项 | 值 |
| --- | --- |
| 服务器 | `106.12.106.113` |
| 目录 | `/opt/boss-forge`（当前 release：`/opt/boss-forge/current`） |
| Compose | `/opt/boss-forge/deploy`（`compose.intranet.yaml` + `.env.intranet`） |
| 健康检查 | `curl -sS http://127.0.0.1:3100/health` |

健康检查关注：`releaseId`（应对齐已部署的 Git SHA / 发布号）、`contactDispatchMode`（生产期望 **`real`**）。代码发版后核对 live SHA 与本次批准的应用提交是否一致（后续纯文档提交可领先生产）；**纯文档变更可只合入 GitHub，不必强求立刻部署**。

---

## 6. 常见故障

| 现象 | 怎么做 |
| --- | --- |
| 二维码 Waiting / 刷新失败、「二维码暂时不可用」 | Web「BOSS 登录」页点 **「重新连接扫码服务」**（恢复浏览器连接并保留已选微信 / BOSS App 方式）。仍要扫码时 **通知人** 使用对应应用，代理不可代扫。 |
| `risk_controlled` / 安全验证文案 | **人** 在 BOSS 官方页完成验证；确认后再重启 `boss-login` 续跑。未验证时不要反复硬重启。 |
| 日上限 200 停机 | 预期停机；有余下 `ready` 招呼可在 Worker 健康时发完，不要强行重开定时凑筛选。 |
| `uncertain` 打招呼堵队列 | 核对岗位/账号后，对确认未发出的走产品核验（如 `verify-not-sent`）；不要无回执自动重试。 |

换账号后同名岗位 ID 可能改变；按[账号切换与岗位恢复](docs/BOSS_ACCOUNT_SWITCH.md)核对新岗位、规则、联系控制和任务/计划，保留旧历史，不按名称自动重绑。完整排障步骤见[运维手册](docs/OPERATIONS_RUNBOOK.md)。

---

## 7. 如何验证改动

1. **本地/CI**：按[验证指南](docs/TESTING.md)选择范围；纯文档检查链接、命令、事实和 diff，不为更新文档操作真实业务。代码检查：`pnpm typecheck` · `pnpm lint:web` · `pnpm test`；涉及数据层再跑 `pnpm test:integration:data`；用户流 `pnpm test:e2e:user`（隔离 E2E 须 `realGreetingExecuted: false`）。
2. **合入**：开 PR → 合并到 `main`；记下 tip SHA。
3. **上线（代码改动）**：按 `docs/INTRANET_DEPLOYMENT.md` 部署到 `106.12.106.113`；`/health` 的 `releaseId` **匹配** 本次 main SHA（或发布号）；确认 `contactDispatchMode`。
4. **文档-only**：合入 GitHub `main` 即可；可选是否同步服务器工作树。

开发机改代码用本机仓库；**永远不要把 Mac 开发目录当成生产**。
