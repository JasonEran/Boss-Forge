# Odoo 重构内网部署、升级与验收运行手册

> 适用阶段：R0-R4；Odoo 19 Community；公司内网 Ubuntu。
>
> 强制边界：本手册不配置公网域名、Let's Encrypt、CDN、WAF 或公网数据库。R0-R4 不运行真实联系 Worker，不调用 `boss greet`/`boss send`。

## 1. 交付拓扑与启动边界

默认 `deploy/compose.intranet.yaml` 启动两套相互独立的数据链路：

```text
HR 浏览器 --私网 IP:8069--> Odoo 19 --内部 data 网络--> odoo-postgres
                                  |
                                  +--内部 app 网络--> Boss-Forge API
Boss-Forge API --内部 data 网络--> boss-postgres
Fake contact Worker --内部 data 网络--> boss-postgres（仅写 simulated，不访问 BOSS）
Boss read/preview Worker --显式 profile--> boss-postgres + BOSS/OCR 出站
```

| 服务 | 默认启动 | 主机端口 | 说明 |
|---|---:|---|---|
| `odoo-postgres` | 是 | 无 | 只在 Docker `data` 网络可见 |
| `boss-postgres` | 是 | 无 | 与 Odoo 独立数据库和卷 |
| `boss-migrate` | 是，一次性 | 无 | 幂等执行 SQL migration |
| `boss-forge-api` | 是 | `127.0.0.1:3100` | 可显式改为固定私网 IP |
| `odoo` | 是 | `127.0.0.1:8069` | Odoo HR 控制面 |
| `boss-odoo-sync` | 是 | 无 | Boss-Forge Outbox 回写 Odoo |
| `boss-contact-worker-fake` | 是 | 无 | 仅消费 Fake 授权，记录 `simulated`，不调用 BOSS/boss-cli |
| `boss-worker` | 否 | 无 | 仅 `--profile boss-worker` 启动，读取/预览/筛选 |
| 真实联系 Worker | 不存在 | 无 | R0-R4 Compose 故意不定义 |

`app` 网络允许应用正常出站；`data` 网络为 Docker 内部网络。数据库没有 `ports`，Odoo 和 Boss-Forge 不跨库直写。

默认只绑定回环地址。办公室内网直连时，把 `INTRANET_BIND_IP` 改为 Ubuntu 服务器的固定私网 IPv4，例如 `10.20.0.15`；不要填写公网 IP。本阶段直接使用私网 HTTP，不引入公网反向代理规格。

## 2. 服务器准备

建议基线：Ubuntu LTS、4 vCPU、8 GiB RAM、100 GiB 可扩展磁盘、Docker Engine 与 Compose v2/v5、与公司时钟源同步。

在仓库根目录执行：

```bash
cd /srv/Boss-Forge
docker version
docker compose version
git status --short
```

上线前确认工作树中没有来源不明的改动。镜像首次验证可使用示例标签；正式切换时把 `ODOO_IMAGE`、`POSTGRES_IMAGE`、`NODE_IMAGE` 解析并锁定到已验收 digest，不使用 `latest`。

## 3. 环境配置

```bash
cp deploy/intranet.env.example deploy/.env.intranet
chmod 600 deploy/.env.intranet
```

编辑 `deploy/.env.intranet`：

- 首次引导先替换除 `ODOO_API_KEY` 之外的全部 `CHANGE_ME`；该 Key 必须在 Odoo 初始化、服务用户建立后生成。
- Odoo DB、Boss DB 使用不同密码。
- DB 密码和服务令牌使用 `openssl rand -hex 32` 生成的 URL-safe 值；不要把含 `@ : / % # $` 的未编码密码直接写入 `DATABASE_URL`。
- `BOSS_FORGE_SERVICE_TOKEN` 是 Odoo 调用 Boss-Forge API 的内网服务令牌。
- `ODOO_API_KEY` 是 Odoo 内网服务用户的 API Key，供 Boss-Forge 回写使用，两者不要复用。
- 本机验证保留 `INTRANET_BIND_IP=127.0.0.1`。
- R0-R2 保留 `BOSS_FORGE_RESUME_PREVIEW_ENABLED=0`、`BOSS_RESUME_OCR=0`。
- 不添加 `BOSS_FORGE_REAL_GREET_ENABLED=1`；Compose 已固定为 `0`。

