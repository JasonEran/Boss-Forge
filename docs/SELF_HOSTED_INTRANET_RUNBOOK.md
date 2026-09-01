# Boss-Forge 纯自研内网部署与运行手册

## 1. 服务拓扑

默认启动五个服务：

| 服务 | 是否默认启动 | 主机端口 | 说明 |
|---|---:|---:|---|
| `postgres` | 是 | 无 | 唯一业务数据库，仅 Docker 内部网络 |
| `migrate` | 是，一次性 | 无 | 执行幂等数据库迁移 |
| `api` | 是 | 3100 | 自研 Control API |
| `web` | 是 | 3000 | 唯一 HR 控制面 |
| `contact-worker-fake` | 是 | 无 | 只记录模拟联系，不调用 BOSS |

`boss-worker` 使用 `boss-worker` profile 显式启动，负责读取、简历预览、OCR 和筛选。部署中不存在 Odoo 服务、第二个 PostgreSQL 或真实联系 Worker。

## 2. Ubuntu 首次启动

```bash
cp deploy/intranet.env.example deploy/.env.intranet
```

编辑以下必填值：

- `INTRANET_BIND_IP`：服务器固定私网 IP；只在服务器本机访问可保留 `127.0.0.1`。
- `CONTROL_WEB_ORIGIN`：`http://私网IP:3000`。
- `NEXT_PUBLIC_CONTROL_API_URL`：`http://私网IP:3100`。
- `BOSS_DB_PASSWORD`：使用 URL 安全的随机值。

渲染并检查服务：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml config --services
```

输出只能包含 `postgres`、`migrate`、`api`、`web` 和 `contact-worker-fake`。启用 profile 时可额外出现 `boss-worker`。

构建并启动：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml build
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml up -d
```

健康检查：

```bash
curl --fail http://私网IP:3100/health
curl --fail http://私网IP:3000/
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml ps
```

## 3. 启用 BOSS 读取与筛选

默认不启动 BOSS Worker。先完成同一 Worker 卷内的 BOSS 登录，再执行：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml \
  --profile boss-worker up -d boss-worker
```

简历预览默认关闭。确认业务额度和频率后再设置：

```text
BOSS_FORGE_RESUME_PREVIEW_ENABLED=1
BOSS_FORGE_OCR_PROVIDER=tencent
BOSS_RESUME_OCR=0
```

腾讯云密钥只写入 `deploy/.env.intranet`，不得提交 Git。

## 4. 联系安全边界

- Compose 固定 `BOSS_FORGE_REAL_GREET_ENABLED=0`。
- 默认 Worker 只处理 Fake 联系，结果为 `simulated`。
- 部署文件没有真实联系 Worker。
- 岗位自动联系开关只能生成受控授权，不能打开全局真实执行能力。

验收可运行：

```bash
pnpm test:e2e:user
```

输出必须包含 `realGreetingExecuted: false`。

## 5. 升级

```bash
git pull --ff-only
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml build
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml up -d
```

升级不会自动启动 `boss-worker` profile。升级后检查 Web、API、数据库迁移、任务积压和 Fake 联系状态。

## 6. 备份

数据库卷是唯一必须备份的业务数据。使用 PostgreSQL 自带工具生成逻辑备份，并同时记录代码提交和环境配置版本。不要删除 `postgres_data` 或本地开发卷 `boss_forge_postgres`。

## 7. 回滚

回滚应用镜像或 Git 提交后重新执行 Compose；数据库只允许使用有明确向后兼容说明的版本回滚。任何数据库恢复前先停止 API 和 Worker，并保留当前库的新备份。
