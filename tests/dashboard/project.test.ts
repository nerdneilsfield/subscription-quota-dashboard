import { expect, test } from "bun:test"
import { buildDashboardPayload, projectProviderMetrics } from "../../src/server/dashboard/project"
import { buildMetricKey } from "../../src/shared/metric-key"
import { loadDashboardConfig } from "../../src/server/config/load-config"
import type { DashboardConfigInput, MetricConfig } from "../../src/shared/domain"
import type { NormalizedMetric, ProviderHistoryEvent } from "../../src/server/providers/types"
import type { ProviderCacheSummary } from "../../src/server/dashboard/project"

const NOW = "2026-06-25T12:00:00Z"

function makeConfig(input: DashboardConfigInput) {
  return loadDashboardConfig(input)
}

function poeBalanceMetric(providerMetricId: string, points: number, unit = "points"): NormalizedMetric {
  return {
    providerMetricId,
    label: "API points",
    unit,
    remaining: points,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
  }
}

function poeHistory(
  providerMetricId: string,
  rows: Array<{ id: string; ts: string; cost: number; usageType?: string }>,
): ProviderHistoryEvent[] {
  return rows.map((r) => ({
    providerMetricId,
    providerEventId: r.id,
    sourceTimestamp: r.ts,
    value: r.cost,
    valueKind: "consumption" as const,
    usageType: r.usageType ?? "API",
  }))
}

const okCache: ProviderCacheSummary = {
  fetchedAt: NOW,
  staleAfter: "2026-06-25T12:15:00Z",
  status: "ok",
  errors: [],
}

const baseSubscriptions: DashboardConfigInput["subscriptions"] = [
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
        display: { module: "balance-card" },
        window: {
          kind: "calendar",
          period: "month",
          timezone: "UTC",
          anchor: { dayOfMonth: 1, timeOfDay: "00:00" },
        },
      },
    ],
  },
]

const baseProviders: DashboardConfigInput["providers"] = [
  { id: "poe-main", type: "poe", apiKey: "secret-key-xxx" },
  { id: "manual-main", type: "manual" },
]

function baseConfig(overrides: Partial<DashboardConfigInput> = {}): DashboardConfigInput {
  return {
    providers: baseProviders,
    subscriptions: baseSubscriptions,
    profiles: [{ id: "self", name: "Personal", viewKey: "k", subscriptionIds: ["poe-api"] }],
    ...overrides,
  }
}

// Behavior 1: only profile subscriptionIds appear in payload.
test("only profile subscriptionIds appear in payload", () => {
  const config = makeConfig(
    baseConfig({
      subscriptions: [
        ...baseSubscriptions,
        {
          id: "manual-sub",
          name: "Manual",
          providerId: "manual-main",
          metrics: [
            {
              id: "credits",
              label: "Credits",
              unit: "credits",
              used: 5,
              limit: 10,
              display: { module: "period-quota-card" },
            },
          ],
        },
      ],
      profiles: [{ id: "self", name: "Personal", viewKey: "k", subscriptionIds: ["poe-api"] }],
    }),
  )
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "poe-main", metrics: [poeBalanceMetric("points", 500)], cache: okCache }],
  })
  expect(payload.subscriptions.map((s) => s.id)).toEqual(["poe-api"])
})

// Behavior 2: provider metric points projects into configured metric keyed poe-api/points.
test("provider metric projects into configured metricKey", () => {
  const config = makeConfig(baseConfig())
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "poe-main", metrics: [poeBalanceMetric("points", 500)], cache: okCache }],
  })
  const expectedKey = buildMetricKey("poe-main", "poe-api", "points")
  const metric = payload.subscriptions[0]!.metrics.find((m) => m.metricKey === expectedKey)
  expect(metric).toBeDefined()
  expect(metric!.remaining).toBe(500)
})

// Behavior 3: undeclared provider metrics are NOT rendered.
test("undeclared provider metrics are not rendered", () => {
  const config = makeConfig(baseConfig())
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [
      {
        providerAccountId: "poe-main",
        metrics: [poeBalanceMetric("points", 500), poeBalanceMetric("secret-other", 999)],
        cache: okCache,
      },
    ],
  })
  const ids = payload.subscriptions[0]!.metrics.map((m) => m.id)
  expect(ids).toEqual(["points"])
})

