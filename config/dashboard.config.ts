import type { DashboardConfigInput } from "../src/shared/domain"

const config: DashboardConfigInput = {
  providers: [
    {
      id: "poe-main",
      type: "poe",
      apiKeyEnv: "POE_API_KEY",
    },
    {
      id: "manual-main",
      type: "manual",
    },
    // --- A class: account balance providers ---
    // { id: "deepseek-main", type: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" },
    // { id: "stepfun-main", type: "stepfun", apiKeyEnv: "STEPFUN_API_KEY" },
    // { id: "siliconflow-main", type: "siliconflow", apiKeyEnv: "SILICONFLOW_API_KEY" },
    // { id: "openrouter-main", type: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
    // { id: "novita-main", type: "novita", apiKeyEnv: "NOVITA_API_KEY" },
    // --- B class: coding plan providers ---
    // { id: "kimi-main", type: "kimi", apiKeyEnv: "KIMI_API_KEY" },
    // { id: "zhipu-main", type: "zhipu", apiKeyEnv: "ZHIPU_API_KEY" },
    // { id: "minimax-main", type: "minimax", apiKeyEnv: "MINIMAX_API_KEY" },
    // { id: "zenmux-main", type: "zenmux", baseUrl: "https://your-zenmux.example.com", apiKeyEnv: "ZENMUX_API_KEY" },
    // { id: "volc-main", type: "volcengine", region: "cn-beijing", akEnv: "VOLCENGINE_AK", skEnv: "VOLCENGINE_SK" },
    // --- Dynamic provider (auto-discovers codex/claude/xai accounts) ---
    // { id: "cliproxy-main", type: "cliproxy",
    //   baseUrl: process.env.CLIPROXY_BASE_URL ?? "http://localhost:8317",
    //   apiKeyEnv: "CLIPROXY_MGMT_KEY" },
  ],
  subscriptions: [
    {
      id: "poe-api",
      name: "Poe API",
      providerId: "poe-main",
      metrics: [
        {
          id: "points",
          providerMetricId: "points",
          label: "API points",
          unit: "points",
          limit: 1_000_000,
          usageFilter: { usageTypes: ["API"] },
          sourceValueKind: "gauge-remaining",
          window: {
            kind: "calendar",
            period: "month",
            timezone: "Asia/Shanghai",
            anchor: { dayOfMonth: 1, timeOfDay: "00:00" },
          },
          display: { module: "balance-card" },
        },
      ],
    },
    {
      id: "cursor",
      name: "Cursor Pro",
      providerId: "manual-main",
      metrics: [
        {
          id: "fast-requests",
          label: "Fast requests",
          limit: 500,
          used: 124,
          unit: "requests",
          window: {
            kind: "calendar",
            period: "month",
            timezone: "Asia/Shanghai",
            anchor: { dayOfMonth: 1, timeOfDay: "00:00" },
          },
          display: { module: "period-quota-card" },
        },
        {
          id: "five-hour-messages",
          label: "5h messages",
          limit: 50,
          used: 18,
          unit: "messages",
          updatedAt: "2026-06-25T10:00:00+08:00",
          window: {
            kind: "rolling",
            duration: "5h",
          },
          display: { module: "rolling-window-card" },
        },
      ],
    },
  ],
  profiles: [
    {
      id: "self",
      name: "Personal",
      viewKey: process.env.SELF_DASHBOARD_VIEW_KEY,
      subscriptionIds: ["poe-api", "cursor"],
      // dynamicProviderIds: ["cliproxy-main"],
    },
  ],
}

export default config
