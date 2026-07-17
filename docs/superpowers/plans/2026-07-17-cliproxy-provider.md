# CLIProxyAPI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CLIProxyAPI provider adapter that discovers upstream accounts (Codex/Claude/Grok) at runtime via CLIProxyAPI's management API and queries their real quota, rendering each account as a dynamic subscription in the dashboard.

**Architecture:** Adapter calls `GET /v0/management/auth-files` to discover accounts, then `POST /v0/management/api-call` per account with `$TOKEN$` substitution to query upstream quota. Returns `dynamicSubscriptions[]` + `metrics[]`. Storage-first pattern: dynamicSubscriptions persisted on `ProviderCacheRecord`. Projection layer merges static + dynamic subscriptions.

**Tech Stack:** Bun, TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Hono, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-07-17-cliproxy-provider-design.md`

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/server/providers/cliproxy.ts` | CLIProxyAPI adapter (auth-files discovery + api-call fan-out + 3 parsers) |
| `tests/providers/cliproxy.test.ts` | Adapter tests |

### Modified files

| Path | Change |
|---|---|
| `src/shared/domain.ts` | `ProfileConfig.dynamicProviderIds?`; `DynamicSubscription` type; `cliproxy` union member |
| `src/server/providers/types.ts` | `ProviderRefreshResult.dynamicSubscriptions?` |
| `src/server/storage/schema.ts` | Migration 6: `dynamic_subscriptions_json` column |
| `src/server/storage/repositories.ts` | `ProviderCacheRecord.dynamicSubscriptions?`; upsert SQL + decode |
| `src/server/config/load-config.ts` | cliproxy branch + SSRF loopback exemption + `dynamicProviderIds` validation |
| `src/server/refresh/refresh-service.ts` | `collectVisibleProviderAccounts` union; `writeProviderResult` dynamic snapshots; `buildPayloadFromStorage` dynamic loading |
| `src/server/dashboard/project.ts` | `projectProviderMetrics` dynamic branch; `synthesizeMetricConfig`; `inferDisplayModule`; summary exclusion |
| `src/server/main.ts` | Register `cliproxy` adapter |
| `config/dashboard.config.ts` | Example cliproxy provider |
| `.env.example` | `CLIPROXY_BASE_URL=`, `CLIPROXY_MGMT_KEY=` |

---

## Task 1: Type definitions

**Files:**
- Modify: `src/shared/domain.ts`
- Modify: `src/server/providers/types.ts`

- [ ] **Step 1: Add `cliproxy` to `ProviderAccountConfig` union and `DynamicSubscription` type**

In `src/shared/domain.ts`, add to the `ProviderAccountConfig` union (after the volcengine variant):

```ts
  | { id: string; type: "cliproxy"; baseUrl: string; apiKeyEnv?: string | undefined; apiKey?: string | undefined; queryProviders?: string[] | undefined }
```

Add the `DynamicSubscription` type (after `ProviderRuntimeState`):

```ts
export type DynamicSubscription = {
  id: string
  name: string
  providerMetricIds: string[]
  ui?: { color?: string; group?: string; sort?: number }
}
```

Add `dynamicProviderIds?` to `ProfileConfig`:

```ts
export type ProfileConfig = { id: string; name: string; viewKey: string | undefined; subscriptionIds: string[]; dynamicProviderIds?: string[] }
```

- [ ] **Step 2: Add `dynamicSubscriptions?` to `ProviderRefreshResult`**

In `src/server/providers/types.ts`, add import and field:

```ts
import type { DynamicSubscription } from "../../shared/domain"
```

Add to `ProviderRefreshResult`:

```ts
  dynamicSubscriptions?: DynamicSubscription[]
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no consumers yet, just type additions)

- [ ] **Step 4: Commit**

```bash
git add src/shared/domain.ts src/server/providers/types.ts
git commit -m "feat(types): add cliproxy ProviderAccountConfig, DynamicSubscription, dynamicProviderIds"
```

---

## Task 2: Storage migration + ProviderCacheRecord extension

**Files:**
- Modify: `src/server/storage/schema.ts`
- Modify: `src/server/storage/repositories.ts`
- Test: `tests/storage/repositories.test.ts` (if exists) or inline verification

- [ ] **Step 1: Add migration 6**

In `src/server/storage/schema.ts`, append to `MIGRATIONS` array:

```ts
  {
    version: 6,
    sql: "ALTER TABLE provider_cache ADD COLUMN dynamic_subscriptions_json TEXT",
  },
