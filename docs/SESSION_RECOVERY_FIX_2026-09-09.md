# BOSS 登录误判与服务恢复（2026-09-09）

用户反馈“BOSS 登录已经失效或页面已关闭，系统已停止全部 BOSS Worker”。生产复查发现同一浏览器仍处于 authenticated，页面是 BOSS interaction，没有登录页或安全验证页；联系队列为空。

## 原因

健康检查将缺少页面、about:blank、岗位页面 DOM 暂时未挂载统一归为 login_required / url=null。Supervisor 对一次这样的观察立即终止 Worker，且仅对 CDP unavailable 开启自动恢复。即使页面随后恢复登录，也会永久停留在重新扫码错误。

## 修复

- 仅实际 BOSS 登录页判断为 login_required；工作页面短暂缺失或 DOM 未就绪标为 unavailable，继续禁止将未知状态作为已登录。
- 30 秒页面恢复观察窗口内不打断现有 Worker，界面显示自动复查；同期继续检查 API 版本/运行配置和 Worker 心跳。实际发送仍保留逐次登录检查。
- 超过观察窗口则暂停 Worker；真实登录状态恢复后使用现有受控流程重新启动。真正进入登录页时，待 Worker 退出后返回既有微信小程序二维码流程。
- BOSS 安全验证、真实子进程故障、运行配置不一致仍按各自原因处理，不把它们当作普通页面切换。

## 验证

117 个文件 / 829 项测试通过，TypeScript 通过；最终 Linux amd64 镜像的 40 项相关测试通过，覆盖短暂空白、未挂载 DOM、持续不可用、恢复后的新观察窗口、明确登录页和官方安全验证。保留上轮打招呼 pre-write 修复，无数据库迁移或数据清理，也没有发送测试招呼。

发布 boss-session-recovery-20260909-1530cst。备份 /opt/boss-forge/backups/session-recovery-20260909/ 包含旧环境、数据库和错误状态；保留上一生产镜像回滚。

生产切换后复用原登录成功，无需扫码；连续 120.128 秒、25 次状态采样全部 authenticated，Worker 心跳新鲜、运行配置一致。样本保存于备份目录 session-recovery-samples.json；联系记录仍为 13 failed / 5 cancelled，ready/processing/uncertain 为 0。
