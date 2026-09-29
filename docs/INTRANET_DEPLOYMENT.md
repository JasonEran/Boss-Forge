# 构建、部署与回滚

> 适用于现有 Ubuntu / Docker Compose 部署。运行版本与现场状态只在[当前状态](CURRENT_STATUS.md)维护；本手册描述操作方法。

## 1. 部署原则

开发机目录只用于开发。生产根目录为 `/opt/boss-forge`，`current` 指向 `releases/<release-id>`；日常 Compose 和受保护环境文件位于 `deploy/`。代码经 PR 合入 `main` 后发布，API、Web 和 boss-login 使用相同不可变应用镜像。

**纯文档变更只需合入仓库，不必重启服务，也不要求生产应用 SHA 跟随文档提交。** 已有运行中的任务不会因为文档更新而被中断。

不得清空或替换业务/登录卷，不使用 `docker compose down -v`。数据库 schema 变更必须先说明影响并取得批准；不重写已执行 migration。真实联系设置不是部署测试开关，不随发版擅自启用、关闭或放宽。

## 2. 服务与持久化

| 服务 | 启动方式 | 用途 |
| --- | --- | --- |
| postgres | 默认 | 唯一业务数据库，不映射生产主机端口 |
| postgres-backup | 默认 | 周期 custom-format 备份与清单校验 |
| migrate | 一次性 | 执行迁移，正常应成功退出 |
| api / web | 默认 | API 和已构建的 Vinext Web；生产绑定回环 |
| gateway | `https` profile | 独立 TLS 入口；实际端口以现有部署为准 |
| boss-login | `boss-login` profile | Chromium、扫码、会话探测及筛选/联系子 Worker 监督 |
| contact-worker-fake | `contact-fake` profile | 仅隔离模拟，不与 supervisor 并行抢会话 |
| boss-worker | legacy profile | 维护兼容入口，不与 boss-login 同时运行 |

三个必须核对的路径：

| 容器路径 | 职责 |
| --- | --- |
| `/var/lib/boss-forge/runtime` | 登录状态、心跳、扫码偏好及私有 IPC |
| `/var/lib/boss-forge/browser` | Chromium profile |
| `/home/node/.boss-cli` | boss-cli 会话、截图及缓存 |

浏览器和 boss-cli 卷是 external volume；runtime 也必须保持原实际挂载。先读现有容器：

```bash
docker inspect boss-forge-intranet-boss-login-1 --format '{{range .Mounts}}{{println .Destination .Name}}{{end}}'
```

不要把完整 inspect 输出贴进日志，它可能包含秘密。首次安装只有在确认没有旧数据时才可显式创建新卷；已有系统沿用实际挂载名。

## 3. 构建前

1. 记录 Git 提交、目标 release ID、当前生产 release/镜像及挂载名。
2. 查看任务、简历和联系队列，选择适合中断浏览器连接的发布时机；有不确定联系先核验。
3. 备份数据库及受保护配置，确认备份可列出内容。不要把 `.env` 或浏览器资料上传 Git。
4. 复核 [intranet.env.example](../deploy/intranet.env.example) 与现有环境的差异，只合并需要的配置，不能整份覆盖。
5. 依改动完成[验证](TESTING.md)。镜像在构建机生成，避免业务主机一边运行 Chromium 一边编译。

`preflight-intranet.sh` 实际要求物理内存至少 3 GiB，内存加 swap 至少 6 GiB，并检查磁盘、镜像、发布号、联系配置与外部卷。模板注释是部署建议，脚本才是执行门槛。

## 4. 构建应用镜像（构建机）

使用合入后的代码和生产目标平台。以下占位值必须替换，示例不会携带生产秘密：

```bash
release_id=$(git rev-parse --short=7 HEAD)
docker build --platform linux/amd64 -f deploy/docker/Dockerfile.boss-forge --build-arg BOSS_FORGE_RELEASE_ID="$release_id" --build-arg NEXT_PUBLIC_CONTROL_API_URL=https://106.12.106.113 -t "boss-forge:$release_id" .
```

网络受限时可使用 [增量 Dockerfile](../deploy/docker/Dockerfile.boss-forge.incremental)，以已验证镜像为基底：

```bash
base_image="boss-forge:REPLACE_WITH_VERIFIED_BASE"
release_id=$(git rev-parse --short=7 HEAD)
docker build --platform linux/amd64 -f deploy/docker/Dockerfile.boss-forge.incremental --build-arg BASE_APPLICATION_IMAGE="$base_image" --build-arg TARGET_BOSS_FORGE_RELEASE_ID="$release_id" --build-arg TARGET_NEXT_PUBLIC_CONTROL_API_URL=https://106.12.106.113 -t "boss-forge:$release_id" .
```

记录实际镜像 ID；正式 release 标签不能复用为不同内容。通过受控镜像仓库或镜像归档传到服务器，同时准备对应源代码归档到新 release 目录。不要假定服务器 release 目录有 `.git`。

