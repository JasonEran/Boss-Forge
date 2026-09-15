# Boss-Forge

Boss-Forge 是面向内网 HR 团队的自研招聘控制面，通过 `boss-cli` 读取 BOSS 候选人，执行版本化规则筛选、简历预览/OCR、人工审核和受控联系。

项目不依赖 Odoo。Web 是唯一 HR 控制面；API、PostgreSQL 和 Worker 负责业务事实、队列与外部执行。

## 当前状态

总体结论：**基本够用**，适合有人值守的小团队内网使用；BOSS 登录、风控和写后不确定状态仍需要管理员处理。

- 已实现面向内网小团队的岗位、版本化规则、任务、逐任务候选人、简历/OCR、证据解释、人工审核、消息模板/预览、运行状态与审计控制面。低频的流程、分析、团队和自动化能力通过模块内 Tab 保留，不要求普通 HR 先理解全部治理概念。
- 语义提取器默认关闭，当前只允许 `off` 或 `shadow`；影子结果可查看但不会改变通过/淘汰。旧 active 准入不能代表真实 criterion/rubric，已由编译期总闸和 migration 024 禁用。生产语义连接现为关闭且凭据为空，轮换提供方凭据后也只能先恢复 shadow。
- 当前工作树已交付两个独立的真实动作：岗位专属招呼语预览后“一键打招呼”，以及正文预览后“发送消息”。两个动作各自生成候选人级短效签名许可，逐字绑定候选人、BOSS 发件账号、岗位、任务、稳定定位和精确正文；每次许可只允许对应动作的一次外部写。缺少可核验回执时进入“待人工核验”且不自动重试。
- release `audit-events-20260904-1614cst` 已部署，真实 greet/message runtime 已开启；全局和部门联系控制仍保持 safe-off，因此不会领取或执行联系动作。BOSS 会话沿用原持久化 volumes 且为 `authenticated`；联系队列、intent、attempt 和 authorization 均为 0，没有发生真实写入。
- 当前没有同时满足联系条件和人工审核通过的候选人，所以尚未执行首次真实 canary。首次动作前仍必须展示具体动作、候选人、BOSS 发件账号、岗位/任务和完整正文，并取得用户对该组合与正文的精确许可。
- 当前工作树最新全量回归为 523 项单元测试通过；migration 001–026、隔离数据集成和隔离用户/联系 E2E 均通过。隔离 E2E 明确断言没有真实 BOSS 写入；类型检查、Web lint 和生产构建也通过。

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

打开 `http://localhost:3000`。仅在本地开发且没有 `boss-login` 或其他进程占用同一浏览器 profile 时，才可在独立终端启动：

```bash
pnpm m1:worker
```

简历预览默认关闭；开启前请先阅读 [本地开发与验证](docs/LOCAL_DEVELOPMENT.md)。登录、验证、风控或运行状态不一致时立即停止 Worker，不得靠反复刷新二维码或重建 profile 恢复。

## 页面

界面按角色展示 7 个一级模块；现有 14 个页面 URL 保留为模块子页和深链接，不再平铺在主导航：

- 工作台：`/`
- 岗位设置：岗位信息、当前生效规则、待发布版本和规则编辑统一在 `/positions`；旧 `/rules`、`/semantic` 自动回到岗位页
- 任务与计划：`/tasks`
- 候选人：候选人审核 `/candidates`、招聘流程 `/pipeline`
- 联系：联系与模板 `/contacts`、自动联系 `/automation`
- 招聘运营：运营工作台 `/operations`、数据分析 `/analytics`
- 系统设置：团队与权限 `/team`、BOSS 扫码/会话状态 `/boss-login`、审计与安全 `/audit`

面试官只显示工作台和候选人；HR 不显示系统设置；招聘负责人和管理员显示全部模块。服务端岗位权限仍独立校验，隐藏导航不作为授权边界。

## 常用验证

```bash
pnpm typecheck
pnpm lint:web
pnpm test
pnpm test:integration:data
pnpm test:e2e:user
pnpm web:build
```

隔离 E2E 必须输出 `realGreetingExecuted: false`；这证明测试没有真实写入，不替代首次真实 canary 验收。

## 文档

- [文档索引](docs/README.md)
- [产品需求](docs/PRODUCT_REQUIREMENTS.md)
- [当前实现状态](docs/CURRENT_STATUS.md)
- [2026-09-04 修复与复验报告](docs/REMEDIATION_REPORT_2026-09-04.md)
- [2026-09-04 产品审计快照与修复后复验](docs/PRODUCT_AUDIT_2026-09-04.md)
- [系统架构](docs/SYSTEM_ARCHITECTURE.md)
- [本地开发与验证](docs/LOCAL_DEVELOPMENT.md)
- [Ubuntu 内网部署](docs/INTRANET_DEPLOYMENT.md)
- [boss-cli 集成边界](docs/BOSS_CLI_INTEGRATION.md)
- [自研产品路线图](docs/ROADMAP.md)
- [前端设计系统](design-system/boss-forge/MASTER.md)

## 安全边界

- `preview` 会访问真实简历并可能消耗平台预览额度；默认关闭。
- 常规浏览器验收停在消息预览/取消；只有显式隔离测试才允许创建 mock 联系 fixture。
- 真实联系必须同时满足已验收编译能力、`BOSS_FORGE_CONTACT_DISPATCH_MODE=real`、独立运行开关、至少 32 字节的预览签名密钥、Worker 启动确认以及候选人级短效许可；默认配置不能发送。任何无权威回执的写后结果都禁止自动重试。
- 语义结果只以 shadow 方式保存，不得作为正式筛选结论。
- BOSS 登录目录和 boss-cli 数据必须使用已有 external volume；不得清空、复制、重建或用新卷试错，也不得用反复刷新二维码代替恢复。
- 不实现绕过验证码、平台风控或产品额度的能力。
