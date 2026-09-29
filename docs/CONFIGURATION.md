# 配置参考

> 配置来源：[本地示例](../.env.example)、[生产模板](../deploy/intranet.env.example)、[Compose](../deploy/compose.intranet.yaml)及代码默认值。生产实际值见带时间的[当前状态](CURRENT_STATUS.md)。

## 1. 配置层次

- 本地 `.env` 用于开发。带 `--env-file-if-exists=.env` 的脚本会加载它；`m0`、`boss-login-relay`、`boss-session-supervisor` 脚本本身不会自动加载。
- 生产 `/opt/boss-forge/deploy/.env.intranet` 供 Compose 注入。修改文件不等于运行容器已使用新值；运行配置变更通常需受控重建相关服务。
- `NEXT_PUBLIC_CONTROL_API_URL` 是前端构建参数。修改后重建 Web 产物；不能仅改容器环境就声称浏览器已更新。
- 岗位、规则、计划、联系控制是数据库业务配置，经控制台/API 修改，不靠 `.env` 覆盖。
- 默认值、示例值、生产实际值应分别记录，禁止把示例文件直接覆盖现有生产秘密。

## 2. 基础配置

| 配置 | 用途 / 默认或约束 |
| --- | --- |
| `DATABASE_URL` | API / Worker 数据库连接；本地模板指向 127.0.0.1:55433 |
| `CONTROL_API_HOST` / `CONTROL_API_PORT` | 本地 API 监听；模板为 127.0.0.1 / 3100 |
| `CONTROL_WEB_ORIGIN` | 允许的 Web 来源，须与实际协议/域名/端口相符 |
| `NEXT_PUBLIC_CONTROL_API_URL` | Web 构建时 API 地址；生产 HTTPS 通过同源网关 |
| `BOSS_FORGE_RELEASE_ID` | API、Web 镜像和 Worker 的不可变发布标识 |
| `BOSS_FORGE_IMAGE` | 生产应用镜像；预检校验标签/摘要和内部 release |
| `BOSS_FORGE_BOOTSTRAP_ADMIN_EMAIL` / `BOSS_FORGE_BOOTSTRAP_PASSWORD` | 空用户表首次创建管理员；不是已存在用户的密码重置接口 |
| `BOSS_FORGE_ACCOUNT_ID` | Worker 分区与账号锁的逻辑标识，不是 BOSS 手机用户身份验证 |
| `BOSS_FORGE_WORKER_ID` / `BOSS_FORGE_RUNTIME_DIR` | Worker 标识与心跳/登录 IPC 文件目录 |

## 3. 浏览器与扫码

| 配置 / 文件 | 用途 |
| --- | --- |
| `BOSS_BROWSER_PROFILE_VOLUME` / `BOSS_CLI_DATA_VOLUME` | 必须对应现有生产实际挂载的 external volume |
| `BOSS_BROWSER_USER_DATA_DIR` / `BOSS_BROWSER_PROFILE_DIRECTORY` | profile 目录与 profile 名称 |
| `BOSS_BROWSER_REMOTE_DEBUGGING_PORT` | 管理的 CDP 端口；模板 53470，不公开到公网 |
| `BOSS_BROWSER_VIEWPORT_WIDTH` / `BOSS_BROWSER_VIEWPORT_HEIGHT` | 部署浏览器尺寸；诊断不得随意覆盖 |
| `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` | 显式浏览器程序路径 |
| `BOSS_FORGE_BOSS_LOGIN_RESTART_POLICY` | Compose 模板 `on-failure`；受控 canary 另行配置 |
| `loginMethod` | 刷新接口字段：`wechat` 或 `boss_app`；省略时使用已保存选择，首次默认微信 |
| `boss-login-method.json` | runtime 中保存扫码偏好，不是数据库规则或账号身份 |

扫码偏好不是新增 `.env` 开关。API 只接收合法枚举，安全验证状态下不能通过刷新绕过验证。

## 4. 三种不同的数量限制

| 概念 | 来源 | 含义 |
| --- | --- | --- |
| 单任务目标 | 数据库 `tasks.candidate_limit` / `auto_greet` | 自动招呼开启按 sent greet 计数；关闭按 screened + matched 计数；默认 20，范围 1–100000 |
| 每波大小 | `SCREENING_CHUNK_SIZE=20` | 控制每波处理量，不等于任务总目标 |
| 账号日自动招呼上限 | `BOSS_FORGE_AUTO_GREET_DAILY_LIMIT` | 默认 200，按上海自然日，计入 sent、ready、processing 和 uncertain 的真实招呼占用，独立于简历软限额 |

