# M2 定时筛选与受控联系运行手册

## 当前交付范围

M2 已实现：

- 一次性、每日、工作日、每周定时筛选；统一使用 `Asia/Shanghai` 时区。
- 定时器只生成与“立即执行”相同的筛选任务，由 M1 Worker 串行调用 `boss-cli recommend/search`，并在简历精筛开关开启时继续执行 `boss-cli preview`。
- 审核通过后生成服务端消息预览，HR 显式确认后写入联系意图与 Outbox。
- 联系意图具备幂等、同岗位去重、跨岗位冷却、允许时段、账号/岗位/任务限额和紧急停止策略。
- 执行前再次检查策略；超时或中断记为 `uncertain` 并停止自动重试。
- 联系结果、失败原因与关键操作进入 Dashboard 和审计日志。

本轮没有测试任何真实 `boss greet`，也没有发送消息。

## 启动

```bash
pnpm db:up
pnpm db:migrate
pnpm m1:seed
pnpm api
pnpm m1:worker
pnpm web:dev
```

访问 `http://localhost:3000`：

1. 选择岗位后可立即执行筛选，或创建定时筛选。
2. 在待审核列表查看原文证据并通过/拒绝。
3. 对已通过候选人点击“消息预览”。
4. 明确确认后仅创建 `ready` 联系任务；默认不会真实执行。

## 真实打招呼安全门

联系 Worker 默认拒绝运行。只有命令行批准参数和环境总开关同时存在时，才可能调用 `boss-cli greet`：

```bash
BOSS_FORGE_REAL_GREET_ENABLED=1 pnpm m2:contact-worker -- --approve-real-greet
```

不要把总开关长期写成 `1`。真实验收前应逐条核对候选人、岗位、预览消息、当天限额和 BOSS 当前页面，并取得单独授权。

当前 `.env.example` 的安全默认值是：

```dotenv
BOSS_FORGE_REAL_GREET_ENABLED=0
```

## 无真实发送验证

```bash
pnpm typecheck
pnpm lint:web
pnpm test
pnpm test:integration:data
pnpm test:e2e:user
pnpm web:build
```

数据集成测试使用合成候选人和假传输，只验证联系状态从 `ready` 到 `sent` 的数据库闭环，不调用 `boss-cli greet` 或 `send`。

`test:e2e:user` 按 HR 用户路径调用与 Dashboard 相同的控制 API，覆盖岗位、规则、立即筛选任务、候选人证据、人工审核、消息预览、联系意图、定时任务和审计日志。测试断言真实打招呼未执行，并在结束后自动清理所有合成数据。

完整验收结果参见 [M1/M2 验收清单与测试报告](M1_M2_ACCEPTANCE.md)。
