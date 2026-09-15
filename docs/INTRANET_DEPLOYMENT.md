# Boss-Forge Ubuntu 内网部署

> 部署文件：`deploy/compose.intranet.yaml`
>
> 形态：纯自研 Web/API、单 PostgreSQL、默认零真实联系

> 当前状态：release `audit-events-20260904-1614cst` 已生产部署；真实 greet/message runtime 已开启，但全局/部门联系控制保持 safe-off，尚未执行真实写入。Compose 模板默认仍是 `disabled`/`0`。

## 1. 使用边界

本文描述 2026-09-04 修复版本及其后续联系版本的部署方式。下文 1.1/1.2 是历史发布证据；当前联系 release 见 1.3。Control API 提供登录和部门级授权；跨公网访问时必须启用 TLS 网关，不能用明文 HTTP 传输账号或招聘数据。

部署文件不包含 Odoo 或第二个 PostgreSQL。当前工作树已包含真实联系传输，但默认配置仍失败关闭；只有 real 模式、兼容总闸、部署签名密钥、supervisor 确认、四级开关和候选人级许可全部满足时才可处理一个明确动作。`https` profile 提供独立、可选的只读证书反向代理。

### 1.1 2026-09-04 既有远端发布安全基线（历史）

以下内容记录 `remediation-20260904-0312cst` 这一历史发布轮次，本身不作为最终 release 的部署证据；最终现场结果见第 1.2 节。该轮远端使用同一不可变镜像运行 API、Web 和 `boss-login`，migration 023–024 已应用，24 条 migration checksum 均存在。浏览器 profile 与 boss-cli 数据继续挂载原 external volume；受控重启前后均验证为 `authenticated`，该轮启动后的 Worker heartbeat 为 fresh，没有刷新二维码、退出登录或重建登录目录。

Supervisor 只运行 M1 和 `contact-worker --fake --loop`，不存在 Real Worker。运行环境为 `BOSS_FORGE_REAL_GREET_ENABLED=0`，编译期能力门为 false；只读检查确认候选人待联系 `queued`、联系审批请求 `pending/approved`、联系意图 `ready/processing` 和 `contact_attempts` 均为 0。全局与部门控制继续 disabled + emergency stop；1 条历史岗位级 enabled 控制记录按审计红线保留，但无法形成可执行联系任务。

该历史轮次已新增并持久化 3 GiB swap，物理 RAM 与 swap 合计通过预检；Compose 资源/PID 上限、生产 Web、每日备份和 TLS gateway 当时均在运行。发布前数据库备份已经通过 `pg_restore --list` 校验。最近核对时生产 semantic 保持 disabled，API key 为空；诊断期间暴露过的旧凭据必须先在提供方轮换，不得从历史环境文件或备份恢复，轮换后也只允许 shadow。

该历史轮次已把远端日常运维目录同步为受审计部署文件，旧文件以 `.pre-remediation-20260904` 后缀保留。登录相关命名卷明确声明为 external，build context 指向 `/opt/boss-forge/current`，避免未来从陈旧源码构建或意外创建替代登录卷。该轮生产环境把 TLS 网关映射到主机 443；文中的 8443 是示例默认值。

### 1.2 最终 release 现场状态

release `boundaryfix-20260904-1043cst` 已部署，镜像为 `sha256:9fdcd7f13c70eb29c16df59a7bccf30074d01e011f0abe492805fd245db8cb69`。API/Web 使用精确镜像且 healthy，公开 HTTPS 首页返回 200；`/health` 返回正确 release 和简历额度（每日 120、每小时 20）。Safari 刷新旧会话后直接进入 Dashboard，岗位、任务、候选人、联系、自动联系、运营、设置和审计页面均加载，没有 `Load failed`。

`boss-login` 与 `migrate` 容器也是精确最终镜像，但保持 Created/停止。原 worker runtime、browser profile、boss-cli data 三个卷挂载一致，当前没有运行容器占用 browser profile。为避免 worker 自动领取 17 份 queued 简历，本次最终部署没有启动它；因此没有执行新的在线 `authenticated` 探测。BOSS 状态页按真实情况显示服务未启动、release/策略/心跳不一致并阻止自动操作，同时明确提示不要刷新二维码或重新登录。先前已经验证的登录卷持久化、`authenticated` 和单次 `target_missing` canary 仍是有效历史证据，但不能冒充本次部署后的新探测。

数据库共有 24 条 migration；今日 `resume_viewed=1`，简历状态 failed 7、queued 17、screened 6。两个 screening 任务的 `wait_reason` 都是 `daily_quota_reached`，属于 canary 临时一份额度留下的等待状态；服务已停止，不会自动执行。enabled schedule 为 0。联系意图/actionable/real、attempt、sent、queued-contact、授权和审批请求全部为 0。部署前 `pre-boundaryfix` dump 已验证。

