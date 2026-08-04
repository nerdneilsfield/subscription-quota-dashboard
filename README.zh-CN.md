# subscription-quota-dashboard

[English](README.md) | [简体中文](README.zh-CN.md)

统一的只读实时订阅配额仪表盘。
Bun + Hono 服务端、React + Vite 前端、SQLite 存储、签名 Session Cookie 认证。

## 环境要求

- 本地开发需要 [Bun](https://bun.sh/)。
- 为 `config/dashboard.config.ts` 中启用的实时数据源配置凭证。

## 快速开始

```bash
# 1. 安装依赖。
bun install

# 2. 复制环境变量模板并填写真实值。
cp .env.example .env
#   - POE_API_KEY             Poe provider API key
#   - SELF_DASHBOARD_VIEW_KEY 用于登录的随机 128-bit view key
#   - SESSION_SECRET          用于签名 Session Cookie 的随机 256-bit secret
#   - PORT                    HTTP 端口，默认 3000

# --- 开发环境（支持热更新）---
# 开发环境运行两个进程：Hono API server 与 Vite dev server。
bun run dev          # terminal 1 — Hono API：http://127.0.0.1:3000
bun run client:dev   # terminal 2 — Vite UI：http://127.0.0.1:5173
#   -> 打开 http://127.0.0.1:5173/d/self?range=24h

# --- 生产环境 ---
bun run build
NODE_ENV=production bun run start
#   -> 打开 http://127.0.0.1:3000/d/self?range=24h
```

## 容器部署

生产镜像使用固定版本的 `oven/bun:1.3.14-alpine` build/runtime stages。
容器以非 root 用户 `bun` 运行，监听 `0.0.0.0:3000`，同时提供编译后的 SPA
与 API；日志为 JSON，SQLite 数据写入 `/app/data`。凭证只在运行时注入，`.env`
文件不会进入 build context。

从 `.env.example` 创建部署环境文件。至少设置：

```env
SELF_DASHBOARD_VIEW_KEY=replace-with-a-random-128-bit-value
SESSION_SECRET=replace-with-a-random-256-bit-value
PUBLIC_ORIGIN=https://dashboard.example.com
```

为每个启用的 provider 添加凭证。不要提交该文件。使用容器 runtime 的
`--env-file` 时，每行必须是字面量 `KEY=value`，不要写 shell `export`。

### Apple Container（已验证）

Apple 官方 `container` runtime 是本地部署首选；已在 Apple Silicon 的原生
`linux/arm64` 镜像上验证：

```bash
container system start
container build --progress plain \
  -t subscription-quota-dashboard:latest .
container volume create subscription-quota-data
container run --name subscription-quota-dashboard --detach \
  --publish 127.0.0.1:3000:3000 \
  --env-file .env.container \
  --volume subscription-quota-data:/app/data \
  subscription-quota-dashboard:latest
curl --fail http://127.0.0.1:3000/health
container logs subscription-quota-dashboard
```

预期 health 响应：

```json
{"ok":true}
```

停止并删除部署：

```bash
container stop subscription-quota-dashboard
container delete subscription-quota-dashboard
```

### Docker 或 Lima fallback

同一份 Dockerfile 兼容 OCI/Docker：

```bash
docker build -t subscription-quota-dashboard:latest .
docker volume create subscription-quota-data
docker run --detach \
  --name subscription-quota-dashboard \
  --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --env-file .env.container \
  --volume subscription-quota-data:/app/data \
  subscription-quota-dashboard:latest
```

Apple Container 不可用时，启动 Lima Docker VM 后执行同样的 Docker 命令。
镜像包含 `/health` health check，并声明 `3000` 端口与 `/app/data` volume。

## 环境变量

| Variable | 用途 |
| --- | --- |
| `POE_API_KEY` | Poe provider API key；config 通过 `apiKeyEnv` 引用。 |
| `SELF_DASHBOARD_VIEW_KEY` | `self` profile 的 128-bit 随机登录 view key。 |
| `SESSION_SECRET` | 用于签名 Session Cookie 的 256-bit secret；必填。 |
| `PORT` | 服务端口，默认 `3000`。 |
| `HOST` | 监听地址，默认 `127.0.0.1`；镜像默认 `0.0.0.0`。 |
| `PUBLIC_ORIGIN` | 浏览器访问的 HTTP(S) origin；HTTPS 反代部署必填。 |
| `CONFIG_PATH` | Dashboard config 路径；默认 `/app/config/dashboard.config.ts`。 |
| `DASHBOARD_DB` | SQLite 路径；默认 `/app/data/dashboard.db`。 |
| `LOG_LEVEL` | `debug`、`info`、`warn`、`error` 或 `silent`。 |
| `LOG_FORMAT` | `pretty` 或 `json`；生产建议 `json`。 |

> **任何 URL 都不能放 `viewKey`。** 认证通过一次性登录流程签发的 Session
> Cookie 完成。不要把 `viewKey` 或 `apiKey` 放入 URL/query string。

完整模板见 `.env.example`。

## 配置

Profile、subscription、metric 与 provider 定义在：

```text
config/dashboard.config.ts
```

Profile 名称上方的小 slogan 可选且可配置：

```ts
const config: DashboardConfigInput = {
  branding: { slogan: "SQD / 配额运营" },
  // providers, subscriptions, profiles ...
}
```

省略 `branding.slogan` 时，使用内置中英文文案。大标题（例如 `Personal`）由
`profiles[].name` 控制。

Provider API key 应通过环境变量名 `apiKeyEnv` 引用，**不要写字面量**。若直接配置
`apiKey`，该 config 只能视作个人本地文件，**不得提交**。

## 指南

- [部署指南](docs/deployment.zh-CN.md)：GHCR、Docker、Apple Container、反代、升级、回滚、备份、排障。
- [多 Profile 指南](docs/multi-profile.zh-CN.md)：Profile URL、key、可见 subscription、session、轮换。
- English: [Deployment guide](docs/deployment.md) · [Multi-profile guide](docs/multi-profile.md)

GitHub Actions 仅在 semantic-version tag（例如 `v1.2.3`）自动发布多架构镜像到：

```text
ghcr.io/nerdneilsfield/subscription-quota-dashboard
```

普通 `master` push 不发布；`workflow_dispatch` 仍可手动发布。

## 数据存储

Metric snapshot 与 refresh 状态持久化到 SQLite：

```text
data/dashboard.db
```

`data/` 与 `.env` 已加入 gitignore。删除 `data/dashboard.db` 会清空历史数据；
配置驱动的 manual 值不受影响。

## 前端路由

| Route | 行为 |
| --- | --- |
| `/d/:profileId?range=X` | 指定 profile 的 Dashboard。 |
| 其他路径 | 404 Not Found。 |

`range` 支持 `1h`、`24h`、`7d`、`30d`，默认 `24h`。非法 `range` 或 `profileId`
显示 404。前端不自动轮询；挂载、手动刷新、页面重新可见时才取数。

## 认证与 Session

- 每个 profile 有独立的 profile-scoped session cookie name，同一浏览器可同时登录多个 profile。
- Session Cookie 使用 `SESSION_SECRET` 签名，带 `HttpOnly`、`SameSite`，生产环境带 `Secure`；有效期 7 天。
- 认证支持 Session Cookie 或一次性 `viewKey` 登录；`viewKey` 不会写入 URL。

## 安全说明

Dashboard 的基础防护面向个人/可信部署：签名 HttpOnly Cookie、`Cache-Control: no-store`、
`Referrer-Policy: no-referrer`、Origin check、日志脱敏与登录/refresh 限流。

**不建议直接暴露到任意公网。** 公网部署前，使用 HTTPS 反向代理、强认证与网络层限流。

## 开发命令

| Command | 用途 |
| --- | --- |
| `bun install` | 安装依赖。 |
| `bun run dev` | Bun `--watch` server。 |
| `bun run client:dev` | Vite dev server + HMR。 |
| `bun run build` | 构建 client 与 server bundle。 |
| `bun run start` | 运行构建后的 server。 |
| `bun run typecheck` | `tsc --noEmit`。 |
| `bun test` | 运行完整测试。 |

## 日志

服务端输出 HTTP 请求、认证、profile refresh、provider 调用、CLIProxy account 发现、
cache 写入与错误等结构化日志。每个请求有 `X-Request-Id`，同一 refresh 链路共享该 ID。

生产默认使用 `info` + `json`；排查 provider 时可临时设 `LOG_LEVEL=debug`。Authorization、
cookie、API key、token、password、view key 与 session secret 会替换为 `[REDACTED]`。

## OpenCode Go

OpenCode Go 使用认证后的 SolidStart `lite.subscription.get` server function，因为 OpenCode
当前没有公开的个人 quota API。只配置 `Fe26...` auth cookie：

```env
OPENCODE_WORKSPACE_ID=wrk_...
OPENCODE_AUTH_COOKIE=Fe26...
```

Adapter 提取真实的 5 小时、weekly、monthly 百分比与 reset time，不使用 `eval`；对临时
`429`/`5xx` 重试，session 过期时返回认证错误。Cookie 等同 password，只放 `.env`。

## Xiaomi MiMo Token Plan

MiMo Token Plan quota 来自认证后的 Subscription Management API。将浏览器请求
`/api/v1/tokenPlan/usage` 的 `Cookie` header 值复制到 `.env`：

```env
MIMO_SESSION_COOKIE='api-platform_ph=...; api-platform_serviceToken=...; ...'
```

Adapter 展示真实 Plan Credits、剩余进度、套餐级别、到期/reset、自动续订、MiMo Claw
entitlement 与 compensation Credits。Session cookie 会脱敏，绝不能提交。
