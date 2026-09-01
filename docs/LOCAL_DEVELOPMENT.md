# Boss-Forge 本地开发与验证

## 1. 环境要求

- macOS 或 Linux。
- Node.js 22+。
- pnpm 11.22.0（仓库 `packageManager` 已锁定）。
- Docker Desktop/Engine 与 Compose v2。
- 运行真实 BOSS 读取时需要 Chromium/Chrome、已登录的 BOSS 会话和 `@joohw/boss-cli` 0.6.6。

## 2. 初始化

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm m1:seed
```

本地 PostgreSQL 只绑定 `127.0.0.1:55433`。迁移是幂等的；不要修改已经执行过的迁移文件。

`m1:seed` 创建“当前登录岗位”、Legacy TEM8 规则和默认人工联系模板，不代替正式业务数据导入。

## 3. 启动 Web 与 API

终端一：

```bash
pnpm api
```

终端二：

```bash
pnpm web:dev
```

访问：

- Web：`http://localhost:3000`
- API：`http://127.0.0.1:3100`
- 健康检查：`http://127.0.0.1:3100/health`

Web 默认请求 `http://127.0.0.1:3100`；可通过构建时环境变量 `NEXT_PUBLIC_CONTROL_API_URL` 修改。

## 4. BOSS 登录与只读诊断

安装项目私有 Chrome for Testing：

```bash
pnpm m0:install-browser
```

检查 boss-cli、Chrome 和心跳：

```bash
pnpm m0:doctor
pnpm m0:heartbeat
```

M0 脚本不会自动读取 `.env`。如需自定义账号、浏览器目录或真实操作开关，应由 Shell/进程管理器显式加载环境变量。

打开登录页并人工登录：

```bash
pnpm m0 -- login
```

只读命令：

```bash
pnpm m0 -- live positions
pnpm m0 -- live recommend --job "岗位名称"
pnpm m0 -- live search --keyword "TEM8"
```

## 5. 启动筛选 Worker

```bash
pnpm m1:worker
```

Worker 每轮先物化到期计划，再按账号领取筛选任务。它使用任务创建时绑定的规则版本，不读取页面临时状态。

默认环境：

```text
BOSS_FORGE_RESUME_PREVIEW_ENABLED=0
BOSS_FORGE_OCR_PROVIDER=tencent
BOSS_RESUME_OCR=0
```

关闭简历预览时，Worker 仍会采集卡片、去重和执行可由卡片证据完成的规则；需要完整简历的候选人会保留精筛队列状态。

## 6. 简历预览与 OCR

`preview` 会打开真实候选人简历，并可能消耗平台预览额度。只在业务确认额度与频率后启用：

```text
BOSS_FORGE_RESUME_PREVIEW_ENABLED=1
```

腾讯云模式：

```text
BOSS_FORGE_OCR_PROVIDER=tencent
BOSS_RESUME_OCR=0
TENCENTCLOUD_SECRET_ID=...
TENCENTCLOUD_SECRET_KEY=...
TENCENTCLOUD_OCR_REGION=ap-guangzhou
```

该模式把 `boss-cli preview` 产生的截图提交给腾讯云 `GeneralBasicOCR`。密钥只放 `.env`，不得写入代码、日志或 Git。

boss-cli 内置 OCR 模式：

```text
BOSS_FORGE_OCR_PROVIDER=boss
BOSS_RESUME_OCR=1
```

不要同时开启两个 OCR 提供方。

单次人工预览诊断必须显式批准：

```bash
pnpm m0 -- live preview \
  --job "岗位名称" \
  --candidate "候选人姓名" \
  --approve-preview
```

## 7. 通用语义筛选（可选）

同义词/规范实体条件不要求模型；HR 在岗位规则中配置规范值和别名后，Worker 会先执行确定性匹配。复杂经历的语义评分可接 OpenAI 兼容的内网端点，默认关闭：

```text
BOSS_FORGE_SEMANTIC_ENABLED=0
BOSS_FORGE_SEMANTIC_MODE=shadow
BOSS_FORGE_SEMANTIC_BASE_URL=http://model.internal:8000/v1
BOSS_FORGE_SEMANTIC_MODEL=approved-model-name
BOSS_FORGE_SEMANTIC_API_KEY=...
BOSS_FORGE_SEMANTIC_TIMEOUT_MS=45000
```

Worker 调用 `<BASE_URL>/chat/completions`。首次接入必须设置 `ENABLED=1`、`MODE=shadow`：模型结论和版本会保存，但不影响通过/淘汰。用固定历史样本核对准确率、未知率和原文证据后，才可由管理员改为 `active`。凭据只进入 `.env`/Worker；不得进入前端、日志或 Git。

没有模型配置、请求失败、输出不符合 Schema、缺少原文证据或低于岗位阈值时，系统失败关闭为 `unknown/manual_review`；原有确定性规则继续运行。

## 8. Fake 联系 Worker

Dashboard 创建的联系意图固定为 Fake。启动循环 Worker：

```bash
pnpm m2:contact-worker:fake -- --loop
```

结果应进入 `simulated`，不能出现 BOSS 外部消息 ID，也不能计为真实发送。

不要在常规开发中运行 `pnpm m2:contact-worker`。Real 路径未完成产品验收，并因缺少权威账号健康源在 Repository 中失败关闭。

## 9. M0 真实 greet 诊断边界

M0 保留独立的真实 `greet` 命令：

```bash
BOSS_FORGE_REAL_GREET_ENABLED=1 pnpm m0 -- live greet \
  --job "岗位名称" \
  --candidate "候选人姓名" \
  --approve-greet
```

它需要命令行批准和环境变量同时存在，会直接联系真实候选人，不经过 Dashboard 联系策略。当前项目没有执行过该验收。除非用户对具体候选人、岗位和本次操作明确授权，否则不得运行。

## 10. 自动化验证

```bash
pnpm typecheck
pnpm lint:web
pnpm test
pnpm web:build
pnpm test:integration:data
pnpm test:e2e:user
```

当前基线：

- Vitest：17 个文件、164 个测试。
- Web：13 个路由构建通过。
- 数据集成：真实 PostgreSQL、Fake 联系、幂等和计划物化通过。
- 用户 E2E：必须输出 `realGreetingExecuted: false`，并清理合成数据。

## 11. 常见问题

| 现象 | 检查 |
|---|---|
| API 连接失败 | PostgreSQL 是否健康、`.env` 的 `DATABASE_URL`、3100 端口 |
| Web 数据为空 | 是否运行迁移/种子、API 是否启动、浏览器控制台 CORS 错误 |
| Worker 一直 idle | 是否有 queued 任务、账号 ID 是否一致、任务是否已被租约领取 |
| boss-cli 解析失败 | 版本必须为 0.6.6；检查上游输出格式是否变化 |
| Chrome 不可用 | 运行 `m0:install-browser`，或设置 `CHROME_PATH`/`PUPPETEER_EXECUTABLE_PATH` |
| OCR 无正文 | 检查截图引用、提供方配置、腾讯密钥和 OCR 返回日志 |
| 语义结果一直 unknown | 检查规则是否为 schema 1.1、模型开关/端点、Worker 日志、原文证据和岗位阈值 |
| 联系被阻断 | 候选人是否审核通过、时段/限额/冷却、是否已有 active intent |