### 1.3 当前联系 release 现场状态

release `audit-events-20260904-1614cst` 已生产部署，migration 026 与独立 greet/message runtime 已上线。BOSS 会话继续使用原 `browser_profile`、`boss_cli_data` 和 `worker_runtime` 持久化 volumes，状态为 `authenticated`；部署没有退出登录、清理浏览器数据或重建登录目录。

运行模式已是 real，但全局和部门联系控制保持 safe-off。现场联系队列、intent、attempt 和 authorization 均为 0，真实发送为 0。当前没有同时满足联系条件和人工审核通过的候选人，因此尚未签发用于执行的候选人许可，也没有执行首次真实 canary。首次动作仍须先展示唯一动作、候选人、BOSS 发件账号、岗位/任务和完整正文，并取得用户对该组合与正文的精确许可；部署完成、runtime real 或预览成功都不能替代许可。

## 2. 服务

| 服务 | 默认启动 | 主机端口 | 说明 |
|---|---:|---:|---|
| `postgres` | 是 | 无 | 唯一业务数据库，仅内部 data 网络 |
| `postgres-backup` | 是 | 无 | 每日生成并校验自包含备份，默认保留 14 天 |
| `migrate` | 一次性 | 无 | 执行幂等迁移后退出 |
| `api` | 是 | 3100 | Control API |
| `web` | 是 | 3000 | 唯一 HR 控制面 |
| `gateway` | `https` profile | 8443 | 独立 TLS 入口；Web/API 可仅绑定本机 |
| `contact-worker-fake` | `contact-fake` profile | 无 | 只消费 Fake 联系；不要与 supervisor 并行运行 |
| `boss-login` | `boss-login` profile | 无 | 持久化登录、实时会话验证与筛选 worker 监督 |
| `boss-worker` | `boss-worker` profile | 无 | 旧维护入口；不得与 `boss-login` 并行运行 |

Web/API 默认绑定 `127.0.0.1`。办公室明文内网访问时，运维显式设置服务器固定私网 IP；公网环境保持本机绑定并启用 `https` profile。

## 3. 准备环境

安装 Docker Engine 与 Compose v2，克隆仓库后：

```bash
cp deploy/intranet.env.example deploy/.env.intranet
```

至少修改：

```text
INTRANET_BIND_IP=10.x.x.x
BOSS_DB_PASSWORD=<URL 安全随机值>
BOSS_FORGE_BOOTSTRAP_PASSWORD=<管理员强密码>
CONTROL_WEB_ORIGIN=http://10.x.x.x:3000
NEXT_PUBLIC_CONTROL_API_URL=http://10.x.x.x:3100
BOSS_FORGE_RELEASE_ID=<当前 Git commit 或不可变发布号>
BOSS_FORGE_IMAGE=boss-forge:<同一发布号>
BOSS_BROWSER_PROFILE_VOLUME=<已经存在的持久化浏览器卷名>
BOSS_CLI_DATA_VOLUME=<已经存在的 boss-cli 数据卷名>
```

`NEXT_PUBLIC_CONTROL_API_URL` 是 Web 构建参数；修改后必须重新 build。`BOSS_FORGE_RELEASE_ID` 会同时写入镜像、API 和 worker 状态，页面据此拒绝把不同批次的服务显示成一致。数据库密码建议使用 `openssl rand -hex 32`。

浏览器登录目录和 boss-cli 数据使用 **external volume**，不属于 Compose 项目生命周期，因此 `docker compose down -v` 也不能删除它们。首次安装且确认没有旧登录数据时，先显式创建固定名称的空卷，再把准确名称写入环境文件：

```bash
docker volume create boss-forge-browser-profile
docker volume create boss-forge-boss-cli-data
```

已有部署绝不能创建同名替代卷、复制或重建浏览器目录。先只读查询当前容器的实际挂载名，再原样写入环境文件：

```bash
docker inspect <当前-boss-login-容器> \
  --format '{{range .Mounts}}{{println .Destination .Name}}{{end}}'
```

其中 `/var/lib/boss-forge/browser` 对应 `BOSS_BROWSER_PROFILE_VOLUME`，`/home/node/.boss-cli` 对应 `BOSS_CLI_DATA_VOLUME`。若无法确认原卷，停止部署并保留当前容器，不得以新卷试错。

