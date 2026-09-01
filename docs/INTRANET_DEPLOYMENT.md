# Boss-Forge Ubuntu 内网部署

> 部署文件：`deploy/compose.intranet.yaml`
>
> 形态：纯自研 Web/API、单 PostgreSQL、Fake 联系

## 1. 使用边界

当前部署适合受控内网单团队试用。Control API 尚无登录和部门级授权，不应直接暴露公网，也不应在互不信任的多部门环境中共用。

部署文件不包含 Odoo、第二个 PostgreSQL、反向代理或 Real Contact Worker。

## 2. 服务

| 服务 | 默认启动 | 主机端口 | 说明 |
|---|---:|---:|---|
| `postgres` | 是 | 无 | 唯一业务数据库，仅内部 data 网络 |
| `migrate` | 一次性 | 无 | 执行幂等迁移后退出 |
| `api` | 是 | 3100 | Control API |
| `web` | 是 | 3000 | 唯一 HR 控制面 |
| `contact-worker-fake` | 是 | 无 | 只消费 Fake 联系 |
| `boss-worker` | 否 | 无 | `boss-worker` profile；BOSS 读取、预览和 OCR |

Web/API 默认绑定 `127.0.0.1`。办公室访问时，运维显式设置服务器固定私网 IP。

## 3. 准备环境

安装 Docker Engine 与 Compose v2，克隆仓库后：

```bash
cp deploy/intranet.env.example deploy/.env.intranet
```

至少修改：

```text
INTRANET_BIND_IP=10.x.x.x
BOSS_DB_PASSWORD=<URL 安全随机值>
CONTROL_WEB_ORIGIN=http://10.x.x.x:3000
NEXT_PUBLIC_CONTROL_API_URL=http://10.x.x.x:3100
```

`NEXT_PUBLIC_CONTROL_API_URL` 是 Web 构建参数；修改后必须重新 build。数据库密码建议使用 `openssl rand -hex 32`。

腾讯云密钥只写入 `deploy/.env.intranet`，该文件被 Git 忽略。

## 4. 配置检查

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  config --services
```

默认输出应为：

```text
postgres
migrate
api
contact-worker-fake
web
```

顺序可能不同，但不得出现 Odoo 或 Real/Greet Worker。检查固定安全门：

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  config | grep BOSS_FORGE_REAL_GREET_ENABLED
```

值必须为 `"0"`。

## 5. 构建与启动

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

检查：

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  ps

curl --fail http://10.x.x.x:3100/health
curl --fail http://10.x.x.x:3000/
```

`migrate` 正常状态是成功退出，不是长期运行。

## 6. BOSS Worker

默认部署不会读取 BOSS。完成同一 `boss_cli_data`/`browser_profile` 卷内的人工登录后，再启动：

```bash
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  --profile boss-worker \
  up -d boss-worker
```

容器内 Worker 强制 headless，而首次 `boss login` 需要可见浏览器。如果 Ubuntu 图形登录不稳定，应继续使用已经登录且受控的 macOS Worker；不要跨操作系统复制 Chrome profile。

简历预览默认关闭。业务确认平台额度后，再在环境文件设置：

```text
BOSS_FORGE_RESUME_PREVIEW_ENABLED=1
BOSS_FORGE_OCR_PROVIDER=tencent
BOSS_RESUME_OCR=0
```

然后重新创建 `boss-worker`。

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

E2E 必须包含：

```text
realGreetingExecuted: false
```

运行环境还应检查：

- Web/API 健康。
- PostgreSQL 没有主机端口。
- Fake Worker 日志只出现 `simulated`。
- `boss-worker` 未经批准不会自动启动。
- 不存在 Real Worker。

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
  logs --tail=200 boss-worker
```

日志不得输出 OCR 密钥、完整简历正文或 boss-cli 原始敏感 stdout。

## 9. 备份

创建目录后，从容器输出自包含 PostgreSQL 备份：

```bash
mkdir -p backups
docker compose \
  --env-file deploy/.env.intranet \
  -f deploy/compose.intranet.yaml \
  exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > backups/boss-forge.dump
```

同时保存 Git 提交号和不含秘密值的环境配置清单。浏览器登录卷是否备份由账号负责人单独决定，不能进入通用备份仓库。

## 10. 升级与回滚

升级：

```bash
git pull --ff-only
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml build
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml up -d
```

升级不会自动启动 profile 中的 `boss-worker`。

回滚应用前先备份数据库，切回已验证提交后重新 build/up。已执行数据库迁移不允许通过修改旧 SQL 回滚；需要显式的新迁移或从备份恢复。

不要删除 `postgres_data`。任何 `down -v` 都会删除业务数据卷，除非用户明确要求且已有可验证备份，否则禁止执行。
