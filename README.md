# Boss-Forge

Boss-Forge 是面向内网 HR 团队的自研招聘控制面，通过 `boss-cli` 读取 BOSS 候选人，执行版本化规则筛选、简历预览/OCR、人工审核和受控联系。

项目不依赖 Odoo。Web 是唯一 HR 控制面；API、PostgreSQL 和 Worker 负责业务事实、队列与外部执行。

## 当前状态

- 已实现：岗位和规则版本、立即/定时筛选、推荐/搜索、候选人去重、简历精筛、TEM8 与当前英语级别、BOSS 985/211/双一流标签、通用同义词/语义条件、人工审核、消息预览、Fake 联系、审计。
- 已接入但默认关闭：OpenAI 兼容的语义事实提取器；默认影子模式，严格校验原文证据并把低置信度结果送人工复核。仓库没有配置或实测真实模型端点。
- 尚未实现：登录与部门权限、招聘阶段/面试/Offer、协作待办、语义评估数据集与目录审批、可操作的自动联系开关、回复同步、分析报表、可成功执行的产品级 Real 联系。
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