启用有界面 Chromium 前，宿主机必须同时满足：物理 RAM 不少于 3 GiB，且 RAM+swap 合计不少于 6 GiB。高内存主机无需为了形式强制配置 swap；低内存主机必须用足够 swap 补足 6 GiB 总量。曾发生 OOM 的远端不得以“当前可用内存看起来足够”代替整改。业务时段不得在同一台机器上构建镜像。Compose 已设置每个服务的内存和 PID 上限，避免单个 Chromium 或构建进程拖垮 PostgreSQL 与 Web。

公网 HTTPS 示例：

```text
INTRANET_BIND_IP=127.0.0.1
PUBLIC_BIND_IP=0.0.0.0
BOSS_HTTPS_PORT=8443
CONTROL_WEB_ORIGIN=https://<服务器地址>:8443
NEXT_PUBLIC_CONTROL_API_URL=https://<服务器地址>:8443
TLS_DIRECTORY=/etc/letsencrypt
BOSS_FORGE_TLS_CERTIFICATE=/etc/letsencrypt/live/<证书名>/fullchain.pem
BOSS_FORGE_TLS_PRIVATE_KEY=/etc/letsencrypt/live/<证书名>/privkey.pem
```

证书目录只读挂载到独立网关，不修改或 reload 主机 Nginx。启动命令增加 `--profile https`。

直接使用公网 IP 时不要使用自签名证书。Certbot 5.4 及以上可签发 Let's Encrypt
短期 IP 证书；把证书路径配置为
`/etc/letsencrypt/live/boss-forge-ip/{fullchain,privkey}.pem`。IP 证书有效期约 6 天，
部署后的 `deploy/renew-ip-certificate.sh` 可由
`deploy/boss-forge-cert-renewal.cron` 每 12 小时检查续期并平滑 reload 独立网关。

腾讯云密钥只写入 `deploy/.env.intranet`，该文件被 Git 忽略。

如需内网语义模型，必须先在提供方轮换诊断期间暴露过的旧凭据，再配置服务端连接；不得从历史环境文件或备份恢复旧值：

```text
BOSS_FORGE_SEMANTIC_ENABLED=1
BOSS_FORGE_SEMANTIC_BASE_URL=https://model.internal/v1
BOSS_FORGE_SEMANTIC_MODEL=<批准的模型名>
BOSS_FORGE_SEMANTIC_API_KEY=<新轮换的专用密钥，启用时必填>
```

启用时连接地址必须是 HTTPS，且必须配置非空专用密钥（即使内网网关只校验固定令牌）。这些变量注入 `api` 和可选的 BOSS Worker：岗位页通过 API 生成同义词，Worker 只保存简历语义 shadow 结果。AI 同义词必须由用户预览并应用后才进入新规则版本；岗位只允许 off/shadow，`SEMANTIC_ACTIVE_DECISIONS_AVAILABLE=false`，migration 024 也禁止 active。岗位模式修改后无需重启 Worker，端点或模型连接修改后需要重新创建 API/Worker。未配置模型时保持 `ENABLED=0`，界面会明确提示模型尚未配置。

## 4. 配置检查

在 Linux 部署主机先运行只读预检：

```bash
deploy/preflight-intranet.sh deploy/.env.intranet
```

预检会验证 Docker/Compose、固定 Compose 项目名、本机不可变镜像及镜像内发布号、真实联系开关、内存/swap、磁盘、两个外部登录数据卷是否真实存在，以及运行中的 `boss-login` 挂载名是否与配置完全一致。多个 `boss-login`、旧 `boss-worker`、独立 `contact-worker-fake` 或任何其他容器并发使用同一浏览器 profile 时，预检都会拒绝继续。它不会重启服务或修改登录数据。

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  config --services
```

默认输出应为：

```text
postgres
postgres-backup
migrate
api
web
```

顺序可能不同，但不得出现 Odoo 或 Real/Greet Worker。检查固定安全门：

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  config | grep BOSS_FORGE_REAL_GREET_ENABLED
```

默认值必须为 `"0"`。如经业务负责人批准启用真实联系，必须同时设置以下三项；只改其中一项时预检和 Worker 都会失败关闭：

```text
BOSS_FORGE_CONTACT_DISPATCH_MODE=real
BOSS_FORGE_REAL_GREET_ENABLED=1
BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY=<至少 32 字节的部署专用随机密钥>
```

`BOSS_FORGE_REAL_GREET_ENABLED` 是为兼容既有部署保留的变量名，实际同时控制两个相互独立的真实动作。它不代表允许自动打招呼；每次打招呼或发送正文仍分别需要候选人级短效许可。改动前先确认不存在 `queued`、`approved` 或 `processing` 联系任务，并保留全局紧急停止；不得通过直接运行 CLI 绕过预览许可。

