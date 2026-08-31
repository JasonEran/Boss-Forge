# M0 技术验证运行手册

> M0 默认不发送消息、不打招呼，并关闭外部百度 OCR。

## 1. 已实现范围

- pnpm TypeScript monorepo。
- 精确锁定 `@joohw/boss-cli@0.6.6`。
- 安全 CLI 子进程调用：参数数组、`shell: false`、环境白名单、超时、取消和输出限制。
- `boss-cli@0.6.6` 版本化输出解析器。
- Worker 心跳文件。
- Boss 账号级进程锁。
- positions、recommend、search、deep-search、preview 等输出契约测试。
- 受控真实验证入口；简历预览和打招呼要求显式批准参数。

## 2. 环境准备

要求：

- Node.js 22 或更高版本。
- pnpm 11.22.0。
- 本机安装 Chrome 或 Chromium。
- 可以访问 Boss 直聘。

安装：

```bash
pnpm install
pnpm m0:install-browser
cp .env.example .env
```

当前程序不会自动读取 `.env`；需要由进程管理器加载，或在 Shell 中显式设置。M0 所有 Worker 命令在未配置时仍强制使用 `BOSS_RESUME_OCR=0`。

`m0:install-browser` 把 Chrome for Testing 安装到被 Git 忽略的 `.boss-forge/browsers`。Worker 会自动发现该浏览器；如果使用系统 Chrome，可设置 `CHROME_PATH`。

安全说明：`boss-cli@0.6.6` 的 Puppeteer 依赖原本会解析到含已知 `extract-zip` 漏洞的 `@puppeteer/browsers@2.x`。本项目覆盖到不再依赖 `extract-zip` 的 `@puppeteer/browsers@3.2.1`，因此运行环境要求 Node.js 22，并通过 CLI 契约和启动测试验证兼容性。

## 3. 自动验证

```bash
pnpm typecheck
pnpm test
pnpm m0:doctor
pnpm m0:heartbeat
```

心跳输出位置：

```text
.boss-forge/runtime/worker-heartbeat.json
```

持续运行 Worker 心跳：

```bash
pnpm worker
```

## 4. Boss 登录

M0 工具不自动登录。首次使用时由 HR/管理员在本机终端运行：

```bash
pnpm m0 -- login
```

在打开的 Chrome 中人工完成扫码、验证码或其他登录步骤。不得自动绕过验证。

## 5. 只读真实验证

读取岗位：

```bash
pnpm m0 -- live positions
```

读取指定岗位推荐候选人：

```bash
pnpm m0 -- live recommend --job "岗位名称"
```

常规搜索：

```bash
pnpm m0 -- live search --keyword "TEM8"
```

所有操作通过账号锁串行执行。默认账号 ID 为 `boss-account-01`，可通过 `BOSS_FORGE_ACCOUNT_ID` 修改。

## 6. 简历预览验证

简历预览会消耗平台每日查看额度，因此必须显式批准：

```bash
pnpm m0 -- live preview \
  --job "岗位名称" \
  --candidate "候选人姓名" \
  --approve-preview
```

命令先执行 `recommend <岗位>` 建立正确页面上下文，再执行 `preview <候选人>`。默认只保存本地截图，不调用百度 OCR。

## 7. 人工批准打招呼验证

以下命令会对真实候选人打招呼，只能由已授权 HR 在核对姓名和岗位后执行：

```bash
pnpm m0 -- live greet \
  --job "岗位名称" \
  --candidate "候选人姓名" \
  --approve-greet
```

没有 `--approve-greet` 时程序直接拒绝执行。命令先重新读取指定岗位推荐列表，再执行真实 `greet`。

## 8. M0 验收记录

| 检查项 | 自动/人工 | 通过标准 |
|---|---|---|
| 依赖版本 | 自动 | `boss-cli` 必须为 0.6.6 |
| 类型检查 | 自动 | `pnpm typecheck` 无错误 |
| 契约测试 | 自动 | `pnpm test` 全部通过 |
| Worker 心跳 | 自动 | 文件符合 schema 且 OCR 默认关闭 |
| 账号锁 | 自动 | 同账号并发调用被串行化 |
| CLI help | 自动 | 无浏览器状态也能成功调用 |
| 岗位读取 | 人工环境 | 登录后 `live positions` 返回结构化岗位 |
| 推荐/搜索 | 人工环境 | 返回结构化候选人列表 |
| 简历预览 | 人工批准 | 保存截图并能解析路径 |
| 打招呼 | 人工批准 | 指定候选人成功且只发送一次 |

### 8.1 2026-08-31 实机验收

| 检查项 | 结果 | 说明 |
|---|---|---|
| 登录态复用 | 通过 | 项目专用 Chrome 和固定 CDP 端口可跨命令复用招聘端登录态 |
| 推荐候选人 | 通过 | `recommend` 成功读取当前岗位；页面重复卡片由适配层归并为 15 条唯一候选人 |
| 常规搜索 | 通过 | `search TEM8` 成功执行并返回结构化空结果 |
| 岗位读取 | 上游阻塞 | BOSS 页面显示“共 11 个职位”，但 `boss-cli@0.6.6` 的当前页面选择器读取为 0 条；侧边栏跳转也存在兼容问题 |
| 简历预览 | 待人工批准 | 会消耗平台每日查看额度，本次未执行 |
| 打招呼 | 待人工批准 | 会联系真实候选人，本次未执行 |

岗位读取问题保留在 `boss-cli` 适配边界内处理。Boss-Forge 不新增第二套职位页面抓取；上游发布兼容版本后，先更新版本化解析契约和回归样本，再升级依赖。

## 9. 当前边界

- M0 只验证执行链路，不包含 Dashboard、数据库、Redis 或完整任务队列。
- 输出解析器严格绑定 `boss-cli@0.6.6`；升级版本必须增加契约样本并通过测试。
- M0 心跳写本地文件；M1 接入 API/数据库后改为上报控制面。
- 多 Boss 账号一期应使用独立 Worker 或独立 macOS 用户。