// Behavior 4: duplicated account-scoped balance is deduped in summary.
test("duplicated account-scoped balance deduped in summary by providerAccountId+providerMetricId", () => {
  const config = makeConfig(
    baseConfig({
      subscriptions: [
        {
          id: "sub-a",
          name: "A",
          providerId: "poe-main",
          metrics: [
            {
              id: "points",
              providerMetricId: "points",
              label: "A points",
              unit: "points",
              limit: 1000,
              display: { module: "balance-card" },
              window: { kind: "calendar", period: "month", timezone: "UTC", anchor: { dayOfMonth: 1, timeOfDay: "00:00" } },
            },
          ],
        },
        {
          id: "sub-b",
          name: "B",
          providerId: "poe-main",
          metrics: [
            {
              id: "points",
              providerMetricId: "points",
              label: "B points",
              unit: "points",
              limit: 1000,
              display: { module: "balance-card" },
              window: { kind: "calendar", period: "month", timezone: "UTC", anchor: { dayOfMonth: 1, timeOfDay: "00:00" } },
            },
          ],
        },
      ],
      profiles: [{ id: "self", name: "Personal", viewKey: "k", subscriptionIds: ["sub-a", "sub-b"] }],
    }),
  )
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "poe-main", metrics: [poeBalanceMetric("points", 500)], cache: okCache }],
  })
  // Both subscription metrics show 500 remaining
  expect(payload.subscriptions).toHaveLength(2)
  for (const sub of payload.subscriptions) {
    expect(sub.metrics[0]!.remaining).toBe(500)
  }
  // Summary deduped: total remaining = 500 (not 1000)
  expect(payload.summaryGroups).toHaveLength(1)
  expect(payload.summaryGroups[0]!.remaining).toBe(500)
})

// Behavior 5: filtered consumption uses normalized filter in summary identity.
test("filtered consumption uses normalized filter in summary identity", () => {
  const config = makeConfig(
    baseConfig({
      subscriptions: [
        {
          id: "poe-api",
          name: "Poe API",
          providerId: "poe-main",
          metrics: [
            {
              id: "api-points",
              providerMetricId: "points",
              label: "API points",
              unit: "points",
              limit: 1000,
              usageFilter: { usageTypes: ["API"] },
              display: { module: "balance-card" },
            },
            {
              id: "chat-points",
              providerMetricId: "points",
              label: "Chat points",
              unit: "points",
              limit: 1000,
              usageFilter: { usageTypes: ["SUBSCRIPTION"] },
              display: { module: "balance-card" },
            },
          ],
        },
      ],
      profiles: [{ id: "self", name: "Personal", viewKey: "k", subscriptionIds: ["poe-api"] }],
    }),
  )
  const events = poeHistory("points", [
    { id: "q1", ts: "2026-06-25T11:00:00Z", cost: 10, usageType: "API" },
    { id: "q2", ts: "2026-06-25T11:30:00Z", cost: 20, usageType: "SUBSCRIPTION" },
  ])
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    selectedRange: "24h",
    providers: [
      {
        providerAccountId: "poe-main",
        metrics: [poeBalanceMetric("points", 800)],
        historyEvents: events,
        cache: okCache,
      },
    ],
  })
  const filters = payload.summaryGroups.map((g) => g.normalizedUsageFilter ?? "").sort()
  expect(filters).toEqual(["usageTypes=API", "usageTypes=SUBSCRIPTION"])
  const apiGroup = payload.summaryGroups.find((g) => g.normalizedUsageFilter === "usageTypes=API")!
  expect(apiGroup.consumption).toBe(10)
  const chatGroup = payload.summaryGroups.find((g) => g.normalizedUsageFilter === "usageTypes=SUBSCRIPTION")!
  expect(chatGroup.consumption).toBe(20)
})