### 单独组装前端产物时

仅在完整构建不可行且已有验证流程时使用。保留服务器所用浏览器版本，不能因为开发机旧基底更方便就降级生产 Chromium。

- Linux 目标环境构建 `apps/web/dist`；源代码必须对应同一提交与锁文件。
- 默认 `.dockerignore` 排除 dist；组装时显式允许并 COPY 产物，不能让旧基底的 dist 冒充新前端。
- 覆盖 manifest 后，构建阶段以匹配锁文件完成 `pnpm install --offline --frozen-lockfile --ignore-scripts`（前提是基底已有所需依赖及构建产物）；不要让普通 node 用户在只读运行时重新安装依赖。
- 比较构建产物与新镜像的 `apps/web/dist/server/index.js` 和资源清单校验和。
- 以生产 node 用户、只读文件系统和必要 tmpfs 做启动冒烟，核对实际页面改动。

9 月 28 日曾因依赖元数据未同步导致启动时 EACCES，已修正。镜像标签和 HTTP 200 都不能单独证明前端更新成功。

## 5. 备份与预检（服务器）

先进入服务器根目录：

```bash
cd /opt/boss-forge
```

建立本次独立备份目录，示例路径中的日期/版本需替换，不覆盖旧备份：

```bash
release_id="REPLACE_WITH_RELEASE_ID"
install -d -m 700 "/opt/boss-forge/backups/$release_id"
docker exec boss-forge-intranet-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "/opt/boss-forge/backups/$release_id/database.before.dump"
docker exec -i boss-forge-intranet-postgres-1 pg_restore --list < "/opt/boss-forge/backups/$release_id/database.before.dump"
```

确认导出命令成功且清单可读。清单校验不等于数据恢复演练；重要数据库变更还需在隔离库恢复并校验。配置备份仅保存在权限受控目录，勿打印秘密。

记录旧配置后，将 `.env.intranet` 中应用镜像和 release 更新为本次目标；必要时审查并同步 Compose/脚本变更。然后执行：

```bash
deploy/preflight-intranet.sh deploy/.env.intranet
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml --profile boss-login --profile https config --services
```

预检失败先修正具体问题，不绕过检查。不要输出完整 `config` 分享，它会展开环境秘密。

## 6. 迁移与切换（服务器）

应用无新 migration 时不需要为发版重跑数据修复脚本。有新迁移时，先完成批准、备份和兼容性检查，再使用新镜像运行：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml run --rm migrate
```

迁移成功后切换 `current` 到本次 release 目录。确认新镜像已存在，协调当前任务后，更新三个应用服务：

```bash
docker compose --env-file deploy/.env.intranet -f deploy/compose.intranet.yaml --profile boss-login --profile https up -d --no-build --no-deps --wait --wait-timeout 90 api web boss-login
```

该命令不会替你初始化数据库、启动网关或备份服务；首次部署需先配置并启动默认依赖，HTTPS 网关也需有效证书。现有部署只在网关配置改变时更新网关，不在每次应用发布时重启全部服务。

## 7. 发布后验收

- `/health` 的 `releaseId` 和联系模式符合本次预期。
- API、Web、boss-login 镜像一致；实际挂载与发版前相同。
- Web 新产物校验和及目标页面改动存在；浏览器无新增错误。
- 登录状态真实显示：需要扫码就通知本人；认证成功则核对 Worker 心跳、release、简历策略。
- 原任务、联系队列和计划仍存在；恢复授权范围内的业务，记录进度而不是只看容器健康。

登录支持微信 / App 切换，图片随二维码或反馈变化更新，慢下载不会被轮询持续打断。扫码/安全验证由本人完成，不能靠发版重启反复取码。

## 8. 回滚

健康失败先保存失败证据；切回**已核对的旧应用镜像及配置**，恢复旧 `current` 指向，再按同一命令更新 API/Web/boss-login。保留原卷和已发生的业务结果。

应用回滚不会自动回滚数据库。若 schema 不向后兼容，先评估恢复方案；未经明确批准不能用旧 dump 覆盖现在的业务数据。新的有效数据也不能因回滚而丢失。

## 9. 备份、TLS 与秘密

`postgres-backup` 模板每 24 小时备份、保留 14 天，写临时文件、校验后原子改名。定期检查最近成功日志，将备份复制到独立受控存储，并做隔离恢复演练。

TLS 由独立 gateway 使用只读证书目录，查看 [续期脚本](../deploy/renew-ip-certificate.sh)与 [cron 示例](../deploy/boss-forge-cert-renewal.cron)。核对实际证书有效期、续期日志和 reload 结果，不把“存在 cron 文件”当成续期成功。

OCR/模型/数据库/预览签名密钥仅放受保护环境。模型端点和凭据变更需一致更新相关 API/Worker；已失效或泄露凭据不能从旧备份恢复继续使用。
