# Boss-Forge

内网 HR 智能简历筛选与候选人联络 Dashboard。

当前文档：

- [基于 Odoo Community Recruitment 的详细重构设计](docs/ODOO_COMMUNITY_REFACTOR_PLAN.md)
- [Odoo 重构内网部署、升级与验收手册](docs/ODOO_REFACTOR_RUNBOOK.md)
- [Odoo 重构实施报告](docs/ODOO_REFACTOR_IMPLEMENTATION_REPORT.md)
- [HR Dashboard 产品需求文档](docs/HR_DASHBOARD_PRD.md)
- [系统架构设计](docs/SYSTEM_ARCHITECTURE.md)
- [M0 技术验证运行手册](docs/M0_RUNBOOK.md)
- [M1 数据闭环运行手册](docs/M1_RUNBOOK.md)
- [M2 定时筛选与受控联系运行手册](docs/M2_RUNBOOK.md)
- [M1/M2 验收清单与测试报告](docs/M1_M2_ACCEPTANCE.md)
- [两阶段交付计划](docs/TWO_PHASE_DELIVERY_PLAN.md)
- [boss-cli 能力复用清单](docs/BOSS_CLI_REUSE_MATRIX.md)
- [HR Dashboard 需求思维导图](docs/HR_DASHBOARD_MINDMAP.md)
- [Dashboard 设计系统](design-system/boss-forge/MASTER.md)

## M0 快速验证

当前重构以 Odoo 19 Community Recruitment 作为 HR 主控制面，Boss-Forge 负责 BOSS 渠道执行、规则判定、任务队列和受控联系。旧 Dashboard 与 M0/M1/M2 命令继续保留，用于本地验证、运维诊断和渐进迁移；不会在切换前删除既有能力。

```bash
pnpm install
pnpm m0:install-browser
pnpm typecheck
pnpm test
pnpm m0:doctor
pnpm m0 -- login
```

登录需要在打开的 Chrome 中人工完成。登录后可执行：

```bash
pnpm m0 -- live positions
```

简历预览和真实打招呼分别要求显式传入 `--approve-preview` 与 `--approve-greet`，详见 [M0 技术验证运行手册](docs/M0_RUNBOOK.md)。

## Dashboard 本地预览

```bash
pnpm web:dev
```

浏览器打开 `http://localhost:3000`。Dashboard 已接入 M1/M2 控制 API，可配置岗位与 TEM8 规则、立即或定时筛选、查看采集证据、人工审核、预览消息并创建受控联系任务。真实打招呼默认关闭。

前端按 HR 工作流划分为六个功能页：

- `/`：工作台总览与快捷待办
- `/positions`：岗位与筛选规则
- `/tasks`：立即任务与定时计划
- `/candidates`：候选人证据与人工审核
- `/contacts`：消息预览、联系意图与执行记录
- `/audit`：审计日志与自动化安全边界

## M1 本地数据闭环

```bash
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm m1:seed
```

分别在三个终端启动控制 API、采集 Worker 和 Dashboard：

```bash
pnpm api
pnpm m1:worker
pnpm web:dev
```

此时 Dashboard 的“立即执行筛选”会创建幂等任务，Worker 先读取推荐候选人并去重，再将候选人排入完整简历精筛队列。精筛通过 `boss-cli preview` 复用现有简历截图/OCR 能力，识别 TEM8 及候选人明确写出的 TEM4、CET4/6、IELTS、TOEFL、BEC 等证书或成绩；完成精筛后才允许 HR 审核。

岗位规则可直接选择 BOSS 的 `985`、`211`、`双一流`平台标签，并配置“满足任一”或“必须全部”。这些结论只读取 `boss-cli recommend/search` 返回的显式标签，不从学校名称、简历正文或 OCR 自行推断，也不需要导入学校名单。版本化院校目录仅保留给公司自定义白名单/黑名单等可选规则。

真实简历预览默认关闭。腾讯云通用印刷体 OCR 模式需要设置 `BOSS_FORGE_RESUME_PREVIEW_ENABLED=1`、`BOSS_FORGE_OCR_PROVIDER=tencent` 及 `TENCENTCLOUD_SECRET_ID/SECRET_KEY`；`BOSS_RESUME_OCR` 保持为 `0`，避免同时调用 `boss-cli` 内置百度 OCR。Worker 只把 `boss-cli` 生成的简历截图提交给腾讯云 `GeneralBasicOCR`，密钥只从服务端环境变量读取。简历精筛开关与真实打招呼开关完全独立。

## M2 安全边界

M2 已实现定时筛选、人工审核后的消息预览、显式联系确认、Outbox、限额/时段/冷却策略、失败与不确定结果恢复和审计日志。真实 `boss-cli greet` 执行需要 `--approve-real-greet` 与 `BOSS_FORGE_REAL_GREET_ENABLED=1` 同时存在；本轮没有进行真实打招呼测试，详见 [M2 运行手册](docs/M2_RUNBOOK.md)。

无真实发送的完整用户流程可重复执行：

```bash
pnpm test:e2e:user
```
