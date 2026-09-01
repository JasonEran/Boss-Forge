# Boss-Forge

Boss-Forge 是面向内网 HR 团队的自研招聘控制面，通过 `boss-cli` 读取 BOSS 候选人，执行版本化规则筛选、简历预览/OCR、人工审核和受控联系。

项目不依赖 Odoo。Web 是唯一 HR 控制面；API、PostgreSQL 和 Worker 负责业务事实、队列与外部执行。

## 当前状态

- 已实现 R1–R6 内网控制面：部门账号/岗位权限、服务端分页检索、招聘管道、时间线/备注/附件元数据、待办/面试反馈、跨岗位档案、Do-Not-Contact、可视化嵌套规则、规则生命周期/模板/回放/回滚、语义目录/评估集/生效门禁、BOSS 回复、人才库/健康/告警/导出、分析报表和自动联系多级开关/审批/紧急停止。
- OpenAI 兼容语义提取器仍默认影子模式；确定性同义词和固定评估集可直接运行，真实内网模型端点需要由管理员配置并另行做岗位效果验收。
- 自动联系目前是 Fake-only：产品可以配置和演练 R6 就绪条件，但不能执行真实打招呼。
- 真实打招呼未测试；内网 Compose 没有 Real Worker，固定 `BOSS_FORGE_REAL_GREET_ENABLED=0`。
- 当前验证基线：17 个测试文件、164 个测试通过；数据集成和 Fake-only 用户 E2E 通过。

完整状态见 [当前实现状态](docs/CURRENT_STATUS.md)。

## 本地启动

要求 Node.js 22+、pnpm 11 和 Docker。

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm m1:seed
```

分别启动 API 与 Web：

```bash
pnpm api
pnpm web:dev
```

打开 `http://localhost:3000`。需要读取 BOSS 时，再在独立终端启动：

```bash
pnpm m1:worker
```

简历预览默认关闭；开启前请先阅读 [本地开发与验证](docs/LOCAL_DEVELOPMENT.md)。

## 页面

- `/`：工作台总览
- `/positions`：岗位和结构化规则
- `/tasks`：立即任务与定时计划
- `/candidates`：筛选结果、证据和人工审核
- `/contacts`：消息预览、Fake 联系意图和结果
- `/audit`：审计与安全状态
- `/team`：部门成员、岗位协作者与阶段配置
- `/pipeline`：招聘管道、协作时间线和跟进
- `/rules`：嵌套规则、审批、模板、回放和回滚
- `/semantic`：语义目录、HR 评估集和生效门禁
- `/operations`：回复、人才库、账号健康、告警和导出
- `/automation`：多级开关、审批、紧急停止和 Fake 演练
- `/analytics`：招聘漏斗与来源分析

## 常用验证

```bash
pnpm typecheck
pnpm lint:web
pnpm test
pnpm test:integration:data
pnpm test:e2e:user
pnpm web:build
```

`test:e2e:user` 必须输出 `realGreetingExecuted: false`。

## 文档

- [文档索引](docs/README.md)
- [产品需求](docs/PRODUCT_REQUIREMENTS.md)
- [当前实现状态](docs/CURRENT_STATUS.md)
- [系统架构](docs/SYSTEM_ARCHITECTURE.md)
- [本地开发与验证](docs/LOCAL_DEVELOPMENT.md)
- [Ubuntu 内网部署](docs/INTRANET_DEPLOYMENT.md)
- [boss-cli 集成边界](docs/BOSS_CLI_INTEGRATION.md)
- [自研产品路线图](docs/ROADMAP.md)
- [前端设计系统](design-system/boss-forge/MASTER.md)

## 安全边界

- `preview` 会访问真实简历并可能消耗平台预览额度；默认关闭。
- Dashboard 创建的联系意图固定为 Fake，不会发送真实招呼。
- M0 诊断命令包含显式批准的真实 `greet` 通道，只供人工技术验证；未经单独授权不得运行。
- 不实现绕过验证码、平台风控或产品额度的能力。