// Behavior 6: default usage_type=API filter applied; override includes more.
test("default usage_type=API filter applied to raw Poe history", () => {
  const config = makeConfig(baseConfig())
  const events = poeHistory("points", [
    { id: "q1", ts: "2026-06-25T11:00:00Z", cost: 10, usageType: "API" },
    { id: "q2", ts: "2026-06-25T11:30:00Z", cost: 25, usageType: "SUBSCRIPTION" },
  ])
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    selectedRange: "24h",
    providers: [
      {
        providerAccountId: "poe-main",
        metrics: [poeBalanceMetric("points", 500)],
        historyEvents: events,
        cache: okCache,
      },
    ],
  })
  const metric = payload.subscriptions[0]!.metrics[0]!
  expect(metric.rangeStats!.source).toBe("provider-history")
  expect(metric.rangeStats!.consumption).toBe(10)
  // display usageFilter reflects resolved default
  expect(metric.display.usageFilter?.usageTypes).toEqual(["API"])
})

test("config override usageFilter.usageTypes expands included rows", () => {
  const config = makeConfig(
    baseConfig({
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
              usageFilter: { usageTypes: ["API", "SUBSCRIPTION"] },
              display: { module: "balance-card" },
            },
          ],
        },
      ],
    }),
  )
  const events = poeHistory("points", [
    { id: "q1", ts: "2026-06-25T11:00:00Z", cost: 10, usageType: "API" },
    { id: "q2", ts: "2026-06-25T11:30:00Z", cost: 25, usageType: "SUBSCRIPTION" },
  ])
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    selectedRange: "24h",
    providers: [
      {
        providerAccountId: "poe-main",
        metrics: [poeBalanceMetric("points", 500)],
        historyEvents: events,
        cache: okCache,
      },
    ],
  })
  const metric = payload.subscriptions[0]!.metrics[0]!
  expect(metric.rangeStats!.consumption).toBe(35)
  expect(metric.display.usageFilter?.usageTypes).toEqual(["API", "SUBSCRIPTION"])
})

// Behavior 7: Poe balance > configuredLimit -> used=0, omit percentUsed, status ok.
test("Poe balance above configuredLimit shows used=0, omits percentUsed, status ok", () => {
  const config = makeConfig(baseConfig())
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [
      {
        providerAccountId: "poe-main",
        metrics: [poeBalanceMetric("points", 1_200_000)],
        cache: okCache,
      },
    ],
  })
  const metric = payload.subscriptions[0]!.metrics[0]!
  expect(metric.used).toBe(0)
  expect(metric.percentUsed).toBeUndefined()
  expect(metric.status).toBe("ok")
})

// Behavior 8: provider runtime resetAt does NOT replace configured recurring anchor.
test("provider runtime resetAt does not replace configured recurring calendar anchor", () => {
  const config = makeConfig(baseConfig())
  // Provider metric advertises a resetAt that the anchor would never produce.
  const providerMetric: NormalizedMetric = {
    ...poeBalanceMetric("points", 500),
    window: {
      kind: "calendar",
      period: "month",
      timezone: "UTC",
      resetAt: "2026-07-15T00:00:00Z",
    },
  }
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "poe-main", metrics: [providerMetric], cache: okCache }],
  })
  const window = payload.subscriptions[0]!.metrics[0]!.window!
  // Configured anchor dayOfMonth=1 -> next reset is 2026-07-01, NOT provider's 2026-07-15.
  expect(window.kind).toBe("calendar")
  expect(window.anchor).toEqual({ dayOfMonth: 1, timeOfDay: "00:00" })
  expect(window.resetAt).toBe("2026-07-01T00:00:00Z")
  expect(window.timezone).toBe("UTC")
})

// Behavior 9: rolling windowStartAt only when history covers rolling duration.
test("rolling windowStartAt derived when provider history covers duration", () => {
  const rollingMetric: MetricConfig = {
    id: "five-hour-points",
    providerMetricId: "points",
    label: "5h usage",
    unit: "points",
    limit: 5000,
    display: { module: "rolling-window-card" },
    window: { kind: "rolling", duration: "5h" },
  }
  const config = makeConfig(
    baseConfig({
      subscriptions: [
        { id: "poe-api", name: "Poe API", providerId: "poe-main", metrics: [rollingMetric] },
      ],
    }),
  )
  // History spans 7h: 05:00 -> 12:00 (>= 5h duration)
  const events = poeHistory("points", [
    { id: "a", ts: "2026-06-25T05:00:00Z", cost: 1 },
    { id: "b", ts: "2026-06-25T12:00:00Z", cost: 2 },
  ])
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [
      {
        providerAccountId: "poe-main",
        metrics: [poeBalanceMetric("points", 400)],
        historyEvents: events,
        cache: okCache,
      },
    ],
  })
  const window = payload.subscriptions[0]!.metrics[0]!.window!
  expect(window.kind).toBe("rolling")
  expect(window.duration).toBe("5h")
  expect(window.windowStartAt).toBe("2026-06-25T07:00:00.000Z")
})