加载维护 Shell 变量并检查配置：

```bash
set -a
. deploy/.env.intranet
set +a

if grep -n 'CHANGE_ME' deploy/.env.intranet | grep -v 'ODOO_API_KEY=CHANGE_ME_'; then
  echo '请先替换除 ODOO_API_KEY 外的全部 CHANGE_ME'
  exit 1
fi

docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  config --quiet
```

检查真实联系仍关闭：

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  config | grep -E '^[[:space:]]+BOSS_FORGE_REAL_GREET_ENABLED: "0"$'

docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  config --services
```

第一条命令必须只看到值 `0`；服务列表允许 `boss-contact-worker-fake`，但不得出现任何 Real contact/greet Worker。

## 4. 首次初始化

### 4.1 拉取、构建与 Boss 数据库迁移

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  pull odoo odoo-postgres boss-postgres

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  build boss-migrate boss-forge-api boss-odoo-sync boss-contact-worker-fake

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  up -d odoo-postgres boss-postgres

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  run --rm boss-migrate
```

迁移可以重复运行；`schema_migrations` 中已有的文件不会重复执行。

### 4.2 初始化 Odoo Community 和 Addons

Odoo 19 的 `admin_passwd` 是仅配置文件选项。本项目在 `odoo.conf` 中将其留空并关闭数据库列表，禁用 Web 数据库管理；首次建库使用官方 `odoo db init`，不向启动命令传 master password。

首次执行：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  run --rm odoo \
  odoo db --config=/etc/odoo/odoo.conf init "$ODOO_DB_NAME" \
  --language=zh_CN \
  --username="$ODOO_ADMIN_LOGIN" \
  --password="$ODOO_ADMIN_PASSWORD"

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  run --rm odoo \
  odoo --config=/etc/odoo/odoo.conf \
  --database="$ODOO_DB_NAME" \
  --init=base,web,mail,hr,hr_recruitment,calendar,utm,attachment_indexation,hr_skills,hr_recruitment_skills,survey,hr_recruitment_survey,boss_forge_connector,boss_forge_rules,boss_forge_recruitment,boss_forge_security \
  --without-demo=all \
  --stop-after-init
```

激活中文、管理员账号，并写入 Connector 的 fail-closed 参数：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  run --rm -T odoo \
  odoo shell --config=/etc/odoo/odoo.conf --database="$ODOO_DB_NAME" <<'PY'
import os

env['res.lang']._activate_lang('zh_CN')
admin = env.ref('base.user_admin')
admin.write({
    'login': os.environ['ODOO_ADMIN_LOGIN'],
    'password': os.environ['ODOO_ADMIN_PASSWORD'],
    'lang': 'zh_CN',
    'tz': 'Asia/Shanghai',
})
params = env['ir.config_parameter'].sudo()
params.set_param('boss_forge_connector.base_url', 'http://boss-forge-api:3100')
params.set_param('boss_forge_connector.service_token', os.environ['BOSS_FORGE_SERVICE_TOKEN'])
params.set_param('boss_forge_connector.contact_transport_mode', 'fake')
params.set_param('boss_forge_connector.real_contact_enabled', 'False')
env.cr.commit()
PY
```

先启动 Odoo 与 Boss-Forge API；此时不要启动 `boss-odoo-sync`：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  up -d odoo boss-forge-api
```

在 Odoo 创建仅用于 Boss-Forge 回写的内网服务用户。当前 Controller 会校验 `base.group_system`，因此该专用用户必须加入 Settings/System 组；禁止供人员交互登录，也不要复用管理员或 HR 账号。生成 API Key 后把值写入 `deploy/.env.intranet` 的 `ODOO_API_KEY`，不要写入 Git、日志或 Chatter。确认引导占位符已经全部清零：

```bash
if grep -n 'CHANGE_ME' deploy/.env.intranet; then
  echo '仍有未替换的生产配置占位符'
  exit 1
