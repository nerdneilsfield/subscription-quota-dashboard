import { expect, test } from "bun:test"
import { loadDashboardConfig } from "../../src/server/config/load-config"
import type { DashboardConfigInput } from "../../src/shared/domain"

const baseConfig: DashboardConfigInput = {
  providers: [{ id: "poe-main", type: "poe", apiKey: "poe_test_key" }],
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
          limit: 1000,
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
  ],
  profiles: [{ id: "self", name: "Personal", viewKey: "view_secret_128_bits", subscriptionIds: ["poe-api"] }],
}

test("normalizes a valid config", () => {
  const config = loadDashboardConfig(baseConfig)
  expect(config.profiles.get("self")?.subscriptionIds).toEqual(["poe-api"])
  expect(config.subscriptions.get("poe-api")?.metrics[0]?.providerMetricId).toBe("points")
})

test("rejects a missing viewKey with profile id", () => {
  const invalid: DashboardConfigInput = {
    ...baseConfig,
    profiles: [{ id: "self", name: "Personal", viewKey: undefined, subscriptionIds: ["poe-api"] }],
  }
  expect(() => loadDashboardConfig(invalid)).toThrow("profiles[self].viewKey")
})

test("rejects calendar resetAt and anchor together", () => {
  const invalid = structuredClone(baseConfig)
  const metric = invalid.subscriptions[0]!.metrics[0]!
  metric.window = {
    kind: "calendar",
    period: "month",
    timezone: "Asia/Shanghai",
    resetAt: "2026-07-01T00:00:00+08:00",
    anchor: { dayOfMonth: 1, timeOfDay: "00:00" },
  }
  expect(() => loadDashboardConfig(invalid)).toThrow("exactly one of resetAt or anchor")
})

test("marks unresolved Poe provider unavailable instead of throwing", () => {
  const config = loadDashboardConfig({
    ...baseConfig,
    providers: [{ id: "poe-main", type: "poe", apiKeyEnv: "MISSING_POE_KEY" }],
  })
  expect(config.providers.get("poe-main")?.type).toBe("poe")
  expect(config.providerRuntime.get("poe-main")?.available).toBe(false)
  expect(config.providerRuntime.get("poe-main")?.reason).toContain("MISSING_POE_KEY")
})

test("rejects stale manual rolling metric without updatedAt", () => {
  const invalid = structuredClone(baseConfig)
  invalid.providers.push({ id: "manual-main", type: "manual" })
  invalid.subscriptions.push({
    id: "manual-sub",
    name: "Manual Sub",
    providerId: "manual-main",
    metrics: [{ id: "rolling", label: "Rolling", unit: "messages", used: 1, window: { kind: "rolling", duration: "5h" }, display: { module: "rolling-window-card" } }],
  })
  expect(() => loadDashboardConfig(invalid)).toThrow("subscriptions[manual-sub].metrics[rolling].updatedAt")
})

test("rejects duplicate ids and broken references", () => {
  expect(() => loadDashboardConfig({ ...baseConfig, providers: [...baseConfig.providers, baseConfig.providers[0]!] })).toThrow("providers[poe-main]")
  expect(() => loadDashboardConfig({ ...baseConfig, subscriptions: [{ ...baseConfig.subscriptions[0]!, providerId: "missing" }] })).toThrow("subscriptions[poe-api].providerId")
  expect(() => loadDashboardConfig({ ...baseConfig, profiles: [{ ...baseConfig.profiles[0]!, subscriptionIds: ["missing"] }] })).toThrow("profiles[self].subscriptionIds")
})

test("rejects invalid window rules and display modules", () => {
  const invalidDuration = structuredClone(baseConfig)
  invalidDuration.subscriptions[0]!.metrics[0]!.window = { kind: "rolling", duration: "five-hours" }
  expect(() => loadDashboardConfig(invalidDuration)).toThrow("duration")

  const invalidDisplay = structuredClone(baseConfig)
  ;(invalidDisplay.subscriptions[0]!.metrics[0]!.display as { module: string }).module = "chart-card"
  expect(() => loadDashboardConfig(invalidDisplay)).toThrow("display.module")
})

test("infers manual sourceValueKind", () => {
  const config = loadDashboardConfig({
    providers: [{ id: "manual-main", type: "manual" }],
    subscriptions: [{ id: "manual", name: "Manual", providerId: "manual-main", metrics: [
      { id: "used", label: "Used", unit: "requests", used: 4, display: { module: "period-quota-card" } },
      { id: "remaining", label: "Remaining", unit: "credits", remaining: 7, display: { module: "balance-card" } },
      { id: "status", label: "Status", unit: "state", display: { module: "manual-status-card" } },
    ] }],
    profiles: [{ id: "self", name: "Self", viewKey: "secret", subscriptionIds: ["manual"] }],
  })
  const metrics = config.subscriptions.get("manual")!.metrics
  expect(metrics.map((metric) => metric.sourceValueKind)).toEqual(["gauge-used", "gauge-remaining", "status"])
})