test("rolling windowStartAt omitted when history does not cover duration", () => {
  const rollingMetric: MetricConfig = {
    id: "five-hour-points",
    providerMetricId: "points",
    label: "5h usage",
    unit: "points",
    limit: 5000,
    display: { module: "rolling-window-card" },
    window: { kind: "rolling", duration: "5h" },
  }
  const config = makeConfig(
    baseConfig({
      subscriptions: [
        { id: "poe-api", name: "Poe API", providerId: "poe-main", metrics: [rollingMetric] },
      ],
    }),
  )
  // History spans 1h: 11:00 -> 12:00 (< 5h duration)
  const events = poeHistory("points", [
    { id: "a", ts: "2026-06-25T11:00:00Z", cost: 1 },
    { id: "b", ts: "2026-06-25T12:00:00Z", cost: 2 },
  ])
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [
      {
        providerAccountId: "poe-main",
        metrics: [poeBalanceMetric("points", 400)],
        historyEvents: events,
        cache: okCache,
      },
    ],
  })
  const window = payload.subscriptions[0]!.metrics[0]!.window!
  expect(window.windowStartAt).toBeUndefined()
})

// Behavior 10: title defaults to metric label, subtitle defaults to window label.
test("display title defaults to metric label and subtitle defaults to window label", () => {
  const config = makeConfig(baseConfig())
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "poe-main", metrics: [poeBalanceMetric("points", 500)], cache: okCache }],
  })
  const metric = payload.subscriptions[0]!.metrics[0]!
  expect(metric.display.title).toBe("API points")
  expect(metric.display.subtitle).toContain("Monthly")
})

// Behavior 11: SummaryGroup has stable id, optional providerType, normalizedUsageFilter.
test("SummaryGroup has stable id, providerType, and normalizedUsageFilter", () => {
  const config = makeConfig(baseConfig())
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    selectedRange: "24h",
    providers: [
      {
        providerAccountId: "poe-main",
        metrics: [poeBalanceMetric("points", 500)],
        historyEvents: poeHistory("points", [{ id: "q1", ts: "2026-06-25T11:00:00Z", cost: 10 }]),
        cache: okCache,
      },
    ],
  })
  expect(payload.summaryGroups).toHaveLength(1)
  const group = payload.summaryGroups[0]!
  expect(group.id).toBeTruthy()
  expect(group.id).toBe(`points|gauge-remaining|poe|same-reset|usageTypes=API`)
  expect(group.providerType).toBe("poe")
  expect(group.normalizedUsageFilter).toBe("usageTypes=API")
  expect(group.unit).toBe("points")
})

// Unit-mismatch guard: different units produce separate groups (no mixing).
test("summary groups do not mix different units", () => {
  const config = makeConfig(
    baseConfig({
      subscriptions: [
        {
          id: "mixed",
          name: "Mixed",
          providerId: "manual-main",
          metrics: [
            { id: "credits", label: "Credits", unit: "credits", used: 5, limit: 10, display: { module: "period-quota-card" } },
            { id: "tokens", label: "Tokens", unit: "tokens", used: 50, limit: 100, display: { module: "period-quota-card" } },
          ],
        },
      ],
      profiles: [{ id: "self", name: "Personal", viewKey: "k", subscriptionIds: ["mixed"] }],
    }),
  )
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "manual-main", metrics: [], cache: okCache }],
  })
  const units = payload.summaryGroups.map((g) => g.unit).sort()
  expect(units).toEqual(["credits", "tokens"])
})

