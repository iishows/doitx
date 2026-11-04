# 离线部署（内网 / 单台云主机）

面向**一台 Linux 云主机 + Docker Compose** 的离线部署指南：在一台能上网的机器上把镜像打成 tar 包，搬进没有外网的环境，然后一键起服务。

这条路径不依赖 GHCR、GitHub 或任何 registry——目标机器只需要 Docker 和 compose 插件。

> 需要能直连外网时，用 `docs/self-host.md` 的常规拉取式部署更省事，不用打离线包。

## 1. 部署形态

单台主机上跑这几个容器（由 `infra/compose/docker-compose.images.yml` 定义）：

| 服务 | 作用 |
|---|---|
| `postgres` | 数据库（镜像按 digest 固定） |
| `migrate` | 一次性迁移任务，`api` 启动前跑完 |
| `data-init` | 初始化数据卷属主 |
| `api` | HTTP API，默认只监听 `127.0.0.1:3100` |
| `worker` | Graphile Worker，跑后台任务 |
| `web` | Web 前端（Vite preview），默认只监听 `127.0.0.1:5173` |
| `supervisor` | 管理 bot computer 容器的生命周期，独占 Docker socket |
| `computer` | bot 实际运行的沙箱容器，按 bot 动态创建 |

`api` 和 `worker` 都是**常驻进程**，不能只起一个。

### 主机要求

- Linux（amd64 或 arm64 都行，镜像两种架构都有）
- Docker Engine + `docker compose` 插件（`docker compose version` 能跑通）
- `openssl`（installer 用它生成密钥）、`curl`（联网机器上打包时需要）
- 内存：建议 4 GB 起；每个 bot computer 会再吃一份
- 磁盘：镜像本身约 8 GB，再加数据卷和 bot 家目录。**打包前会检查空间并拒绝在不足时开跑**
- 端口：默认只绑 `127.0.0.1:3100`（API）和 `127.0.0.1:5173`（Web），由你前面加的反向代理对外暴露

## 2. 在联网机器上打离线包

在**这个仓库的检出目录**里执行：

```bash
bash infra/compose/make-image-bundle.sh --tag v0.3.10
```

产物是 `dist/offline-bundle/rakazo-offline-bundle-v0.3.10.tar.gz`（约 8 GB）。

常用参数：

| 参数 | 说明 |
|---|---|
| `--tag <tag>` | 记录到包里的 app / computer 镜像标签。默认取 `git describe` 的最近 tag，没有则 `edge` |
| `--output <dir>` | 输出目录，默认 `dist/offline-bundle` |
| `--build` | 从当前源码构建 app 和 computer 镜像，而不是用本机已有的镜像 |
| `--dry-run` | 只打印将要保存哪些镜像、包含哪些文件，不写盘 |

默认拿**本机已有的镜像**去 `docker save`。所以先确认它们在本机：

```bash
docker image inspect ghcr.io/iishows/doitx/app:v0.3.10
docker image inspect ghcr.io/iishows/doitx/computer:v0.3.10
```

如果本机没有，先 `docker pull`，或者加 `--build` 从源码构建。

> computer 镜像构建很慢（要装浏览器和一堆系统依赖），除非确实需要，优先用现成镜像。

### 包里有什么

```
rakazo-offline-bundle-<tag>/
  install-images.sh                  # 目标机上的入口
  docker-compose.images.yml          # 必需，installer 按相对路径找
  .env.images.example                # 必需
  restrict-computer-egress.sh        # 必需，离线下缺了会直接报错
  images/rakazo-images.tar           # app + computer + postgres + busybox
  BUNDLE_ENV                         # 本次打包的镜像标签，填 .env 时用
  IMAGES.txt                         # 镜像清单与 digest，便于核对
  SHA256SUMS                         # 完整性校验
  README-OFFLINE.md                  # 目标机上的简版说明
  OFFLINE.md                         # 本文件的副本，离线机器上直接可读
```

镜像用仓库里约定的 `ghcr.io/iishows/doitx/*` 名字保存，所以目标机 `docker load` 之后 Compose 能直接解析，不需要改配置。

### 关于 updater

包里**不含** `updater` 镜像。它是 `docker-compose.prod.yml` 里的一个可选自动升级边车，工作方式是定期从 GitHub 和 registry 发现新版本再拉取——离线环境里这两样都够不到，放进去也没有意义。

## 3. 搬进内网

把 tar 包拷到目标主机（U 盘、跳板机、堡垒机传文件都可以）：

```bash
scp dist/offline-bundle/rakazo-offline-bundle-v0.3.10.tar.gz user@your-vm:/opt/
```

## 4. 在目标主机上安装

```bash
cd /opt
tar -xzf rakazo-offline-bundle-v0.3.10.tar.gz
cd rakazo-offline-bundle-v0.3.10

# 校验完整性（可选但推荐）
sha256sum -c SHA256SUMS

# 载入镜像
docker load -i images/rakazo-images.tar
```

然后跑 installer。**必须在包目录里执行**——它按相对路径找 Compose 文件和 env 样例：

```bash
bash install-images.sh --offline
```

`--offline` 的含义：保留本地 Compose / env 文件、不下载、不拉镜像，所有镜像必须已经 `docker load` 进来。

installer 会做的事：

1. 用 `.env.images.example` 生成 `.env`，并填上随机密钥
2. 启动 Postgres，跑数据库迁移
3. 拉起全部服务并等待健康检查