test("deepseek provider resolves apiKeyEnv", () => {
  process.env.DEEPSEEK_TEST_KEY = "ds-secret"
  const config = loadDashboardConfig({
    providers: [{ id: "ds", type: "deepseek", apiKeyEnv: "DEEPSEEK_TEST_KEY" }],
    subscriptions: [{ id: "ds-sub", name: "DS", providerId: "ds", metrics: [{ id: "bal", label: "Balance", unit: "CNY", display: { module: "balance-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["ds-sub"] }],
  })
  expect(config.providerRuntime.get("ds")?.available).toBe(true)
  expect(config.providerRuntime.get("ds")?.apiKey).toBe("ds-secret")
  delete process.env.DEEPSEEK_TEST_KEY
})

test("deepseek provider unavailable when env missing and no fallback", () => {
  const config = loadDashboardConfig({
    providers: [{ id: "ds", type: "deepseek", apiKeyEnv: "DEEPSEEK_MISSING_KEY" }],
    subscriptions: [{ id: "ds-sub", name: "DS", providerId: "ds", metrics: [{ id: "bal", label: "Balance", unit: "CNY", display: { module: "balance-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["ds-sub"] }],
  })
  expect(config.providerRuntime.get("ds")?.available).toBe(false)
  expect(config.providerRuntime.get("ds")?.reason).toContain("DEEPSEEK_MISSING_KEY")
})

test("siliconflow rejects loopback baseUrl (SSRF)", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "sf", type: "siliconflow", baseUrl: "http://127.0.0.1:8080", apiKey: "k" }],
    subscriptions: [{ id: "sf-sub", name: "SF", providerId: "sf", metrics: [{ id: "bal", label: "B", unit: "CNY", display: { module: "balance-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["sf-sub"] }],
  })).toThrow("baseUrl")
})

test("siliconflow rejects non-allowlisted host (SSRF)", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "sf", type: "siliconflow", baseUrl: "https://api.evil.com", apiKey: "k" }],
    subscriptions: [{ id: "sf-sub", name: "SF", providerId: "sf", metrics: [{ id: "bal", label: "B", unit: "CNY", display: { module: "balance-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["sf-sub"] }],
  })).toThrow("baseUrl")
})

test("siliconflow accepts allowlisted CN host", () => {
  const config = loadDashboardConfig({
    providers: [{ id: "sf", type: "siliconflow", baseUrl: "https://api.siliconflow.cn", apiKey: "k" }],
    subscriptions: [{ id: "sf-sub", name: "SF", providerId: "sf", metrics: [{ id: "bal", label: "B", unit: "CNY", display: { module: "balance-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["sf-sub"] }],
  })
  expect(config.providerRuntime.get("sf")?.available).toBe(true)
})

test("zenmux rejects private IP baseUrl (SSRF)", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "http://10.0.0.1", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })).toThrow("baseUrl")
})

test("zenmux accepts arbitrary public host", () => {
  const config = loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "https://my-zenmux.example.com", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })
  expect(config.providerRuntime.get("zm")?.available).toBe(true)
})

// --- IPv6 SSRF tests ---

test("SSRF rejects IPv6 loopback [::1]", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "http://[::1]:8080", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })).toThrow("loopback")
})

test("SSRF rejects IPv6 link-local [fe80::1]", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "http://[fe80::1]", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })).toThrow("loopback")
})

test("SSRF rejects IPv6 link-local [fe90::1] (fe80::/10)", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "http://[fe90::1]", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })).toThrow("loopback")
})

test("SSRF rejects IPv6 ULA [fc00::1]", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "http://[fc00::1]", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })).toThrow("loopback")
})

test("SSRF rejects IPv6 ULA [fd00::1]", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "http://[fd00::1]", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })).toThrow("loopback")
})

test("SSRF rejects IPv4-mapped IPv6 [::ffff:127.0.0.1]", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "http://[::ffff:127.0.0.1]", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })).toThrow("loopback")
})

test("SSRF rejects IPv6 unspecified [::]", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "http://[::]", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })).toThrow("loopback")
})

test("SSRF rejects CGNAT 100.64.0.1", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "http://100.64.0.1", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })).toThrow("loopback")
})

test("SSRF does not false-positive on valid host starting with 'fc'", () => {
  const config = loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "https://fc-proxy.example.com", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })
  expect(config.providerRuntime.get("zm")?.available).toBe(true)
})