首次真实 canary 前，必须把唯一一个具体动作、候选人、BOSS 发件账号、岗位/任务和完整正文展示给用户，并取得对该组合与正文的逐字许可；部署完成、开关开启或预览成功都不能替代这次许可。

## 5. 构建与启动

首次部署可在空闲主机上构建；已启用 BOSS 会话后，应在构建机生成相同不可变镜像并传入部署主机，不能一边运行 Chromium 一边在资源紧张的业务主机上编译。

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  build

docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  up -d
```

所有服务必须使用环境文件中同一个 `BOSS_FORGE_IMAGE`，禁止继续复用 `boss-forge:intranet` 一类可变标签进行部分重建。Web 由 `vinext start` 运行已构建产物，不再使用 `wrangler dev` 常驻。

检查：

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  ps

curl --fail http://10.x.x.x:3100/health
curl --fail http://10.x.x.x:3000/
```

`migrate` 正常状态是成功退出，不是长期运行。`postgres-backup` 首次启动会立即生成一份 custom-format 备份并用 `pg_restore --list` 校验，之后按配置周期运行。

## 6. BOSS Worker

默认部署不会读取 BOSS。需要使用 BOSS 时，启动带扫码与 Worker 自动交接能力的会话监督服务：

服务器无图形桌面时，先启动受 Boss Forge 管理员会话保护的实时扫码页。容器通过隔离的 Xvfb 显示器运行固定尺寸的有界面 Chromium；不使用 `--headless`，也不要在同一个账号/profile 上切换有头与无头模式：

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  --profile https \
  --profile boss-login \
  up -d --no-build --no-deps boss-login
```

管理员访问 `/boss-login`，使用 BOSS 直聘 App 扫描画面中的二维码。页面首次只读取一次服务器画面，不会自动截图或自动刷新；二维码过期时，由管理员点击“立即刷新二维码”，服务端才向 BOSS 请求并截取一次新二维码。扫码成功后，`boss-login` 会在同一持久化 Chromium 会话中自动启动筛选 Worker。supervisor 每 5 秒只读检查 Chromium CDP 中的 BOSS 页面和筛选 Worker 心跳；登录页、验证页、Chromium 消失或心跳陈旧都会立即停止 BOSS workers，并保持错误状态等待管理员处理，不会反复刷新二维码。

当前 `boss-login` supervisor 只允许在 authenticated 且 Control API 的运行版本、简历安全策略、联系模式与 Worker 完全一致后启动筛选 Worker，并按配置选择不启动、启动模拟联系 Worker 或启动真实联系 Worker。API 不可用或任一值不一致时，它保持错误状态且不会启动任何 BOSS Worker。真实模式还要求编译能力、两个明确运行开关、部署专用许可签名密钥和 Worker 命令行确认全部满足；候选人级许可缺失或失效时不会产生外部写。legacy `boss-worker` service 不得与 `boss-login` 同时运行。

`boss-login` 是专用、非 root 的容器。由于 Ubuntu 24.04 对容器内 Chromium 用户命名空间的默认限制，该容器显式使用 `--no-sandbox`，同时启用 `no-new-privileges` 并移除全部 Linux capabilities；不修改宿主机安全参数，也不挂载 Docker socket。Xvfb 只在容器内部监听 Unix socket，不开放 VNC 或 TCP 显示端口；管理员仍通过 `/boss-login` 获取一次性二维码画面。

扫码流程及其自动启动的 Worker 统一使用有界面模式，并保持同一组固定窗口尺寸、Chrome profile 和调试端口。不要把该 profile 改回 headless，不要在运行期间切换模式，也不要跨操作系统复制 Chrome profile。旧 `boss-worker` profile 仅保留给维护场景，启动前必须先停止 `boss-login`。

简历预览默认关闭。业务确认平台额度后，再在环境文件设置：

```text
BOSS_FORGE_RESUME_PREVIEW_ENABLED=1
BOSS_FORGE_OCR_PROVIDER=tencent
BOSS_RESUME_OCR=0
```

配置修改后，应先确认环境文件指向原有 external browser/boss-cli volumes、预检通过且已有可验证数据库备份，再受控重建 `boss-login`；重建后先在 `/boss-login` 确认 authenticated、release ID 与简历策略一致，再恢复任务。不得复制、清空或重建登录目录，也不得使用 `down -v`。

语义模型开关或端点变更后也需要按同一受控流程重建 `boss-login`。查看候选人详情中的“通用语义评估”，核对模型、提示词、目录、评分标准版本以及原文证据；影子结果不得改变候选人通过/淘汰。

## 7. 验收

部署前在代码目录执行：

```bash
pnpm typecheck
pnpm lint:web
pnpm test
pnpm web:build
pnpm test:integration:data
pnpm test:e2e:user
```

两个集成脚本默认是**零联系安全模式**：只允许连接 loopback 且数据库名包含 `test`、`e2e` 或 `audit` 的一次性 PostgreSQL；不会创建 contact intent、审批、控制记录、人工回复或账号健康记录。它们必须与生产数据库和生产 API 完全隔离。

包含联系数据状态机的测试需要同时设置 `BOSS_FORGE_TEST_CONTACTS=1` 和 `BOSS_FORGE_ALLOW_CONTACT_TEST_DATA=I_UNDERSTAND_ISOLATED_ONLY`，且仍只能使用一次性本地数据库；日常验收不要运行。任何测试都不得启动 BOSS browser、M1 或 real/fake contact worker。

E2E 输出必须包含：

```text
realGreetingExecuted: false
```

运行环境还应检查：

- Web/API 健康。
- PostgreSQL 没有主机端口。
- base 服务中没有 contact worker；启用 `boss-login` 后只允许 supervisor 按明确模式启动受管联系 Worker。默认/常规验收使用 disabled 或 Fake，日志只能出现 `simulated`。
- `boss-worker` 未经批准不会自动启动。
- 真实模式上线前必须以空联系队列开始，并分别验证打招呼和正文发送的预览绑定。任何 `uncertain` 都必须停止该账号后续自动联系，由负责人在 BOSS 页面人工核验，禁止自动重试。

## 8. 日志

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  logs --tail=200 api web contact-worker-fake
```

