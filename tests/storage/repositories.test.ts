import { expect, test } from "bun:test"
import { openDashboardDatabase } from "../../src/server/storage/database"
import { createRepositories } from "../../src/server/storage/repositories"
import type {
  ImportStateRecord,
  ProjectedHistoryEvent,
  ProviderCacheRecord,
  SnapshotInsert,
} from "../../src/server/storage/repositories"
import type { DynamicSubscription } from "../../src/shared/domain"

function makeDb() {
  const db = openDashboardDatabase(":memory:")
  return createRepositories(db)
}

const baseProvider: ProviderCacheRecord = {
  providerAccountId: "poe/main",
  fetchedAt: "2026-01-01T00:00:00.000Z",
  staleAfter: "2026-01-01T00:05:00.000Z",
  status: "ok",
  normalized: { metrics: [{ id: "points", used: 10 }] },
  errors: [],
}

test("provider cache upsert then read by account id round-trips fields", () => {
  const repo = makeDb()
  repo.providerCache.upsert(baseProvider)
  const got = repo.providerCache.get("poe/main")
  expect(got).toEqual(baseProvider)
})

test("provider cache upsert overwrites prior record for same account id", () => {
  const repo = makeDb()
  repo.providerCache.upsert(baseProvider)
  const updated: ProviderCacheRecord = {
    ...baseProvider,
    status: "stale",
    normalized: { metrics: [{ id: "points", used: 99 }] },
    errors: [{ message: "rate limited", retryable: true }],
  }
  repo.providerCache.upsert(updated)
  expect(repo.providerCache.get("poe/main")).toEqual(updated)
})

test("provider cache preserves error list with retryable flag", () => {
  const repo = makeDb()
  const record: ProviderCacheRecord = {
    ...baseProvider,
    status: "unavailable",
    errors: [
      { message: "boom", retryable: false },
      { message: "again", retryable: true },
    ],
  }
  repo.providerCache.upsert(record)
  expect(repo.providerCache.get("poe/main")?.errors).toEqual(record.errors)
})

