# CLIProxyAPI Provider Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CLIProxyAPI provider adapter that discovers upstream accounts (Codex/Claude/Grok) at runtime and queries their real quota, rendering each account as a dynamic subscription.

**Architecture:** Adapter calls `GET /v0/management/auth-files` to discover accounts, then `POST /v0/management/api-call` per account with `$TOKEN$` substitution. Returns `dynamicSubscriptions[]` + `metrics[]`. Storage-first: `dynamicSubscriptions` persisted on `ProviderCacheRecord` via `coalesce` upsert (last-good preserved on failure). Projection merges static + dynamic.

**Tech Stack:** Bun, TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Hono, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-07-17-cliproxy-provider-design.md`

**Key decisions from adversarial reviews (K3 4-reviewer + my own):**
- Upsert uses `coalesce(excluded.dynamic_subscriptions_json, provider_cache.dynamic_subscriptions_json)` -- failure preserves old value
- Codex `reset_at` is Unix epoch seconds -> `new Date(reset_at * 1000).toISOString()`
- Codex window classified by `limit_window_seconds` (18000->5h, 604800->7d, 2592000->30d, other->skip), NOT hardcoded primary/secondary
- Claude `utilization` is 0-100, used directly (NO ×100)
- Grok: two endpoints (weekly+monthly) merged, 5 required headers
- `inferDisplayModule` honors `suggestedDisplayModule` first
- xai monthly percent: `used / monthly_limit * 100` (no Math.min cap)
- Storage uses existing `ProviderCacheRow` type + `decodeProviderCache` (NOT `db.prepare`)
- Config: `} else if (provider.type === "cliproxy") {` (not standalone `if`)
- SSRF: only `localhost`/`127.x`/`::1` exempted (NOT `::`)
- Failed accounts still produce DynamicSubscription with error metric; error also pushed to `result.errors[]` for badge escalation
- `dynamic` flag on `ProjectedMetric` for summary exclusion (NOT string prefix)
- Concurrency: cap 6, per-call AbortController 70s, overall deadline 120s, fast-fail on all-401 batch

---

## Task 1: Type definitions

**Files:**
- Modify: `src/shared/domain.ts`
- Modify: `src/server/providers/types.ts`

- [ ] **Step 1: Add types to domain.ts**

In `src/shared/domain.ts`, add to the `ProviderAccountConfig` union (after the volcengine variant):

```ts
  | { id: string; type: "cliproxy"; baseUrl: string; apiKeyEnv?: string | undefined; apiKey?: string | undefined; queryProviders?: string[] | undefined }
```

Add after `ProviderRuntimeState`:

```ts
export type DynamicSubscription = {
  id: string
  name: string
  providerMetricIds: string[]
  ui?: { color?: string; group?: string; sort?: number }
}
```

Change `ProfileConfig`:

```ts
export type ProfileConfig = { id: string; name: string; viewKey: string | undefined; subscriptionIds: string[]; dynamicProviderIds?: string[] }
```

- [ ] **Step 2: Add to ProviderRefreshResult**

In `src/server/providers/types.ts`, add import:

```ts
import type { DynamicSubscription } from "../../shared/domain"
```

Add field to `ProviderRefreshResult`:

```ts
  dynamicSubscriptions?: DynamicSubscription[]
```

- [ ] **Step 3: Run typecheck + commit**

Run: `bun run typecheck`
Expected: PASS

```bash
git add src/shared/domain.ts src/server/providers/types.ts
git commit -m "feat(types): add cliproxy ProviderAccountConfig, DynamicSubscription, dynamicProviderIds"
```

---

## Task 2: Storage migration + ProviderCacheRow extension

**Files:**
- Modify: `src/server/storage/schema.ts`
- Modify: `src/server/storage/repositories.ts`
- Test: `tests/storage/repositories.test.ts`

**CRITICAL: Use existing `ProviderCacheRow` type + `decodeProviderCache` pattern. Do NOT use `db.prepare` or `Record<string, unknown>` casts. The codebase uses `db.query<RowType, [ParamType]>(sql).get(...)`.**

- [ ] **Step 1: Write failing storage tests**

Create or append to `tests/storage/repositories.test.ts`:

```ts
import { expect, test } from "bun:test"
import { createRepositories } from "../../src/server/storage/repositories"
import type { DashboardDatabase } from "../../src/server/storage/database"
import type { DynamicSubscription } from "../../src/shared/domain"

// Minimal in-memory DB for testing (use the real better-sqlite3 via openDashboardDatabase)
import { openDashboardDatabase } from "../../src/server/storage/database"
import { join } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

function makeDb(): DashboardDatabase {
  const dir = mkdtempSync(join(tmpdir(), "cliproxy-test-"))
  return openDashboardDatabase(join(dir, "test.db"))
}

const dynSubs: DynamicSubscription[] = [
  { id: "cliproxy:codex:abc123", name: "CLIProxy - Codex #1", providerMetricIds: ["codex:abc123:five_hour"], ui: { group: "CLIProxy" } },
]

test("providerCache round-trips dynamicSubscriptions", () => {
  const db = makeDb()
  const storage = createRepositories(db)
  storage.providerCache.upsert({
    providerAccountId: "cp-1",
    fetchedAt: "2026-07-17T00:00:00Z",
    staleAfter: "2026-07-17T00:05:00Z",
    status: "ok",
    normalized: { metrics: [] },
    errors: [],
    dynamicSubscriptions: dynSubs,
  })
  const got = storage.providerCache.get("cp-1")
  expect(got?.dynamicSubscriptions).toEqual(dynSubs)
})

test("providerCache preserves dynamicSubscriptions when upsert omits them (coalesce)", () => {
  const db = makeDb()
  const storage = createRepositories(db)
  // First write with dynamicSubscriptions
  storage.providerCache.upsert({
    providerAccountId: "cp-1",
    fetchedAt: "2026-07-17T00:00:00Z",
    staleAfter: "2026-07-17T00:05:00Z",
    status: "ok",
    normalized: { metrics: [] },
    errors: [],
    dynamicSubscriptions: dynSubs,
  })
  // Second write WITHOUT dynamicSubscriptions (simulates adapter failure)
  storage.providerCache.upsert({
    providerAccountId: "cp-1",
    fetchedAt: "2026-07-17T00:01:00Z",
    staleAfter: "2026-07-17T00:06:00Z",
    status: "stale",
    normalized: { metrics: [] },
    errors: [{ message: "failed", retryable: true }],
  })
  // Should still have the old dynamicSubscriptions (coalesce)
  const got = storage.providerCache.get("cp-1")
  expect(got?.dynamicSubscriptions).toEqual(dynSubs)
  expect(got?.status).toBe("stale") // other fields updated
})

test("providerCache overwrites dynamicSubscriptions with empty array on success", () => {
  const db = makeDb()
  const storage = createRepositories(db)
  storage.providerCache.upsert({
    providerAccountId: "cp-1",
    fetchedAt: "2026-07-17T00:00:00Z",
    staleAfter: "2026-07-17T00:05:00Z",
    status: "ok",
    normalized: { metrics: [] },
    errors: [],
    dynamicSubscriptions: dynSubs,
  })
  // Overwrite with empty (0 accounts found -- valid success)
  storage.providerCache.upsert({
    providerAccountId: "cp-1",
    fetchedAt: "2026-07-17T00:01:00Z",
    staleAfter: "2026-07-17T00:06:00Z",
    status: "ok",
    normalized: { metrics: [] },
    errors: [],
    dynamicSubscriptions: [],
  })
  const got = storage.providerCache.get("cp-1")
  expect(got?.dynamicSubscriptions).toEqual([])
})

test("providerCache null dynamic_subscriptions_json decodes as undefined", () => {
  const db = makeDb()
  const storage = createRepositories(db)
  storage.providerCache.upsert({
    providerAccountId: "cp-1",
    fetchedAt: "2026-07-17T00:00:00Z",
    staleAfter: "2026-07-17T00:05:00Z",
    status: "ok",
    normalized: { metrics: [] },
    errors: [],
    // no dynamicSubscriptions -> undefined -> null in DB
  })
  const got = storage.providerCache.get("cp-1")
  expect(got?.dynamicSubscriptions).toBeUndefined()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/storage/repositories.test.ts`
Expected: FAIL (column doesn't exist / field doesn't exist)

- [ ] **Step 3: Add migration 6**

In `src/server/storage/schema.ts`, append to `MIGRATIONS`:

```ts
  {
    version: 6,
    sql: "ALTER TABLE provider_cache ADD COLUMN dynamic_subscriptions_json TEXT",
  },
```

- [ ] **Step 4: Extend ProviderCacheRow + decodeProviderCache**

In `src/server/storage/repositories.ts`, add `dynamic_subscriptions_json` to `ProviderCacheRow`:

```ts
type ProviderCacheRow = {
  provider_account_id: string
  fetched_at: string
  stale_after: string
  status: string
  normalized_json: string
  error_json: string | null
  dynamic_subscriptions_json: string | null  // NEW
}
```

Add `DynamicSubscription` import:

```ts
import type { DynamicSubscription } from "../../shared/domain"
```

Add `dynamicSubscriptions?` to `ProviderCacheRecord`:

```ts
export type ProviderCacheRecord = {
  providerAccountId: string
  fetchedAt: string
  staleAfter: string
  status: "ok" | "stale" | "unavailable"
  normalized: { metrics: Array<Record<string, unknown>> }
  errors: Array<{ message: string; retryable: boolean }>
  dynamicSubscriptions?: DynamicSubscription[]
}
```

Extend `decodeProviderCache`:

```ts
function decodeProviderCache(row: ProviderCacheRow): ProviderCacheRecord {
  const result: ProviderCacheRecord = {
    providerAccountId: row.provider_account_id,
    fetchedAt: row.fetched_at,
    staleAfter: row.stale_after,
    status: row.status as ProviderCacheRecord["status"],
    normalized: JSON.parse(row.normalized_json) as ProviderCacheRecord["normalized"],
    errors: row.error_json ? (JSON.parse(row.error_json) as ProviderCacheRecord["errors"]) : [],
  }
  if (row.dynamic_subscriptions_json !== null) {
    result.dynamicSubscriptions = JSON.parse(row.dynamic_subscriptions_json) as DynamicSubscription[]
  }
  return result
}
```

- [ ] **Step 5: Update upsert SQL with coalesce**

In the `upsert` function, change the SQL to include `dynamic_subscriptions_json` with `coalesce`:

```ts
    upsert(record) {
      const sql = [
        "insert into provider_cache(",
        "  provider_account_id, fetched_at, stale_after, status, normalized_json, error_json, dynamic_subscriptions_json",
        ") values (?, ?, ?, ?, ?, ?, ?)",
        "on conflict(provider_account_id) do update set",
        "  fetched_at = excluded.fetched_at,",
        "  stale_after = excluded.stale_after,",
        "  status = excluded.status,",
        "  normalized_json = excluded.normalized_json,",
        "  error_json = excluded.error_json,",
        "  dynamic_subscriptions_json = coalesce(excluded.dynamic_subscriptions_json, provider_cache.dynamic_subscriptions_json)",
      ].join("\n")
      db.query(sql).run(
        record.providerAccountId,
        record.fetchedAt,
        record.staleAfter,
        record.status,
        JSON.stringify(record.normalized),
        record.errors.length > 0 ? JSON.stringify(record.errors) : null,
        record.dynamicSubscriptions !== undefined ? JSON.stringify(record.dynamicSubscriptions) : null,
      )
    },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/storage/repositories.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 7: Run full test suite + typecheck**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/server/storage/schema.ts src/server/storage/repositories.ts tests/storage/repositories.test.ts
git commit -m "feat(storage): migration 6 + dynamic_subscriptions_json with coalesce (last-good preservation)"
```

---

## Task 3: Config loading - cliproxy branch + SSRF + validation

**Files:**
- Modify: `src/server/config/load-config.ts`
- Test: `tests/config/load-config.test.ts`

**CRITICAL: The cliproxy branch must be `} else if (provider.type === "cliproxy") {` -- NOT a standalone `if`. The existing chain is `if (volcengine) ... else if (API_KEY) ... else { manual }`. A standalone `if` would let cliproxy fall through to `else { manual }`, resetting providerRuntime.**

- [ ] **Step 1: Write failing tests**

Append to `tests/config/load-config.test.ts`:

```ts
test("cliproxy requires baseUrl", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "cp", type: "cliproxy" } as never],
    subscriptions: [],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: [] }],
  })).toThrow("baseUrl")
})