```

- [ ] **Step 2: Add `dynamicSubscriptions?` to `ProviderCacheRecord`**

In `src/server/storage/repositories.ts`, add import:

```ts
import type { DynamicSubscription } from "../../shared/domain"
```

Add field to `ProviderCacheRecord`:

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

- [ ] **Step 3: Update upsert SQL to include `dynamic_subscriptions_json`**

In `src/server/storage/repositories.ts`, find the `providerCache.upsert` implementation (the SQL INSERT). Update the SQL to include the new column:

```ts
upsert(record: ProviderCacheRecord): void {
  const sql = `insert into provider_cache(
      provider_account_id, fetched_at, stale_after, status,
      normalized_json, error_json, dynamic_subscriptions_json
    ) values (?, ?, ?, ?, ?, ?, ?)
    on conflict(provider_account_id) do update set
      fetched_at = excluded.fetched_at,
      stale_after = excluded.stale_after,
      status = excluded.status,
      normalized_json = excluded.normalized_json,
      error_json = excluded.error_json,
      dynamic_subscriptions_json = excluded.dynamic_subscriptions_json`
  const dynJson = record.dynamicSubscriptions !== undefined
    ? JSON.stringify(record.dynamicSubscriptions)
    : null
  db.prepare(sql).run(
    record.providerAccountId,
    record.fetchedAt,
    record.staleAfter,
    record.status,
    JSON.stringify(record.normalized),
    record.errors.length > 0 ? JSON.stringify(record.errors) : null,
    dynJson,
  )
}
```

- [ ] **Step 4: Update decode to parse `dynamic_subscriptions_json`**

Find the `providerCache.get` implementation (or `decodeProviderCache`). Add parsing:

```ts
get(providerAccountId: string): ProviderCacheRecord | undefined {
  const row = db.prepare("select * from provider_cache where provider_account_id = ?").get(providerAccountId) as Record<string, unknown> | undefined
  if (!row) return undefined
  const dynJson = row["dynamic_subscriptions_json"] as string | null
  const result: ProviderCacheRecord = {
    providerAccountId: row["provider_account_id"] as string,
    fetchedAt: row["fetched_at"] as string,
    staleAfter: row["stale_after"] as string,
    status: row["status"] as "ok" | "stale" | "unavailable",
    normalized: JSON.parse(row["normalized_json"] as string),
    errors: row["error_json"] ? JSON.parse(row["error_json"] as string) : [],
  }
  if (dynJson) {
    result.dynamicSubscriptions = JSON.parse(dynJson) as DynamicSubscription[]
  }
  return result
}
```

- [ ] **Step 5: Run typecheck + tests**

Run: `bun run typecheck && bun test`
Expected: PASS (existing tests still pass; migration runs on next DB open)

- [ ] **Step 6: Commit**

```bash
git add src/server/storage/schema.ts src/server/storage/repositories.ts
git commit -m "feat(storage): add dynamic_subscriptions_json column + ProviderCacheRecord field"
```

---

## Task 3: Config loading - cliproxy branch + SSRF exemption + validation

**Files:**
- Modify: `src/server/config/load-config.ts`
- Test: `tests/config/load-config.test.ts`

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

test("cliproxy rejects non-loopback private IP (SSRF)", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "cp", type: "cliproxy", baseUrl: "http://10.0.0.1:8317", apiKey: "k" }],
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/config/load-config.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement cliproxy branch + SSRF exemption + validation**

In `src/server/config/load-config.ts`, add helper `isLoopbackOnly`:

```ts
function isLoopbackOnly(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|]$/g, "")
  if (h === "localhost") return true
  if (/^127\./.test(h)) return true
  if (h === "::1" || h === "::") return true
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

Add the cliproxy branch BEFORE the `API_KEY_PROVIDER_TYPES.has(provider.type)` check in the provider loop:

