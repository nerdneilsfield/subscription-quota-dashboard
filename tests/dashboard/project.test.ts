import { expect, test } from "bun:test"
import { buildDashboardPayload, projectProviderMetrics } from "../../src/server/dashboard/project"
import { buildMetricKey } from "../../src/shared/metric-key"
import { loadDashboardConfig } from "../../src/server/config/load-config"
import type { DashboardConfigInput, MetricConfig } from "../../src/shared/domain"
import type { NormalizedMetric, ProviderHistoryEvent } from "../../src/server/providers/types"
import type { ProviderAccountProjection, ProviderCacheSummary } from "../../src/server/dashboard/project"

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
  expect(window.timezone).toBe("America/Los_Angeles")
})

test("configured rolling resetAt is projected as the authoritative cutoff", () => {
  const metric: MetricConfig = {
    id: "five-hour",
    providerMetricId: "five-hour",
    label: "5h quota",
    unit: "%",
    limit: 100,
    display: { module: "period-quota-card" },
    window: { kind: "rolling", duration: "5h", resetAt: "2026-06-25T16:30:00Z" },
  }
  const config = makeConfig(baseConfig({
    subscriptions: [{ id: "poe-api", name: "Poe API", providerId: "poe-main", metrics: [metric] }],
  }))
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{
      providerAccountId: "poe-main",
      metrics: [{
        providerMetricId: "five-hour",
        label: "5h quota",
        unit: "%",
        used: 10,
        limit: 100,
        sourceValueKind: "gauge-used",
        sourceConfidence: "known",
      }],
      cache: okCache,
    }],
  })
  expect(payload.subscriptions[0]!.metrics[0]!.window).toMatchObject({
    resetAt: "2026-06-25T16:30:00Z",
    timezone: "America/Los_Angeles",
  })
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
    now: NOW,
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

// Spec ~918: subscription status escalates from subscription-level cache status/errors.
test("subscription status escalates to warn when its cache carries provider-level errors (metrics all ok)", () => {
  const config = makeConfig(
    baseConfig({
      subscriptions: [
        {
          id: "man-sub", name: "Manual", providerId: "manual-main",
          // No limit → metric computes ok regardless of cache; escalation must
          // come from the subscription-level cache errors.
          metrics: [{ id: "health", label: "Health", unit: "", display: { module: "manual-status-card" } }],
        },
      ],
      profiles: [{ id: "self", name: "Personal", viewKey: "k", subscriptionIds: ["man-sub"] }],
    }),
  )
  const erroredCache: ProviderCacheSummary = {
    fetchedAt: NOW,
    staleAfter: "2026-06-25T12:15:00Z",
    status: "ok",
    errors: [{ message: "Poe history request failed (503)", retryable: true }],
  }
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "manual-main", metrics: [], cache: erroredCache }],
  })
  expect(payload.subscriptions[0]!.metrics[0]!.status).toBe("ok")
  expect(payload.subscriptions[0]!.status).toBe("warn")
  expect(payload.subscriptions[0]!.errors).toHaveLength(1)
})

test("subscription status escalates to stale when its cache status is stale even if metrics compute ok", () => {
  const config = makeConfig(
    baseConfig({
      subscriptions: [
        {
          id: "man-sub", name: "Manual", providerId: "manual-main",
          metrics: [{ id: "health", label: "Health", unit: "", display: { module: "manual-status-card" } }],
        },
      ],
      profiles: [{ id: "self", name: "Personal", viewKey: "k", subscriptionIds: ["man-sub"] }],
    }),
  )
  // cache.status "stale" but staleAfter in the future → metric stays ok via the
  // timestamp check (computeMetricStatus only short-circuits on "unavailable"),
  // yet the subscription-level cache status must still escalate the badge.
  const staleStatusCache: ProviderCacheSummary = {
    fetchedAt: NOW,
    staleAfter: "2026-06-25T12:30:00Z",
    status: "stale",
    errors: [],
  }
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "manual-main", metrics: [], cache: staleStatusCache }],
  })
  expect(payload.subscriptions[0]!.metrics[0]!.status).toBe("ok")
  expect(payload.subscriptions[0]!.status).toBe("stale")
})

test("subscription status is unavailable when its cache status is unavailable", () => {
  const config = makeConfig(
    baseConfig({
      subscriptions: [
        {
          id: "man-sub", name: "Manual", providerId: "manual-main",
          metrics: [{ id: "health", label: "Health", unit: "", display: { module: "manual-status-card" } }],
        },
      ],
      profiles: [{ id: "self", name: "Personal", viewKey: "k", subscriptionIds: ["man-sub"] }],
    }),
  )
  const unavailableCache: ProviderCacheSummary = {
    fetchedAt: NOW,
    staleAfter: "2026-06-25T12:15:00Z",
    status: "unavailable",
    errors: [],
  }
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "manual-main", metrics: [], cache: unavailableCache }],
  })
  expect(payload.subscriptions[0]!.status).toBe("unavailable")
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

