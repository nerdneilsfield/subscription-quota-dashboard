# 多 Profile 指南

[English](multi-profile.md) | [简体中文](multi-profile.zh-CN.md)

Profile 为同一个 server 提供独立的 Dashboard view 与独立登录 key。多个 profile
可以共享 provider account 与 subscription，但每个 profile 只暴露自己选择的
subscription。

## 1. 配置模型

关系如下：

```text
provider account -> subscription -> profile
```

- `providers`：上游凭证或 manual source；
- `subscriptions`：绑定一个 provider 的命名 quota 定义；
- `profiles`：URL ID、显示名称、view key 与可见 subscription。

Dashboard 大标题由 `profiles[].name` 控制；顶部全局小 slogan 由
`branding.slogan` 控制。

## 2. 定义多个 Profile

编辑 `config/dashboard.config.ts`，按受众增加 profile：

```ts
import type { DashboardConfigInput } from "../src/shared/domain"

const config: DashboardConfigInput = {
  branding: { slogan: "SQD / 配额运营" },

  providers: [
    // Existing provider declarations.
  ],

  subscriptions: [
    // Existing subscription declarations.
  ],

  profiles: [
    {
      id: "personal",
      name: "Personal",
      viewKey: process.env.PERSONAL_DASHBOARD_VIEW_KEY,
      subscriptionIds: ["poe-api", "mimo-token-plan"],
      dynamicProviderIds: ["cliproxy-main"],
    },
    {
      id: "team",
      name: "Team",
      viewKey: process.env.TEAM_DASHBOARD_VIEW_KEY,
      subscriptionIds: ["poe-api", "doubao-coding-plan"],
    },
  ],
}

export default config
```

Profile ID 应使用 URL-safe、全小写、稳定的值。它会成为 route segment，不得包含
secret。

## 3. 添加 Profile 专属 key

为每个 profile 使用不同环境变量和不同随机值：

```env
PERSONAL_DASHBOARD_VIEW_KEY=replace-with-a-random-personal-key
TEAM_DASHBOARD_VIEW_KEY=replace-with-a-random-team-key
SESSION_SECRET=replace-with-a-random-256-bit-secret
```

不要把 view key 放进 URL、config 字面量、Git history、截图或聊天消息。Config 应
引用 `process.env`，而不是实际 key。

每个 profile 根据 ID 生成独立 session cookie，因此一个浏览器可同时持有多个
profile 的 session，不会发生 cookie name 冲突。共享的 `SESSION_SECRET` 为所有
profile cookie 签名。

## 4. Profile URL

部署后直接访问：

```text
https://quota.example.com/d/personal?range=24h
https://quota.example.com/d/team?range=24h
```

支持的 range 是 `1h`、`24h`、`7d`、`30d`，默认 `24h`。首次访问会要求对应
profile 的 view key。Profile session 有效期 7 天，并且是 HttpOnly。

## 5. 共享与隔离数据

Subscription 可复用。两个 profile 都列出同一个 subscription ID 时，两边看到同一
个 projected source。若要隔离数据：

1. 凭证不同则声明不同的 provider account ID；
2. 声明绑定这些 provider 的不同 subscription ID；
3. 每个 profile 只列出目标 subscription ID。

Provider credential 始终留在 server 端。Profile 不会收到 raw API key 或 cookie，
只收到所选 subscription 的 UI-ready dashboard payload。

CLIProxy dynamic account 通过 profile 的 `dynamicProviderIds` 单独启用。只有
CLIProxy provider 支持 dynamic discovery。

## 6. Key 轮换

只轮换一个 profile 的访问权限：

1. 为该 profile 的环境变量生成新值；
2. 重启 server/container；
3. 使用新 key 验证 profile URL；
4. 从部署 secret 中撤销旧值。

修改 profile 的 `viewKey` 会使该 profile 的既有 session 失效。修改
`SESSION_SECRET` 会使所有 profile session 失效。

## 7. 校验与部署流程

Config 在 server 启动时加载一次。修改 profile 后重启容器，并检查：

```bash
curl --fail http://127.0.0.1:3000/health
docker logs --tail 100 subscription-quota-dashboard
```

Loader 会拒绝：重复 profile ID、缺失 view key、未知 subscription 引用、重复
dynamic provider ID，以及不指向 CLIProxy provider 的 dynamic provider ID。

容器部署时，将审核后的 config 只读挂载到
`/app/config/dashboard.config.ts`，或重建 image。不要把 env file 挂到公开 web path。

## 8. 安全清单

- 每个 profile 使用唯一、高熵 key；
- 保持 `SESSION_SECRET` 稳定且私密；
- 将 `.env.production` 权限设为 `0600`；
- 只通过 HTTPS reverse proxy 暴露服务；
- 将 `PUBLIC_ORIGIN` 设置为准确的浏览器访问 origin；
- 不要把 `viewKey` 放入 query parameter，server 会拒绝；
- 将 provider cookie 与 API key 当作 password 保护。
