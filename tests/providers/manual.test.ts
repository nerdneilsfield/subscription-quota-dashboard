import { expect, test } from "bun:test"
import type {
  MetricConfig,
  ProviderAccountConfig,
  ProviderRuntimeState,
} from "../../src/shared/domain"
import { createManualProvider } from "../../src/server/providers/manual"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "man-1", type: "manual" }
const runtime: ProviderRuntimeState = { available: true }

function buildInput(metrics: MetricConfig[], now: string): ProviderRefreshInput {
  return {
    providerAccountId: provider.id,
    provider,
    runtime,
    now,
    metrics,
  }
}

test("manual metric with used infers sourceValueKind gauge-used", async () => {
  const metric: MetricConfig = {
    id: "m-used",
    label: "Compute",
    unit: "credit",
    limit: 1000,
    used: 400,
    display: { module: "rolling-window-card" },
  }
  const result = await createManualProvider().refresh(buildInput([metric], "2026-06-25T00:00:00Z"))
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]!.sourceValueKind).toBe("gauge-used")
  expect(result.metrics[0]!.used).toBe(400)
})

test("manual metric with only remaining infers sourceValueKind gauge-remaining", async () => {
  const metric: MetricConfig = {
    id: "m-rem",
    label: "Balance",
    unit: "credit",
    remaining: 250,
    display: { module: "balance-card" },
  }
  const result = await createManualProvider().refresh(buildInput([metric], "2026-06-25T00:00:00Z"))
  expect(result.metrics[0]!.sourceValueKind).toBe("gauge-remaining")
  expect(result.metrics[0]!.remaining).toBe(250)
})

test("manual metric with neither used nor remaining infers sourceValueKind status", async () => {
  const metric: MetricConfig = {
    id: "m-status",
    label: "Health",
    unit: "",
    display: { module: "manual-status-card" },
  }
  const result = await createManualProvider().refresh(buildInput([metric], "2026-06-25T00:00:00Z"))
  expect(result.metrics[0]!.sourceValueKind).toBe("status")
})

test("explicit sourceValueKind on config is honored over inference", async () => {
  const metric: MetricConfig = {
    id: "m-explicit",
    label: "Counter",
    unit: "req",
    used: 10,
    sourceValueKind: "counter",
    display: { module: "rolling-window-card" },
  }
  const result = await createManualProvider().refresh(buildInput([metric], "2026-06-25T00:00:00Z"))
  expect(result.metrics[0]!.sourceValueKind).toBe("counter")
})

test("providerMetricId falls back to id when unset", async () => {
  const metric: MetricConfig = {
    id: "fallback-id",
    label: "L",
    unit: "",
    display: { module: "manual-status-card" },
  }
  const result = await createManualProvider().refresh(buildInput([metric], "2026-06-25T00:00:00Z"))
  expect(result.metrics[0]!.providerMetricId).toBe("fallback-id")
})

test("providerMetricId uses explicit value when set", async () => {
  const metric: MetricConfig = {
    id: "local-id",
    providerMetricId: "upstream-id-42",
    label: "L",
    unit: "",
    display: { module: "manual-status-card" },
  }
  const result = await createManualProvider().refresh(buildInput([metric], "2026-06-25T00:00:00Z"))
  expect(result.metrics[0]!.providerMetricId).toBe("upstream-id-42")
})

test("rolling manual metric older than updatedAt + duration returns unknown confidence", async () => {
  const metric: MetricConfig = {
    id: "m-roll-stale",
    label: "Calls",
    unit: "req",
    used: 100,
    window: { kind: "rolling", duration: "24h" },
    updatedAt: "2026-06-22T00:00:00Z",
    display: { module: "rolling-window-card" },
  }
  // now = 2026-06-25, updatedAt + 24h = 2026-06-23 → stale.
  const result = await createManualProvider().refresh(buildInput([metric], "2026-06-25T00:00:00Z"))
  expect(result.metrics[0]!.sourceConfidence).toBe("unknown")
})

test("rolling manual metric within updatedAt + duration returns known confidence", async () => {
  const metric: MetricConfig = {
    id: "m-roll-fresh",
    label: "Calls",
    unit: "req",
    used: 100,
    window: { kind: "rolling", duration: "24h" },
    updatedAt: "2026-06-24T12:00:00Z",
    display: { module: "rolling-window-card" },
  }
  // now = 2026-06-25, updatedAt + 24h = 2026-06-25T12:00 → still fresh.
  const result = await createManualProvider().refresh(buildInput([metric], "2026-06-25T00:00:00Z"))
  expect(result.metrics[0]!.sourceConfidence).toBe("known")
})

test("non-rolling metric stays known regardless of updatedAt", async () => {
  const metric: MetricConfig = {
    id: "m-cal",
    label: "Calls",
    unit: "req",
    used: 100,
    window: { kind: "calendar", period: "month", timezone: "UTC", resetAt: "2026-07-01T00:00:00Z" },
    updatedAt: "2020-01-01T00:00:00Z",
    display: { module: "period-quota-card" },
  }
  const result = await createManualProvider().refresh(buildInput([metric], "2026-06-25T00:00:00Z"))
  expect(result.metrics[0]!.sourceConfidence).toBe("known")
})

test("fixed metric past resetAt keeps fixed window metadata; provider does not compute status", async () => {
  const metric: MetricConfig = {
    id: "m-fixed",
    label: "Trial",
    unit: "credit",
    limit: 100,
    used: 100,
    window: { kind: "fixed", startsAt: "2026-06-01T00:00:00Z", resetAt: "2026-06-20T00:00:00Z" },
    display: { module: "period-quota-card" },
  }
  // now is well past resetAt.
  const result = await createManualProvider().refresh(buildInput([metric], "2026-06-25T00:00:00Z"))
  const normalized = result.metrics[0]!
  expect(normalized.window).toEqual({
    kind: "fixed",
    startsAt: "2026-06-01T00:00:00Z",
    resetAt: "2026-06-20T00:00:00Z",
  })
  // Provider must not project status; NormalizedMetric has no status field at all.
  expect("status" in normalized).toBe(false)
})

test("manual provider result carries deterministic fetchedAt/staleAfter and no history/errors", async () => {
  const now = "2026-06-25T00:00:00Z"
  const metric: MetricConfig = {
    id: "m",
    label: "L",
    unit: "",
    display: { module: "manual-status-card" },
  }
  const result = await createManualProvider().refresh(buildInput([metric], now))
  expect(result.providerAccountId).toBe("man-1")
  expect(result.fetchedAt).toBe(now)
  expect(result.staleAfter).toBe(now)
  expect(result.historyEvents).toBeUndefined()
  expect(result.errors).toBeUndefined()
})

test("manual provider type is manual", () => {
  expect(createManualProvider().type).toBe("manual")
})

test("manual provider passes through display module as suggestedDisplayModule", async () => {
  const metric: MetricConfig = {
    id: "m-display",
    label: "L",
    unit: "",
    display: { module: "balance-card" },
  }
  const result = await createManualProvider().refresh(buildInput([metric], "2026-06-25T00:00:00Z"))
  expect(result.metrics[0]!.suggestedDisplayModule).toBe("balance-card")
})