test("payload exposes configured dashboard slogan", () => {
  const config = makeConfig(baseConfig({ branding: { slogan: "My quota room" } }))
  const payload = buildDashboardPayload({
    config,
    profileId: "self",
    generatedAt: NOW,
    providers: [{ providerAccountId: "poe-main", metrics: [poeBalanceMetric("points", 500)], cache: okCache }],
  })
  expect(payload.branding).toEqual({ slogan: "My quota room" })
})

test("non-poe gauge-remaining over limit shows ok status (isOverLimit)", () => {
  const config = makeConfig({
    providers: [{ id: "ds", type: "deepseek", apiKey: "k" }],
    subscriptions: [{
      id: "ds-sub", name: "DS", providerId: "ds",
      metrics: [{
        id: "bal", providerMetricId: "balance", label: "Balance", unit: "CNY",
        limit: 50, sourceValueKind: "gauge-remaining",
        display: { module: "balance-card" },
      }],
    }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["ds-sub"] }],
  })
  const providers: ProviderAccountProjection[] = [{
    providerAccountId: "ds",
    metrics: [{
      providerMetricId: "balance", label: "Balance", unit: "CNY",
      remaining: 100, sourceValueKind: "gauge-remaining", sourceConfidence: "known",
    }],
    cache: okCache,
  }]
  const payload = buildDashboardPayload({
    config, profileId: "self", generatedAt: NOW,
    selectedRange: "24h", providers,
  })
  const metric = payload.subscriptions[0]!.metrics[0]!
  expect(metric.status).toBe("ok")
  expect(metric.used).toBe(0)
  expect(metric.percentUsed).toBeUndefined()
})

test("gauge-used over limit shows critical (NOT isOverLimit - only gauge-remaining applies)", () => {
  const config = makeConfig({
    providers: [{ id: "vol", type: "volcengine", ak: "a", sk: "s" }],
    subscriptions: [{
      id: "vol-sub", name: "Vol", providerId: "vol",
      metrics: [{
        id: "afp", providerMetricId: "afp:5h", label: "AFP 5h", unit: "tokens",
        limit: 1000, sourceValueKind: "gauge-used",
        display: { module: "period-quota-card" },
      }],
    }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["vol-sub"] }],
  })
  const providers: ProviderAccountProjection[] = [{
    providerAccountId: "vol",
    metrics: [{
      providerMetricId: "afp:5h", label: "AFP 5h", unit: "tokens",
      used: 1500, limit: 1000, sourceValueKind: "gauge-used", sourceConfidence: "known",
    }],
    cache: okCache,
  }]
  const payload = buildDashboardPayload({
    config, profileId: "self", generatedAt: NOW,
    selectedRange: "24h", providers,
  })
  // gauge-used over-limit -> critical via existing used>limit check (project.ts:665-667)
  // isOverLimit does NOT apply (only gauge-remaining + remaining>limit)
  expect(payload.subscriptions[0]!.metrics[0]!.status).toBe("critical")
})

test("percent-based metric at 100% shows critical (NOT isOverLimit)", () => {
  const config = makeConfig({
    providers: [{ id: "mm", type: "minimax", apiKey: "k" }],
    subscriptions: [{
      id: "mm-sub", name: "MM", providerId: "mm",
      metrics: [{
        id: "5h", providerMetricId: "five_hour", label: "5h", unit: "%",
        limit: 100, sourceValueKind: "gauge-remaining",
        display: { module: "rolling-window-card", thresholds: { criticalPercentUsed: 95 } },
      }],
    }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["mm-sub"] }],
  })
  const providers: ProviderAccountProjection[] = [{
    providerAccountId: "mm",
    metrics: [{
      providerMetricId: "five_hour", label: "5h", unit: "%",
      remaining: 0, limit: 100, sourceValueKind: "gauge-remaining", sourceConfidence: "known",
    }],
    cache: okCache,
  }]
  const payload = buildDashboardPayload({
    config, profileId: "self", generatedAt: NOW,
    selectedRange: "24h", providers,
  })
  // used=100, percentUsed=100, hits critical threshold, NOT isOverLimit (gauge-remaining only)
  expect(payload.subscriptions[0]!.metrics[0]!.status).toBe("critical")
})

