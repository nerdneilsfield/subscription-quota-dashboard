import { expect, test } from "bun:test"
import { openDashboardDatabase } from "../../src/server/storage/database"
import { createRepositories } from "../../src/server/storage/repositories"
import type {
  DashboardStorage,
  ImportStateRecord,
  ProjectedHistoryEvent,
  ProviderCacheRecord,
  SnapshotInsert,
} from "../../src/server/storage/repositories"
import { loadDashboardConfig } from "../../src/server/config/load-config"
import type { DashboardConfigInput, MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createRateLimiter } from "../../src/server/auth/rate-limit"
import type { RateLimiter } from "../../src/server/auth/rate-limit"
import type {
  NormalizedMetric,
  ProviderAdapter,
  ProviderHistoryEvent,
  ProviderRefreshInput,
  ProviderRefreshResult,
} from "../../src/server/providers/types"
import { createRefreshService } from "../../src/server/refresh/refresh-service"

const NOW_MS = Date.parse("2026-06-25T12:00:00.000Z")
const NOW_ISO = "2026-06-25T12:00:00.000Z"
const fixedNow = (): Date => new Date(NOW_MS)

function makeStorage(): DashboardStorage {
  return createRepositories(openDashboardDatabase(":memory:"))
}

// Storage spy: captures write arguments + whether importState.upsert ran in tx.
function spyStorage(base: DashboardStorage) {
  const snapshotInserts: SnapshotInsert[][] = []
  const historyInserts: ProjectedHistoryEvent[][] = []
  const importStateUpserts: ImportStateRecord[] = []
  const cacheUpserts: ProviderCacheRecord[] = []
  let txDepth = 0
  const importStateInTx: boolean[] = []
  const storage: DashboardStorage = {
    ...base,
    providerCache: { ...base.providerCache, upsert(r) { cacheUpserts.push(r); base.providerCache.upsert(r) } },
    snapshots: { ...base.snapshots, insertMany(rows) { snapshotInserts.push(rows); base.snapshots.insertMany(rows) } },
    historyEvents: { ...base.historyEvents, insertMany(rows) { historyInserts.push(rows); base.historyEvents.insertMany(rows) } },
    importState: {
      ...base.importState,
      upsert(r) { importStateUpserts.push(r); importStateInTx.push(txDepth > 0); base.importState.upsert(r) },
    },
    transaction<T>(fn: () => T): T { txDepth++; try { return base.transaction(fn) } finally { txDepth-- } },
  }
  return { storage, snapshotInserts, historyInserts, importStateUpserts, cacheUpserts, importStateInTx }
}

function poeProvider(id: string, apiKey = "k"): ProviderAccountConfig {
  return { id, type: "poe", apiKey }
}

function pointsMetric(id: string, overrides: Partial<MetricConfig> = {}): MetricConfig {
  return {
    id,
    providerMetricId: "points",
    label: id,
    unit: "points",
    limit: 1_000_000,
    display: { module: "balance-card" },
    ...overrides,
  }
}

function balanceMetric(remaining: number): NormalizedMetric {
  return {
    providerMetricId: "points",
    label: "Points",
    unit: "points",
    remaining,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
  }
}

function historyEvent(id: string, cost: number, opts: { usageType?: string; ts?: string } = {}): ProviderHistoryEvent {
  return {
    providerMetricId: "points",
    providerEventId: id,
    sourceTimestamp: opts.ts ?? NOW_ISO,
    value: cost,
    valueKind: "consumption",
    usageType: opts.usageType ?? "API",
  }
}

function okResult(paId: string, metrics: NormalizedMetric[], history: ProviderHistoryEvent[] = [], nextImportState?: { maxCreationTime?: number; importedQueryIdsAtMaxCreationTime: string[] }): ProviderRefreshResult {
  const r: ProviderRefreshResult = {
    providerAccountId: paId,
    fetchedAt: NOW_ISO,
    staleAfter: NOW_ISO,
    metrics,
    historyEvents: history,
  }
  if (nextImportState) r.nextImportState = nextImportState
  return r
}

// Controllable provider: refresh returns a promise resolved externally.
type PendingCall = { input: ProviderRefreshInput; resolve: (r: ProviderRefreshResult) => void; reject: (e: Error) => void }
function controllableProvider(type: string = "poe"): {
  adapter: ProviderAdapter
  started: ProviderRefreshInput[]
  pending: PendingCall[]
} {
  const started: ProviderRefreshInput[] = []
  const pending: PendingCall[] = []
  const adapter: ProviderAdapter = {
    type,
    async refresh(input): Promise<ProviderRefreshResult> {
      started.push(input)
      return new Promise<ProviderRefreshResult>((resolve, reject) => {
        pending.push({ input, resolve, reject })
      })
    },
  }
  return { adapter, started, pending }
}

