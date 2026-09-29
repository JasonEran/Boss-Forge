# Boss-Forge

Boss-Forge 是供招聘团队使用的 Web 控制台，连接 BOSS 直聘，支持岗位同步、规则筛选、简历读取、受控打招呼、实时沟通及面试到入职的跟进。Web 是 HR 的操作入口，PostgreSQL 保存业务事实；项目不依赖 Odoo。

## 从这里开始

| 你要做什么 | 阅读入口 |
| --- | --- |
| 日常招聘：登录、岗位、筛选、联系 | [使用手册](docs/USER_GUIDE.md) |
| 换了 BOSS 账号，岗位或任务不工作 | [账号切换与岗位恢复](docs/BOSS_ACCOUNT_SWITCH.md) |
| 查看实际部署、已知限制和最近验证 | [当前状态](docs/CURRENT_STATUS.md) |
| 任务不动、二维码不更新、发送待核验 | [运维与排障](docs/OPERATIONS_RUNBOOK.md) |
| 开发、测试、部署 | [本地开发](docs/LOCAL_DEVELOPMENT.md) · [验证指南](docs/TESTING.md) · [部署手册](docs/INTRANET_DEPLOYMENT.md) |
| 查看全部文档和历史记录 | [文档索引](docs/README.md) |

## 先理解这几件事

- 控制台账号与 BOSS 手机扫码账号是两种身份。BOSS 登录成功还需要浏览器认证和 Worker 心跳通过检查。
- 支持**微信扫码 / BOSS App 扫码**切换；二维码过期需手动刷新，安全验证需本人完成。
- 同名岗位可能有不同 BOSS 岗位 ID。换账号后先同步岗位、核对绑定和规则，旧任务不能靠改名恢复。
- 同一个 BOSS 浏览器会话串行执行。两个岗位可以各建一个任务，但不会同时操作浏览器。
- 任务开启自动打招呼时，人数目标指**成功打招呼人数**；关闭时指**筛通过人数**。每波最多处理 20 人，采集数不等于成功数。
- 默认账号每日自动招呼上限为 200，按上海自然日计算，与简历查看额度、单任务目标分开。平台限制仍有效。

## 本地启动

需要 Node.js **22.13.0+**、pnpm **11.22.0** 和 Docker。以下命令只用于本地开发库：

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
```

先修改 `.env` 中管理员初始密码，再分别启动两个终端：

```bash
pnpm api
```

```bash
pnpm web:dev
```

访问 [本地控制台](http://localhost:3000)。首次空库由 API 创建管理员；可选演示种子、BOSS 浏览器与 Worker 的启动条件见[本地开发](docs/LOCAL_DEVELOPMENT.md)。默认本地配置不执行真实联系。

## 开发与维护约定

按改动运行类型、测试、前端构建或数据集成，具体见[验证指南](docs/TESTING.md)。纯文档修改检查链接、命令和事实，不把旧测试结果写成本次运行。

代码经 PR 合入 `main` 后部署；纯文档更新可只合入仓库。运行版本、镜像和现场时间只在[当前状态](docs/CURRENT_STATUS.md)维护，历史报告不代表服务器此刻状态。不要清空登录卷或生产业务数据；不绕过验证码、风控及平台额度。
