# Boss-Forge 当前实现状态

> 对账日期：2026-09-01
>
> 代码基线：Odoo 运行时已移除后的纯自研控制面

## 1. 结论

Boss-Forge 已具备本地/内网的“岗位规则 → 筛选任务 → 候选人证据 → 人工审核 → 消息预览 → Fake 联系 → 审计”闭环。它可以用于受控的筛选准确性验证，但还不是完整的部门级 ATS，也没有上线真实自动联系。

## 2. 已实现

| 能力 | 状态 | 说明 |
|---|---|---|
| 六页 HR Web | 已实现 | `/`、`/positions`、`/tasks`、`/candidates`、`/contacts`、`/audit` |
| 岗位与规则版本 | 已实现 | 新建岗位；结构化编辑常用条件；保存生成不可变新版本 |
| 规则引擎 | 已实现 | Legacy TEM8 与 schema 1.0 组合规则；严格校验和证据输出 |
| BOSS 学校标签 | 已实现 | 只使用显式 985/211/双一流平台标签，支持任一/全部 |
| 立即与定时任务 | 已实现 | recommend/search；once/daily/weekdays/weekly；计划可停用 |
| 候选人去重 | 已实现 | 自然人稳定指纹 + 岗位状态分离 |
| 完整简历精筛 | 已实现、默认关闭 | `boss-cli preview` 截图；腾讯云 OCR 或 boss-cli OCR |
| 人工审核 | 已实现 | 通过/拒绝、备注、纠错码、乐观锁和审计 |
| 消息预览 | 已实现 | 使用当前模板版本渲染，创建前重新核对版本 |
| Fake 联系 | 已实现 | 联系意图、Outbox、Fake Worker、`simulated` 结果和恢复 |
| Real 联系安全逻辑 | 部分实现、失败关闭 | 有双重许可和调度前检查；缺少权威账号健康源，产品路径不能成功发送 |
| 内网部署 | 已实现配置 | Web/API/单 PostgreSQL/Fake Worker；BOSS Worker 按 profile 启用 |

## 3. 未实现或未开放

- 登录、会话、用户、部门、岗位协作者和服务端数据权限。
- 可配置招聘阶段、面试、Offer、入职、人才库运营和跨岗位推荐。
- 候选人备注、附件、@协作和个人待办。
- Dashboard 中的全局/岗位/任务自动联系开关与管理员审批。
- BOSS 回复同步、Do-Not-Contact 实时同步和账号健康数据源。
- 招聘漏斗、来源质量、审核准确率和运营分析。
- 任意嵌套 AND/OR/NOT 的拖拽式规则编辑器和历史回放 UI。
- 正式的 Real Worker 部署与真实副作用验收。

## 4. 已知限制

- Control API 当前没有认证；前端使用固定 `hr:dashboard` 等操作者标识。
- Web 每 5 秒读取一次完整 Dashboard 快照；候选人只在前端分页，数据量大时需要服务端分页。
- “立即执行”按钮当前固定使用推荐来源；搜索来源由计划表单或 API 使用。
- 计划业务时区固定为 `Asia/Shanghai`。
- 历史迁移 `006`–`012` 保留此前试验产生的可空外部映射字段和集成表；运行时不再提供 Odoo API 或同步 Worker。
- M0 诊断命令仍保留显式真实 `greet` 能力，必须同时具备命令行批准和环境开关；它不属于 Dashboard 产品闭环。

## 5. 最近验证结果

| 验证 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint:web` | 通过 |
| `pnpm test` | 14 个文件、149 个测试通过 |
| `pnpm web:build` | 6 个路由构建通过 |
| 生产 Web 启动 | `/positions` 返回 HTTP 200 |
| `pnpm test:integration:data` | 通过；幂等、乐观锁、Fake 联系、计划生命周期通过 |
| `pnpm test:e2e:user` | 通过；`realGreetingExecuted: false` |
| 内网 Compose 渲染 | 默认 5 个服务，无 Odoo、无 Real Worker |
| Control API | `/health` 正常；旧 Odoo 集成路径返回 404 |

真实打招呼执行数：**0**。

## 6. 数据保护说明

移除 Odoo 时未删除 Boss-Forge PostgreSQL 卷、岗位、候选人或规则数据。本机没有 Odoo 容器或 Odoo 数据卷。已删除代码均可从 Git 历史恢复。
