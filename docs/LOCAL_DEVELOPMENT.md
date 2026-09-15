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
BOSS_FORGE_SEMANTIC_BASE_URL=https://model.internal/v1
BOSS_FORGE_SEMANTIC_MODEL=approved-model-name
BOSS_FORGE_SEMANTIC_API_KEY=...
BOSS_FORGE_SEMANTIC_TIMEOUT_MS=45000
```

启用时 `<BASE_URL>` 必须使用 HTTPS，且 `BOSS_FORGE_SEMANTIC_API_KEY` 必填；本地 mock 也应使用仅供测试的非生产令牌。Worker 和岗位页的“生成同义词”按钮都调用 `<BASE_URL>/chat/completions`。HR 在“岗位设置 → 编辑岗位规则”填写一个识别内容，AI 结果必须预览并由用户应用后才写入新版本。岗位只允许 off/shadow；`SEMANTIC_ACTIVE_DECISIONS_AVAILABLE=false`，影子结果不进入规则结论。模式来自岗位配置，修改后无需重启 Worker；端点和凭据只进入 `.env`/服务端，不得进入前端、日志或 Git。

没有模型配置、请求失败、输出不符合 Schema、缺少原文证据或低于岗位阈值时，系统失败关闭为 `unknown/manual_review`；原有确定性规则继续运行。

## 8. 隔离 Fake 联系 Worker

Fake 状态机只用于明确隔离且允许 mock 联系 fixture 的测试，不是常规开发/E2E 的必经步骤。只在一次性本地测试数据库中启动：

```bash
pnpm m2:contact-worker:fake -- --loop
```

结果应进入 `simulated`，不能出现 BOSS 外部消息 ID，也不能计为真实发送。

不要把 Fake Worker 当成产品发送能力。当前工作树的真实联系能力已经交付，但默认关闭，且只能由同一 `boss-login` supervisor 在完成全部门禁后启动；普通本地开发和隔离 E2E 不运行它。

## 9. 真实 greet/message 开发边界

当前工作树将外部写拆为两个相互独立的动作：

- `greet`：读取并展示当前 BOSS 岗位的精确招呼语，许可后只执行一次打招呼。
- `message`：展示岗位模板渲染后的精确正文，许可后只执行一次正文发送，不隐式打招呼。

API 的 `greet-preview` 与 `message-preview` 为具体候选人签发短效 HMAC 许可，逐字绑定动作、操作者、BOSS 发件账号、浏览器 profile、候选人稳定 locator、岗位、任务、模板/provider 标识和正文哈希。对象、正文、登录账号或时效任一变化都必须重新预览；两个动作的许可不可互换。

真实运行同时要求：

```text
BOSS_FORGE_CONTACT_DISPATCH_MODE=real
BOSS_FORGE_REAL_GREET_ENABLED=1
BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY=<至少 32 字节的部署专用随机密钥>
```

此外还必须由 `boss-login` supervisor 以真实 Worker 明确确认参数启动，并通过登录、release、策略、四级联系开关、DNC、额度、时段、冷却和全局写入 fence 检查。M0 不提供可绕过上述许可的 greet/send 命令；不要直接运行浏览器脚本或调用 BOSS 写接口。

生产 release `audit-events-20260904-1614cst` 已部署，真实 runtime 已开启，但全局/部门控制 safe-off，尚未执行真实写入。首次真实 canary 前必须展示具体动作、候选人、BOSS 发件账号和完整正文，并取得用户对该组合与正文的精确许可；没有许可只允许预览。

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

- Vitest：最新全量 523 项通过；双动作许可、全局写入 fence、回执、语义、只读简历与 API 同源回退定向回归均已计入，不重复相加。
- Web：14 个页面路由生产构建通过。
- 数据集成：一次性本地 PostgreSQL，默认零联系数据；任务、幂等、计划和逐任务历史通过。
- 用户 E2E：必须输出 `realGreetingExecuted: false`，默认不创建联系记录并清理合成数据。
- migration 001–026 已在一次性隔离 PostgreSQL 通过；contact fixture 只验证数据约束和模拟状态，不启动真实 BOSS 浏览器或执行外部联系。

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
