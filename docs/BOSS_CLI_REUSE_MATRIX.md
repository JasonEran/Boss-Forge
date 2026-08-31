# boss-cli 能力复用清单

> 调研日期：2026-08-31
>
> 上游仓库：[joohw/boss-cli](https://github.com/joohw/boss-cli)
>
> 原则：能调用不重写，Boss-Forge 不包含 Boss 页面自动化实现。

## 直接复用

| 分类 | 命令 | Boss-Forge 用途 |
|---|---|---|
| 会话 | `boss login` | 打开登录页并复用本机 Chrome 登录态 |
| 岗位 | `boss positions` | 同步职位及状态 |
| 岗位 | `boss jd <名称>` | 同步职位详情和 JD |
| 获客 | `boss recommend [岗位]` | 获取推荐候选人；保留 BOSS 显式标签供 985/211/双一流筛选 |
| 获客 | `boss search [关键词]` | 获取常规搜索候选人；复用卡片 `标签`，不按学校名自建分类 |
| 获客 | `boss deep-search --core ... --bonus ... [--match]` | 配置并执行深度匹配 |
| 简历 | `boss preview <姓名>` | 获取在线简历截图及可选 OCR 正文 |
| 会话 | `boss list [--unread]` | 获取沟通列表和未读消息 |
| 会话 | `boss chat <姓名>` / `--index <序号>` | 打开候选人聊天 |
| 消息 | `boss send --text <内容>` | 发送文本消息 |
| 消息 | `boss send ... --request-resume` | 发送后索取附件简历 |
| 招呼 | `boss greet <姓名> --job <岗位>` | 人工确认或自动策略触发后执行打招呼 |
| 候选人动作 | `boss action resume` | 在线简历截图及可选 OCR |
| 候选人动作 | `boss action not-fit` | 标记不合适 |
| 候选人动作 | `boss action remark --remark <内容>` | 写入 Boss 侧备注 |
| 候选人动作 | `boss action agree-resume` | 接受候选人的附件简历 |
| 候选人动作 | `boss action request-attachment-resume` | 主动索取附件简历 |
| 候选人动作 | `boss action history` | 读取同事和本人沟通记录 |
| 候选人动作 | `boss action wechat` | 交换微信 |

## Boss-Forge 自建

- 内网 Dashboard、公司用户、角色和权限。
- 立即任务、定时计划、队列、状态机和失败恢复。
- 筛选规则、版本、标准能力词典和 `TEM8/专八` 等归一化。
- 候选人结构化数据、跨任务/岗位去重、联系冷却期。
- 人工审核工作台和第一阶段人工确认流程。
- 第二阶段自动打招呼三级开关、限额、熔断与紧急停止。
- 业务幂等、审计日志、指标和招聘漏斗。
- 对 CLI 输出的最薄结构化解析层。

## 不建设

- Boss DOM 选择器、页面 URL 识别和导航。
- Chrome/CDP 生命周期、页面会话锁、随机延时和弹窗处理。
- 推荐、搜索、深搜、岗位、JD、简历预览、截图、聊天和招呼的页面自动化。
- `boss-cli@0.6.6` 通过项目级 pnpm 补丁保证推荐卡片同时输出“优势”和显式“标签”；Boss-Forge 只做字段归一化和规则判定，不复制 DOM 读取逻辑。
- 简历弹层、长截图继续复用 `boss-cli`；OCR 按配置选择 `boss-cli` 内置百度 OCR 或用户指定的腾讯云 `GeneralBasicOCR`，不会重写 BOSS 页面操作。

## 版本与调用约束

1. 生产安装确定版本号，不使用 `@latest`，也不从 Dashboard 调用 `boss update`。
2. 通过子进程参数数组调用，禁止拼接 Shell 字符串。
3. 同一 Boss 账号串行执行 CLI 命令。
4. 保存命令、参数摘要、版本、退出码和脱敏输出，但不保存密钥。
5. 上游升级先做契约回归：命令参数、输出格式、页面前置条件和错误行为。
6. 缺失能力优先向上游提交 Issue/PR，再评审是否在 Boss-Forge 扩展。