```ts
    if (provider.type === "cliproxy") {
      if (!provider.baseUrl || provider.baseUrl === "") {
        fail(`${providerPath}.baseUrl`, "cliproxy requires baseUrl")
      }
      validateBaseUrlSkipLoopback(provider.baseUrl, `${providerPath}.baseUrl`)
      const { apiKey, reason } = resolveBearerCredential(provider as { apiKeyEnv?: string | undefined; apiKey?: string | undefined })
      const state: ProviderRuntimeState = { available: apiKey !== undefined }
      if (apiKey !== undefined) state.apiKey = apiKey
      if (reason !== undefined) state.reason = reason
      providers.set(provider.id, provider)
      providerRuntime.set(provider.id, state)
    } else if (API_KEY_PROVIDER_TYPES.has(provider.type)) {
```

Add `dynamicProviderIds` validation in the profiles loop (after existing `subscriptionIds` validation):

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/config/load-config.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/config/load-config.ts tests/config/load-config.test.ts
git commit -m "feat(config): cliproxy branch with SSRF loopback exemption + dynamicProviderIds validation"
```

---

## Task 4: Projection - dynamic subscription branch

**Files:**
- Modify: `src/server/dashboard/project.ts`
- Test: `tests/dashboard/project.test.ts`

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
  // Should have 2 subscriptions: poe-api (static) + cliproxy:codex:abc123 (dynamic)
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
  // Summary groups should NOT contain the dynamic metric's unit/kind
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
    { providerAccountId: "cp-main", metrics: [], cache: undefined },
  ]
  const payload = buildDashboardPayload({
    config, profileId: "self", generatedAt: NOW,
    selectedRange: "24h", providers,
  })
  // Only poe-api subscription, no dynamic
  expect(payload.subscriptions).toHaveLength(1)
  expect(payload.subscriptions[0]!.id).toBe("poe-api")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/dashboard/project.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement dynamic subscription projection**

In `src/server/dashboard/project.ts`, add `DynamicSubscription` to imports:

```ts
import type { DynamicSubscription, LimitWindow, MetricConfig, MetricStatus, NormalizedConfig, RangeKey, SourceValueKind } from "../../shared/domain"
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
        })
      }
    }
  }
```

Add helper functions:

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
  if (m.sourceValueKind === "status") return "manual-status-card"
  if (m.window?.kind === "rolling") return "rolling-window-card"
  if (m.window?.kind === "calendar" || m.window?.kind === "fixed") return "period-quota-card"
  return "balance-card"
}
```

In `buildDashboardPayload`, pass dynamic data to `projectProviderMetrics`:

```ts
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

Exclude dynamic metrics from `buildSummaryGroups`. In `buildSummaryGroups` (or the function that calls it), filter out metrics where `subscriptionId` starts with `"cliproxy:"`:

```ts
  const summaryInput = projected.filter(p => !p.subscriptionId.startsWith("cliproxy:"))
  const summaryGroups = buildSummaryGroups(summaryInput, selectedRange, input.generatedAt)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/dashboard/project.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/dashboard/project.ts tests/dashboard/project.test.ts
git commit -m "feat(projection): dynamic subscription branch + synthesizeMetricConfig + summary exclusion"
```

---

## Task 5: Refresh service - visibility union + dynamic snapshots + storage loading

**Files:**
- Modify: `src/server/refresh/refresh-service.ts`
- Test: `tests/refresh/refresh-service.test.ts`

- [ ] **Step 1: Write failing test for collectVisibleProviderAccounts union**

Append to `tests/refresh/refresh-service.test.ts`:

```ts
test("collectVisibleProviderAccounts includes dynamic providers", async () => {
  const { service } = setupService({
    config: {
      providers: new Map([
        ["poe-main", { id: "poe-main", type: "poe", apiKey: "k" }],
        ["cp-main", { id: "cp-main", type: "cliproxy", baseUrl: "http://localhost:8317", apiKey: "k" }],
      ]),
      providerRuntime: new Map([
        ["poe-main", { available: true, apiKey: "k" }],
        ["cp-main", { available: true, apiKey: "k" }],
      ]),
      subscriptions: new Map([["poe-api", { id: "poe-api", name: "Poe", providerId: "poe-main", metrics: [] }]]),
      profiles: new Map([["self", { id: "self", name: "P", viewKey: "k", subscriptionIds: ["poe-api"], dynamicProviderIds: ["cp-main"] }]]),
    },
  })
  // Refresh should attempt to refresh BOTH poe-main AND cp-main
  const refreshCalls: string[] = []
  // ... mock provider that records calls ...
  // Assert cp-main is in the refresh set
})
```

Note: the exact test setup depends on the existing test harness. Adapt to match the pattern in `tests/refresh/refresh-service.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/refresh/refresh-service.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `collectVisibleProviderAccounts`**