fi

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  up -d boss-odoo-sync
```

`contact_transport_mode=fake`、`real_contact_enabled=False`、Compose 固定 `BOSS_FORGE_REAL_GREET_ENABLED=0`、Fake Worker 与真实 Worker 分离且没有真实联系进程，共同构成 R0-R4 的关闭边界。

### 4.3 启动默认服务

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml up -d
```

默认会启动 Fake 模拟联系 Worker，不会启动读/筛 `boss-worker`，也不存在真实联系 Worker。每个 BOSS 账号应配置一个绑定相同 `BOSS_FORGE_ACCOUNT_ID` 的 Worker 实例，避免跨账号领取任务。

## 5. 健康检查与正常运维

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml ps

curl --fail --show-error "http://${INTRANET_BIND_IP}:${ODOO_HTTP_PORT}/web/health"
curl --fail --show-error "http://${INTRANET_BIND_IP}:${BOSS_API_PORT}/health"
curl --fail --show-error "http://${INTRANET_BIND_IP}:${BOSS_API_PORT}/api/integration/odoo/v1/health"

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  exec -T odoo-postgres pg_isready -U "$ODOO_DB_USER" -d postgres
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  exec -T boss-postgres pg_isready -U "$BOSS_DB_USER" -d "$BOSS_DB_NAME"
```

Odoo、API、同步 Worker、两个数据库应正常；`boss-migrate` 应为 `Exited (0)`。数据库不应显示主机端口映射。

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml logs --tail=200 odoo
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml logs --tail=200 boss-forge-api
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml logs --tail=200 boss-odoo-sync
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml logs --tail=200 boss-contact-worker-fake
```

停止应用但保留数据库和 filestore：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  stop odoo boss-forge-api boss-odoo-sync boss-contact-worker-fake
```

不要对生产数据执行 `down -v`。

## 6. Ubuntu Boss Worker

Worker 镜像包含 Node 22、锁定的 `boss-cli`、Chromium 和中文字体。它仍然需要人工完成的 BOSS 登录态；系统不处理验证码或绕过登录。

先验证工具链，不访问候选人：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  --profile boss-worker run --rm boss-worker pnpm m0:doctor
```

只有登录态能由容器内 Chromium 复用后，才启动读/筛 Worker：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  --profile boss-worker up -d boss-worker
```

默认 Worker 强制 headless，而 `boss login` 需要图形会话。Ubuntu 首次登录必须使用同一 Linux 登录卷的临时图形会话；不能完成时继续使用已经登录的受控 macOS Worker，不要复制其他操作系统的 Chrome profile。

R3 首次只做岗位、推荐或搜索的只读检查。简历预览在 HR 明确确认额度/频率后才把 `BOSS_FORGE_RESUME_PREVIEW_ENABLED` 改为 `1`；腾讯 OCR 配置完整前保持关闭。

若 Ubuntu 的 `boss-cli + Chromium + 登录态` 不稳定，停止该 profile，继续使用现有受控 macOS Worker，不自动复制跨操作系统 Chrome profile。

## 7. Odoo 模块升级与应用发布

升级前必须完成第 8 节备份，并在恢复副本跑相同步骤。

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  --profile boss-worker stop boss-worker
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  stop boss-contact-worker-fake boss-odoo-sync boss-forge-api odoo

git fetch origin
git switch --detach <已批准的提交或标签>

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  build boss-migrate boss-forge-api boss-odoo-sync boss-contact-worker-fake
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  run --rm boss-migrate

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml run --rm odoo \
  odoo --config=/etc/odoo/odoo.conf --database="$ODOO_DB_NAME" \
  --update=boss_forge_connector,boss_forge_rules,boss_forge_recruitment,boss_forge_security \
  --stop-after-init
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  up -d odoo boss-forge-api boss-odoo-sync boss-contact-worker-fake
```

