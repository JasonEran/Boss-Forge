# M1 数据与规则闭环运行手册

> M1 执行候选人读取、去重、完整简历精筛和待审核入库；真实简历预览需要显式环境开关，任何情况下都不自动发送招呼。

## 1. 已实现范围

- PostgreSQL 持久化的岗位、不可变规则版本、任务、候选人、快照、岗位状态、规则证据和审计日志。
- 岗位、规则版本、立即任务和 Dashboard 查询 API。
- `Idempotency-Key` 保证重复点击不会创建重复任务。
- Worker 通过 `FOR UPDATE SKIP LOCKED` 领取任务，并在 BOSS 账号锁内调用 `boss-cli`。
- 候选人指纹去重，原始字段和证据保留。
- TEM8 多表达评估及否定、备考、主观能力和易混淆证书识别。
- 完整简历预览队列、OCR 文本二次规则评估、失败重试和任务状态收敛。
- 未达到 TEM8 时展示简历明确写出的 TEM4、CET4/6、IELTS、TOEFL、BEC 等当前证书或成绩，不做跨考试体系等值换算。
- Dashboard 使用真实 API 数据，支持创建立即任务和 5 秒状态刷新。
- Dashboard 支持新建岗位与 TEM8 规则版本、切换岗位、查看候选人原文及命中证据。
- HR 可以通过或拒绝候选人，保存备注和规则纠错类型。
- 审核接口同时使用幂等键和状态版本，防止重复点击与多人静默覆盖。

## 2. 本地启动

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm m1:seed
```

依次在独立终端启动：

```bash
pnpm api
pnpm m1:worker
pnpm web:dev
```

- Dashboard：`http://localhost:3000`
- Control API：`http://127.0.0.1:3100`
- PostgreSQL：仅绑定 `127.0.0.1:55433`

## 3. 立即任务数据流

```text
Dashboard 创建任务
  → Control API 验证 Idempotency-Key
  → PostgreSQL tasks(queued)
  → Worker 锁定并领取任务
  → boss-cli recommend/search（候选人卡片初筛）
  → 解析、指纹去重、候选人进入 resume screening 队列
  → 重新建立候选人列表上下文并调用 boss-cli preview
  → 简历 OCR 正文执行 TEM8 精筛并识别当前英语证书/成绩
  → 候选人快照、简历证据、规则结论和待审核状态入库
  → Dashboard 刷新结果
```

## 4. 任务与规则语义

- `matched`：高置信度确认符合 TEM8 条件，进入待审核。
- `ambiguous`：表达冲突、备考或主观描述，进入待复核。
- `insufficient`：简历 OCR 无正文、读取失败或完整简历仍无证据，保留在人工复核队列。
- `not_matched`：有高置信度排除证据，保存记录但不进入待审核列表。

## 5. 安全边界

- `preview` 只有在 `BOSS_FORGE_RESUME_PREVIEW_ENABLED=1` 与 `BOSS_RESUME_OCR=1` 同时开启时执行；默认均关闭。
- 当前 `boss-cli` OCR 使用外部 OCR 服务，只有完成隐私审批并配置密钥后才能开启；日志不保存完整简历正文。
- M1 Worker 不生成 `greet` 或 `send`，真实联系总开关保持关闭。
- 同一 BOSS 账号的页面操作使用进程锁串行化。
- 自动打招呼开关仍保持关闭，不会因 M1 任务自动联系候选人。
- PostgreSQL 开发端口只绑定本机回环地址。

## 6. 当前实机验收

2026-08-31 已完成两次只读采集任务：

- 每次获取 33 位候选人，重复任务后候选人主档按指纹去重。
- 30 位为 `insufficient`，3 位因 CET 等明确易混淆证书判定为 `not_matched`。
- 同一幂等键重复请求返回同一任务 ID。
- 常驻 Worker 可将 Dashboard 新建的 `queued` 任务推进到 `screening`，全部简历精筛完成后再进入 `waiting_review`。
- 已完成基于合成 OCR 文本的简历精筛集成测试；没有调用真实简历预览或联系命令。
- 既有 33 位候选人不会因迁移自动触发预览，可在候选人详情中按需点击“重新精筛简历”。

## 7. M1 当前状态与后续项

M1 数据闭环已经完成，并已与 M2 的定时筛选、消息预览和受控联系流程集成。当前自动打招呼仍关闭。

后续增强项：

- 审核队列的分页、条件筛选和已审核历史视图。
- 将规则纠错反馈汇总为词典变更待审批列表。
- 新版本升级时先运行所有解析器契约测试；契约失败禁止部署。

当前验收结果参见 [M1/M2 验收清单与测试报告](M1_M2_ACCEPTANCE.md)。
