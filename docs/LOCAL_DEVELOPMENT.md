# 本地开发

> 仅用于开发机和隔离数据；生产操作见[部署手册](INTRANET_DEPLOYMENT.md)。

## 1. 环境

- Node.js 22.13.0+（Web 声明比根项目的 22+ 更严格）。生产当前使用 Node 22，正式构建尽量与之对齐。
- pnpm 11.22.0，见根 `packageManager`。
- Docker Engine / Desktop 与 Compose v2。
- 需要浏览器夹具时安装 Chrome/Chromium；需要真实 BOSS 时另有明确业务授权和专用会话。

安装依赖使用锁文件，保留 `pnpm-workspace.yaml` 中 boss-cli 的补丁及构建允许项：

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
```

本地 PostgreSQL 使用 [compose.yaml](../compose.yaml)，只绑定 `127.0.0.1:55433`。本地开发库名 `boss_forge` 不是集成测试要求的一次性测试库。

首次启动 API 前修改 `.env` 中管理员初始密码。`pnpm m1:seed` 是可选的旧演示种子：创建“当前登录岗位”、TEM8 规则和模板；不应在生产运行，也不能代替 BOSS 岗位同步。

## 2. 启动控制台

两个终端分别执行：

```bash
pnpm api
```

```bash
pnpm web:dev
```

Web：[http://localhost:3000](http://localhost:3000)；API 健康：[http://127.0.0.1:3100/health](http://127.0.0.1:3100/health)。默认 API 地址及生产同源配置见[配置参考](CONFIGURATION.md)。

Web 使用 Vinext/Vite 构建与 React；`pnpm web:build` 生成 `apps/web/dist`，`pnpm --dir apps/web start` 启动生产产物。不要把 `pnpm build` 当成 Web 打包，它只执行根 TypeScript 检查。

## 3. 浏览器与 Worker

普通页面开发和数据测试不启动 BOSS Worker。只在专用开发会话、明确允许真实读取且没有其他进程占用同一 profile 时使用：

```bash
pnpm m0:install-browser
pnpm m0:doctor
pnpm m0:heartbeat
```

M0 不自动加载 `.env`。通过受控环境注入所需变量，不把秘密直接写进 shell 历史。生产由 `boss-session-supervisor` 管理浏览器和子 Worker，开发时也不要同时启动多个共享 profile 的进程。

经授权的本地单 Worker 入口：

```bash
pnpm m1:worker
```

这会领取数据库中的实际任务。务必确认 `DATABASE_URL`、`BOSS_FORGE_ACCOUNT_ID` 与浏览器目录均为本次允许的环境。

`BOSS_FORGE_RESUME_PREVIEW_ENABLED=0` 是模板默认值。关闭时不会完成完整简历精筛，队列可能等待；这不是启动第二个 Worker 的理由。

## 4. OCR 和模型

Tencent 路径使用 `BOSS_FORGE_OCR_PROVIDER=tencent`、`BOSS_RESUME_OCR=0` 与服务端 Tencent 凭据。boss 路径使用 `BOSS_FORGE_OCR_PROVIDER=boss` 和内置 OCR 设置。不要同时开启两个提供方。

模型连接默认关闭。需要时配置批准的 HTTPS 端点、模型和服务端密钥；旧语义结果只允许 off/shadow，招聘 AI 分析使用单独的规则开关。没有证据、模型失败或简历不完整时保留未知/失败原因，不伪造通过。

全部配置名与默认值见[配置参考](CONFIGURATION.md)。

## 5. 隔离测试

快速检查：

```bash
pnpm typecheck
pnpm lint:web
pnpm test
pnpm web:build
```

完整测试分层、已知基线及数据库创建步骤见[验证指南](TESTING.md)。不要把测试脚本指向生产 API、数据库或已登录浏览器。

`pnpm m2:contact-worker:fake` 仅用于允许 mock 联系数据的一次性环境，结果应为 `simulated`。默认日常开发不启动真实联系 Worker，不把 Fake 结果统计成真实发送。

## 6. 常见问题

| 问题 | 检查 |
| --- | --- |
| pnpm 尝试重新安装 / EACCES | 锁文件、依赖元数据与当前 manifest 是否一致；产物镜像需在构建阶段完成安装 |
| API 不通 | 本地 PostgreSQL、DATABASE_URL、3100 端口、API 日志 |
| 页面没有岗位 | 当前控制台身份与权限、是否同步/创建了测试岗位；不要先清数据库 |
| Worker idle | 是否有可领取任务、规则已发布、账号一致、前序工作或浏览器租约 |
| Chrome 路径找不到 | 安装浏览器或显式配置 CHROME_PATH |
| Mac boss-cli help 测试超时 | 记录平台差异并在生产对应 Linux 环境复核，不跳过后声称全量通过 |
| Web lint 失败 | 先区分本次引入与已知基线；最近已知结果见当前状态 |
