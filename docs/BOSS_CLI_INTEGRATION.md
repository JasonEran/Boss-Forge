# boss-cli 集成边界

> 上游项目：`https://github.com/joohw/boss-cli`
>
> 当前唯一支持版本：`0.6.6`

## 1. 复用原则

Boss-Forge 不直接维护 BOSS 页面选择器、登录流程或会话协议。所有 BOSS 页面操作由 `@joohw/boss-cli` 执行，`packages/boss-cli-adapter` 负责：

- 把类型化命令转换为 argv。
- 分类只读、额度读取和外部写入风险。
- 使用参数数组启动进程，不拼接 Shell 字符串。
- 校验安装版本。
- 把 stdout 解析为稳定的岗位或候选人结构。
- 屏蔽原始 stdout 中可能包含的敏感简历内容，不写入通用执行日志。

## 2. 能力分层

| boss-cli 命令 | 适配器 | M0 诊断 | Dashboard Worker |
|---|---:|---:|---:|
| `login` | 支持 | 支持 | 不自动执行 |
| `positions` | 支持 | 支持 | 不使用 |
| `jd` | 支持 argv | 未开放 | 不使用 |
| `recommend` | 支持解析 | 支持 | 使用 |
| `search` | 支持解析 | 支持 | 使用 |
| `deep-search` | 支持解析 | 未开放 | 当前不使用 |
| `preview` | 支持解析 | 显式批准 | 精筛开关开启时使用 |
| `greet` | 支持 | 双重批准 | 产品路径当前不可成功执行 |
| `list/chat/send/action` | 支持 argv/部分解析 | 未开放 | 当前不使用 |

“适配器支持”只表示存在类型和参数映射，不代表已经成为 Dashboard 产品功能。

## 3. 风险分类

| 风险 | 命令 | 约束 |
|---|---|---|
| `read` | help、version、login、positions、jd、recommend、search、list/chat 只读形态 | 仍受平台频率和登录态约束 |
| `quota-consuming-read` | preview、带 `--match` 的 deep-search、部分 resume/history action | 必须显式业务批准和配额控制 |
| `external-write` | greet、send、not-fit/remark/wechat 等 action | 不允许从普通 Web 请求直接执行 |

## 4. 本地补丁

仓库通过 pnpm `patchedDependencies` 固定补丁：

```text
patches/@joohw__boss-cli@0.6.6.patch
```

补丁只在推荐候选人文本输出中增加 `标签:` 行，使适配器能读取上游候选人对象已有的 `highlights`。它不新增页面抓取、不推断学校类别，也不改变 greet 行为。

985/211/双一流必须来自该显式标签行；缺少标签时按规则 `unknownPolicy` 处理。

## 5. 解析契约

适配器只接受 0.6.6。升级 boss-cli 前必须：

1. 阅读上游变更。
2. 重新应用或删除本地补丁。
3. 更新 `SUPPORTED_BOSS_CLI_VERSIONS`。
4. 为 positions/recommend/search/deep-search/preview 增加真实脱敏 fixture。
5. 运行命令构建、解析器和 Worker 集成测试。
6. 单独复核所有额度读取与写入命令的风险分类。

未知版本必须失败关闭，不能尝试“尽量解析”。

## 6. Worker 调用约束

- 同一 `BOSS_FORGE_ACCOUNT_ID` 的外部操作必须经过账号锁。
- 任务只能由绑定相同账号 ID 的 Worker 领取。
- greet 前必须重新读取原来源候选人列表，并用快照和姓名唯一性重验目标。
- 同名多条、候选人消失或关键信息变化时失败关闭。
- stdout 解析错误只影响当前任务/候选人，不得静默视为无候选人。
- 浏览器 profile 和 `.boss-cli` 数据不得提交 Git 或跨操作系统直接复制。

## 7. 不重复建设

Boss-Forge 不建设：

- 第二套 BOSS DOM 抓取和登录实现。
- 绕过验证码、风控、额度或平台限制的能力。
- 从学校名称推断 BOSS 平台 985/211/双一流标签。
- 浏览器端直接调用 boss-cli。

Boss-Forge 自己建设的是岗位规则、任务队列、证据、审核、联系策略、幂等、审计和 HR 产品界面。
