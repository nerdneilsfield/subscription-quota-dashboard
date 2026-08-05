# 部署指南

[English](deployment.md) | [简体中文](deployment.zh-CN.md)

本指南使用 GitHub Actions 发布到以下地址的镜像：

```text
ghcr.io/nerdneilsfield/subscription-quota-dashboard
```

镜像支持 `linux/amd64` 与 `linux/arm64`。镜像包含编译后的 React client 与
Bun/Hono server；provider 凭证和 SQLite 数据在运行时注入。

## 1. 准备运行时 secret

创建仅用于部署的 env 文件，不要提交：

```bash
cp .env.example .env.production
chmod 600 .env.production
```

至少设置：

```env
SELF_DASHBOARD_VIEW_KEY=replace-with-a-random-128-bit-value
SESSION_SECRET=replace-with-a-random-256-bit-value
PUBLIC_ORIGIN=https://quota.example.com
```

生成 secret：

```bash
openssl rand -hex 16   # view key material
openssl rand -hex 32   # session secret material
```

只为 `config/dashboard.config.ts` 中启用的 provider 添加凭证。Provider secret
放环境变量，不要写进 config。

`SESSION_SECRET` 必须在重启之间保持不变；修改它会使所有 profile session 失效。

## 2. 拉取并运行 GHCR 镜像

创建 release tag 后才会自动发布：

```bash
git tag v1.2.3
git push origin v1.2.3
```

自动发布仅监听 `v*.*.*` tag。普通 `master` push 不发布；需要明确构建时仍可使用
手动 `workflow_dispatch`。

Public package 无需登录即可拉取。Private package 需要带 `read:packages` 的 GitHub
token：

```bash
printf '%s' "$GHCR_READ_TOKEN" \
  | docker login ghcr.io -u nerdneilsfield --password-stdin
```

生产环境建议固定版本运行：

```bash
export IMAGE=ghcr.io/nerdneilsfield/subscription-quota-dashboard:v1.2.3

docker pull "$IMAGE"
docker volume create subscription-quota-data
docker run --detach \
  --name subscription-quota-dashboard \
  --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --env-file "$PWD/.env.production" \
  --volume subscription-quota-data:/app/data \
  "$IMAGE"
```

检查 health 与日志：

```bash
curl --fail http://127.0.0.1:3000/health
docker logs --follow subscription-quota-dashboard
```

预期 health 响应：

```json
{"ok":true}
```

不要把 `3000` 直接暴露到公网；在 loopback binding 前放 HTTPS reverse proxy。

## 3. Reverse proxy 要求

在 `.env.production` 设置浏览器访问的 public URL：

```env
PUBLIC_ORIGIN=https://quota.example.com
```

Proxy 必须：

- 终止 TLS；
- 将请求转发到 `127.0.0.1:3000`；
- 保留 `Host` header；
- 放行 `/`、`/api/*`、`/health`；
- 原样转发浏览器 Cookie。

生产 Origin check 使用 `PUBLIC_ORIGIN`。如果它与浏览器实际访问的 origin 不完全
一致，登录和 refresh 请求会被拒绝。

## 4. 使用自定义 config

镜像默认 config 是 `/app/config/dashboard.config.ts`。无需重建镜像即可修改
profile 或 subscription 时，可将审核后的 config 只读挂载：

```bash
docker run --detach \
  --name subscription-quota-dashboard \
  --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --env-file "$PWD/.env.production" \
  --volume subscription-quota-data:/app/data \
  --volume "$PWD/config/dashboard.config.ts:/app/config/dashboard.config.ts:ro" \
  ghcr.io/nerdneilsfield/subscription-quota-dashboard:latest
```

服务启动时只加载一次 config。修改挂载的 config 文件后可重启容器；修改 env
文件后必须重建容器：

```bash
docker stop subscription-quota-dashboard
docker rm subscription-quota-dashboard
# 重新执行上面的 docker run 命令。
```

`docker restart` 不会重新读取原始 `--env-file`；环境变量在容器创建时即固定。

Profile 配置见[多 Profile 指南](./multi-profile.zh-CN.md)。

## 5. 升级与回滚

Workflow 仅在 `v1.2.3` 等 version tag 触发。每次 release 更新 `latest`、原始
`v1.2.3`、规范化 semver tag 与 commit SHA tag。`master` push 不发布；手动 dispatch
仍可用。

升级时保留 SQLite 数据：

```bash
docker pull ghcr.io/nerdneilsfield/subscription-quota-dashboard:latest
docker stop subscription-quota-dashboard
docker rm subscription-quota-dashboard
# 重新执行第 2 节的 docker run 命令。
```

生产环境可固定 commit image：

```text
ghcr.io/nerdneilsfield/subscription-quota-dashboard:sha-<commit>
```

升级必须复用 `subscription-quota-data` named volume；删除它会丢失 quota history
与 refresh state。

## 6. 备份 SQLite 数据

复制数据库前先停止容器：

```bash
docker stop subscription-quota-dashboard
docker run --rm \
  --volume subscription-quota-data:/data:ro \
  --volume "$PWD/backups:/backup" \
  alpine:3.22 \
  tar -czf /backup/dashboard-$(date +%Y%m%d-%H%M%S).tar.gz -C /data dashboard.db
docker start subscription-quota-dashboard
```

备份与部署 secret 同等保护。数据库包含 quota history 与运维 metadata。

## 7. Apple Container 本地验证

仓库已验证通过同一份 Dockerfile 在 Apple Container 本地构建：

```bash
container system start
container build --progress plain \
  -t subscription-quota-dashboard:latest .
container volume create subscription-quota-data
container run --name subscription-quota-dashboard --detach \
  --publish 127.0.0.1:3000:3000 \
  --env-file .env.production \
  --volume subscription-quota-data:/app/data \
  subscription-quota-dashboard:latest
curl --fail http://127.0.0.1:3000/health
```

GHCR pull 请使用上方 Docker/OCI 流程，除非当前 Apple Container 版本明确支持所需
的 registry login/pull 命令。

## 8. 排障清单

- 登录 `401`：检查 profile view key 与 `PUBLIC_ORIGIN`。
- 登录或 refresh `403`：浏览器 origin 与 `PUBLIC_ORIGIN` 不一致。
- `SQLiteError: unable to open database file`：使用 named `/app/data` volume 与仓库提供的 entrypoint；它会修复挂载 volume 的 ownership。
- Provider unavailable：检查 `docker logs` 与对应环境变量。
- Config validation failure：检查重复 ID，以及 provider/subscription 引用是否存在。
