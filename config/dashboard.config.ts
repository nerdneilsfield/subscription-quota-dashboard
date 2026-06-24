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
    },
  ],
}

export default config
