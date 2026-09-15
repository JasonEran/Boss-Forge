# Worker 退出码 0 导致服务异常

2026-09-09 09:20:39，联系任务 `0f2f1cfa-d1b8-4855-9c59-aebeb201da9b` 因 BOSS 招呼语响应与预览正文不一致，被记录为 uncertain。联系 Worker 随后主动结束循环并退出 0；session supervisor 将常驻子进程结束视为故障，停止筛选 Worker，并持续发布“Worker 异常停止（退出码 0）”。不是容器 OOM，也不是数据库中的十分钟超时回收。

修复：联系 Worker 在 uncertain 后保持运行并按 2–30 秒退避查询。数据库原有的同账号 processing/uncertain 阻断继续生效，不会重发不确定任务或绕过核验继续发送。真正的数据库、风控、进程异常仍由 supervisor 处理；单次执行仍可正常退出，SIGTERM 停止后不会多领任务。uncertain 日志改为 ok=false。

本次不改招呼语回执判断，也不把已有 uncertain 标为成功或未发送。2026-09-09 09:20 六人批次中五条 ready 已按用户要求取消，谭紫怡仍保留 uncertain，六条 outbox 均 completed。部署前真实 ready/processing 数为 0；无需数据库迁移。

恢复中另外发现：保存的登录凭证已被 BOSS 导向登录页，但网页后台请求一直存在，`waitForNetworkIdle` 超时导致 login relay 停留在 error，已经加载的二维码无法展示。修复为仅把“网络空闲等待超时”作为可继续的页面稳定等待结果，接着仍执行实际页面登录核验或二维码就绪检查；导航失败、连接异常、安全验证不忽略。

验证：116 个测试文件、807 项测试及 TypeScript 检查通过；Linux amd64 发布镜像内 42 项目标测试通过。新增回归覆盖 uncertain 后继续等待、实际 dispatcher 只调用一次 transport、退避上限、单次运行、停止信号及基础设施错误传播，并覆盖网络空闲超时与真正导航/连接失败的区别。测试不连接 BOSS、不发送消息。

最终发布版本：`boss-worker-lifecycle-20260909-1410cst`。仅覆盖 Worker 循环与登录等待相关代码，沿用已发布前端和依赖。生产备份位于 `/opt/boss-forge/backups/worker-lifecycle-20260909/`，本地测试证据位于 `artifacts/worker-lifecycle-20260909/`。

生产验收（14:10 北京时间）：API、Web、gateway、boss-login 容器健康；登录状态接口 HTTP 200、awaiting_scan、runtimeConsistent=true，二维码接口 HTTP 200 且 PNG 有效，心跳持续更新。BOSS 实际要求重新扫码，筛选和联系子进程尚未启动，因此未宣称登录后的真实 Worker 运行验证已完成。所有真实联系记录仍为 5 cancelled、6 历史 failed、1 uncertain，ready/processing 为 0。本次未发送任何候选人消息。