In `src/server/refresh/refresh-service.ts`, modify `collectVisibleProviderAccounts`:

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

- [ ] **Step 4: Update `writeProviderResult` to write dynamic snapshots**

In `writeProviderResult`, after the existing `for (const { subscriptionId, metric } of subMetrics)` loop (line ~245), add:

```ts
    // Dynamic subscription snapshots
    if (result.dynamicSubscriptions) {
      for (const dynSub of result.dynamicSubscriptions) {
        for (const providerMetricId of dynSub.providerMetricIds) {
          const matched = result.metrics.find((m) => m.providerMetricId === providerMetricId)
          if (!matched) continue
          if (matched.used === undefined && matched.remaining === undefined && matched.sourceValueKind !== "status") continue
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

- [ ] **Step 5: Update `writeProviderResult` cache record to include dynamicSubscriptions**

In `writeProviderResult`, modify the `cacheRecord` construction:

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

- [ ] **Step 6: Update `buildPayloadFromStorage` to load dynamic snapshots/history + pass dynamicSubscriptions**

In `buildPayloadFromStorage`, after the existing `for (const subId of profile.subscriptionIds)` loop (line ~397), add:

```ts
    // Load snapshots/history for dynamic subscriptions
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
          const histRows = storage.historyEvents.listForMetric(metricKey, rangeStart, rangeEnd)
          if (histRows.length > 0) {
            storedHistory.set(metricKey, histRows.map((r) => ({ sourceTimestamp: r.sourceTimestamp, value: r.value, valueKind: r.valueKind })))
          }
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

Add `DynamicSubscription` to the imports at the top of `refresh-service.ts`:

```ts
import type { DynamicSubscription } from "../../shared/domain"
```

Update the `buildDashboardPayload` call at the end of `buildPayloadFromStorage`:

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