升级后重复健康检查、对应阶段验收，并确认真实联系安全门没有变化。读/筛 Worker 不会自动恢复；只有升级前确实启用且负责人批准时，才显式执行 `--profile boss-worker up -d boss-worker`。

## 8. 一致性备份

备份必须同时包含：Odoo PostgreSQL、Odoo filestore、Boss-Forge PostgreSQL、部署提交号、镜像摘要和脱敏配置。截图/OCR 产物另行按卷或对象存储备份。

```bash
BACKUP_DIR="/srv/boss-forge-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
git rev-parse HEAD > "$BACKUP_DIR/git-revision.txt"
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  images > "$BACKUP_DIR/images.txt"
grep -E '^(COMPOSE_PROJECT_NAME|INTRANET_BIND_IP|ODOO_HTTP_PORT|BOSS_API_PORT|ODOO_IMAGE|POSTGRES_IMAGE|NODE_IMAGE|BOSS_FORGE_IMAGE|ODOO_DB_NAME|BOSS_DB_NAME|BOSS_FORGE_RESUME_PREVIEW_ENABLED|BOSS_RESUME_OCR|TENCENTCLOUD_OCR_REGION)=' \
  deploy/.env.intranet > "$BACKUP_DIR/config-summary.txt"

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  --profile boss-worker stop boss-worker
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  stop boss-contact-worker-fake odoo boss-forge-api boss-odoo-sync

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  exec -T odoo-postgres pg_dump -U "$ODOO_DB_USER" -d "$ODOO_DB_NAME" -Fc \
  > "$BACKUP_DIR/odoo.dump"
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  exec -T boss-postgres pg_dump -U "$BOSS_DB_USER" -d "$BOSS_DB_NAME" -Fc \
  > "$BACKUP_DIR/boss-forge.dump"
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  cp "odoo:/var/lib/odoo/filestore/$ODOO_DB_NAME" "$BACKUP_DIR/odoo-filestore"
sha256sum "$BACKUP_DIR/odoo.dump" "$BACKUP_DIR/boss-forge.dump" \
  > "$BACKUP_DIR/SHA256SUMS"

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  up -d odoo boss-forge-api boss-odoo-sync boss-contact-worker-fake
```

定期做恢复演练；只有能成功恢复并完成对账的文件才算有效备份。备份流程有意不自动重启读/筛 Worker；若备份前确实运行，必须经负责人确认后再显式启动。

## 9. 回滚

### 9.1 仅代码/镜像回滚

数据库结构兼容时，按备份提交重新 build/up；不要还原数据库：

```bash
ROLLBACK_BACKUP_DIR=/srv/boss-forge-backups/<已批准备份目录>
ROLLBACK_REVISION="$(tr -d '\n' < "$ROLLBACK_BACKUP_DIR/git-revision.txt")"
git cat-file -e "$ROLLBACK_REVISION^{commit}"

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  --profile boss-worker stop boss-worker
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  stop boss-contact-worker-fake boss-odoo-sync boss-forge-api odoo
git switch --detach "$ROLLBACK_REVISION"
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  build boss-migrate boss-forge-api boss-odoo-sync boss-contact-worker-fake
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  up -d odoo boss-forge-api boss-odoo-sync boss-contact-worker-fake
```

随后检查 API、Odoo、事件积压和 fake 联系安全门。读/筛 Worker 仍保持停止，等待负责人批准。

### 9.2 数据库/filestore 回滚

只在迁移不兼容、数据已受损且负责人批准维护窗口时使用。先保留故障现场的新备份，再停止 Odoo、API、同步和 Worker。Odoo DB 与对应 filestore 必须作为同一恢复点恢复，Boss DB 使用同一批次 dump。

禁止覆盖或删除原库。下面命令将备份恢复到新 DB 名和新 filestore 目录；先验证，再通过新的环境文件切换：