// projectProviderMetrics standalone: undeclared provider metrics are not in projected output.
test("projectProviderMetrics returns one ProjectedMetric per configured metric matching providerMetricId", () => {
  const config = makeConfig(baseConfig())
  const projected = projectProviderMetrics({
    config,
    subscriptionIds: ["poe-api"],
    providers: [
      {
        providerAccountId: "poe-main",
        metrics: [poeBalanceMetric("points", 500), poeBalanceMetric("hidden", 999)],
      },
    ],
  })
  const keys = projected.map((p) => p.metricKey)
  expect(keys).toEqual([buildMetricKey("poe-main", "poe-api", "points")])
  expect(projected[0]!.providerMetric?.remaining).toBe(500)
})

// Status precedence: critical overrides warn overrides ok.
test("subscription status is the highest precedence of its metric statuses", () => {
  const config = makeConfig(
    baseConfig({
      subscriptions: [
        {
          id: "mixed",
          name: "Mixed",
          providerId: "manual-main",
          metrics: [
            // ok metric (no limit, no usage)
            { id: "status", label: "Status", unit: "credits", notes: "ok", display: { module: "manual-status-card" } },
            // critical metric (used > limit)
            { id: "over", label: "Over", unit: "tokens", used: 200, limit: 100, display: { module: "period-quota-card" } },
          ],
        },
      ],
      profiles: [{ id: "self", name: "Personal", viewKey: "k", subscriptionIds: ["mixed"] }],
    }),
  )
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "manual-main", metrics: [], cache: okCache }],
  })
  expect(payload.subscriptions[0]!.status).toBe("critical")
})

// Percent used: omitted when limit absent.
test("percentUsed omitted when limit absent", () => {
  const config = makeConfig(
    baseConfig({
      subscriptions: [
        {
          id: "nolimit",
          name: "NoLimit",
          providerId: "manual-main",
          metrics: [{ id: "m", label: "M", unit: "credits", display: { module: "manual-status-card" } }],
        },
      ],
      profiles: [{ id: "self", name: "Personal", viewKey: "k", subscriptionIds: ["nolimit"] }],
    }),
  )
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "manual-main", metrics: [], cache: okCache }],
  })
  expect(payload.subscriptions[0]!.metrics[0]!.percentUsed).toBeUndefined()
})

// Config-declared metric missing from provider output renders with sourceConfidence unknown + unavailable.
test("config metric missing from provider output is marked unavailable", () => {
  const config = makeConfig(baseConfig())
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "poe-main", metrics: [], cache: okCache }],
  })
  const metric = payload.subscriptions[0]!.metrics[0]!
  expect(metric.status).toBe("unavailable")
  expect(metric.display.sourceConfidence).toBe("unknown")
})

// Fixed window past resetAt -> status expired.
test("fixed window metric past resetAt is expired", () => {
  const config = makeConfig(
    baseConfig({
      subscriptions: [
        {
          id: "fixed-sub",
          name: "Fixed",
          providerId: "manual-main",
          metrics: [
            {
              id: "trial",
              label: "Trial",
              unit: "credits",
              used: 5,
              limit: 10,
              display: { module: "period-quota-card" },
              window: {
                kind: "fixed",
                startsAt: "2026-06-01T00:00:00Z",
                resetAt: "2026-06-15T00:00:00Z",
              },
            },
          ],
        },
      ],
      profiles: [{ id: "self", name: "Personal", viewKey: "k", subscriptionIds: ["fixed-sub"] }],
    }),
  )
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "manual-main", metrics: [], cache: okCache }],
  })
  expect(payload.subscriptions[0]!.metrics[0]!.status).toBe("expired")
})

// Snapshot input is never silently mutated; payload.projects keep provider/account semantics intact.
test("payload exposes generatedAt and selectedRange defaults to 24h", () => {
  const config = makeConfig(baseConfig())
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "poe-main", metrics: [poeBalanceMetric("points", 500)], cache: okCache }],
  })
  expect(payload.generatedAt).toBe(NOW)
  expect(payload.selectedRange).toBe("24h")
  expect(payload.ranges).toEqual(["1h", "24h", "7d", "30d"])
  expect(payload.profile).toEqual({ id: "self", name: "Personal" })
})