test("cliproxy accepts localhost baseUrl (SSRF loopback exemption)", () => {
  const config = loadDashboardConfig({
    providers: [{ id: "cp", type: "cliproxy", baseUrl: "http://localhost:8317", apiKey: "k" }],
    subscriptions: [],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: [] }],
  })
  expect(config.providerRuntime.get("cp")?.available).toBe(true)
  expect(config.providerRuntime.get("cp")?.apiKey).toBe("k")
})

test("cliproxy accepts 127.0.0.1 baseUrl", () => {
  const config = loadDashboardConfig({
    providers: [{ id: "cp", type: "cliproxy", baseUrl: "http://127.0.0.1:8317", apiKey: "k" }],
    subscriptions: [],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: [] }],
  })
  expect(config.providerRuntime.get("cp")?.available).toBe(true)
})

test("cliproxy rejects non-loopback private IP (SSRF)", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "cp", type: "cliproxy", baseUrl: "http://10.0.0.1:8317", apiKey: "k" }],
    subscriptions: [],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: [] }],
  })).toThrow("private")
})

test("cliproxy rejects :: (unspecified, not loopback)", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "cp", type: "cliproxy", baseUrl: "http://[::]:8317", apiKey: "k" }],
    subscriptions: [],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: [] }],
  })).toThrow("private")
})

test("cliproxy resolves apiKeyEnv", () => {
  process.env.CLIPROXY_TEST_KEY = "mgmt-secret"
  const config = loadDashboardConfig({
    providers: [{ id: "cp", type: "cliproxy", baseUrl: "http://localhost:8317", apiKeyEnv: "CLIPROXY_TEST_KEY" }],
    subscriptions: [],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: [] }],
  })
  expect(config.providerRuntime.get("cp")?.apiKey).toBe("mgmt-secret")
  delete process.env.CLIPROXY_TEST_KEY
})

test("dynamicProviderIds references unknown provider -> fail", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "cp", type: "cliproxy", baseUrl: "http://localhost:8317", apiKey: "k" }],
    subscriptions: [],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: [], dynamicProviderIds: ["nonexistent"] }],
  })).toThrow("nonexistent")
})

test("dynamicProviderIds references existing provider -> ok", () => {
  const config = loadDashboardConfig({
    providers: [{ id: "cp", type: "cliproxy", baseUrl: "http://localhost:8317", apiKey: "k" }],
    subscriptions: [],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: [], dynamicProviderIds: ["cp"] }],
  })
  expect(config.profiles.get("self")?.dynamicProviderIds).toEqual(["cp"])
})

test("cliproxy queryProviders validates known providers", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "cp", type: "cliproxy", baseUrl: "http://localhost:8317", apiKey: "k", queryProviders: ["codix"] }],
    subscriptions: [],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: [] }],
  })).toThrow("queryProviders")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/config/load-config.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement cliproxy branch**

In `src/server/config/load-config.ts`, add helpers:

```ts
function isLoopbackOnly(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|]$/g, "")
  if (h === "localhost") return true
  if (/^127\./.test(h)) return true
  if (h === "::1") return true
  // NOT :: (unspecified address -- should not be exempted)
  return false
}

function validateBaseUrlSkipLoopback(baseUrl: string, path: string): void {
  let parsed: URL
  try { parsed = new URL(baseUrl) } catch { fail(path, `baseUrl "${baseUrl}" is not a valid URL`) }
  const host = parsed.hostname.toLowerCase()
  if (isLoopbackOrPrivateHost(host) && !isLoopbackOnly(host)) {
    fail(path, `baseUrl host "${host}" is private (non-loopback)`)
  }
}
```

Add the cliproxy branch as an `else if` BEFORE the `API_KEY_PROVIDER_TYPES` check:

```ts
    } else if (provider.type === "cliproxy") {
      if (!provider.baseUrl || provider.baseUrl === "") {
        fail(`${providerPath}.baseUrl`, "cliproxy requires baseUrl")
      }
      validateBaseUrlSkipLoopback(provider.baseUrl, `${providerPath}.baseUrl`)
      if (provider.queryProviders !== undefined) {
        const knownProviders = new Set(["codex", "claude", "xai"])
        for (const qp of provider.queryProviders) {
          if (!knownProviders.has(qp)) {
            fail(`${providerPath}.queryProviders`, `unknown provider "${qp}"`)
          }
        }
      }
      const { apiKey, reason } = resolveBearerCredential(provider as { apiKeyEnv?: string | undefined; apiKey?: string | undefined })
      const state: ProviderRuntimeState = { available: apiKey !== undefined }
      if (apiKey !== undefined) state.apiKey = apiKey
      if (reason !== undefined) state.reason = reason
      providers.set(provider.id, provider)
      providerRuntime.set(provider.id, state)
    } else if (API_KEY_PROVIDER_TYPES.has(provider.type)) {
```

Add `dynamicProviderIds` validation in the profiles loop:

```ts
    for (const dynProviderId of profile.dynamicProviderIds ?? []) {
      if (!providers.has(dynProviderId)) {
        fail(
          `profiles[${profile.id}].dynamicProviderIds`,
          `references unknown provider "${dynProviderId}"`,
        )
      }
    }
```

- [ ] **Step 4: Run tests + typecheck + commit**

Run: `bun test tests/config/load-config.test.ts && bun run typecheck`
Expected: PASS

```bash
git add src/server/config/load-config.ts tests/config/load-config.test.ts
git commit -m "feat(config): cliproxy else-if branch + SSRF loopback exemption + queryProviders validation"
```

---

## Task 4: Projection - dynamic subscription branch

**Files:**
- Modify: `src/server/dashboard/project.ts`
- Test: `tests/dashboard/project.test.ts`