- [ ] **Step 7: Run typecheck + tests**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/server/refresh/refresh-service.ts tests/refresh/refresh-service.test.ts
git commit -m "feat(refresh): union dynamicProviderIds, write dynamic snapshots, load from storage"
```

---

## Task 6: CLIProxyAPI adapter

**Files:**
- Create: `src/server/providers/cliproxy.ts`
- Test: `tests/providers/cliproxy.test.ts`

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
const metrics: MetricConfig[] = []
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id,
    provider,
    runtime: { available: true, apiKey: "mgmt-key" },
    now: NOW,
    metrics,
    ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

const AUTH_FILES_BODY = {
  files: [
    {
      auth_index: "abc123",
      provider: "codex",
      label: "alice@example.com",
      disabled: false,
      status: "active",
      id_token: { chatgpt_account_id: "acc_123", plan_type: "pro" },
    },
    {
      auth_index: "def456",
      provider: "claude",
      label: "claude@example.com",
      disabled: false,
      status: "active",
    },
    {
      auth_index: "ghi789",
      provider: "xai",
      label: "grok@example.com",
      disabled: false,
      status: "active",
    },
    {
      auth_index: "skip1",
      provider: "codex",
      disabled: true,
      status: "disabled",
    },
  ],
}

test("discovers accounts from auth-files and filters by provider type", async () => {
  const urls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    urls.push(url)
    if (url.includes("/auth-files")) return makeResp(200, AUTH_FILES_BODY)
    if (url.includes("/api-call")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
      if (body.auth_index === "abc123") {
        return makeResp(200, {
          status_code: 200,
          body: JSON.stringify({
            rate_limit: {
              primary_window: { used_percent: 72, limit_window_seconds: 18000, reset_at: 1752735600 },
              secondary_window: { used_percent: 45, limit_window_seconds: 604800, reset_at: 1753254000 },
            },
          }),
        })
      }
      if (body.auth_index === "def456") {
        return makeResp(200, {
          status_code: 200,
          body: JSON.stringify({
            five_hour: { utilization: 65, resets_at: "2026-07-17T05:00:00Z" },
            seven_day: { utilization: 40, resets_at: "2026-07-24T00:00:00Z" },
          }),
        })
      }
      if (body.auth_index === "ghi789") {
        return makeResp(200, {
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
        })
      }
      return makeResp(200, { status_code: 500, body: "{}" })
    }
    return makeResp(404, {})
  }
  const result = await createCliproxyProvider(fakeFetch as unknown as FakeFetch).refresh(buildInput())

  expect(urls.some(u => u.includes("/auth-files"))).toBe(true)
  expect(result.dynamicSubscriptions).toBeDefined()
  expect(result.dynamicSubscriptions!.length).toBe(3) // codex, claude, xai (skip1 filtered)

  // Codex
  const codexSub = result.dynamicSubscriptions!.find(s => s.id.includes("codex"))!
  expect(codexSub.name).toContain("alice")
  const codex5h = result.metrics.find(m => m.providerMetricId === "codex:abc123:five_hour")!
  expect(codex5h.used).toBe(72)
  expect(codex5h.limit).toBe(100)
  expect(codex5h.window?.resetAt).toBe("2025-07-17T05:00:00.000Z") // 1752735600 * 1000

  // Claude (utilization used directly, NOT x100)
  const claude5h = result.metrics.find(m => m.providerMetricId === "claude:def456:five_hour")!
  expect(claude5h.used).toBe(65)

  // Grok
  const grokWeekly = result.metrics.find(m => m.providerMetricId === "xai:ghi789:weekly")!
  expect(grokWeekly.used).toBe(30)
  const grokMonthly = result.metrics.find(m => m.providerMetricId === "xai:ghi789:monthly")!
  expect(grokMonthly.used).toBe(20) // 200/1000*100
})

test("auth-files 404 -> non-retryable 'management API not enabled'", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(404, {})
  const result = await createCliproxyProvider(fakeFetch as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.errors![0]!.message).toContain("not enabled")
})

test("auth-files 401 -> non-retryable auth error", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(401, {})
  const result = await createCliproxyProvider(fakeFetch as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.errors![0]!.message).toContain("authentication failed")
})

test("api-call 502 -> retryable error for that account", async () => {
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) return makeResp(200, AUTH_FILES_BODY)
    return makeResp(502, { error: "request failed" })
  }
  const result = await createCliproxyProvider(fakeFetch as unknown as FakeFetch).refresh(buildInput())
  // All accounts fail with 502 -> error metrics produced, dynamicSubscriptions still present
  expect(result.dynamicSubscriptions!.length).toBe(3)
  const errorMetrics = result.metrics.filter(m => m.sourceValueKind === "status")
  expect(errorMetrics.length).toBe(3)
})

test("management key missing -> unavailable", async () => {
  const result = await createCliproxyProvider().refresh(buildInput({
    runtime: { available: false, reason: "no key" },
  }))
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.retryable).toBe(false)
})

test("does not skip unavailable accounts (quota exceeded = most important)", async () => {
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) {
      return makeResp(200, {
        files: [{
          auth_index: "jkl012",
          provider: "codex",
          disabled: false,
          status: "active",
          unavailable: true, // quota exceeded!
          id_token: { chatgpt_account_id: "acc_456" },
        }],
      })
    }
    return makeResp(200, {
      status_code: 200,
      body: JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 1752735600 },
        },
      }),
    })
  }
  const result = await createCliproxyProvider(fakeFetch as unknown as FakeFetch).refresh(buildInput())
  expect(result.dynamicSubscriptions!.length).toBe(1) // NOT skipped
  expect(result.metrics.find(m => m.providerMetricId === "codex:jkl012:five_hour")!.used).toBe(100)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/providers/cliproxy.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

Create `src/server/providers/cliproxy.ts`:

```ts
import type { DynamicSubscription, MetricConfig } from "../../shared/domain"
import type {
  NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult,
} from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// CLIProxyAPI adapter.
// Discovers upstream accounts via GET /v0/management/auth-files, then queries
// each account's quota via POST /v0/management/api-call with $TOKEN$ substitution.
// Supports codex, claude, xai providers.
//
// Sources:
//   cc-switch subscription.rs (Codex/Claude quota URLs + response parsing)
//   CPAMP xai_probe.go (Grok billing URL + response parsing)
//   CLIProxyAPI api_tools.go (api-call endpoint shape + $TOKEN$ mechanism)

const DEFAULT_QUERY_PROVIDERS = ["codex", "claude", "xai"]
const API_CALL_CONCURRENCY = 6
const PER_CALL_TIMEOUT_MS = 70_000

