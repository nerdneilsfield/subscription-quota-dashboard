import type { DashboardConfigInput } from "../src/shared/domain"

const config: DashboardConfigInput = {
  // Optional: overrides the localized header slogan above the profile name.
  // branding: { slogan: "SQD / 配额运营" },
  // 0 disables background refresh. Positive values must be >= 30 seconds.
  refresh: { intervalSeconds: Number(process.env.AUTO_REFRESH_INTERVAL_SECONDS ?? 0) },
  providers: [
    {
      id: "poe-main",
      type: "poe",
      apiKeyEnv: "POE_API_KEY",
    },
    // --- A class: account balance providers ---
    // { id: "deepseek-main", type: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" },
    // { id: "stepfun-main", type: "stepfun", apiKeyEnv: "STEPFUN_API_KEY" },
    // { id: "siliconflow-main", type: "siliconflow", apiKeyEnv: "SILICONFLOW_API_KEY" },
    // { id: "openrouter-main", type: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
    // { id: "novita-main", type: "novita", apiKeyEnv: "NOVITA_API_KEY" },
    // --- B class: coding plan providers ---
    // { id: "kimi-main", type: "kimi", apiKeyEnv: "KIMI_API_KEY" },
    { id: "zhipu-main", type: "zhipu", apiKeyEnv: "ZHIPU_API_KEY" },
    // { id: "minimax-main", type: "minimax", apiKeyEnv: "MINIMAX_API_KEY" },
    // { id: "zenmux-main", type: "zenmux", baseUrl: "https://your-zenmux.example.com", apiKeyEnv: "ZENMUX_API_KEY" },
    { id: "volc-main", type: "volcengine", region: "cn-beijing", akEnv: "VOLCENGINE_AK", skEnv: "VOLCENGINE_SK" },
    { id: "mimo-token-main", type: "mimo-token-plan", sessionCookieEnv: "MIMO_SESSION_COOKIE" },
    { id: "opencode-go-main", type: "opencode-go", workspaceIdEnv: "OPENCODE_WORKSPACE_ID", authCookieEnv: "OPENCODE_AUTH_COOKIE" },
    // --- Dynamic provider (auto-discovers codex/claude/xai/antigravity accounts) ---
    { id: "cliproxy-main", type: "cliproxy",
      baseUrl: process.env.CLIPROXY_BASE_URL ?? "http://localhost:8317",
      apiKeyEnv: "CLIPROXY_MGMT_KEY" },
  ],
  subscriptions: [
    {
      id: "poe-api",
      name: "Poe API",
      providerId: "poe-main",
      // Optional per-subscription override; 0 disables this subscription.
      // refresh: { intervalSeconds: 60 },
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
      id: "zhipu-coding-plan",
      name: "Zhipu Coding Plan",
      providerId: "zhipu-main",
      metrics: [
        {
          id: "five-hour",
          providerMetricId: "five_hour",
          label: "5h quota",
          unit: "%",
          sourceValueKind: "gauge-used",
          window: { kind: "rolling", duration: "5h" },
          display: { module: "period-quota-card" },
        },
        {
          id: "weekly",
          providerMetricId: "weekly_limit",
          label: "Weekly quota",
          unit: "%",
          sourceValueKind: "gauge-used",
          window: { kind: "rolling", duration: "7d" },
          display: { module: "period-quota-card" },
        },
      ],
    },
    // {
    //   id: "minimax-coding-plan",
    //   name: "MiniMax Coding Plan",
    //   providerId: "minimax-main",
    //   metrics: [
    //     {
    //       id: "five-hour",
    //       providerMetricId: "five_hour",
    //       label: "5h quota",
    //       unit: "%",
    //       sourceValueKind: "gauge-remaining",
    //       window: { kind: "rolling", duration: "5h" },
    //       display: { module: "period-quota-card" },
    //     },
    //     {
    //       id: "weekly",
    //       providerMetricId: "weekly_limit",
    //       label: "Weekly quota",
    //       unit: "%",
    //       sourceValueKind: "gauge-remaining",
    //       window: { kind: "rolling", duration: "7d" },
    //       display: { module: "period-quota-card" },
    //     },
    //   ],
    // },
    {
      id: "mimo-token-plan",
      name: "Xiaomi MiMo Token Plan",
      providerId: "mimo-token-main",
      metrics: [
        {
          id: "plan-credits",
          providerMetricId: "mimo:plan_credits",
          label: "Plan credits",
          unit: "credits",
          sourceValueKind: "gauge-used",
          display: { module: "period-quota-card" },
        },
      ],
    },
    {
      id: "opencode-go",
      name: "OpenCode Go",
      providerId: "opencode-go-main",
      metrics: [
        {
          id: "five-hour",
          providerMetricId: "go:five_hour",
          label: "5h quota",
          unit: "%",
          sourceValueKind: "gauge-used",
          display: { module: "period-quota-card" },
        },
        {
          id: "weekly",
          providerMetricId: "go:weekly",
          label: "Weekly quota",
          unit: "%",
          sourceValueKind: "gauge-used",
          display: { module: "period-quota-card" },
        },
        {
          id: "monthly",
          providerMetricId: "go:monthly",
          label: "Monthly quota",
          unit: "%",
          sourceValueKind: "gauge-used",
          display: { module: "period-quota-card" },
        },
      ],
    },
    {
      id: "doubao-agent-plan",
      name: "Doubao Agent Plan",
      providerId: "volc-main",
      metrics: [
        {
          id: "five-hour",
          providerMetricId: "afp:five_hour",
          label: "5h quota",
          unit: "tokens",
          sourceValueKind: "gauge-used",
          window: { kind: "rolling", duration: "5h" },
          display: { module: "period-quota-card" },
        },
        {
          id: "weekly",
          providerMetricId: "afp:weekly_limit",
          label: "Weekly quota",
          unit: "tokens",
          sourceValueKind: "gauge-used",
          window: { kind: "rolling", duration: "7d" },
          display: { module: "period-quota-card" },
        },
        {
          id: "monthly",
          providerMetricId: "afp:monthly",
          label: "Monthly quota",
          unit: "tokens",
          sourceValueKind: "gauge-used",
          window: { kind: "rolling", duration: "30d" },
          display: { module: "period-quota-card" },
        },
      ],
    },
    {
      id: "doubao-coding-plan",
      name: "Doubao Coding Plan",
      providerId: "volc-main",
      metrics: [
        {
          id: "five-hour",
          providerMetricId: "cp:five_hour",
          label: "5h quota",
          unit: "%",
          sourceValueKind: "gauge-used",
          window: { kind: "rolling", duration: "5h" },
          display: { module: "period-quota-card" },
        },
        {
          id: "weekly",
          providerMetricId: "cp:weekly_limit",
          label: "Weekly quota",
          unit: "%",
          sourceValueKind: "gauge-used",
          window: { kind: "rolling", duration: "7d" },
          display: { module: "period-quota-card" },
        },
        {
          id: "monthly",
          providerMetricId: "cp:monthly",
          label: "Monthly quota",
          unit: "%",
          sourceValueKind: "gauge-used",
          window: { kind: "rolling", duration: "30d" },
          display: { module: "period-quota-card" },
        },
      ],
    },
  ],
  profiles: [
    {
      id: "self",
      name: "Personal",
      viewKey: process.env.SELF_DASHBOARD_VIEW_KEY,
      subscriptionIds: ["poe-api", "zhipu-coding-plan", "mimo-token-plan", "opencode-go", "doubao-agent-plan", "doubao-coding-plan"],
      dynamicProviderIds: ["cliproxy-main"],
    },
  ],
}

export default config