function resolvePending(pending: PendingCall[], paId: string, result: ProviderRefreshResult): void {
  const call = pending.find((p) => p.input.providerAccountId === paId)
  expect(call).toBeDefined()
  call!.resolve(result)
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

// --- Test 1: singleflight dedup ---

test("two concurrent refreshes for the same provider account share one provider call", async () => {
  const calls: ProviderRefreshInput[] = []
  const fake: ProviderAdapter = {
    type: "poe",
    async refresh(input) {
      calls.push(input)
      await flush()
      return okResult(input.providerAccountId, [balanceMetric(500)])
    },
  }
  const config = loadDashboardConfig({
    providers: [poeProvider("poe-main")],
    subscriptions: [{ id: "sub-main", name: "Main", providerId: "poe-main", metrics: [pointsMetric("points")] }],
    profiles: [{ id: "self", name: "Self", viewKey: "k", subscriptionIds: ["sub-main"] }],
  })
  const { storage } = spyStorage(makeStorage())
  const providers = new Map<string, ProviderAdapter>([["poe", fake], ["manual", { type: "manual", async refresh(i) { return okResult(i.providerAccountId, []) } }]])
  const svc = createRefreshService({ config, storage, providers, now: fixedNow })

  const [a, b] = await Promise.all([
    svc.refreshProfile({ profileId: "self", ip: "1.1.1.1" }),
    svc.refreshProfile({ profileId: "self", ip: "1.1.1.1" }),
  ])

  expect(calls).toHaveLength(1)
  expect(a.status).toBe("ok")
  expect(b.status).toBe("ok")
})

// --- Test 2: joined singleflight does not consume rate-limit token ---

test("a joined singleflight request does not consume a rate-limit token", async () => {
  const calls: ProviderRefreshInput[] = []
  const fake: ProviderAdapter = {
    type: "poe",
    async refresh(input) {
      calls.push(input)
      await flush()
      return okResult(input.providerAccountId, [balanceMetric(500)])
    },
  }
  const config = loadDashboardConfig({
    providers: [poeProvider("poe-main")],
    subscriptions: [{ id: "sub-main", name: "Main", providerId: "poe-main", metrics: [pointsMetric("points")] }],
    profiles: [{ id: "self", name: "Self", viewKey: "k", subscriptionIds: ["sub-main"] }],
  })
  const { storage } = spyStorage(makeStorage())
  const providers = new Map<string, ProviderAdapter>([["poe", fake], ["manual", { type: "manual", async refresh(i) { return okResult(i.providerAccountId, []) } }]])
  const limiter: RateLimiter = createRateLimiter({ maxAttempts: 1, windowMs: 30_000, now: () => NOW_MS })
  const svc = createRefreshService({ config, storage, providers, now: fixedNow, rateLimiter: limiter })

  await Promise.all([
    svc.refreshProfile({ profileId: "self", ip: "1.1.1.1" }),
    svc.refreshProfile({ profileId: "self", ip: "1.1.1.1" }),
  ])

  // Only the first (new) refresh consumed a token; the joined one did not.
  expect(limiter.count("1.1.1.1:self:poe-main")).toBe(1)
  expect(calls).toHaveLength(1)
})

// --- Test 3: concurrency cap 2 ---

test("three concurrent provider accounts with cap 2 do not start the third until one settles", async () => {
  const { adapter, started, pending } = controllableProvider("poe")
  const config = loadDashboardConfig({
    providers: [poeProvider("poe-a"), poeProvider("poe-b"), poeProvider("poe-c")],
    subscriptions: [
      { id: "sub-a", name: "A", providerId: "poe-a", metrics: [pointsMetric("points")] },
      { id: "sub-b", name: "B", providerId: "poe-b", metrics: [pointsMetric("points")] },
      { id: "sub-c", name: "C", providerId: "poe-c", metrics: [pointsMetric("points")] },
    ],
    profiles: [{ id: "all", name: "All", viewKey: "k", subscriptionIds: ["sub-a", "sub-b", "sub-c"] }],
  })
  const { storage } = spyStorage(makeStorage())
  const providers = new Map<string, ProviderAdapter>([["poe", adapter], ["manual", { type: "manual", async refresh(i) { return okResult(i.providerAccountId, []) } }]])
  const svc = createRefreshService({ config, storage, providers, now: fixedNow })

  const promise = svc.refreshProfile({ profileId: "all", ip: "1.1.1.1" })
  await flush()
  // Cap is 2: only two provider calls started.
  expect(started).toHaveLength(2)

  resolvePending(pending, started[0]!.providerAccountId, okResult(started[0]!.providerAccountId, [balanceMetric(1)]))
  await flush()
  // Third started after one settled.
  expect(started).toHaveLength(3)

  for (const s of started.slice(1)) {
    resolvePending(pending, s.providerAccountId, okResult(s.providerAccountId, [balanceMetric(s.providerAccountId === "poe-b" ? 2 : 3)]))
  }
  const outcome = await promise
  expect(outcome.status).toBe("ok")
})

// --- Test 4: undeclared provider metrics filtered before snapshot writes ---

test("undeclared provider metrics are filtered before snapshot writes", async () => {
  const fake: ProviderAdapter = {
    type: "poe",
    async refresh(input) {
      // Provider returns a declared metric ("points") and an undeclared one ("rogue").
      return okResult(input.providerAccountId, [
        balanceMetric(500),
        { providerMetricId: "rogue", label: "Rogue", unit: "x", remaining: 9, sourceValueKind: "gauge-remaining", sourceConfidence: "known" },
      ])
    },
  }
  const config = loadDashboardConfig({
    providers: [poeProvider("poe-main")],
    subscriptions: [{ id: "sub-main", name: "Main", providerId: "poe-main", metrics: [pointsMetric("points")] }],
    profiles: [{ id: "self", name: "Self", viewKey: "k", subscriptionIds: ["sub-main"] }],
  })
  const spy = spyStorage(makeStorage())
  const providers = new Map<string, ProviderAdapter>([["poe", fake], ["manual", { type: "manual", async refresh(i) { return okResult(i.providerAccountId, []) } }]])
  const svc = createRefreshService({ config, storage: spy.storage, providers, now: fixedNow })

  await svc.refreshProfile({ profileId: "self", ip: "1.1.1.1" })

  const rows = spy.snapshotInserts.flat()
  expect(rows.every((r) => r.metricId === "points")).toBe(true)
  expect(rows.some((r) => r.metricId === "rogue")).toBe(false)
})

// --- Test 5: cross-profile watermark collection ---

test("provider-account refresh includes metrics from hidden profiles before advancing nextImportState", async () => {
  const received: ProviderRefreshInput[] = []
  const fake: ProviderAdapter = {
    type: "poe",
    async refresh(input) {
      received.push(input)
      return okResult(input.providerAccountId, [balanceMetric(100)], [historyEvent("q1", 5)], {
        maxCreationTime: 1000,
        importedQueryIdsAtMaxCreationTime: ["q1"],
      })
    },
  }
  const config = loadDashboardConfig({
    providers: [poeProvider("poe-main")],
    subscriptions: [
      { id: "sub-visible", name: "Visible", providerId: "poe-main", metrics: [pointsMetric("vis-points")] },
      { id: "sub-hidden", name: "Hidden", providerId: "poe-main", metrics: [pointsMetric("hid-points")] },
    ],
    profiles: [
      { id: "self", name: "Self", viewKey: "k", subscriptionIds: ["sub-visible"] },
      { id: "other", name: "Other", viewKey: "k2", subscriptionIds: ["sub-hidden"] },
    ],
  })
  const spy = spyStorage(makeStorage())
  const providers = new Map<string, ProviderAdapter>([["poe", fake], ["manual", { type: "manual", async refresh(i) { return okResult(i.providerAccountId, []) } }]])
  const svc = createRefreshService({ config, storage: spy.storage, providers, now: fixedNow })

  await svc.refreshProfile({ profileId: "self", ip: "1.1.1.1" })

  // Adapter received metrics from BOTH visible and hidden subscriptions.
  expect(received).toHaveLength(1)
  const metricIds = received[0]!.metrics.map((m) => m.id)
  expect(metricIds).toContain("vis-points")
  expect(metricIds).toContain("hid-points")

  // importState advanced with watermark.
  expect(spy.importStateUpserts.some((r) => r.providerAccountId === "poe-main" && r.maxCreationTime === 1000)).toBe(true)
})

// --- Test 6: raw Poe history projected per configured usage filter ---

test("raw Poe history is projected per configured usage filter into metric-specific ProjectedHistoryEvent rows", async () => {
  const fake: ProviderAdapter = {
    type: "poe",
    async refresh(input) {
      return okResult(input.providerAccountId, [balanceMetric(500)], [
        historyEvent("api-1", 10, { usageType: "API" }),
        historyEvent("web-1", 20, { usageType: "WEB" }),
      ])
    },
  }
  const config = loadDashboardConfig({
    providers: [poeProvider("poe-main")],
    subscriptions: [
      {
        id: "sub-api",
        name: "API only",
        providerId: "poe-main",
        metrics: [
          { ...pointsMetric("api-points"), usageFilter: { usageTypes: ["API"] } },
          { ...pointsMetric("all-points"), providerMetricId: "points", usageFilter: { usageTypes: ["API", "WEB"] } },
        ],
      },
    ],
    profiles: [{ id: "self", name: "Self", viewKey: "k", subscriptionIds: ["sub-api"] }],
  })
  const spy = spyStorage(makeStorage())
  const providers = new Map<string, ProviderAdapter>([["poe", fake], ["manual", { type: "manual", async refresh(i) { return okResult(i.providerAccountId, []) } }]])
  const svc = createRefreshService({ config, storage: spy.storage, providers, now: fixedNow })

  await svc.refreshProfile({ profileId: "self", ip: "1.1.1.1" })

  const rows = spy.historyInserts.flat()
  // api-points metric: only API event.
  const apiRows = rows.filter((r) => r.metricKey.includes("api-points"))
  expect(apiRows.some((r) => r.providerEventId === "api-1")).toBe(true)
  expect(apiRows.some((r) => r.providerEventId === "web-1")).toBe(false)
  // all-points metric: both events.
  const allRows = rows.filter((r) => r.metricKey.includes("all-points"))
  expect(allRows.some((r) => r.providerEventId === "api-1")).toBe(true)
  expect(allRows.some((r) => r.providerEventId === "web-1")).toBe(true)
  // normalizedUsageFilter present.
  expect(allRows.every((r) => r.normalizedUsageFilter.includes("usageTypes="))).toBe(true)
})

// --- Test 7: nextImportState persisted inside transaction ---

test("nextImportState is persisted through importState.upsert inside storage.transaction", async () => {
  const fake: ProviderAdapter = {
    type: "poe",
    async refresh(input) {
      return okResult(input.providerAccountId, [balanceMetric(500)], [], {
        maxCreationTime: 42,
        importedQueryIdsAtMaxCreationTime: ["q1"],
      })
    },
  }
  const config = loadDashboardConfig({
    providers: [poeProvider("poe-main")],
    subscriptions: [{ id: "sub-main", name: "Main", providerId: "poe-main", metrics: [pointsMetric("points")] }],
    profiles: [{ id: "self", name: "Self", viewKey: "k", subscriptionIds: ["sub-main"] }],
  })
  const spy = spyStorage(makeStorage())
  const providers = new Map<string, ProviderAdapter>([["poe", fake], ["manual", { type: "manual", async refresh(i) { return okResult(i.providerAccountId, []) } }]])
  const svc = createRefreshService({ config, storage: spy.storage, providers, now: fixedNow })

  await svc.refreshProfile({ profileId: "self", ip: "1.1.1.1" })

  expect(spy.importStateUpserts.length).toBeGreaterThan(0)
  // Every importState.upsert happened inside a transaction.
  expect(spy.importStateInTx.every(Boolean)).toBe(true)
  expect(spy.importStateUpserts.some((r) => r.maxCreationTime === 42 && r.importedQueryIdsAtMaxCreationTime.includes("q1"))).toBe(true)
})

// --- Test 8: stale fallback on provider failure ---

test("returns stale cache with a safe error when provider refresh fails after cache exists", async () => {
  // Seed a stale cache.
  const base = makeStorage()
  base.providerCache.upsert({
    providerAccountId: "poe-main",
    fetchedAt: "2026-06-25T11:00:00.000Z",
    staleAfter: "2026-06-25T11:05:00.000Z",
    status: "stale",
    normalized: { metrics: [balanceMetric(300)] },
    errors: [],
  })
  const fake: ProviderAdapter = {
    type: "poe",
    async refresh() { throw new Error("Poe is down") },
  }
  const config = loadDashboardConfig({
    providers: [poeProvider("poe-main")],
    subscriptions: [{ id: "sub-main", name: "Main", providerId: "poe-main", metrics: [pointsMetric("points")] }],
    profiles: [{ id: "self", name: "Self", viewKey: "k", subscriptionIds: ["sub-main"] }],
  })
  const providers = new Map<string, ProviderAdapter>([["poe", fake], ["manual", { type: "manual", async refresh(i) { return okResult(i.providerAccountId, []) } }]])
  const svc = createRefreshService({ config, storage: base, providers, now: fixedNow })

  const outcome = await svc.refreshProfile({ profileId: "self", ip: "1.1.1.1" })
  expect(outcome.status).toBe("degraded")
  if (outcome.status === "degraded") {
    expect(outcome.error).toContain("down")
    expect(outcome.payload.subscriptions[0]?.metrics[0]?.remaining).toBe(300)
  }
})
