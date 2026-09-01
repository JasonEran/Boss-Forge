# Boss-Forge 当前实现状态

> 对账日期：2026-09-01
> 运行边界：内网、单部门实例、Fake 联系，不含产品级 Real Worker

## 1. 结论

R1–R6 的控制面、数据模型、API 和 Fake-only 验收已经实现。系统现在是可由整个 HR 部门使用的内网 ATS 工作台，而不只是筛选工具。真实打招呼仍未开放，也没有在本次验收中执行。

## 2. 交付能力

| 版本 | 已实现能力 | 主要页面/API |
|---|---|---|
| R1 | 密码会话；管理员/招聘负责人/HR/面试官；岗位成员；服务端岗位隔离；当前用户审计；候选人服务端分页、筛选、检索和排序 | `/team`、`/api/auth/*`、`/api/pipeline` |
| R2 | 可配置阶段；候选人时间线、备注、@成员、附件元数据；跟进待办；面试和反馈；跨岗位自然人档案；Do-Not-Contact 和淘汰原因 | `/pipeline`、`/api/collaboration/*` |
| R3 | 任意嵌套 AND/OR/NOT 可视化规则树；部门模板；Draft/Pending/Published/Retired；审批；历史候选人回放差异；回滚；已发布配置数据库防改触发器 | `/rules`、`/api/rules/*` |
| R4 | 部门规范事实目录；提示词/目录/模型版本；审批发布；HR 固定评估集；准确率/召回率/纠错率/未知率/成本指标；90% active 门禁；off/shadow/active | `/semantic`、`/api/semantic/*` |
| R5 | BOSS 回复幂等同步；人才标签；跨岗位推荐和重复联系提示；漏斗/来源/审核/OCR 指标；账号健康；告警；导出和保留策略 | `/operations`、`/analytics` |
| R6 | 全局/部门/岗位/任务开关；审批；权威账号健康；时段、额度和冷却策略；DNC 闭环；紧急停止；就绪检查和 Fake 演练 | `/automation`、`/api/automation/*` |

原有岗位、立即/定时筛选、BOSS 推荐/搜索、简历预览/OCR、TEM8/当前英语级别、985/211/双一流显式标签、人工审核、消息预览、Fake 联系、Outbox 与审计均保留。

## 3. 明确未开放

- 产品级 Real Contact Worker 和真实副作用验收。
- 真实内网大模型的岗位效果验收；连接器、版本管理和评估门禁已具备，但仓库不自带模型地址或凭据。
- 公网 SaaS、多租户计费、公共注册和公网安全规格。
- 绕过 BOSS 验证码、风控或额度；从学校名推断 985/211/双一流。
- 二进制附件上传服务；当前只登记内网存储路径和附件元数据。

## 4. 最近验证

| 命令 | 结果 |
|---|---|
| `pnpm db:migrate` | 迁移 014、015 已应用 |
| `pnpm typecheck` | 通过 |
| `pnpm lint:web` | 通过 |
| `pnpm test` | 17 个文件、164 个测试通过 |
| `pnpm test:e2e:user` | R1–R6 全流程通过；`realGreetingExecuted: false` |
| `pnpm web:build` | 13 个路由生产构建通过 |

E2E 覆盖两名 HR 岗位隔离、同一自然人双岗位、协作/面试、规则回放、语义 active 门禁、回复/人才库/健康/导出、多级开关/审批、DNC 和紧急停止。真实打招呼执行数：**0**。

## 5. 默认登录

首次空库启动会创建默认管理员：

- 邮箱：`admin@boss-forge.internal`
- 密码：`ChangeMe-BossForge-Internal!`

可通过 `BOSS_FORGE_BOOTSTRAP_*` 环境变量覆盖。进入内网试用前应修改默认密码并创建实际成员账号。