```bash
RESTORE_BACKUP_DIR=/srv/boss-forge-backups/<已批准备份目录>
RESTORE_SUFFIX="$(date +%Y%m%d%H%M%S)"
ODOO_RESTORE_DB="boss_forge_odoo_restore_${RESTORE_SUFFIX}"
BOSS_RESTORE_DB="boss_forge_restore_${RESTORE_SUFFIX}"
test -f "$RESTORE_BACKUP_DIR/odoo.dump"
test -f "$RESTORE_BACKUP_DIR/boss-forge.dump"
test -d "$RESTORE_BACKUP_DIR/odoo-filestore"

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  --profile boss-worker stop boss-worker
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  stop boss-contact-worker-fake boss-odoo-sync boss-forge-api odoo

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  exec -T odoo-postgres createdb -U "$ODOO_DB_USER" "$ODOO_RESTORE_DB"
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  exec -T odoo-postgres pg_restore --exit-on-error --no-owner --no-privileges \
  -U "$ODOO_DB_USER" -d "$ODOO_RESTORE_DB" < "$RESTORE_BACKUP_DIR/odoo.dump"

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  exec -T boss-postgres createdb -U "$BOSS_DB_USER" "$BOSS_RESTORE_DB"
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  exec -T boss-postgres pg_restore --exit-on-error --no-owner --no-privileges \
  -U "$BOSS_DB_USER" -d "$BOSS_RESTORE_DB" < "$RESTORE_BACKUP_DIR/boss-forge.dump"

docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  run --rm --no-deps --user root --entrypoint mkdir odoo \
  -p "/var/lib/odoo/filestore/$ODOO_RESTORE_DB"
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  cp "$RESTORE_BACKUP_DIR/odoo-filestore/." \
  "odoo:/var/lib/odoo/filestore/$ODOO_RESTORE_DB"
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  run --rm --no-deps --user root --entrypoint chown odoo \
  -R odoo:odoo "/var/lib/odoo/filestore/$ODOO_RESTORE_DB"

cp deploy/.env.intranet deploy/.env.restore
```

只在 `deploy/.env.restore` 中把 `ODOO_DB_NAME`、`BOSS_DB_NAME` 改为上面的新库名，并使用独立的内网验证端口。用该文件启动并完成以下对账；确认后才批准替换正式环境文件。原 DB、原 filestore 和原环境文件全部保留。

- Odoo 岗位数、申请数、审核状态。
- Boss-Forge 岗位快照、逻辑候选人数、联系历史。
- Odoo external map 与 Boss UUID 完整。
- Outbox/Inbox 已处理事件和 dead letter。
- `contact_attempts` 与已联系历史一致，不会重复发送。

恢复后仍保持 fake transport 和 real contact disabled；事件只做幂等重放，禁止跨库补写。

## 10. R0-R4 无真实打招呼验收

每一阶段开始和结束都检查：

```bash
test "$(docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  config | grep -c 'BOSS_FORGE_REAL_GREET_ENABLED: "0"')" -ge 1
! docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  config --services | grep -E '(real-contact|greet-worker)'
! docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  top | grep -E '(approve-real-greet|boss[[:space:]]+greet)'
```

### R0：技术基线

1. Compose `config --quiet` 通过。
2. Odoo、双 PostgreSQL、API healthy；`boss-migrate` 退出码为 0。
3. 安装 4 个 Addon，并在独立临时库用 `--test-enable --stop-after-init` 跑 Odoo 测试，禁止在正式库执行安装测试：

```bash
ODOO_R0_TEST_DB="${ODOO_DB_NAME}_r0_$(date +%Y%m%d%H%M%S)"
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  run --rm odoo odoo db --config=/etc/odoo/odoo.conf init "$ODOO_R0_TEST_DB" \
  --language=zh_CN --username=r0_admin --password="$(openssl rand -hex 24)"
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  run --rm odoo odoo --config=/etc/odoo/odoo.conf --database="$ODOO_R0_TEST_DB" \
  --init=boss_forge_connector,boss_forge_rules,boss_forge_recruitment,boss_forge_security \
  --test-enable --without-demo=all --stop-after-init
```