首次运行会提示备份 `ENCRYPTION_KEY`。**这个丢了，加密过的内容就永久解不开了**，请立刻存到安全的地方。

### 首次运行前先把镜像标签对上

`.env.images.example` 里镜像标签默认是 `edge`。包里的 `BUNDLE_ENV` 记录了实际保存的标签，把它填进 `.env`：

```bash
cat BUNDLE_ENV          # 看看这次是什么
grep -E 'RAKAZO_IMAGE_TAG|RAKAZO_COMPUTER_IMAGE_TAG' BUNDLE_ENV >> .env
```

不这么做的话，Compose 会去找 `:edge` 镜像，而本地只有 `:v0.3.10`，启动会失败。

## 5. 配置 `.env`

`.env` 里必须按你的环境改的几项：

```bash
# 对外访问的地址：浏览器用哪个 origin，就写哪个。VPS 上一般走 https
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
# Vite preview 用它做 allowlist，必须写成公网域名，不要留 localhost
RAKAZO_HOST=app.example.com

# 是否允许注册
SIGNUPS_ENABLED=true
```

其余按需：

| 变量 | 用途 |
|---|---|
| `SANDBOX_PROVIDER` | `docker` = 用本机 supervisor 跑 bot（默认）；`none` = 只起 UI，不起 computer |
| `SANDBOX_COMPUTER_EGRESS` | `restricted` = bot 只能出公网，不能碰宿主 / 内网 / 云元数据。installer 装好防火墙规则时会自动设 |
| `SANDBOX_COMPUTER_DNS` | restricted 模式下若宿主私有 DNS 被挡，指定公网 DNS，如 `1.1.1.1,1.0.0.1` |
| `HTTP_PROXY` / `HTTPS_PROXY` | api / worker 出网走代理时填（内网常见） |
| `SMTP_URL` / `EMAIL_FROM` | 要收发密码重置邮件才需要 |

改完再跑一次 installer 让配置生效：

```bash
bash install-images.sh --offline
```

## 6. 验证

```bash
# 容器状态：都应该是 running / healthy
docker compose --env-file .env -f docker-compose.images.yml ps

# 存活检查
curl -fsS http://127.0.0.1:3100/health
# 就绪检查（含依赖）：degraded 有值时说明某个能力没起来
curl -fsS http://127.0.0.1:3100/ready
```

日志：

```bash
docker compose --env-file .env -f docker-compose.images.yml logs -f api
```

## 7. 反向代理与 TLS

API 和 Web 默认只绑 `127.0.0.1`，必须由反向代理对外暴露。仓库提供了 Caddy 配置 `infra/compose/Caddyfile.prod`，把域名指过来即可（它会自动申请证书）。

- Web → `127.0.0.1:5173`
- API → `127.0.0.1:3100`

注意 `RAKAZO_HOST` 要和反向代理上的公网域名一致，否则 Vite preview 会拒绝请求。

## 8. 升级

离线升级：在新版本仓库上重新打包 → 传进去 → 载入 → 重启。

```bash
# 目标机上
docker load -i images/rakazo-images.tar        # 载入新标签的镜像
# 把 .env 里的 RAKAZO_IMAGE_TAG / RAKAZO_COMPUTER_IMAGE_TAG 改成新标签
bash install-images.sh --offline               # 会重建到新镜像
```

数据库迁移是幂等的，重启时会自动跑。

> **回滚**：旧镜像还在本机（`docker image ls`），把 `.env` 的标签改回去、重跑 installer 即可。所以升级前别急着 `docker rmi` 旧镜像。

## 9. 排错

**`image not found` / 容器起不来**
`.env` 里的标签和实际载入的标签不一致。对着 `BUNDLE_ENV` 和 `docker image ls` 核对，把 `.env` 里的 `RAKAZO_IMAGE_TAG` 改成正确的值。这也是离线包默认标签是 `edge` 而实际是 `v0.3.10` 时最常见的坑。

**installer 报缺文件**
没有在包目录里执行。`install-images.sh` 会按相对路径找 `docker-compose.images.yml`、`.env.images.example`、`restrict-computer-egress.sh`，必须 `cd` 进去再跑。

**打包装到一半空间不足**
`docker save` 需要和镜像总大小相当的空间。脚本会预检并拒绝，释放空间的办法：`docker rmi` 掉旧标签的 app 镜像，或者用 `--output` 指到另一个文件系统。

**bot computer 起不来 / 没网**
检查 `SANDBOX_COMPUTER_EGRESS`。`restricted` 模式依赖宿主上的防火墙规则（由 `restrict-computer-egress.sh` 安装，需要 root）。如果宿主不支持这些规则，installer 会退化成 `open` 并在日志里说明原因。

**迁移失败**
看 `migrate` 服务日志。常见原因是 Postgres 没起来或者 `POSTGRES_PASSWORD` / `POSTGRES_APP_PASSWORD` 不匹配。

## 10. 相关文档

- `docs/self-host.md` — 完整自托管文档（英文），含拉取式部署、加密、对象存储、CSP 等
- `docs/self-host-restricted-network.md` — 受限网络 / registry 镜像
- `docs/self-host-secrets.md` — 密钥管理
- `docs/content-encryption.md` — 内容加密与 `ENCRYPTION_KEY` / 主密钥