**CRITICAL:**
- Import `DisplayModule` (it's used by `inferDisplayModule` but NOT currently imported in project.ts)
- `inferDisplayModule` must honor `m.suggestedDisplayModule` first
- Test 3 must NOT set `cache: undefined` (exactOptionalPropertyTypes rejects explicit undefined on optional fields) -- omit the key entirely
- Summary exclusion uses a `dynamic` flag on `ProjectedMetric`, NOT `startsWith("cliproxy:")`

- [ ] **Step 1: Write failing tests**

Append to `tests/dashboard/project.test.ts`:

```ts
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
    name: "CLIProxy - Codex #1",
    providerMetricIds: ["codex:abc123:five_hour"],
    ui: { group: "CLIProxy" },
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
      }],
      cache: okCache,
    },
  ]
  const payload = buildDashboardPayload({
    config, profileId: "self", generatedAt: NOW,
    selectedRange: "24h", providers,
    dynamicSubscriptions: dynSubs,
  })
  expect(payload.subscriptions).toHaveLength(2)
  const dynSub = payload.subscriptions.find(s => s.id === "cliproxy:codex:abc123")!
  expect(dynSub.name).toBe("CLIProxy - Codex #1")
  expect(dynSub.metrics).toHaveLength(1)
  expect(dynSub.metrics[0]!.label).toBe("5h")
  expect(dynSub.metrics[0]!.used).toBe(72)
  expect(dynSub.metrics[0]!.display.module).toBe("rolling-window-card")
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/dashboard/project.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement dynamic subscription projection**

In `src/server/dashboard/project.ts`, update imports (ADD `DisplayModule` and `DynamicSubscription`):

```ts
import type {
  DisplayModule,
  DynamicSubscription,
  LimitWindow,
  MetricConfig,
  MetricStatus,
  NormalizedConfig,
  RangeKey,
  SourceValueKind,
} from "../../shared/domain"
```

Add `dynamic?: boolean` to `ProjectedMetric`:

```ts
export type ProjectedMetric = {
  // ... existing fields ...
  dynamic?: boolean
}
```

Add `dynamicProviderIds` and `dynamicSubscriptions` to `ProjectProviderMetricsInput`:

```ts
export type ProjectProviderMetricsInput = {
  config: NormalizedConfig
  subscriptionIds: string[]
  dynamicProviderIds?: string[]
  providers: Array<ProviderAccountProjection>
  snapshots?: Map<string, SnapshotPoint[]>
  storedHistory?: Map<string, ProjectedHistoryPoint[]>
  dynamicSubscriptions?: Map<string, DynamicSubscription[]>
  now: string
}
```

Add to `DashboardProjectionInput`:

```ts
export type DashboardProjectionInput = {
  config: NormalizedConfig
  profileId: string
  generatedAt: string
  selectedRange?: RangeKey
  providers: Array<ProviderAccountProjection>
  snapshots?: Map<string, SnapshotPoint[]>
  storedHistory?: Map<string, ProjectedHistoryPoint[]>
  dynamicSubscriptions?: Map<string, DynamicSubscription[]>
}
```

In `projectProviderMetrics`, after the existing `for (const subscriptionId of input.subscriptionIds)` loop, add:

```ts
  // --- dynamic subscriptions ---
  for (const providerId of input.dynamicProviderIds ?? []) {
    const providerAccount = input.config.providers.get(providerId)
    if (!providerAccount) continue
    const providerType = providerAccount.type
    const providerProjection = input.providers.find((p) => p.providerAccountId === providerId)
    const dynamicSubs = input.dynamicSubscriptions?.get(providerId) ?? []

    for (const dynSub of dynamicSubs) {
      for (const providerMetricId of dynSub.providerMetricIds) {
        const matchedMetric = providerProjection?.metrics.find(
          (m) => m.providerMetricId === providerMetricId,
        )
        if (!matchedMetric) continue

        const metricKey = buildMetricKey(providerId, dynSub.id, providerMetricId)
        const syntheticConfig = synthesizeMetricConfig(matchedMetric, providerMetricId)
        result.push({
          subscriptionId: dynSub.id,
          subscriptionName: dynSub.name,
          ...(dynSub.ui ? { subscriptionUi: dynSub.ui } : {}),
          metricId: providerMetricId,
          metricKey,
          providerAccountId: providerId,
          providerType,
          providerMetricId,
          config: syntheticConfig,
          providerMetric: matchedMetric,
          cache: providerProjection?.cache,
          resolvedUsageFilter: {},
          normalizedUsageFilter: "",
          projectedHistory: [],
          snapshots: input.snapshots?.get(metricKey) ?? [],
          dynamic: true,
        })
      }
    }
  }
```

Add helpers:

```ts
function synthesizeMetricConfig(m: NormalizedMetric, providerMetricId: string): MetricConfig {
  const config: MetricConfig = {
    id: providerMetricId,
    providerMetricId,
    label: m.label,
    unit: m.unit,
    sourceValueKind: m.sourceValueKind,
    display: { module: inferDisplayModule(m) },
  }
  if (m.notes !== undefined) config.notes = m.notes
  if (m.window !== undefined) config.window = m.window
  return config
}

function inferDisplayModule(m: NormalizedMetric): DisplayModule {
  if (m.suggestedDisplayModule !== undefined) return m.suggestedDisplayModule
  if (m.sourceValueKind === "status") return "manual-status-card"
  if (m.window?.kind === "rolling") return "rolling-window-card"
  if (m.window?.kind === "calendar" || m.window?.kind === "fixed") return "period-quota-card"
  return "balance-card"
}
```

In `buildDashboardPayload`, pass dynamic data:

```ts
  const profile = input.config.profiles.get(input.profileId)
  // ...
  const projected = projectProviderMetrics({
    config: input.config,
    subscriptionIds: profile.subscriptionIds,
    ...(profile.dynamicProviderIds ? { dynamicProviderIds: profile.dynamicProviderIds } : {}),
    providers: input.providers,
    now: input.generatedAt,
    ...(input.snapshots !== undefined ? { snapshots: input.snapshots } : {}),
    ...(input.storedHistory !== undefined ? { storedHistory: input.storedHistory } : {}),
    ...(input.dynamicSubscriptions !== undefined ? { dynamicSubscriptions: input.dynamicSubscriptions } : {}),
  })
```

In `buildDashboardPayload`, exclude dynamic metrics from summary:

```ts
  const summaryGroups = buildSummaryGroups(
    projected.filter(p => !p.dynamic),
    selectedRange,
    input.generatedAt,
  )
```

- [ ] **Step 4: Run tests + typecheck + commit**

Run: `bun test tests/dashboard/project.test.ts && bun run typecheck`
Expected: PASS

```bash
git add src/server/dashboard/project.ts tests/dashboard/project.test.ts
git commit -m "feat(projection): dynamic subscription branch + synthesizeMetricConfig + dynamic flag for summary"
```

---

## Task 5: Refresh service - visibility union + dynamic snapshots + storage loading

**Files:**
- Modify: `src/server/refresh/refresh-service.ts`
- Test: `tests/refresh/refresh-service.test.ts`

**CRITICAL: Read `tests/refresh/refresh-service.test.ts` first to learn the test harness pattern (likely `loadDashboardConfig` + `spyStorage` + `createRefreshService`). Write REAL tests, not placeholders.**

- [ ] **Step 1: Write failing test**

Read the existing test file first:
Run: `head -60 tests/refresh/refresh-service.test.ts`

Then write a test matching the existing harness. The key assertion: a cliproxy provider in `dynamicProviderIds` gets refreshed (adapter is called).

```ts
test("collectVisibleProviderAccounts includes dynamic providers", async () => {
  // Use the SAME harness pattern as existing tests in this file.
  // Create config with a cliproxy provider + dynamicProviderIds.
  // Create a fake adapter that records when refresh() is called.
  // Call refreshProfile.
  // Assert the fake adapter was called for BOTH the static provider AND cliproxy.
})
```

Also write tests for:
- Dynamic snapshots written after refresh
- `buildPayloadFromStorage` loads dynamic snapshots
- `dynamicSubscriptions` preserved on adapter failure (last-good via coalesce)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/refresh/refresh-service.test.ts`
Expected: FAIL

- [ ] **Step 3: Update collectVisibleProviderAccounts**

In `src/server/refresh/refresh-service.ts`, add `DynamicSubscription` import:

```ts
import type { DynamicSubscription } from "../../shared/domain"
```

Modify `collectVisibleProviderAccounts`:

```ts
  function collectVisibleProviderAccounts(profileId: string): string[] {
    const profile = config.profiles.get(profileId)
    if (!profile) return []
    const seen = new Set<string>()
    for (const subId of profile.subscriptionIds) {
      const sub = config.subscriptions.get(subId)
      if (sub) seen.add(sub.providerId)
    }
    for (const dynProviderId of profile.dynamicProviderIds ?? []) {
      seen.add(dynProviderId)
    }
    return Array.from(seen)
  }
```

- [ ] **Step 4: Update writeProviderResult for dynamic snapshots + dynamicSubscriptions on cacheRecord**

In `writeProviderResult`, after the existing `for (const { subscriptionId, metric } of subMetrics)` loop (after line ~245), add:

```ts
    // Dynamic subscription snapshots
    if (result.dynamicSubscriptions) {
      for (const dynSub of result.dynamicSubscriptions) {
        for (const providerMetricId of dynSub.providerMetricIds) {
          const matched = result.metrics.find((m) => m.providerMetricId === providerMetricId)
          if (!matched) continue
          const metricKey = buildMetricKey(paId, dynSub.id, providerMetricId)
          const snap: SnapshotInsert = {
            providerAccountId: paId,
            subscriptionId: dynSub.id,
            metricId: providerMetricId,
            metricKey,
            timestamp: tsIso,
            source: "provider",
            sourceValueKind: matched.sourceValueKind,
          }
          if (matched.authoritativeValue !== undefined) snap.authoritativeValue = matched.authoritativeValue
          if (matched.used !== undefined) snap.used = matched.used
          if (matched.remaining !== undefined) snap.remaining = matched.remaining
          if (matched.limit !== undefined) snap.limit = matched.limit
          snapshotRows.push(snap)
        }
      }
    }
```

Update `cacheRecord` construction (around line ~248):

```ts
    const cacheRecord: ProviderCacheRecord = {
      providerAccountId: paId,
      fetchedAt: result.fetchedAt,
      staleAfter: result.staleAfter,
      status: cacheStatus,
      normalized: { metrics: result.metrics as Array<Record<string, unknown>> },
      errors: result.errors ?? [],
      ...(result.dynamicSubscriptions !== undefined ? { dynamicSubscriptions: result.dynamicSubscriptions } : {}),
    }
```

**The coalesce in the upsert SQL (Task 2) handles the failure case**: when `result.dynamicSubscriptions` is undefined, `cacheRecord.dynamicSubscriptions` is omitted, `upsert` writes `null`, and `coalesce` preserves the old value.

- [ ] **Step 5: Update buildPayloadFromStorage for dynamic loading**

In `buildPayloadFromStorage`, after the existing `for (const subId of profile.subscriptionIds)` loop (after line ~397), add:

```ts
    // Load snapshots for dynamic subscriptions (history not needed -- adapter produces none)
    const dynamicSubscriptions = new Map<string, DynamicSubscription[]>()
    for (const dynProviderId of profile.dynamicProviderIds ?? []) {
      const cache = storage.providerCache.get(dynProviderId)
      const dynSubs = cache?.dynamicSubscriptions ?? []
      if (dynSubs.length > 0) {
        dynamicSubscriptions.set(dynProviderId, dynSubs)
      }
      for (const dynSub of dynSubs) {
        for (const providerMetricId of dynSub.providerMetricIds) {
          const metricKey = buildMetricKey(dynProviderId, dynSub.id, providerMetricId)
          const snapRows = storage.snapshots.listForMetric(metricKey, rangeStart, rangeEnd)
          if (snapRows.length > 0) {
            snapshots.set(metricKey, snapRows.map((s) => {
              const p: SnapshotPoint = { timestamp: s.timestamp, sourceValueKind: s.sourceValueKind }
              if (s.authoritativeValue !== undefined) p.authoritativeValue = s.authoritativeValue
              if (s.used !== undefined) p.used = s.used
              if (s.remaining !== undefined) p.remaining = s.remaining
              if (s.limit !== undefined) p.limit = s.limit
              return p
            }))
          }
        }
      }
    }
```

Update the `buildDashboardPayload` call:

```ts
    return buildDashboardPayload({
      config,
      profileId,
      generatedAt,
      selectedRange: range,
      providers: providerProjections,
      ...(storedHistory.size > 0 ? { storedHistory } : {}),
      ...(snapshots.size > 0 ? { snapshots } : {}),
      ...(dynamicSubscriptions.size > 0 ? { dynamicSubscriptions } : {}),
    })
```

- [ ] **Step 6: Run typecheck + tests + commit**

Run: `bun run typecheck && bun test`
Expected: PASS

```bash
git add src/server/refresh/refresh-service.ts tests/refresh/refresh-service.test.ts
git commit -m "feat(refresh): union dynamicProviderIds + dynamic snapshot write/read + coalesce preservation"
```

---

## Task 6: CLIProxyAPI adapter

**Files:**
- Create: `src/server/providers/cliproxy.ts`
- Test: `tests/providers/cliproxy.test.ts`

**Key implementation requirements:**
- Codex `reset_at` is Unix epoch seconds -> `new Date(reset_at * 1000).toISOString()`
- Codex window classified by `limit_window_seconds` (NOT hardcoded primary/secondary)
- Claude `utilization` is 0-100, used directly
- Grok: two endpoints (weekly `?format=credits` + monthly bare), 5 required headers, merge results
- xai monthly: `used / monthly_limit * 100` (NO Math.min cap)
- `inferDisplayModule` honors `suggestedDisplayModule` first
- Concurrency cap 6, per-call AbortController 70s, overall deadline 120s, fast-fail on all-401
- Failed accounts: error metric + push to `result.errors[]` for badge escalation
- api-call 502: check management HTTP status before parsing body

- [ ] **Step 1: Write failing tests**

Create `tests/providers/cliproxy.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createCliproxyProvider } from "../../src/server/providers/cliproxy"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

type FakeFetch = typeof fetch

const provider: ProviderAccountConfig = {
  id: "cp-1", type: "cliproxy",
  baseUrl: "http://localhost:8317", apiKey: "mgmt-key",
}
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id,
    provider,
    runtime: { available: true, apiKey: "mgmt-key" },
    now: NOW,
    metrics: [],
    ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

const AUTH_FILES_BODY = {
  files: [
    { auth_index: "abc123", provider: "codex", label: "alice@example.com", disabled: false, status: "active",
      id_token: { chatgpt_account_id: "acc_123", plan_type: "pro" } },
    { auth_index: "def456", provider: "claude", label: "claude@example.com", disabled: false, status: "active" },
    { auth_index: "ghi789", provider: "xai", label: "grok@example.com", disabled: false, status: "active" },
    { auth_index: "skip1", provider: "codex", disabled: true, status: "disabled" },
  ],
}

function makeCodexBody(): unknown {
  return {
    status_code: 200,
    body: JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 72, limit_window_seconds: 18000, reset_at: 1783275600 },
        secondary_window: { used_percent: 45, limit_window_seconds: 604800, reset_at: 1783880400 },
      },
    }),
  }
}

function makeClaudeBody(): unknown {
  return {
    status_code: 200,
    body: JSON.stringify({
      five_hour: { utilization: 65, resets_at: "2026-07-17T05:00:00Z" },
      seven_day: { utilization: 40, resets_at: "2026-07-24T00:00:00Z" },
    }),
  }
}

function makeXaiBody(): unknown {
  return {
    status_code: 200,
    body: JSON.stringify({
      config: {
        credit_usage_percent: 30,
        monthly_limit: { val: 1000 },
        used: { val: 200 },
        on_demand_cap: { val: 500 },
        on_demand_used: { val: 100 },
        current_period: { type: "weekly", end: "2026-07-24T00:00:00Z" },
        billing_period_end: "2026-08-01T00:00:00Z",
      },
    }),
  }
}

function makeFakeFetch(codexBody = makeCodexBody(), claudeBody = makeClaudeBody(), xaiBody = makeXaiBody()) {
  const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) return makeResp(200, AUTH_FILES_BODY)
    if (url.includes("/api-call")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
      if (body.auth_index === "abc123") return makeResp(200, codexBody)
      if (body.auth_index === "def456") return makeResp(200, claudeBody)
      if (body.auth_index === "ghi789") return makeResp(200, xaiBody)
      return makeResp(200, { status_code: 500, body: "{}" })
    }
    return makeResp(404, {})
  }
  return raw as unknown as FakeFetch
}

test("discovers accounts, filters by provider, skips disabled", async () => {
  const fetchImpl = makeFakeFetch()
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  expect(result.dynamicSubscriptions).toBeDefined()
  expect(result.dynamicSubscriptions!.length).toBe(3) // skip1 filtered
})

test("codex: reset_at converted from Unix seconds to ISO", async () => {
  const fetchImpl = makeFakeFetch()
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  const codex5h = result.metrics.find(m => m.providerMetricId === "codex:abc123:five_hour")!
  expect(codex5h.used).toBe(72)
  expect(codex5h.limit).toBe(100)
  // 1783275600 seconds -> 2026-07-04T07:00:00.000Z
  expect(codex5h.window?.resetAt).toBe("2026-07-04T07:00:00.000Z")
})

test("codex: window classified by limit_window_seconds", async () => {
  // Free plan with 30-day secondary window
  const freeBody = {
    status_code: 200,
    body: JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 80, limit_window_seconds: 18000, reset_at: 1783275600 },
        secondary_window: { used_percent: 30, limit_window_seconds: 2592000, reset_at: 1785850800 },
      },
    }),
  }
  const fetchImpl = makeFakeFetch(freeBody)
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  // primary -> five_hour (18000), secondary -> monthly (2592000), NOT weekly
  const fiveHour = result.metrics.find(m => m.providerMetricId === "codex:abc123:five_hour")!
  expect(fiveHour.window?.duration).toBe("5h")
  const monthly = result.metrics.find(m => m.providerMetricId === "codex:abc123:monthly")!
  expect(monthly).toBeDefined()
  expect(monthly.window?.duration).toBe("30d")
})

test("claude: utilization used directly (NOT x100)", async () => {
  const fetchImpl = makeFakeFetch()
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  const claude5h = result.metrics.find(m => m.providerMetricId === "claude:def456:five_hour")!
  expect(claude5h.used).toBe(65) // NOT 6500
  expect(claude5h.limit).toBe(100)
})

test("xai: two endpoints merged, monthly percent not capped", async () => {
  // overage: used=1500, monthly_limit=1000 -> 150%
  const xaiOverage = {
    status_code: 200,
    body: JSON.stringify({
      config: {
        credit_usage_percent: 80,
        monthly_limit: { val: 1000 },
        used: { val: 1500 },
        on_demand_cap: { val: 500 },
        on_demand_used: { val: 200 },
        current_period: { type: "weekly", end: "2026-07-24T00:00:00Z" },
        billing_period_end: "2026-08-01T00:00:00Z",
      },
    }),
  }
  const fetchImpl = makeFakeFetch(makeCodexBody(), makeClaudeBody(), xaiOverage)
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  const monthly = result.metrics.find(m => m.providerMetricId === "xai:ghi789:monthly")!
  expect(monthly.used).toBe(150) // 1500/1000*100, NOT capped at 100
})

test("xai: weekly and on_demand metrics produced", async () => {
  const fetchImpl = makeFakeFetch()
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  const weekly = result.metrics.find(m => m.providerMetricId === "xai:ghi789:weekly")!
  expect(weekly.used).toBe(30)
  const onDemand = result.metrics.find(m => m.providerMetricId === "xai:ghi789:on_demand")!
  expect(onDemand.used).toBe(20) // 100/500*100
})

test("xai: required headers sent", async () => {
  const calls: Record<string, Record<string, string>> = {}
  const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) return makeResp(200, AUTH_FILES_BODY)
    if (url.includes("/api-call")) {
      const body = JSON.parse(init?.body as string)
      if (body.auth_index === "ghi789") {
        calls.xai = body.header
        // Return both weekly and monthly with same body
        return makeResp(200, makeXaiBody())
      }
      return makeResp(200, { status_code: 200, body: "{}" })
    }
    return makeResp(404, {})
  }
  await createCliproxyProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(calls.xai!["x-xai-token-auth"]).toBe("xai-grok-cli")
  expect(calls.xai!["x-grok-client-version"]).toBe("0.2.101")
  expect(calls.xai!["User-Agent"]).toContain("grok-pager")
})

test("failed accounts produce error metric + push to errors[] for badge escalation", async () => {
  const fetchImpl = makeFakeFetch(
    { status_code: 401, body: "{}" }, // codex upstream 401
    makeClaudeBody(),
    makeXaiBody(),
  )
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  // Codex account has error metric
  const codexError = result.metrics.find(m => m.providerMetricId === "codex:abc123:error")
  expect(codexError).toBeDefined()
  expect(codexError!.sourceValueKind).toBe("status")
  expect(codexError!.notes).toContain("auth")
  // Error pushed to result.errors[] for subscription badge escalation
  expect(result.errors).toBeDefined()
  expect(result.errors!.length).toBeGreaterThan(0)
})

test("does not skip unavailable accounts (quota exceeded = most important)", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) {
      return makeResp(200, {
        files: [{
          auth_index: "jkl012", provider: "codex",
          disabled: false, status: "active", unavailable: true,
          id_token: { chatgpt_account_id: "acc_456" },
        }],
      })
    }
    return makeResp(200, makeCodexBody())
  }
  const result = await createCliproxyProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.dynamicSubscriptions!.length).toBe(1)
  expect(result.metrics.find(m => m.providerMetricId === "codex:jkl012:five_hour")).toBeDefined()
})

test("auth-files 404 -> non-retryable 'management API not enabled'", async () => {
  const fetchImpl = async (): Promise<Response> => makeResp(404, {})
  const result = await createCliproxyProvider(fetchImpl as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.errors![0]!.message).toContain("not enabled")
})

test("auth-files 401 -> non-retryable auth error", async () => {
  const fetchImpl = async (): Promise<Response> => makeResp(401, {})
  const result = await createCliproxyProvider(fetchImpl as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.errors![0]!.message).toContain("authentication failed")
})

test("api-call 502 -> retryable error for that account", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) return makeResp(200, AUTH_FILES_BODY)
    return makeResp(502, { error: "request failed" })
  }
  const result = await createCliproxyProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.dynamicSubscriptions!.length).toBe(3) // still produced
  const errorMetrics = result.metrics.filter(m => m.sourceValueKind === "status")
  expect(errorMetrics.length).toBe(3) // all accounts failed
})

test("api-call 400 'auth token not found' -> account error with stale auth_index note", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) return makeResp(200, AUTH_FILES_BODY)
    return makeResp(400, { error: "auth token not found" })
  }
  const result = await createCliproxyProvider(raw as unknown as FakeFetch).refresh(buildInput())
  const codexError = result.metrics.find(m => m.providerMetricId === "codex:abc123:error")
  expect(codexError!.notes).toContain("stale")
})

test("management key missing -> unavailable", async () => {
  const result = await createCliproxyProvider().refresh(buildInput({
    runtime: { available: false, reason: "no key" },
  }))
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.retryable).toBe(false)
})

test("codex 429 -> classified as upstream error (not parse error)", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) return makeResp(200, AUTH_FILES_BODY)
    const body = typeof (await new Response(input).text().catch(() => "")) === "string" ? {} : {}
    return makeResp(200, { status_code: 429, body: '{"error":"rate limited"}' })
  }
  const result = await createCliproxyProvider(raw as unknown as FakeFetch).refresh(buildInput())
  const codexError = result.metrics.find(m => m.providerMetricId === "codex:abc123:error")
  expect(codexError).toBeDefined()
  expect(codexError!.notes).toContain("429")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/providers/cliproxy.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

Create `src/server/providers/cliproxy.ts`:

```ts
import type { DynamicSubscription } from "../../shared/domain"
import type {
  NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult,
} from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// CLIProxyAPI adapter.
// GET /v0/management/auth-files -> discover accounts
// POST /v0/management/api-call -> query upstream quota with $TOKEN$ substitution
// Sources: cc-switch subscription.rs (Codex/Claude), CPAMP xai_probe.go (Grok)

const DEFAULT_QUERY_PROVIDERS = ["codex", "claude", "xai"]
const API_CALL_CONCURRENCY = 6
const PER_CALL_TIMEOUT_MS = 70_000
const OVERALL_DEADLINE_MS = 120_000

type CliproxyProvider = {
  id: string; type: "cliproxy"; baseUrl: string
  apiKeyEnv?: string | undefined; apiKey?: string | undefined; queryProviders?: string[] | undefined
}

type AuthFileEntry = {
  auth_index?: string
  provider?: string
  label?: string
  disabled?: boolean
  unavailable?: boolean
  status?: string
  id_token?: { chatgpt_account_id?: string; plan_type?: string }
}

type FilteredAccount = {
  provider: string
  authIndex: string
  label?: string
  idToken?: { chatgpt_account_id?: string; plan_type?: string }
}

export function createCliproxyProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "cliproxy",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 5 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "CLIProxyAPI provider unavailable: management key not configured", retryable: false }] }
      }

      const providerConfig = input.provider as CliproxyProvider
      const baseUrl = providerConfig.baseUrl.replace(/\/$/, "")
      const queryProviders = providerConfig.queryProviders ?? DEFAULT_QUERY_PROVIDERS
      const deadline = Date.now() + OVERALL_DEADLINE_MS
      const deadlineController = new AbortController()
      const deadlineTimer = setTimeout(() => deadlineController.abort(), OVERALL_DEADLINE_MS)

      // 1) Discover accounts
      let authFiles: AuthFileEntry[]
      const mgmtHeaders = new Headers()
      mgmtHeaders.set("Authorization", `Bearer ${apiKey}`)
      mgmtHeaders.set("Accept", "application/json")

      try {
        const res = await fetchImpl(`${baseUrl}/v0/management/auth-files`, {
          method: "GET", headers: mgmtHeaders, signal: deadlineController.signal,
        })
        if (res.status === 404) {
          clearTimeout(deadlineTimer)
          return { ...base, errors: [{ message: "CLIProxyAPI management API not enabled. Set MANAGEMENT_PASSWORD or remote-management.secret-key.", retryable: false }] }
        }
        if (res.status === 401 || res.status === 403) {
          clearTimeout(deadlineTimer)
          return { ...base, errors: [authError("CLIProxyAPI authentication failed")] }
        }
        if (!res.ok) {
          clearTimeout(deadlineTimer)
          return { ...base, errors: [{ message: `CLIProxyAPI auth-files request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        const body = (await res.json()) as { files?: AuthFileEntry[] }
        authFiles = Array.isArray(body.files) ? body.files : []
      } catch {
        clearTimeout(deadlineTimer)
        return { ...base, errors: [{ message: "CLIProxyAPI auth-files network error", retryable: true }] }
      }

      // Filter accounts
      const accounts: FilteredAccount[] = authFiles.flatMap((a): FilteredAccount[] => {
        if (!a.provider || !queryProviders.includes(a.provider)) return []
        if (a.disabled === true) return []
        if (a.status !== undefined && a.status !== "active") return []
        if (!a.auth_index || a.auth_index === "") return []
        // Do NOT skip unavailable (quota exceeded = most important to show)
        return [{
          provider: a.provider,
          authIndex: a.auth_index,
          ...(a.label !== undefined ? { label: a.label } : {}),
          ...(a.id_token !== undefined ? { idToken: a.id_token } : {}),
        }]
      })

      // 2) Fan out api-call per account (concurrency-capped, with deadline + fast-fail)
      const metrics: NormalizedMetric[] = []
      const dynamicSubscriptions: DynamicSubscription[] = []
      const adapterErrors: Array<{ message: string; retryable: boolean }> = []

      for (let i = 0; i < accounts.length; i += API_CALL_CONCURRENCY) {
        if (Date.now() >= deadline) break
        const batch = accounts.slice(i, i + API_CALL_CONCURRENCY)
        const results = await Promise.allSettled(
          batch.map((acct) => queryAccountWithTimeout(fetchImpl, baseUrl, apiKey, acct, deadlineController.signal)),
        )

        // Fast-fail: if entire batch returned auth errors, abort remaining
        const batchResults = results.map(r => r.status === "fulfilled" ? r.value : { metrics: [] as NormalizedMetric[], error: "request failed" })
        const allAuthFailed = batchResults.every(r =>
          r.error !== undefined && (r.error.includes("auth") || r.error.includes("authentication"))
        )
        if (allAuthFailed && i + API_CALL_CONCURRENCY < accounts.length) {
          adapterErrors.push({ message: "All api-call requests in batch failed authentication; aborting remaining", retryable: false })
          break
        }

        for (let j = 0; j < batchResults.length; j++) {
          const acct = batch[j]!
          const r = batchResults[j]!
          const accountMetrics: NormalizedMetric[] = []
          accountMetrics.push(...r.metrics)
          if (r.error) {
            const errorMetric = makeErrorMetric(acct.provider, acct.authIndex, r.error)
            accountMetrics.push(errorMetric)
            // Push to adapter errors for subscription badge escalation
            adapterErrors.push({ message: `${acct.provider}:${acct.authIndex}: ${r.error}`, retryable: !r.error.includes("auth") })
          }
          metrics.push(...accountMetrics)
          dynamicSubscriptions.push({
            id: `cliproxy:${acct.provider}:${acct.authIndex}`,
            name: acct.label ? `CLIProxy - ${acct.label}` : `CLIProxy - ${acct.provider} #${acct.authIndex.slice(0, 8)}`,
            providerMetricIds: accountMetrics.map(m => m.providerMetricId),
            ui: { group: "CLIProxy" },
          })
        }
      }

      clearTimeout(deadlineTimer)
      return { ...base, metrics, dynamicSubscriptions, ...(adapterErrors.length > 0 ? { errors: adapterErrors } : {}) }
    },
  }
}