`BOSS_FORGE_RESUME_QUOTAS_ENABLED=0` 关闭的是本平台简历软限额，**不关闭账号自动招呼日上限，也不改变 BOSS 平台限制**。数据库 `contact_settings.internal_quotas_enabled` 是另一套联系数量策略开关，不应混称“无限制”。

简历查看配置包括 `BOSS_FORGE_RESUME_DAILY_LIMIT`、`BOSS_FORGE_RESUME_HOURLY_LIMIT`、`BOSS_FORGE_RESUME_DWELL_MIN_SECONDS` / `TARGET_SECONDS` / `MAX_SECONDS`、`BOSS_FORGE_RESUME_BATCH_SIZE`、`BOSS_FORGE_RESUME_BREAK_MINUTES`、`BOSS_FORGE_RESUME_WORKDAY_START_HOUR` / `END_HOUR`。模板停留时间为 10 秒，现场值可能不同；以 `/health` 与 Worker 相同的运行策略为准。

## 5. 简历、OCR 和模型

| 配置 | 用途 / 默认 |
| --- | --- |
| `BOSS_FORGE_RESUME_PREVIEW_ENABLED` | 真实简历读取开关；模板 0 |
| `BOSS_FORGE_OCR_PROVIDER` | `tencent` 或 `boss`；模板 tencent |
| `BOSS_RESUME_OCR` | boss-cli 内置 OCR；Tencent 路径用 0，避免双重 OCR |
| `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` / `TENCENTCLOUD_OCR_REGION` | Tencent OCR 服务端凭据和区域，区域模板 ap-guangzhou |
| `BOSS_FORGE_SEMANTIC_ENABLED` | 模型连接总开关；模板 0，不等于每个岗位启用 AI |
| `BOSS_FORGE_SEMANTIC_BASE_URL` / `BOSS_FORGE_SEMANTIC_MODEL` / `BOSS_FORGE_SEMANTIC_API_KEY` | 获准的 HTTPS 服务、模型和专用密钥 |
| `BOSS_FORGE_SEMANTIC_FALLBACK_MODEL` | 可选备用模型，主模型失败时使用 |
| `BOSS_FORGE_SEMANTIC_TIMEOUT_MS` | 模板 45000 毫秒；实际超时和 fallback 逻辑以连接器为准 |

旧规则语义模式来自岗位数据库字段，只允许 off/shadow；不要把模板中遗留的 `BOSS_FORGE_SEMANTIC_MODE` 当作覆盖岗位模式的有效开关。岗位招聘 AI 评估还有自己的规则配置与分析状态，参见[架构](SYSTEM_ARCHITECTURE.md)。

## 6. 真实联系

| 配置 | 约束 |
| --- | --- |
| `BOSS_FORGE_CONTACT_DISPATCH_MODE` | `disabled`（模板默认）、`fake`（隔离模拟）、`real` |
| `BOSS_FORGE_REAL_GREET_ENABLED` | 兼容命名的独立运行总闸，真实模式需要 1 |
| `BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY` | API 与 Worker 共用的部署秘密，至少 32 UTF-8 字节，不进入前端 |
| `BOSS_FORGE_ACCOUNT_HEALTH_MAX_AGE_MS` | 联系账号健康记录新鲜度；模板 1800000 毫秒 |

还需要受 supervisor 管理的 Worker、明确任务/动作授权、业务开关和发送前检查。联系模式 real 只说明运行能力，不能证明某个任务已开启自动招呼，也不能证明消息已送达。没有回执时必须保留不确定状态。

## 7. 备份与秘密

生产模板 `BOSS_FORGE_BACKUP_INTERVAL_SECONDS=86400`，`BOSS_FORGE_BACKUP_RETENTION_DAYS=14`。资源限制、镜像、绑定端口和 TLS 文件路径集中在生产模板；修改前阅读[部署手册](INTRANET_DEPLOYMENT.md)。

只分享必要配置名与非秘密状态。不要输出整个 `docker inspect`、完整 Compose 渲染或 `.env`；它们可能包含数据库密码、OCR 密钥和签名秘密。
