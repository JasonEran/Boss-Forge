# Boss-Forge

内网 HR 智能简历筛选与候选人联络 Dashboard。

当前文档：

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

此时 Dashboard 的“立即执行筛选”会创建幂等任务，Worker 从 BOSS 读取推荐候选人，去重、评估 TEM8 规则后写入 PostgreSQL 待审核列表。

## M2 安全边界

M2 已实现定时筛选、人工审核后的消息预览、显式联系确认、Outbox、限额/时段/冷却策略、失败与不确定结果恢复和审计日志。真实 `boss-cli greet` 执行需要 `--approve-real-greet` 与 `BOSS_FORGE_REAL_GREET_ENABLED=1` 同时存在；本轮没有进行真实打招呼测试，详见 [M2 运行手册](docs/M2_RUNBOOK.md)。

无真实发送的完整用户流程可重复执行：

```bash
pnpm test:e2e:user
```