4. Odoo 中文、Asia/Shanghai、附件、招聘 Kanban 可用。
5. 创建 HR A、HR B、负责人和 3 个岗位样例。
6. Connector 参数仍为 fake/False。

### R1：组织、岗位、账号和集成

1. HR A 只能修改负责/协作岗位，不能修改 HR B 岗位。
2. 负责人可查看团队岗位；用人经理/面试官不能触发外部动作。
3. 岗位明确绑定 BOSS 账号业务 ID，不允许 Worker 猜账号。
4. 重复投递同一 `event_id` 只生成一条业务记录。
5. API 停止后 Odoo Outbox 保留事件；恢复后可重投。
6. 日志不出现服务令牌、Cookie、OCR Secret 或简历全文。

### R2：通用规则与院校规则

1. HR 不改代码可发布 3 类岗位规则，发布版本不可原地修改。
2. TEM8、TEM-8、英语专业八级命中同一能力；不足时展示当前英语级别。
3. “本科 985 OR 211”使用锁定目录版本。
4. 标准名、简称、曾用名匹配；独立学院不继承母校标签。
5. 多义、缺字、OCR 冲突为 `unknown/manual_review`。
6. 历史回放不增加联系意图和尝试数。

### R3：候选人采集、精筛和审核

1. 首先使用 fixture/fake 事件，不启动真实 Worker。
2. 同一候选人在不同岗位生成不同 applicant，并显示跨岗位提示。
3. Odoo applicant、Boss candidate state、external map 数量可对账。
4. 所有规则状态均有证据和原因码。
5. HR A 不能审核 HR B 候选人；重复提交返回幂等结果或版本冲突。
6. 若启用 `boss-worker` profile，只做批准的读取/预览，仍不运行联系执行器。

现有无真实副作用的用户路径：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  exec -T boss-forge-api pnpm test:e2e:user
```

输出必须包含 `realGreetingExecuted: false`。

### R4：审核后联系授权（Fake transport）

1. “通过并联系”原子创建审核、不可变授权和 Outbox。
2. “通过但暂不联系”不创建联系授权。
3. 重复点击、重复事件、进程重启不新增第二条意图。
4. 全局、账号、岗位任一停止都阻断 dispatch。
5. 冷却、时段、额度、禁止联系和授权撤销均能阻断。
6. Fake 结果可回写 Odoo；不确定结果触发暂停和人工活动。
7. Connector 参数仍为 `contact_transport_mode=fake`、`real_contact_enabled=False`。

默认常驻 Fake Worker 只处理 `transport_mode=fake`。验收时查看其日志：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  logs --tail=200 boss-contact-worker-fake
```

对应 intent/attempt/candidate 必须为 `simulated`/`fake`，不得计入真实额度、冷却或 `sent` 统计；任何 BOSS 外部 message ID 或真实候选人页面状态变化都视为失败。R4 退出时不要启用真实联系。

## 11. 常见故障

| 现象 | 检查 | 处理 |
|---|---|---|
| Odoo unhealthy | Odoo 日志、DB health、数据库初始化 | 先修 DB/模块错误，不删除卷 |
| API unhealthy | API 日志、迁移退出码 | 重跑幂等迁移，再启动 API |
| Connector 积压 | API health、URL、两端令牌、Inbox/Outbox | 修复后幂等重投，不跨库更新 |
| Worker unhealthy | heartbeat、Chromium、账号登录态 | 停 profile，人工恢复登录 |
| OCR 失败 | provider、区域、密钥、截图路径 | 保留为信息不足并人工复核 |
| 联系状态 uncertain | 确认没有 Real Worker、检查 Fake 事件 | 暂停账号，人工核验，不自动重试 |
| 两侧数量不同 | external map、dead letter、correlation ID | 输出差异清单并重放事件 |

## 12. 发布报告模板

每次 R0-R4 发布记录：Git commit、镜像 digest、迁移清单、Odoo 模块版本、脱敏环境摘要、备份路径/校验和、健康检查、自动测试、HR 场景、数据对账、安全门、遗留问题和回滚点。

报告必须明确写出：`真实打招呼执行数：0`。
