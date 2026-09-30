# 运维与排障手册

> 用于现有生产环境。先读状态再操作；部署步骤另见[部署手册](INTRANET_DEPLOYMENT.md)。

## 1. 位置与入口

| 项目 | 位置 |
| --- | --- |
| 控制台 | `https://106.12.106.113` |
| 服务目录 | `/opt/boss-forge` |
| 当前应用 | `/opt/boss-forge/current`，指向不可变 release 目录 |
| Compose / 环境 | `/opt/boss-forge/deploy/compose.intranet.yaml`、`.env.intranet` |
| 运行状态 | 登录容器内 `/var/lib/boss-forge/runtime` |
| 业务事实 | PostgreSQL；不是页面缓存或日志里的临时计数 |

服务器凭据通过授权的秘密渠道获取，不写在文档、命令历史或工单中。日常操作优先使用控制台；诊断需要 shell 时使用授权 SSH 连接。

## 2. 第一步：只读检查

以下命令在**服务器**执行，不改业务数据：

```bash
cd /opt/boss-forge
readlink current
curl -fsS http://127.0.0.1:3100/health
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml --profile boss-login --profile https ps
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml logs --since 15m --tail 80 boss-login api
```

检查登录状态及心跳，不要输出整个环境文件：

```bash
docker exec boss-forge-intranet-boss-login-1 cat /var/lib/boss-forge/runtime/boss-login-status.json
docker exec boss-forge-intranet-boss-login-1 cat /var/lib/boss-forge/runtime/worker-heartbeat.json
```

联合判断：API、登录状态的 `releaseId` 和联系模式相同；简历策略一致；浏览器认证成功；Worker 心跳新鲜。容器 `healthy` 不能单独证明 BOSS 已登录；心跳 `ready` 表示 Worker 可领取工作，不表示一定有任务。

登录容器的健康检查会将 `error/risk_controlled` 和认证后的陈旧或停止心跳判为不健康；等待本人扫码时允许登录服务保持健康。浏览器探测有 15 秒总超时，失败连接会关闭。`boss_session_supervisor.session_stopped` 日志保留探测失败原因；不要通过延长超时或循环重启掩盖页面无响应。

## 3. 登录问题

| 现象 | 先检查 | 恢复方式 |
| --- | --- | --- |
| 手机扫过，控制台仍等扫码 | 手机是否确认；是否提示使用 App；当前扫码方式 | 按官方要求选择微信或 App；等待后台认证，不把扫码提示当成功 |
| 二维码过期 | 状态、图片版本、是否仍在下载 | 手动刷新一次；慢网络下等图片完成，不连续刷新 |
| 服务连接故障 | 容器、CDP、状态文件新鲜度 | 控制台“重新连接扫码服务”保留原方式；若仍失败查日志 |
| `authenticated` 但不能执行 | release / 策略 / 心跳一致性 | 修正不一致的部署或进程，不清空登录数据 |
| `risk_controlled` / 安全验证 | BOSS 官方页面提示 | 由本人完成；完成后核对状态，必要时受控恢复服务 |

不要用连续刷新、反复重启、切换 profile 或复制 Cookie 处理风控。重启会中断当前浏览器操作，应先确认任务与联系队列。

## 4. 任务不动

按顺序检查岗位、任务、简历、联系四层：

1. 当前 BOSS 账号与任务岗位 ID 是否匹配；岗位是否开放。
2. 任务是否真正可执行：`queued/running/screening`、`wait_reason_code`、`next_run_at`、`last_progress_at`。
3. 同账号是否有前序任务，或实时沟通正在占用浏览器；不要开第二个 Worker 抢同一会话。
4. 是否有简历正在处理或等重试，是否因内容不完整、找不到来源或额度停止。
5. 自动招呼是否开启，是否有待发送/发送中/待核验记录，是否已达到目标或账号日上限。

| 原因 | 正确判断与动作 |
| --- | --- |
| `BOSS_JOB_NOT_FOUND` | 核对当前账号、开放状态及 ID。换账号后按[岗位恢复流程](BOSS_ACCOUNT_SWITCH.md)，不直接重试旧 ID |
| `resume_retry_scheduled` | 读取预计重试时间；完成记录保留，等待后再检查是否推进 |
| `content_incomplete` | 简历图片未确认完整；保留失败原因，不把缺失内容当成未通过条件 |
| `target_missing` / 来源失效 | 原候选人不可定位，不改看其他人；重新采集或人工核查 |
| `greet_target_met` | 成功招呼已达任务目标，正常停止下一波 |
| `screening_pass_target_met` | 仅筛选任务通过人数达标，正常停止 |
| `screening_pool_exhausted` | 本次来源无新增；已排简历可能仍需处理，不能承诺目标可达 |
| 每日招呼上限 | 按上海自然日统计，相关任务和计划会停用；不要清零或改上限凑数 |

### 只读 SQL 示例

以下在服务器执行。使用精确任务 ID，输出状态和计数即可，不输出候选人正文：

```bash
docker exec -i boss-forge-intranet-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off' <<'SQL'
SELECT t.id, p.name, t.status, t.source_job_id, t.candidate_limit, t.auto_greet,
       t.wait_reason_code, t.wait_reason, t.next_run_at, t.last_progress_at, t.error_message
FROM tasks t JOIN positions p ON p.id = t.position_id
ORDER BY t.created_at DESC LIMIT 10;
SQL
```

对已选任务核对 `candidate_position_states.resume_screening_status`、`rule_decision`，以及 `contact_intents.action_kind/status`。历史 `sent` 总量不能代表今天或该任务的发送量。

## 5. 联系恢复

- `ready`：先检查岗位执行开关、任务自动招呼设置、账号和四级控制，不直接改状态。
- `processing`：当前动作已领取；暂停岗位只挡下一次领取，等待这次结果。
- `sent`：已有成功回执，不能重发。
- `uncertain`：不知道外部是否已完成；在 BOSS 同账号同会话核实，再走产品的已发送/未发送核验。
- `failed`：查看具体原因，不能把所有失败批量重置为 ready。

所有恢复必须保留幂等、回执和审计。不要通过 CLI 或数据库 UPDATE 绕过产品联系检查。

同账号存在真实 `uncertain` 记录时，联系 Worker 保持存活但不领取新的发送；等待超过 10 分钟也不会解除核验要求。这类待发送队列，以及被暂停执行的队列，不再抢占简历领取的优先级。筛选推进不等于发送已经恢复，交班时应分别报告两者。

## 6. 浏览器诊断约束

优先读取状态文件与已有日志。确需只读 CDP 检查时，连接 supervisor 管理的浏览器，使用 `defaultViewport: null` 保留生产视口，结束时 `disconnect()`，不能 `browser.close()`。禁止为了截图改变页面尺寸、导航到别的岗位或调用联系人动作。浏览器中的业务读取也要遵守账号锁，避免打断执行中的任务。

## 7. 发布后和交班时

记录观察时间、应用版本、登录/Worker 状态、活跃任务及等待原因、联系队列、计划启用状态和待人工事项。不要只写“正常”或“已修复”。

- 业务恢复记录保存在服务器受控备份目录，仓库只写脱敏结论。
- 清理本次创建的临时诊断会话；不能撤销用户其他会话。
- 不删除业务数据、登录卷或历史失败记录来让界面变干净。
- 无代码变更的配置恢复不需要重新发布应用。纯文档变更不重启正在运行的招聘任务。
