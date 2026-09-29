# 打招呼重试误报修复（2026-09-09）

> **历史记录 · 2026-09-09**：下文保留当时的版本、验证和限制，不代表当前生产状态。现行说明见[文档索引](README.md)、[当前状态](CURRENT_STATUS.md)与[运维手册](OPERATIONS_RUNBOOK.md)。

本次 14:44:43 谭紫怡 / 亚马逊运营的 intent `4ea0157d-00ec-4b12-afb5-48fcf120d175` 于 14:46:05 返回 `BOSS_GREET_TARGET_UNVERIFIED：候选人的原生打招呼入口未就绪或已经联系`。该分支在原生 `chatStop` 调用之前退出；但 Worker 在启动 CLI 时已标记 externalWriteStarted，把它包装成 uncertain，页面又把所有 uncertain 统一显示为“过程被中断”。

实际原始 ID `214f3a8c22ec2c8a1nV82921FVJS` 的 BOSS 历史卡片显示 isFriend=1、按钮“继续沟通”，因此本次重试没有执行首次打招呼。此证据不用于认定早上 09:20 那次招呼的正文或送达状态；早上记录已经由用户在 14:43 手工解除，保持原样。

## 修复

- 原生入口先检查准确候选人、是否已联系、按钮就绪、可用岗位。发送处理器未被调用时返回显式 `contact-not-started` JSON，包含候选人、岗位、招呼语 ID 和正文摘要。
- Worker 只接受字段和四项绑定完全匹配的未发送结果，记为明确失败并释放额度，后续队列继续处理。超时、断连、发送处理器抛错和发送后回执不一致仍保留 uncertain，禁止自动重发。
- 已联系时显示“BOSS 已与这位候选人建立联系，请使用继续沟通；本次未重复打招呼”。页面显示实际错误原因。
- 发送前无可用入口时不再创建响应等待器；检查与执行之间页面状态改变时取消等待器。移除发送前不明弹窗关闭动作。
- 我看过列表的只读重试识别 Puppeteer cause 中的 `frame got detached`，最多恢复一次。

## 验证与数据修正

本地 116 文件 / 823 测试、TypeScript、Linux amd64 前端构建通过；Linux 镜像 60 项相关测试通过。未向候选人发送测试消息。

已备份数据库与环境后，仅修正下午这条 intent 为 failed / 本次未发送，释放误占的 3 个 scope 配额；原 attempt 和原错误保留在历史及审计中，没有改为 sent。其余 5 条旧排队任务的确认于 14:54:37 过期；其中 1 条由 Worker 正常拒绝，4 条以带版本/过期时间/无额度占用条件的事务结束并留审计。最终 13 failed、5 cancelled，ready/processing/uncertain 为 0；需要重新预览，没有延长或重放过期确认。5 条此前用户取消任务保持取消。

发布 `boss-contact-prewrite-20260909-1515cst`，无数据库迁移。备份 `/opt/boss-forge/backups/contact-verification-20260909/`，保留上版回滚镜像。生产 API/web/浏览器服务健康，发布标识一致；登录与 Worker 状态接口已核对。发布后使用正式 withBossSessionPage 路径在生产找到准确候选人，执行 execute=false 的原生入口检查返回 BOSS_GREET_ALREADY_CONTACTED / invoked=false。整批真实发送未验收，不能据单元测试宣称消息送达。