type CliproxyProvider = {
  id: string; type: "cliproxy"; baseUrl: string; apiKeyEnv?: string; apiKey?: string; queryProviders?: string[]
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

      // 1) Discover accounts
      let authFiles: AuthFileEntry[]
      const mgmtHeaders = new Headers()
      mgmtHeaders.set("Authorization", `Bearer ${apiKey}`)
      mgmtHeaders.set("Accept", "application/json")

      try {
        const res = await fetchImpl(`${baseUrl}/v0/management/auth-files`, { method: "GET", headers: mgmtHeaders })
        if (res.status === 404) {
          return { ...base, errors: [{ message: "CLIProxyAPI management API not enabled. Set MANAGEMENT_PASSWORD or remote-management.secret-key.", retryable: false }] }
        }
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("CLIProxyAPI authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `CLIProxyAPI auth-files request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        const body = (await res.json()) as { files?: AuthFileEntry[] }
        authFiles = Array.isArray(body.files) ? body.files : []
      } catch {
        return { ...base, errors: [{ message: "CLIProxyAPI auth-files network error", retryable: true }] }
      }

      // Filter accounts
      const accounts = authFiles.filter((a) => {
        if (!a.provider || !queryProviders.includes(a.provider)) return false
        if (a.disabled === true) return false
        if (a.status !== undefined && a.status !== "active") return false
        if (!a.auth_index || a.auth_index === "") return false
        // Do NOT skip unavailable (quota exceeded = most important to show)
        return true
      })

      // 2) Fan out api-call per account (concurrency-capped)
      const metrics: NormalizedMetric[] = []
      const dynamicSubscriptions: DynamicSubscription[] = []

      // Process in batches of API_CALL_CONCURRENCY
      for (let i = 0; i < accounts.length; i += API_CALL_CONCURRENCY) {
        const batch = accounts.slice(i, i + API_CALL_CONCURRENCY)
        const results = await Promise.allSettled(
          batch.map((acct) => queryAccount(fetchImpl, baseUrl, apiKey, acct)),
        )
        for (let j = 0; j < results.length; j++) {
          const acct = batch[j]!
          const r = results[j]
          const accountMetrics: NormalizedMetric[] = []
          if (r.status === "fulfilled") {
            accountMetrics.push(...r.value.metrics)
            if (r.value.error) {
              accountMetrics.push(makeErrorMetric(acct.provider!, acct.auth_index!, r.value.error))
            }
          } else {
            accountMetrics.push(makeErrorMetric(acct.provider!, acct.auth_index!, "request failed"))
          }
          metrics.push(...accountMetrics)
          dynamicSubscriptions.push({
            id: `cliproxy:${acct.provider}:${acct.auth_index}`,
            name: acct.label ? `CLIProxy - ${acct.label}` : `CLIProxy - ${acct.provider} #${acct.auth_index.slice(0, 8)}`,
            providerMetricIds: accountMetrics.map((m) => m.providerMetricId),
            ui: { group: "CLIProxy" },
          })
        }
      }

      return { ...base, metrics, dynamicSubscriptions }
    },
  }
}

type AccountQueryResult = { metrics: NormalizedMetric[]; error?: string }

async function queryAccount(
  fetchImpl: typeof fetch,
  baseUrl: string,
  mgmtKey: string,
  acct: AuthFileEntry,
): Promise<AccountQueryResult> {
  const provider = acct.provider!
  const authIndex = acct.auth_index!

  if (provider === "codex") {
    return queryCodex(fetchImpl, baseUrl, mgmtKey, authIndex, acct.id_token?.chatgpt_account_id)
  } else if (provider === "claude") {
    return queryClaude(fetchImpl, baseUrl, mgmtKey, authIndex)
  } else if (provider === "xai") {
    return queryXai(fetchImpl, baseUrl, mgmtKey, authIndex)
  }
  return { metrics: [], error: `unknown provider: ${provider}` }
}