启用 BOSS Worker 后：

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  logs --tail=200 boss-login
```

日志不得输出 OCR 密钥、完整简历正文或 boss-cli 原始敏感 stdout。

## 9. 备份

`postgres-backup` 默认每 24 小时向 `postgres_backups` 命名 volume 写入 custom-format 备份，先写临时文件并通过 `pg_restore --list` 后才原子改名；默认保留 14 天。检查最近备份：

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  logs --tail=20 postgres-backup
```

每次正式发布前仍应把最近一份 dump 复制到独立受控存储，并在一次性数据库执行恢复演练。备份清单同时保存 release ID 和不含秘密值的环境配置。浏览器登录卷是否备份由账号负责人单独决定，不能进入通用备份仓库。

## 10. 升级与回滚

升级前先运行 `deploy/preflight-intranet.sh`。API、Web 和 worker 必须使用同一个不可变镜像发布号；不要只重建其中一个服务。若 BOSS 会话正在运行，不得在该主机上 build：

```bash
deploy/preflight-intranet.sh deploy/.env.intranet
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml up -d --no-build
```

上述默认 `up` 不会更新 profile 服务。若远端需要保留 BOSS 会话，先确认 external volume 名、备份、资源和预检均满足要求，再单独受控更新当前推荐的 `boss-login`：

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  --profile boss-login \
  up -d --no-build --no-deps boss-login
```

重建后必须先在 `/boss-login` 验证 authenticated、release ID、简历策略和 Worker 心跳一致，再恢复读取任务。不要启动 legacy `boss-worker`；登录一旦丢失，立即停止 BOSS 相关验收，不得反复刷新二维码或重建 profile。

回滚应用前先备份数据库，切回已验证的不可变镜像后 `up -d --no-build`。migration runner 会校验已应用文件的 SHA-256；不允许修改旧 SQL，回滚数据库需要显式的新迁移或从已验证备份恢复。

不要删除 `postgres_data`。任何 `down -v` 都会删除 Compose 管理的业务数据卷，因此禁止执行。浏览器与 boss-cli 登录卷虽然已改为 external、不会被该命令删除，也不得手工删除、清空、复制或替换。

### 已构建前端产物的发布

常规镜像在容器内执行 `pnpm web:build`。如果使用“在 Linux 构建、将 `apps/web/dist` 装入已验证基础镜像”的产物发布方式，需为组装 Dockerfile 提供专用 `.dockerignore`，允许 `apps/web/dist` 进入构建上下文。仓库默认 `.dockerignore` 排除了 `dist` 与 `**/dist`；仅上传产物后执行 `COPY . /app` 会保留基础镜像里的旧前端。

发布前比较构建产物与新镜像中的 `apps/web/dist/server/index.js`、`vinext-client-assets.js` 校验和；发布后打开实际页面验证改动文案及加载的资源。镜像标签更新或 HTTP 200 本身不能证明新前端已上线。本次现场验证记录见 [生产功能验证](FEATURE_VALIDATION_2026-09-07.md)。
