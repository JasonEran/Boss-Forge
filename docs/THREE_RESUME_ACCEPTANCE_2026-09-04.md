# Boss-Forge 生产三简历全路径验收

> 验收日期：2026-09-04（Asia/Shanghai）
>
> 验收任务：`8e1e9ed2-34ca-451b-9923-bc91e54ac61c`
>
> 岗位与规则：海外运营专员，规则 v3
>
> 验收边界：保留 BOSS 登录；不突破查看额度或风控；联系停在发送前；未创建联系任务，未调用打招呼或发送接口

## 1. 验收结论

三份简历的受控生产验收已完成：采集与简历处理被拆成两个明确阶段，登录目录在 worker 重启后仍为 `authenticated`，简历阶段严格记录 3/3 次尝试并正常退出，没有第四次查看。两份有效简历完成 OCR、结构化识别、规则判定和语义 shadow 展示；一份失效目标以 `target_missing` 安全失败且没有自动重试。

三名候选人均未达到联系条件，因此没有为了走通演示而人工改判，也没有生成候选人级消息预览。联系页保持“仅预览，发送未启动”，生产联系 intent、attempt 和真实发送均为 0。

产品结论：**基本够用（筛选、审核和预览链路可用；系统内真实发送仍不可用）。** 本轮补齐了此前缺失的真实 OCR/规则判断生产样本，但真实联系 transport 仍因多外部写动作且缺少权威 receipt 而保持编译关闭。

## 2. 执行路径与证据

### 2.1 队列整理与迁移

- migration 025 已在生产应用；历史取消任务遗留的 17 条 `queued` 简历状态已转换为 `not_requested`。
- 整理只改变不可执行的排队状态，不删除候选人、任务、OCR 证据或审核记录。
- 验收开始前，生产联系 actionable intent 为 0、contact attempt 为 0。

### 2.2 仅采集阶段

- 使用 release `canary3-20260904-1207cst` 运行 `collection-only`。
- 为海外运营专员规则 v3 创建任务 `8e1e9ed2-34ca-451b-9923-bc91e54ac61c`。
- 采集到 15 名新候选人。
- 该阶段简历查看次数为 0，证明“获取候选人”不会隐式打开简历。

### 2.3 仅简历阶段

- worker 切换为 `resume-only`，硬上限设为 3；重启未清除或重建浏览器目录。
- worker 重启后 BOSS 会话仍为 `authenticated`。
- canary 与 supervisor 均记录 3/3，进程退出码为 0；日志及数据库均没有第四次简历查看。

| 时间（CST） | 候选人 | 简历/OCR 结果 | 规则结果 | 处理结论 |
|---|---|---|---|---|
| 12:55:38 | 周锴 | `target_missing` | 无法取得正文 | 非重试错误；没有自动再次打开 |
| 12:56:38 | 李子音 | OCR 193 行，逐行置信度均为 100；识别 CET-4 | `not_matched`，置信度 0.98 | 英语证书不符合 CET-6 或 TEM-8 任一要求 |
| 12:58:08 | 刘梦莎 | OCR 31 行，逐行置信度均为 100；识别 TEM-4、CET-4 | `not_matched`，置信度 1.0 | 毕业年份为 2027，且英语证书不符合要求 |

两份完成规则判断的样本各保留 2 项语义 shadow 结果。shadow 仅供 HR 查看，不改变硬规则结论；模型未配置或无法给出确定答案的项目在页面显示为“待复核”，没有伪装为已通过或未通过。

## 3. 联系边界

- 三人均为未通过或失败，没有符合联系条件的候选人。
- 没有通过人工改判制造发送资格。
- 没有候选人级消息预览可供许可；联系页只显示“仅预览，发送未启动”。
- `approved=0`、联系记录为 0、actionable contact 为 0、contact attempt 为 0。
- 未点击确认发送，未调用 BOSS 打招呼/发送接口，没有真实消息副作用。

“开启真实打招呼”本轮没有执行。当前 transport 仍可能产生多个外部写动作，并且无法保存足以判定成功和去重的权威 receipt；在这两个问题解决并完成专项许可验收前，保持 `BOSS_FORGE_CONTACT_DISPATCH_MODE=disabled` 和 `REAL_CONTACT_TRANSPORT_AVAILABLE=false` 是必要安全边界。

## 4. 验收后的干净状态

- 验收任务通过正式 API 取消。
- 15 名候选人中保留 2 条 `screened`、1 条 `failed` 作为验收证据；剩余 12 条 `queued` 已停放为 `not_requested`。
- 全库 actionable resume 为 0。
- 全库 actionable contact 为 0，contact attempt 为 0。
- 未删除候选人或历史记录，未清理 Cookie、LocalStorage、浏览器用户目录或登录数据卷。

## 5. 发布与自动化验证

- 三简历生产执行使用 release `canary3-20260904-1207cst`。
- 最终 release：`acceptance2-20260904-1315cst`。
- 对应镜像：`sha256:3a5ac64c166c9e13f1280bf9dd43e92ef85fe0e707cc08f782787e229b346a7c`。
- 最终筛选 worker 已复用原三个持久化卷启动为空闲 normal 模式；`browserAuthenticated=true`、状态为 `authenticated`，联系分发保持 `disabled`，联系 worker 未启动。
- 最终启动前后，任务、简历、联系、审批和 outbox actionable 队列均为 0；当日数据库共有 4 次保守计入的简历查看，其中 1 次为本轮前既有边界 canary、3 次为本轮验收。
- 最新全量回归：67 个测试文件、447 项测试通过。
- `pnpm typecheck`、`pnpm lint:web`、`pnpm web:build` 均通过。

## 6. 仍需人工关注的边界

- `target_missing` 已能安全停止，但候选人卡片失效本身仍可能自然发生；HR 应重新采集候选人，而不是反复重试同一失效目标。
- 当前语义结果只允许 shadow；真实模型未配置的项目显示“待复核”，不能代替 HR 判断。
- 系统内真实联系发送仍不可用。HR 可以完成联系文案配置与安全预览；如确需发送，只能在 transport 单写和权威 receipt 两项阻断修复并另行验收后启用。