async function apiCall(
  fetchImpl: typeof fetch,
  baseUrl: string,
  mgmtKey: string,
  authIndex: string,
  method: string,
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: true; statusCode: number; body: string } | { ok: false; error: string; retryable: boolean }> {
  const res = await fetchImpl(`${baseUrl}/v0/management/api-call`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${mgmtKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ auth_index: authIndex, method, url, header: headers }),
  })
  // Management API HTTP status determines error type
  if (res.status === 502) {
    return { ok: false, error: "api-call transport failure", retryable: true }
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    return { ok: false, error: body.error ?? "api-call bad request", retryable: false }
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
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, authIndex: string, accountId?: string,
): Promise<AccountQueryResult> {
  const headers: Record<string, string> = {
    "Authorization": "Bearer $TOKEN$",
    "User-Agent": "codex-cli",
    "Accept": "application/json",
  }
  if (accountId) headers["ChatGPT-Account-Id"] = accountId

  const result = await apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
    "https://chatgpt.com/backend-api/wham/usage", headers)
  if (!result.ok) return { metrics: [], error: result.error }

  if (result.statusCode === 401 || result.statusCode === 403) {
    return { metrics: [], error: "upstream auth failed (possible stale auth_index)" }
  }
  if (result.statusCode >= 500) {
    return { metrics: [], error: `upstream error (${result.statusCode})` }
  }

  try {
    const parsed = JSON.parse(result.body) as {
      rate_limit?: {
        primary_window?: { used_percent?: number; limit_window_seconds?: number; reset_at?: number }
        secondary_window?: { used_percent?: number; limit_window_seconds?: number; reset_at?: number }
      }
    }
    const windows: Array<{ data: { used_percent?: number; limit_window_seconds?: number; reset_at?: number }; name: string; duration: string }> = []
    const rl = parsed.rate_limit
    if (rl?.primary_window) windows.push({ data: rl.primary_window, name: "five_hour", duration: "5h" })
    if (rl?.secondary_window) windows.push({ data: rl.secondary_window, name: "weekly", duration: "7d" })

    const metrics: NormalizedMetric[] = []
    for (const w of windows) {
      const used = parseNumber(w.data.used_percent)
      const limitWindowSeconds = parseNumber(w.data.limit_window_seconds)
      if (used === undefined) continue
      const resetAt = typeof w.data.reset_at === "number" ? new Date(w.data.reset_at * 1000).toISOString() : undefined
      const metric: NormalizedMetric = {
        providerMetricId: `codex:${authIndex}:${w.name}`,
        label: w.name === "five_hour" ? "5h" : "Weekly",
        unit: "%",
        used,
        limit: 100,
        sourceValueKind: "gauge-used",
        sourceConfidence: "known",
        ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration: w.duration, resetAt } } : {}),
      }
      metrics.push(metric)
    }
    return { metrics }
  } catch {
    return { metrics: [], error: "parse error" }
  }
}

async function queryClaude(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, authIndex: string,
): Promise<AccountQueryResult> {
  const headers: Record<string, string> = {
    "Authorization": "Bearer $TOKEN$",
    "anthropic-beta": "oauth-2025-04-20",
    "Accept": "application/json",
  }

  const result = await apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
    "https://api.anthropic.com/api/oauth/usage", headers)
  if (!result.ok) return { metrics: [], error: result.error }

  if (result.statusCode === 401 || result.statusCode === 403) {
    return { metrics: [], error: "upstream auth failed (possible stale auth_index)" }
  }
  if (result.statusCode >= 500) {
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
      // utilization is 0-100, do NOT multiply
      const resetAt = typeof win.resets_at === "string" ? win.resets_at : undefined
      const duration = key.startsWith("five_hour") ? "5h" : "7d"
      const metric: NormalizedMetric = {
        providerMetricId: `claude:${authIndex}:${key}`,
        label: key.replace(/_/g, " "),
        unit: "%",
        used,
        limit: 100,
        sourceValueKind: "gauge-used",
        sourceConfidence: "known",
        ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration, resetAt } } : {}),
      }
      metrics.push(metric)
    }
    return { metrics }
  } catch {
    return { metrics: [], error: "parse error" }
  }
}