test("history events are idempotent by (provider_account_id, metric_key, provider_event_id)", () => {
  const repo = makeDb()
  const event: ProjectedHistoryEvent = {
    providerAccountId: "poe/main",
    metricKey: "poe%2Fmain/sub/points",
    providerMetricId: "points",
    normalizedUsageFilter: "{}",
    providerEventId: "evt-1",
    sourceTimestamp: "2026-01-01T00:00:00.000Z",
    value: 5,
    valueKind: "used",
    pageCursor: "page-0",
    rowIndex: 0,
  }
  repo.historyEvents.insertMany([event])
  repo.historyEvents.insertMany([{ ...event, value: 999 }])
  const got = repo.historyEvents.listForMetric(event.metricKey, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")
  expect(got).toHaveLength(1)
  expect(got[0]?.value).toBe(999)
})

test("history insertMany generates fallback event id when providerEventId missing", () => {
  const repo = makeDb()
  const metricKey = "poe%2Fmain/sub/points"
  const event: ProjectedHistoryEvent = {
    providerAccountId: "poe/main",
    metricKey,
    providerMetricId: "points",
    normalizedUsageFilter: "{}",
    sourceTimestamp: "2026-01-01T00:00:00.000Z",
    value: 7,
    valueKind: "used",
    pageCursor: "page-1",
    rowIndex: 3,
  }
  repo.historyEvents.insertMany([event])
  const got = repo.historyEvents.listForMetric(metricKey, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")
  expect(got).toHaveLength(1)
  expect(got[0]?.providerEventId).toBe("fallback:poe/main:poe%2Fmain/sub/points:2026-01-01T00:00:00.000Z:page-1:3")
})

test("history fallback event id keeps distinct rows per page cursor and row index", () => {
  const repo = makeDb()
  const metricKey = "poe%2Fmain/sub/points"
  const base: ProjectedHistoryEvent = {
    providerAccountId: "poe/main",
    metricKey,
    providerMetricId: "points",
    normalizedUsageFilter: "{}",
    sourceTimestamp: "2026-01-01T00:00:00.000Z",
    value: 1,
    valueKind: "used",
    pageCursor: "page-0",
    rowIndex: 0,
  }
  repo.historyEvents.insertMany([
    base,
    { ...base, pageCursor: "page-0", rowIndex: 1 },
    { ...base, pageCursor: "page-1", rowIndex: 0 },
  ])
  const got = repo.historyEvents.listForMetric(metricKey, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")
  expect(got).toHaveLength(3)
})

test("projected history stores providerMetricId and normalizedUsageFilter and returns them", () => {
  const repo = makeDb()
  const metricKey = "poe%2Fmain/sub/points"
  const event: ProjectedHistoryEvent = {
    providerAccountId: "poe/main",
    metricKey,
    providerMetricId: "special-points-id",
    normalizedUsageFilter: '{"usageTypes":["synthesis"]}',
    providerEventId: "evt-2",
    sourceTimestamp: "2026-01-01T00:00:00.000Z",
    value: 11,
    valueKind: "remaining",
    pageCursor: "page-0",
    rowIndex: 0,
    raw: { note: "raw" },
  }
  repo.historyEvents.insertMany([event])
  const got = repo.historyEvents.listForMetric(metricKey, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")
  expect(got[0]?.providerMetricId).toBe("special-points-id")
  expect(got[0]?.normalizedUsageFilter).toBe('{"usageTypes":["synthesis"]}')
  expect(got[0]?.raw).toEqual({ note: "raw" })
})

test("history listForMetric filters by metric key and time range inclusively", () => {
  const repo = makeDb()
  const metricKeyA = "poe%2Fmain/sub/points"
  const metricKeyB = "poe%2Fmain/sub/credits"
  const mk = (metricKey: string, ts: string, id: string): ProjectedHistoryEvent => ({
    providerAccountId: "poe/main",
    metricKey,
    providerMetricId: "x",
    normalizedUsageFilter: "{}",
    providerEventId: id,
    sourceTimestamp: ts,
    value: 1,
    valueKind: "used",
    pageCursor: "p",
    rowIndex: 0,
  })
  repo.historyEvents.insertMany([
    mk(metricKeyA, "2026-01-01T00:00:00.000Z", "a-1"),
    mk(metricKeyA, "2026-01-01T12:00:00.000Z", "a-2"),
    mk(metricKeyA, "2026-01-03T00:00:00.000Z", "a-3"),
    mk(metricKeyB, "2026-01-01T00:00:00.000Z", "b-1"),
  ])
  const got = repo.historyEvents.listForMetric(metricKeyA, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")
  expect(got.map((e) => e.providerEventId).sort()).toEqual(["a-1", "a-2"])
})

test("import state persists maxCreationTime and imported query ids and round-trips", () => {
  const repo = makeDb()
  const record: ImportStateRecord = {
    providerAccountId: "poe/main",
    maxCreationTime: 1700000000,
    importedQueryIdsAtMaxCreationTime: ["q-1", "q-2"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
  repo.importState.upsert(record)
  expect(repo.importState.get("poe/main")).toEqual(record)
})

test("import state upsert overwrites prior state for same account id", () => {
  const repo = makeDb()
  repo.importState.upsert({
    providerAccountId: "poe/main",
    maxCreationTime: 100,
    importedQueryIdsAtMaxCreationTime: ["q-old"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  })
  const next: ImportStateRecord = {
    providerAccountId: "poe/main",
    maxCreationTime: 200,
    importedQueryIdsAtMaxCreationTime: ["q-new"],
    updatedAt: "2026-01-02T00:00:00.000Z",
  }
  repo.importState.upsert(next)
  expect(repo.importState.get("poe/main")).toEqual(next)
})

test("import state returns undefined when no row", () => {
  const repo = makeDb()
  expect(repo.importState.get("missing")).toBeUndefined()
})

test("snapshots persist metricKey with source value kind and read back via listForMetric", () => {
  const repo = makeDb()
  const rows: SnapshotInsert[] = [
    {
      providerAccountId: "poe/main",
      subscriptionId: "sub",
      metricId: "points",
      metricKey: "poe%2Fmain/sub/points",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "provider",
      sourceValueKind: "counter",
      authoritativeValue: 100,
      used: 25,
      remaining: 75,
      limit: 100,
    },
    {
      providerAccountId: "poe/main",
      subscriptionId: "sub",
      metricId: "credits",
      metricKey: "poe%2Fmain/sub/credits",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "manual",
      sourceValueKind: "gauge-remaining",
      remaining: 5,
    },
  ]
  expect(() => repo.snapshots.insertMany(rows)).not.toThrow()
  const points = repo.snapshots.listForMetric("poe%2Fmain/sub/points", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")
  expect(points).toHaveLength(1)
  expect(points[0]?.authoritativeValue).toBe(100)
  expect(points[0]?.used).toBe(25)
  expect(points[0]?.remaining).toBe(75)
  expect(points[0]?.limit).toBe(100)
  expect(points[0]?.sourceValueKind).toBe("counter")
})

test("snapshots listForMetric filters by metric key and inclusive time range", () => {
  const repo = makeDb()
  const mk = (metricKey: string, ts: string, remaining: number): SnapshotInsert => ({
    providerAccountId: "poe/main",
    subscriptionId: "sub",
    metricId: metricKey.includes("credits") ? "credits" : "points",
    metricKey,
    timestamp: ts,
    source: "provider",
    sourceValueKind: "gauge-remaining",
    remaining,
  })
  repo.snapshots.insertMany([
    mk("poe%2Fmain/sub/points", "2026-01-01T00:00:00.000Z", 800),
    mk("poe%2Fmain/sub/points", "2026-01-01T12:00:00.000Z", 750),
    mk("poe%2Fmain/sub/points", "2026-01-03T00:00:00.000Z", 700),
    mk("poe%2Fmain/sub/credits", "2026-01-01T00:00:00.000Z", 5),
  ])
  // Inclusive bounds on points key; credits key excluded; out-of-range point excluded.
  const got = repo.snapshots.listForMetric("poe%2Fmain/sub/points", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")
  expect(got.map((s) => s.timestamp).sort()).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-01T12:00:00.000Z"])
  expect(got.every((s) => s.metricKey === "poe%2Fmain/sub/points")).toBe(true)
  // Empty for unknown key.
  expect(repo.snapshots.listForMetric("missing", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")).toEqual([])
})

test("refreshRuns insertStarted returns id and finish updates row", () => {
  const repo = makeDb()
  const id = repo.refreshRuns.insertStarted({
    startedAt: "2026-01-01T00:00:00.000Z",
    providerAccountIds: ["poe/main", "poe/other"],
  })
  expect(typeof id).toBe("number")
  expect(id).toBeGreaterThan(0)
  repo.refreshRuns.finish({
    id,
    finishedAt: "2026-01-01T00:00:01.000Z",
    status: "error",
    errors: [{ message: "partial failure" }],
  })
})

test("healthCheck returns true on live repository", () => {
  const repo = makeDb()
  expect(repo.healthCheck()).toBe(true)
})

test("transaction wraps multiple writes atomically and rolls back on throw", () => {
  const repo = makeDb()
  expect(() =>
    repo.transaction(() => {
      repo.providerCache.upsert(baseProvider)
      throw new Error("boom")
    }),
  ).toThrow()
  expect(repo.providerCache.get("poe/main")).toBeUndefined()
})

test("transaction commits when fn returns normally", () => {
  const repo = makeDb()
  repo.transaction(() => {
    repo.providerCache.upsert(baseProvider)
  })
  expect(repo.providerCache.get("poe/main")).toBeDefined()
})

const dynSubs: DynamicSubscription[] = [
  { id: "cliproxy:codex:abc123", name: "CLIProxy - Codex #1", providerMetricIds: ["codex:abc123:five_hour"], ui: { group: "CLIProxy" } },
]

test("providerCache round-trips dynamicSubscriptions", () => {
  const repo = makeDb()
  repo.providerCache.upsert({
    ...baseProvider,
    providerAccountId: "cp-1",
    dynamicSubscriptions: dynSubs,
  })
  const got = repo.providerCache.get("cp-1")
  expect(got?.dynamicSubscriptions).toEqual(dynSubs)
})

test("providerCache preserves dynamicSubscriptions when upsert omits them (coalesce)", () => {
  const repo = makeDb()
  repo.providerCache.upsert({
    ...baseProvider,
    providerAccountId: "cp-1",
    dynamicSubscriptions: dynSubs,
  })
  repo.providerCache.upsert({
    providerAccountId: "cp-1",
    fetchedAt: "2026-01-01T00:01:00Z",
    staleAfter: "2026-01-01T00:06:00Z",
    status: "stale",
    normalized: { metrics: [] },
    errors: [{ message: "failed", retryable: true }],
  })
  const got = repo.providerCache.get("cp-1")
  expect(got?.dynamicSubscriptions).toEqual(dynSubs)
  expect(got?.status).toBe("stale")
})

test("providerCache overwrites dynamicSubscriptions with empty array on success", () => {
  const repo = makeDb()
  repo.providerCache.upsert({
    ...baseProvider,
    providerAccountId: "cp-1",
    dynamicSubscriptions: dynSubs,
  })
  repo.providerCache.upsert({
    providerAccountId: "cp-1",
    fetchedAt: "2026-01-01T00:01:00Z",
    staleAfter: "2026-01-01T00:06:00Z",
    status: "ok",
    normalized: { metrics: [] },
    errors: [],
    dynamicSubscriptions: [],
  })
  const got = repo.providerCache.get("cp-1")
  expect(got?.dynamicSubscriptions).toEqual([])
})

test("providerCache null dynamic_subscriptions_json decodes as undefined", () => {
  const repo = makeDb()
  repo.providerCache.upsert({
    providerAccountId: "cp-1",
    fetchedAt: "2026-01-01T00:00:00Z",
    staleAfter: "2026-01-01T00:05:00Z",
    status: "ok",
    normalized: { metrics: [] },
    errors: [],
  })
  const got = repo.providerCache.get("cp-1")
  expect(got?.dynamicSubscriptions).toBeUndefined()
})
