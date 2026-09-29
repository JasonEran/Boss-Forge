# “没有已通过、都是信息不足”生产核对

> **历史记录 · 2026-09-07**：下文保留当时的版本、验证和限制，不代表当前生产状态。现行说明见[文档索引](README.md)、[当前状态](CURRENT_STATUS.md)与[运维手册](OPERATIONS_RUNBOOK.md)。

核对时间：2026-09-07 13:56–14:00（Asia/Shanghai）。运行版本：`boss-jobs-20260907-1310cst`。本轮只查询生产状态、筛选记录和规则，并核对代码；未修改规则、候选人结论或队列，未重启服务。

## 实际结果

最新任务仍为 9 月 4 日 17:42 创建的海外运营专员任务 `5aa0915c-1ebf-48cc-a8ac-721a98da7b6a`，共 23 人：

| 人数 | 规则结果 | 完整简历状态 | 原因 |
| --- | --- | --- | --- |
| 19 | insufficient | failed | source_expired；系统未定位到原候选人，未取得完整简历 |
| 4 | not_matched | screened | 当前规则要求 TEM8，证据只识别到其他英语证书 |
| 0 | matched | — | 没有规则通过结果 |

19 人中 7 人的最近失败更新在 9 月 7 日 13:45，错误文字来自新版列表恢复路径；其余 12 人的失败更新在当天 11:13–11:24。错误码只能证明本次未定位到原候选人，不能证明候选人已经删除或永久不可见。

前一任务（9 月 4 日 16:47）15 人均已精筛，其中 13 人 not_matched、2 人 insufficient；这 2 人缺少可确认的英语证书、毕业年份和性别字段。

## 确认的原因和表达问题

1. `packages/data/src/repository.ts` 的 `failResumeScreening` 将读取异常统一写成 `rule_decision = 'insufficient'`，同时单独保存 `resume_screening_status = 'failed'`。前端规则标签直接将 insufficient 显示为“信息不足”。因此技术读取失败和已读简历但证据不足被混在同一结论里。
2. 上述两批共 38 条记录的性别规则证据全部为 `field_missing`，原始卡片无显式性别字段。规则采用 AND 且缺失策略是 manual_review，因此其他条件即便满足也不能自动变为 matched。`packages/m1-core/src/generic-rules.ts` 的 `selectedValues` 对该字段只读卡片显式字段/基本信息，不读取传入的完整简历文字。此处是对现有行为的诊断，不构成新增或强化性别筛选的建议。
3. 最新批次 4 个 not_matched 的英语证据分别为 CET4、CET6+CET4、CET6+CET4+IELTS、TEM4+CET6+CET4。没有提取到 TEM8；现有代码将检测到其他证书但未匹配目标证书归为 not_matched。这不等价于证实本人没有 TEM8。
4. 9 月 7 日 13:57:32 的 BOSS 状态接口报告 Chromium CDP `Network.enable timed out`，全部 BOSS Worker 已停止。不能沿用旧的“等待扫码”或数据库 9 月 4 日的 healthy 快照来描述当前实时连接。

## 语义模式及规则版本的澄清

两批任务冻结使用规则 v5，岗位当前发布的是 v6。当前编辑规则不会自动改写这些历史任务的结论。

岗位语义模式为 shadow。`packages/m1-core/src/index.ts` 的 `evaluateSemanticNode` 对已产生的 shadow/off 结果返回 ignored，在混合 AND 规则中不会单独阻挡其余条件通过。只有尚未提供语义评估时才按缺失处理；纯语义规则全部被忽略时也会归入 insufficient。因此不能把这次已精筛候选人的信息不足归因于 shadow 模式本身。生产语义记录同时有别名匹配和 `semantic_model_unavailable`，说明语义识别能力还存在独立限制。

“已通过人工审核”列表还要求 review_status 为 approved，区别于规则 matched；最新两批没有人工批准记录。

## 后续修复方向

将“读取失败/尚未精筛”和“已精筛但证据不足”独立呈现，并明确列出缺失项、任务使用的规则版本。恢复浏览器连接后核验实际岗位及当前推荐列表，再决定重采或重试；不通过直接修改筛选结论或将缺失信息当作满足来制造通过人数。
