# 验证指南

> 验证必须说明环境、范围和结果。历史数字只保留在带日期报告与[当前状态](CURRENT_STATUS.md)。

## 1. 按改动选择验证

| 改动 | 必需关注 |
| --- | --- |
| 纯文档 | 链接/锚点、命令和配置名、事实对账、Markdown、敏感信息、diff 检查 |
| 类型与业务逻辑 | `pnpm typecheck`、相关单元/契约测试；按影响运行全量 |
| Web | 类型、`pnpm lint:web`、`pnpm web:build`、相关浏览器流程和手机布局 |
| 数据层 | 隔离 PostgreSQL 集成；迁移、幂等、权限、历史及并发约束 |
| 登录 / 浏览器适配 | 隔离 Chromium fixture；原有与新流程、等待超时、风险停止、原账号锁 |
| 联系与沟通 | 模拟传输、目标/正文/版本绑定、回执、不确定状态、暂停及重复提交 |
| 部署 | 镜像 release、非 root 启动、前端产物、卷挂载、健康与运行一致性 |

修复生产问题不默认包含真实发消息验收。外部动作须在用户已授权范围内；模拟验证不能称为实盘通过。

## 2. 仓库命令

在仓库根目录运行：

```bash
pnpm typecheck
pnpm lint:web
pnpm test
pnpm web:build
```

定向测试示例：

```bash
pnpm exec vitest run apps/boss-worker/src/login-entry.test.ts apps/boss-worker/src/login-refresh-request.test.ts apps/boss-worker/src/login-handoff.test.ts
```

命令与脚本以 [package.json](../package.json)、[Web package.json](../apps/web/package.json) 为准。根 `build` 只做类型检查。

## 3. 数据与 API 集成

仅用一次性本地数据库，名称包含 `test`、`e2e` 或 `audit`，并绑定 loopback。以下示例新建独立容器，不挂生产卷；测试密码仅用于这个临时容器：

```bash
docker run -d --name boss-forge-docs-test-db -p 127.0.0.1:55434:5432 -e POSTGRES_USER=boss_forge_test -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=boss_forge_test postgres:17-alpine
docker exec boss-forge-docs-test-db pg_isready -U boss_forge_test -d boss_forge_test
export DATABASE_URL=postgres://boss_forge_test:local-test-only@127.0.0.1:55434/boss_forge_test
export BOSS_FORGE_RESUME_PREVIEW_ENABLED=0
export BOSS_FORGE_CONTACT_DISPATCH_MODE=disabled
export BOSS_FORGE_REAL_GREET_ENABLED=0
pnpm db:migrate
pnpm test:integration:data
pnpm test:integration:migration-history
```

`pg_isready` 成功后才能迁移。API E2E 还需另开一个连接**相同测试库**的 API，使用独立端口，例如 `CONTROL_API_PORT=3110`；测试端设置 `CONTROL_API_URL=http://127.0.0.1:3110` 后运行 `pnpm test:e2e:user`。两个进程都需相同的测试管理员配置。不要误连正在开发或生产使用的 3100 端口。

专用联系 fixture 额外要求 `BOSS_FORGE_TEST_CONTACTS=1` 与 `BOSS_FORGE_ALLOW_CONTACT_TEST_DATA=I_UNDERSTAND_ISOLATED_ONLY`，再使用 `test:integration:data:contacts` / `test:e2e:user:contacts`。它们测试数据约束和模拟状态，不能连接真实 BOSS 或启动真实 Worker。

测试结束后停止并移除**本次创建的测试容器**，勿使用会删除业务卷的通用清理命令。保留失败日志前先去掉秘密和候选人正文。

## 4. 登录与慢网络夹具

隔离 Chrome 使用临时 profile，不复用生产登录目录。当前登录相关入口：

- [微信夹具](../apps/boss-worker/src/wechat-login.integration.ts)。
- [扫码方式与真实 relay 子进程夹具](../apps/boss-worker/src/login-method.integration.ts)。
- [前端慢二维码下载夹具](../apps/web/app/boss-login/boss-login.integration.mjs)，图片延迟超过状态轮询间隔；需单独测试 Web 服务和 `BOSS_UI_TEST_ORIGIN`。

运行前读脚本的环境与启动条件，使用 `CHROME_PATH` 指向当前平台浏览器。检查扫码方式、旧图不覆盖新图、过期提示、风险按钮禁用、下载不被每轮轮询取消。

## 5. 结果记录

至少记录提交/发布号、平台、执行命令、通过/失败/跳过数量、已知基线及是否发生外部业务动作。隔离用户 E2E 应输出 `realGreetingExecuted: false`；部分专用测试另有自己的零外部写断言，不应要求所有脚本打印同一个字段。

不把以下结果混为一谈：

- 类型通过 ≠ 运行通过。
- HTTP 200 ≠ 新前端产物已上线。
- 容器健康 ≠ BOSS 登录完成。
- 采集 / 精筛完成 ≠ 成功招呼。
- 历史全量通过 ≠ 本次重新执行。

已知未解决基线在[当前状态](CURRENT_STATUS.md)列明。纯文档修改无需为更新测试数量运行真实浏览器或业务任务。