test("dynamic subscription projection produces metrics with synthetic config", () => {
  const config = makeConfig({
    providers: [
      { id: "poe-main", type: "poe", apiKey: "k" },
      { id: "cp-main", type: "cliproxy", baseUrl: "http://localhost:8317", apiKey: "k" },
    ],
    subscriptions: baseSubscriptions,
    profiles: [{
      id: "self", name: "Personal", viewKey: "k",
      subscriptionIds: ["poe-api"],
      dynamicProviderIds: ["cp-main"],
    }],
  })
  const dynSubs = new Map([["cp-main", [{
    id: "cliproxy:codex:abc123",
    name: "Codex",
    providerMetricIds: ["codex:abc123:five_hour"],
    identity: { provider: "codex", providerLabel: "Codex", account: "alice@example.com", plan: "Pro", transport: "CLIProxy" },
    ui: { group: "Codex" },
  }, {
    id: "cliproxy:doubao:def456",
    name: "Doubao",
    providerMetricIds: ["doubao:def456:weekly"],
    identity: { provider: "doubao", providerLabel: "Doubao", transport: "CLIProxy" },
  }]]])
  const providers: ProviderAccountProjection[] = [
    {
      providerAccountId: "cp-main",
      metrics: [{
        providerMetricId: "codex:abc123:five_hour",
        label: "5h", unit: "%",
        used: 72, limit: 100,
        sourceValueKind: "gauge-used", sourceConfidence: "known",
        window: { kind: "rolling", duration: "5h", resetAt: "2026-07-17T05:00:00Z" },
      }, {
        providerMetricId: "doubao:def456:weekly",
        label: "Weekly", unit: "%",
        used: 8, limit: 100,
        sourceValueKind: "gauge-used", sourceConfidence: "known",
        window: { kind: "rolling", duration: "7d", resetAt: "2026-07-18T05:00:00Z" },
      }],
      cache: okCache,
    },
  ]
  const payload = buildDashboardPayload({
    config, profileId: "self", generatedAt: NOW,
    selectedRange: "24h", providers,
    dynamicSubscriptions: dynSubs,
  })
  expect(payload.subscriptions).toHaveLength(3)
  const dynSub = payload.subscriptions.find(s => s.id === "cliproxy:codex:abc123")!
  expect(dynSub.name).toBe("Codex")
  expect(dynSub.identity).toEqual({ provider: "codex", providerLabel: "Codex", account: "alice@example.com", plan: "Pro", transport: "CLIProxy" })
  expect(dynSub.metrics).toHaveLength(1)
  expect(dynSub.metrics[0]!.label).toBe("5h")
  expect(dynSub.metrics[0]!.used).toBe(72)
  expect(dynSub.metrics[0]!.display.module).toBe("period-quota-card")
  expect(dynSub.metrics[0]!.window?.timezone).toBe("America/Los_Angeles")
  const doubao = payload.subscriptions.find(s => s.id === "cliproxy:doubao:def456")!
  expect(doubao.metrics[0]!.window?.timezone).toBe("Asia/Shanghai")
})

test("dynamic metrics excluded from summary groups", () => {
  const config = makeConfig({
    providers: [
      { id: "poe-main", type: "poe", apiKey: "k" },
      { id: "cp-main", type: "cliproxy", baseUrl: "http://localhost:8317", apiKey: "k" },
    ],
    subscriptions: baseSubscriptions,
    profiles: [{
      id: "self", name: "Personal", viewKey: "k",
      subscriptionIds: ["poe-api"],
      dynamicProviderIds: ["cp-main"],
    }],
  })
  const dynSubs = new Map([["cp-main", [{
    id: "cliproxy:codex:abc123",
    name: "CLIProxy - Codex",
    providerMetricIds: ["codex:abc123:five_hour"],
  }]]])
  const providers: ProviderAccountProjection[] = [
    {
      providerAccountId: "cp-main",
      metrics: [{
        providerMetricId: "codex:abc123:five_hour",
        label: "5h", unit: "%", used: 72, limit: 100,
        sourceValueKind: "gauge-used", sourceConfidence: "known",
        window: { kind: "rolling", duration: "5h", resetAt: "2026-07-17T05:00:00Z" },
      }],
      cache: okCache,
    },
  ]
  const payload = buildDashboardPayload({
    config, profileId: "self", generatedAt: NOW,
    selectedRange: "24h", providers,
    dynamicSubscriptions: dynSubs,
  })
  for (const g of payload.summaryGroups) {
    expect(g.id).not.toContain("cliproxy")
  }
})

test("dynamic subscription absent (no data) -> no metrics, graceful", () => {
  const config = makeConfig({
    providers: [
      { id: "poe-main", type: "poe", apiKey: "k" },
      { id: "cp-main", type: "cliproxy", baseUrl: "http://localhost:8317", apiKey: "k" },
    ],
    subscriptions: baseSubscriptions,
    profiles: [{
      id: "self", name: "Personal", viewKey: "k",
      subscriptionIds: ["poe-api"],
      dynamicProviderIds: ["cp-main"],
    }],
  })
  const providers: ProviderAccountProjection[] = [
    { providerAccountId: "cp-main", metrics: [] },
  ]
  const payload = buildDashboardPayload({
    config, profileId: "self", generatedAt: NOW,
    selectedRange: "24h", providers,
  })
  expect(payload.subscriptions).toHaveLength(1)
  expect(payload.subscriptions[0]!.id).toBe("poe-api")
})