type AccountQueryResult = { metrics: NormalizedMetric[]; error?: string }

async function queryAccountWithTimeout(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, acct: FilteredAccount, parentSignal: AbortSignal,
): Promise<AccountQueryResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS)
  // Link to parent deadline
  parentSignal.addEventListener("abort", () => controller.abort(), { once: true })
  try {
    return await queryAccount(fetchImpl, baseUrl, mgmtKey, acct, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function queryAccount(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, acct: FilteredAccount, signal: AbortSignal,
): Promise<AccountQueryResult> {
  if (acct.provider === "codex") {
    return queryCodex(fetchImpl, baseUrl, mgmtKey, acct.authIndex, acct.idToken?.chatgpt_account_id, signal)
  } else if (acct.provider === "claude") {
    return queryClaude(fetchImpl, baseUrl, mgmtKey, acct.authIndex, signal)
  } else if (acct.provider === "xai") {
    return queryXai(fetchImpl, baseUrl, mgmtKey, acct.authIndex, signal)
  }
  return { metrics: [], error: `unknown provider: ${acct.provider}` }
}

async function apiCall(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string,
  authIndex: string, method: string, url: string, headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ ok: true; statusCode: number; body: string } | { ok: false; error: string; retryable: boolean }> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/v0/management/api-call`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${mgmtKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ auth_index: authIndex, method, url, header: headers }),
      signal,
    })
  } catch {
    return { ok: false, error: "network error", retryable: true }
  }
  // Management API HTTP status determines error type
  if (res.status === 502) {
    return { ok: false, error: "api-call transport failure", retryable: true }
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    return { ok: false, error: body.error ?? "api-call bad request (stale auth_index?)", retryable: false }
  }
  if (!res.ok) {
    return { ok: false, error: `api-call failed (${res.status})`, retryable: isRetryableStatus(res.status) }
  }
  const body = await res.json() as { status_code?: number; body?: string; error?: string }
  if (body.error !== undefined) {
    return { ok: false, error: body.error, retryable: false }
  }
  return { ok: true, statusCode: body.status_code ?? 0, body: body.body ?? "" }
}

async function queryCodex(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, authIndex: string, accountId: string | undefined, signal: AbortSignal,
): Promise<AccountQueryResult> {
  const headers: Record<string, string> = {
    "Authorization": "Bearer $TOKEN$",
    "User-Agent": "codex-cli",
    "Accept": "application/json",
  }
  if (accountId !== undefined) headers["ChatGPT-Account-Id"] = accountId

  const result = await apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
    "https://chatgpt.com/backend-api/wham/usage", headers, signal)
  if (!result.ok) return { metrics: [], error: result.error }

  if (result.statusCode === 401 || result.statusCode === 403) {
    return { metrics: [], error: "upstream auth failed (possible stale auth_index)" }
  }
  if (result.statusCode === 429) {
    return { metrics: [], error: "upstream rate limited (429)" }
  }
  if (result.statusCode >= 500) {
    return { metrics: [], error: `upstream error (${result.statusCode})` }
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return { metrics: [], error: `upstream error (${result.statusCode})` }
  }

  try {
    const parsed = JSON.parse(result.body) as {
      rate_limit?: Record<string, { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown } | undefined>
    }
    const metrics: NormalizedMetric[] = []
    const rl = parsed.rate_limit ?? {}
    for (const window of Object.values(rl)) {
      if (!window) continue
      const used = parseNumber(window.used_percent)
      const limitWindowSeconds = parseNumber(window.limit_window_seconds)
      if (used === undefined || limitWindowSeconds === undefined) continue

      // Classify by limit_window_seconds (NOT hardcoded primary/secondary)
      let name: string
      let duration: string
      if (limitWindowSeconds === 18000) { name = "five_hour"; duration = "5h" }
      else if (limitWindowSeconds === 604800) { name = "weekly"; duration = "7d" }
      else if (limitWindowSeconds === 2592000) { name = "monthly"; duration = "30d" }
      else continue // unknown window size -> skip

      // reset_at is Unix epoch seconds (NOT ISO string)
      const resetAt = typeof window.reset_at === "number"
        ? new Date(window.reset_at * 1000).toISOString()
        : undefined

      metrics.push({
        providerMetricId: `codex:${authIndex}:${name}`,
        label: name === "five_hour" ? "5h" : name === "weekly" ? "Weekly" : "Monthly",
        unit: "%",
        used,
        limit: 100,
        sourceValueKind: "gauge-used",
        sourceConfidence: "known",
        ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration, resetAt } } : {}),
      })
    }
    return { metrics }
  } catch {
    return { metrics: [], error: "parse error" }
  }
}

async function queryClaude(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, authIndex: string, signal: AbortSignal,
): Promise<AccountQueryResult> {
  const headers: Record<string, string> = {
    "Authorization": "Bearer $TOKEN$",
    "anthropic-beta": "oauth-2025-04-20",
    "Accept": "application/json",
  }

  const result = await apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
    "https://api.anthropic.com/api/oauth/usage", headers, signal)
  if (!result.ok) return { metrics: [], error: result.error }

  if (result.statusCode === 401 || result.statusCode === 403) {
    return { metrics: [], error: "upstream auth failed (possible stale auth_index)" }
  }
  if (result.statusCode === 429) {
    return { metrics: [], error: "upstream rate limited (429)" }
  }
  if (result.statusCode >= 500) {
    return { metrics: [], error: `upstream error (${result.statusCode})` }
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return { metrics: [], error: `upstream error (${result.statusCode})` }
  }

  try {
    const parsed = JSON.parse(result.body) as Record<string, unknown>
    const metrics: NormalizedMetric[] = []
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "extra_usage") continue
      if (typeof value !== "object" || value === null) continue
      const win = value as { utilization?: unknown; resets_at?: unknown }
      const used = parseNumber(win.utilization)
      if (used === undefined) continue
      // utilization is 0-100, used directly (do NOT multiply by 100)
      const resetAt = typeof win.resets_at === "string" ? win.resets_at : undefined
      const duration = key.startsWith("five_hour") ? "5h" : "7d"
      metrics.push({
        providerMetricId: `claude:${authIndex}:${key}`,
        label: key.replace(/_/g, " "),
        unit: "%",
        used,
        limit: 100,
        sourceValueKind: "gauge-used",
        sourceConfidence: "known",
        ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration, resetAt } } : {}),
      })
    }
    return { metrics }
  } catch {
    return { metrics: [], error: "parse error" }
  }
}

async function queryXai(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, authIndex: string, signal: AbortSignal,
): Promise<AccountQueryResult> {
  const headers: Record<string, string> = {
    "Authorization": "Bearer $TOKEN$",
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": "0.2.101",
    "User-Agent": "grok-pager/0.2.101 grok-shell/0.2.101 (macos; aarch64)",
    "Accept": "*/*",
  }

  // Query both weekly and monthly endpoints, merge results
  const [weeklyResult, monthlyResult] = await Promise.all([
    apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits", headers, signal),
    apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
      "https://cli-chat-proxy.grok.com/v1/billing", headers, signal),
  ])

  const metrics: NormalizedMetric[] = []
  let weeklyConfig: Record<string, unknown> | undefined
  let monthlyConfig: Record<string, unknown> | undefined

  if (weeklyResult.ok && weeklyResult.statusCode >= 200 && weeklyResult.statusCode < 300) {
    try {
      const parsed = JSON.parse(weeklyResult.body) as { config?: Record<string, unknown> }
      weeklyConfig = parsed.config
    } catch { /* handled below */ }
  }
  if (monthlyResult.ok && monthlyResult.statusCode >= 200 && monthlyResult.statusCode < 300) {
    try {
      const parsed = JSON.parse(monthlyResult.body) as { config?: Record<string, unknown> }
      monthlyConfig = parsed.config
    } catch { /* handled below */ }
  }

  // Weekly data from weekly endpoint
  const config = weeklyConfig ?? monthlyConfig
  if (!config) {
    const err = !weeklyResult.ok ? weeklyResult.error
      : !monthlyResult.ok ? monthlyResult.error
      : "no billing data"
    return { metrics: [], error: err }
  }

  // Weekly: credit_usage_percent
  const weeklyUsed = parseNumber(config["credit_usage_percent"])
  if (weeklyUsed !== undefined) {
    const period = config["current_period"] as Record<string, unknown> | undefined
    const periodEnd = typeof period?.["end"] === "string" ? period["end"] as string : undefined
    metrics.push({
      providerMetricId: `xai:${authIndex}:weekly`,
      label: "Weekly",
      unit: "%",
      used: weeklyUsed,
      limit: 100,
      sourceValueKind: "gauge-used",
      sourceConfidence: "known",
      ...(periodEnd !== undefined ? { window: { kind: "rolling" as const, duration: "7d", resetAt: periodEnd } } : {}),
    })
  }

  // Monthly: merge from monthlyConfig if available, fallback to weekly config
  const monthlyCfg = monthlyConfig ?? config
  const monthlyLimit = readXaiCents(monthlyCfg, "monthly_limit", "monthlyLimit")
  const used = readXaiCents(monthlyCfg, "used")
  const onDemandCap = readXaiCents(monthlyCfg, "on_demand_cap", "onDemandCap")
  const onDemandUsed = readXaiCents(monthlyCfg, "on_demand_used", "onDemandUsed")
  const billingPeriodEnd = typeof monthlyCfg["billing_period_end"] === "string" ? monthlyCfg["billing_period_end"] as string : undefined

  if (monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined) {
    // NO Math.min cap -- overage >100% is meaningful
    const monthlyUsedPercent = (used / monthlyLimit) * 100
    metrics.push({
      providerMetricId: `xai:${authIndex}:monthly`,
      label: "Monthly",
      unit: "%",
      used: monthlyUsedPercent,
      limit: 100,
      sourceValueKind: "gauge-used",
      sourceConfidence: "known",
      ...(billingPeriodEnd !== undefined ? { window: { kind: "rolling" as const, duration: "30d", resetAt: billingPeriodEnd } } : {}),
    })
  }

  if (onDemandCap !== undefined && onDemandCap > 0 && onDemandUsed !== undefined) {
    const onDemandPercent = (onDemandUsed / onDemandCap) * 100
    metrics.push({
      providerMetricId: `xai:${authIndex}:on_demand`,
      label: "On-demand",
      unit: "%",
      used: onDemandPercent,
      limit: 100,
      sourceValueKind: "gauge-used",
      sourceConfidence: "known",
    })
  }

  if (metrics.length === 0) {
    return { metrics: [], error: "no billing data parsed" }
  }
  return { metrics }
}

function readXaiCents(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const val = obj[key]
    if (val === undefined) continue
    if (typeof val === "number") return val
    if (typeof val === "object" && val !== null) {
      const v = (val as Record<string, unknown>)["val"]
      if (typeof v === "number") return v
    }
  }
  return undefined
}

function makeErrorMetric(provider: string, authIndex: string, error: string): NormalizedMetric {
  return {
    providerMetricId: `${provider}:${authIndex}:error`,
    label: `${provider} status`,
    unit: "",
    sourceValueKind: "status",
    sourceConfidence: "unknown",
    notes: error,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/providers/cliproxy.test.ts`
Expected: PASS

- [ ] **Step 5: Register in main.ts**

In `src/server/main.ts`, add:

```ts
import { createCliproxyProvider } from "./providers/cliproxy"
```

Add to providers map:

```ts
  ["cliproxy", createCliproxyProvider()],
```

- [ ] **Step 6: Run typecheck + full test suite**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/server/providers/cliproxy.ts tests/providers/cliproxy.test.ts src/server/main.ts
git commit -m "feat(providers): add CLIProxyAPI adapter (auth-files + api-call + codex/claude/xai + timeouts + fast-fail)"
```

---

## Task 7: Config example + .env.example

**Files:**
- Modify: `config/dashboard.config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add example + .env + commit**

In `config/dashboard.config.ts`, add to providers (commented out):

```ts
  // CLIProxyAPI dynamic provider (auto-discovers codex/claude/xai accounts)
  // { id: "cliproxy-main", type: "cliproxy",
  //   baseUrl: process.env.CLIPROXY_BASE_URL ?? "http://localhost:8317",
  //   apiKeyEnv: "CLIPROXY_MGMT_KEY" },
```

Add `dynamicProviderIds` to profile (commented out):

```ts
  profiles: [
    {
      id: "self",
      name: "Personal",
      viewKey: process.env.SELF_DASHBOARD_VIEW_KEY,
      subscriptionIds: ["poe-api", "cursor"],
      // dynamicProviderIds: ["cliproxy-main"],
    },
  ],
```

Append to `.env.example`:

```env

# CLIProxyAPI (management key for upstream account discovery + quota query)
CLIPROXY_BASE_URL=http://localhost:8317
CLIPROXY_MGMT_KEY=
```

Run: `bun run typecheck && bun test`
Expected: PASS

```bash
git add config/dashboard.config.ts .env.example
git commit -m "docs(config): add CLIProxyAPI example provider + env vars"
```

---

## Task 8: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 3: Verify no regression**

Run: `bun test tests/providers/poe.test.ts tests/dashboard/project.test.ts tests/config/load-config.test.ts tests/refresh/refresh-service.test.ts tests/storage/repositories.test.ts`
Expected: PASS