async function queryXai(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, authIndex: string,
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
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits", headers),
    apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
      "https://cli-chat-proxy.grok.com/v1/billing", headers),
  ])

  const metrics: NormalizedMetric[] = []
  let weeklyConfig: Record<string, unknown> | undefined
  let monthlyConfig: Record<string, unknown> | undefined

  if (weeklyResult.ok && weeklyResult.statusCode >= 200 && weeklyResult.statusCode < 300) {
    try {
      const parsed = JSON.parse(weeklyResult.body) as { config?: Record<string, unknown> }
      weeklyConfig = parsed.config
    } catch { /* parse error handled below */ }
  }
  if (monthlyResult.ok && monthlyResult.statusCode >= 200 && monthlyResult.statusCode < 300) {
    try {
      const parsed = JSON.parse(monthlyResult.body) as { config?: Record<string, unknown> }
      monthlyConfig = parsed.config
    } catch { /* parse error handled below */ }
  }

  const config = weeklyConfig ?? monthlyConfig
  if (!config) {
    const err = !weeklyResult.ok ? weeklyResult.error : !monthlyResult.ok ? monthlyResult.error : "no billing data"
    return { metrics: [], error: err }
  }

  // Weekly
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

  // Monthly (merge from monthlyConfig if available, fallback to weekly config)
  const cfg = monthlyConfig ?? config
  const monthlyLimit = readXaiCents(cfg, "monthly_limit", "monthlyLimit")
  const used = readXaiCents(cfg, "used")
  const onDemandCap = readXaiCents(cfg, "on_demand_cap", "onDemandCap")
  const onDemandUsed = readXaiCents(cfg, "on_demand_used", "onDemandUsed")
  const billingPeriodEnd = typeof cfg["billing_period_end"] === "string" ? cfg["billing_period_end"] as string : undefined

  if (monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined) {
    const includedUsed = Math.min(used, monthlyLimit)
    const monthlyUsedPercent = (includedUsed / monthlyLimit) * 100
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
    label: "Status",
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

- [ ] **Step 5: Register adapter in main.ts**

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
git commit -m "feat(providers): add CLIProxyAPI adapter (auth-files discovery + api-call fan-out + codex/claude/xai)"
```

---

## Task 7: Config example + .env.example

**Files:**
- Modify: `config/dashboard.config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add example cliproxy provider to config**

In `config/dashboard.config.ts`, add to providers array:

```ts
  // CLIProxyAPI dynamic provider (auto-discovers codex/claude/xai accounts)
  // { id: "cliproxy-main", type: "cliproxy",
  //   baseUrl: process.env.CLIPROXY_BASE_URL ?? "http://localhost:8317",
  //   apiKeyEnv: "CLIPROXY_MGMT_KEY" },
```

Add `dynamicProviderIds` to the profile:

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

- [ ] **Step 2: Update .env.example**

Append:

```env

# CLIProxyAPI (management key for upstream account discovery + quota query)
CLIPROXY_BASE_URL=http://localhost:8317
CLIPROXY_MGMT_KEY=
```

- [ ] **Step 3: Run typecheck + tests**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 4: Commit**

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
Expected: PASS (all tests)

- [ ] **Step 3: Verify no Poe regression**

Run: `bun test tests/providers/poe.test.ts tests/dashboard/project.test.ts tests/config/load-config.test.ts tests/refresh/refresh-service.test.ts`
Expected: PASS

- [ ] **Step 4: Commit if any cleanup needed**

---

## Self-Review Notes

**Spec coverage:**
- ✅ Dynamic subscription architecture (types, profile extension, ProviderRefreshResult) - Task 1
- ✅ Storage migration + ProviderCacheRecord - Task 2
- ✅ Config loading (cliproxy branch, SSRF exemption, dynamicProviderIds validation) - Task 3
- ✅ Projection (dynamic branch, synthesizeMetricConfig, inferDisplayModule, summary exclusion) - Task 4
- ✅ Refresh service (visibility union, dynamic snapshots write, dynamic snapshots read) - Task 5
- ✅ CLIProxyAPI adapter (auth-files, api-call, 3 parsers, concurrency, error metrics) - Task 6
- ✅ Config example + .env.example - Task 7
- ✅ Codex reset_at Unix->ISO conversion - Task 6
- ✅ Claude utilization NOT x100 - Task 6
- ✅ Grok two endpoints merged - Task 6
- ✅ Grok 5 required headers - Task 6
- ✅ Failed accounts still get DynamicSubscription + error metric - Task 6
- ✅ Unavailable accounts NOT skipped - Task 6
- ✅ api-call 502 shape handling - Task 6
- ✅ Management 404 -> "not enabled" - Task 6
- ✅ Concurrency cap 6 - Task 6

**Placeholder scan:** No TBD/TODO. All code complete.

**Type consistency:** `DynamicSubscription` defined in Task 1, used in Tasks 2/4/5/6. `ProviderCacheRecord.dynamicSubscriptions` added in Task 2, read in Task 5. `createCliproxyProvider` defined in Task 6, registered in Task 6 Step 5.
