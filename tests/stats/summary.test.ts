import { expect, test } from "bun:test"
import { buildSummaryGroups } from "../../src/server/stats/summary"
import type { ProjectedMetric } from "../../src/server/dashboard/project"
import type { MetricConfig, SourceValueKind } from "../../src/shared/domain"
import { buildMetricKey } from "../../src/shared/metric-key"

function metric(id: string, unit: string, extra: Partial<MetricConfig> = {}): MetricConfig {
  return {
    id,
    providerMetricId: id,
    label: id,
    unit,
    display: { module: "balance-card" },
    ...extra,
  }
}

function makeProjected(
  overrides: Partial<ProjectedMetric> & Pick<ProjectedMetric, "metricId" | "subscriptionId" | "config">,
): ProjectedMetric {
  const providerAccountId = overrides.providerAccountId ?? "poe-main"
  const subscriptionId = overrides.subscriptionId
  const metricId = overrides.metricId
  const metricKey = overrides.metricKey ?? buildMetricKey(providerAccountId, subscriptionId, metricId)
  const providerMetricId = overrides.providerMetricId ?? metricId
  return {
    subscriptionId,
    subscriptionName: overrides.subscriptionName ?? subscriptionId,
    metricId,
    metricKey,
    providerAccountId,
    providerType: overrides.providerType ?? "poe",
    providerMetricId,
    config: overrides.config,
    providerMetric: overrides.providerMetric,
    cache: overrides.cache,
    resolvedUsageFilter: overrides.resolvedUsageFilter ?? {},
    normalizedUsageFilter: overrides.normalizedUsageFilter ?? "",
    projectedHistory: overrides.projectedHistory ?? [],
    snapshots: overrides.snapshots ?? [],
  }
}

const NOW = "2026-06-25T12:00:00Z"

test("summary dedupes account-scoped balance by providerAccountId+providerMetricId", () => {
  const pm = {
    providerMetricId: "points",
    label: "P",
    unit: "points",
    remaining: 500,
    sourceValueKind: "gauge-remaining" as const,
    sourceConfidence: "known" as const,
  }
  const a = makeProjected({
    metricId: "points",
    subscriptionId: "sub-a",
    providerMetricId: "points",
    config: metric("points", "points"),
    providerMetric: pm,
  })
  const b = makeProjected({
    metricId: "points",
    subscriptionId: "sub-b",
    providerMetricId: "points",
    config: metric("points", "points"),
    providerMetric: pm,
  })
  const groups = buildSummaryGroups([a, b], "24h", NOW)
  expect(groups).toHaveLength(1)
  expect(groups[0]!.remaining).toBe(500)
})

test("summary never mixes different units into one group", () => {
  const a = makeProjected({ metricId: "credits", subscriptionId: "s1", config: metric("credits", "credits") })
  const b = makeProjected({ metricId: "tokens", subscriptionId: "s1", config: metric("tokens", "tokens") })
  const groups = buildSummaryGroups([a, b], "24h", NOW)
  expect(groups.map((g) => g.unit).sort()).toEqual(["credits", "tokens"])
})

test("summary separates same unit by sourceValueKind", () => {
  const a = makeProjected({
    metricId: "m1",
    subscriptionId: "s1",
    config: metric("m1", "points", { sourceValueKind: "gauge-remaining" as SourceValueKind }),
  })
  const b = makeProjected({
    metricId: "m2",
    subscriptionId: "s1",
    config: metric("m2", "points", { sourceValueKind: "gauge-used" as SourceValueKind }),
  })
  const groups = buildSummaryGroups([a, b], "24h", NOW)
  expect(groups).toHaveLength(2)
  const kinds = groups.map((g) => g.sourceValueKind).sort()
  expect(kinds).toEqual(["gauge-remaining", "gauge-used"])
})

test("summary separates by normalizedUsageFilter", () => {
  const a = makeProjected({
    metricId: "m1",
    subscriptionId: "s1",
    config: metric("m1", "points"),
    resolvedUsageFilter: { usageTypes: ["API"] },
    normalizedUsageFilter: "usageTypes=API",
  })
  const b = makeProjected({
    metricId: "m2",
    subscriptionId: "s1",
    config: metric("m2", "points"),
    resolvedUsageFilter: { usageTypes: ["SUBSCRIPTION"] },
    normalizedUsageFilter: "usageTypes=SUBSCRIPTION",
  })
  const groups = buildSummaryGroups([a, b], "24h", NOW)
  expect(groups).toHaveLength(2)
  const filters = groups.map((g) => g.normalizedUsageFilter ?? "").sort()
  expect(filters).toEqual(["usageTypes=API", "usageTypes=SUBSCRIPTION"])
})

test("summary burnRate normalized per hour using selectedRange", () => {
  const a = makeProjected({
    metricId: "m",
    subscriptionId: "s",
    config: metric("m", "points"),
    normalizedUsageFilter: "usageTypes=API",
    projectedHistory: [
      { sourceTimestamp: "2026-06-25T11:00:00Z", value: 30, valueKind: "consumption" },
      { sourceTimestamp: "2026-06-25T11:30:00Z", value: 30, valueKind: "consumption" },
    ],
  })
  const groups = buildSummaryGroups([a], "24h", NOW)
  // 60 total consumption over 24h -> 2.5 per hour
  expect(groups[0]!.burnRate).toEqual({ value: 2.5, per: "hour" })
  expect(groups[0]!.consumption).toBe(60)
})

test("summary group id stable and excludes label", () => {
  const a = makeProjected({
    metricId: "m",
    subscriptionId: "s",
    providerType: "poe",
    normalizedUsageFilter: "usageTypes=API",
    config: metric("m", "points", {
      label: "Custom Label",
      sourceValueKind: "gauge-remaining",
      window: { kind: "calendar", period: "month", timezone: "UTC", anchor: { dayOfMonth: 1, timeOfDay: "00:00" } },
    }),
  })
  const groups = buildSummaryGroups([a], "24h", NOW)
  expect(groups[0]!.id).toBe("points|gauge-remaining|poe|same-reset|usageTypes=API")
  expect(groups[0]!.label).toBe("Custom Label")
})

test("summary providerType propagated from projected metric", () => {
  const a = makeProjected({
    metricId: "m",
    subscriptionId: "s",
    providerType: "manual",
    config: metric("m", "credits", { sourceValueKind: "gauge-used" }),
  })
  const groups = buildSummaryGroups([a], "24h", NOW)
  expect(groups[0]!.providerType).toBe("manual")
})
