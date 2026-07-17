# CLIProxyAPI Provider Design

Date: 2026-07-17
Status: revised after two adversarial reviews (my own + Kimi K3 4-reviewer panel). All Critical/High issues from both reviews resolved. External API claims verified against CLIProxyAPI Go source, cc-switch Rust source, and CPAMP Go source.

## Goal

Add a CLIProxyAPI provider adapter that discovers upstream accounts (Codex, Claude, Grok) at runtime via CLIProxyAPI's management API and queries their real quota through CLIProxyAPI's stored credentials. Each discovered account becomes a dynamic subscription in the dashboard.

## Non-Goals

- No CPAMP dependency -- queries CLIProxyAPI directly.
- No providers other than codex/claude/xai (gemini, openai-compatibility, etc. skipped).
- No write operations -- adapter only reads quota.
- No per-account include/exclude filtering -- a profile with `dynamicProviderIds` sees ALL discovered accounts. See Security Notes.

## Architecture

### Dynamic Subscription Concept

CLIProxyAPI accounts are discovered at runtime via `GET /v0/management/auth-files`. The adapter returns `dynamicSubscriptions[]` alongside `metrics[]`. The projection layer merges static and dynamic subscriptions.

**Storage-first pattern** (no in-memory cache): `dynamicSubscriptions` are stored on `ProviderCacheRecord` (via `dynamic_subscriptions_json` column), written in the same transaction as metrics/snapshots. `getPayload`/`buildPayloadFromStorage` reads from storage. This follows the existing codebase pattern and survives restarts.

### ProviderAccountConfig

```ts
| {
    id: string
    type: "cliproxy"
    baseUrl: string                    // CLIProxyAPI address, e.g. http://localhost:8317
    apiKeyEnv?: string
    apiKey?: string
    queryProviders?: string[]          // default ["codex","claude","xai"]
  }
```

Must be added to the `ProviderAccountConfig` discriminated union in `src/shared/domain.ts`.

### ProfileConfig Extension

```ts
export type ProfileConfig = {
  id: string
  name: string
  viewKey: string | undefined
  subscriptionIds: string[]
  dynamicProviderIds?: string[]
}
```

### DynamicSubscription Type

```ts
export type DynamicSubscription = {
  id: string                    // e.g. "cliproxy:codex:a3f9c1e0"
  name: string                  // e.g. "CLIProxy - alice@example.com" (or label, or "Codex #<short>")
  providerMetricIds: string[]  // metric IDs for THIS account only (never other accounts)
  ui?: { color?: string; group?: string; sort?: number }
}
```

### ProviderRefreshResult Extension

```ts
export type ProviderRefreshResult = {
  // ... existing fields ...
  dynamicSubscriptions?: DynamicSubscription[]
}
```

### Change Surface

| File | Change |
|---|---|
| `src/shared/domain.ts` | `ProfileConfig.dynamicProviderIds?`; `DynamicSubscription` type; `cliproxy` in `ProviderAccountConfig` union |
| `src/server/providers/types.ts` | `ProviderRefreshResult.dynamicSubscriptions?` |
| `src/server/providers/cliproxy.ts` | New adapter (auth-files discovery + api-call fan-out + 3 parsers) |
| `src/server/refresh/refresh-service.ts` | `collectVisibleProviderAccounts` unions `dynamicProviderIds`; `writeProviderResult` writes dynamic snapshots; `buildPayloadFromStorage` loads dynamic snapshots/history + reads `dynamic_subscriptions_json` from storage |
| `src/server/dashboard/project.ts` | `projectProviderMetrics` handles dynamic; `synthesizeMetricConfig`; `inferDisplayModule`; dynamic metrics excluded from `buildSummaryGroups` |
| `src/server/config/load-config.ts` | Validate `dynamicProviderIds`; cliproxy-specific branch (required baseUrl, SSRF loopback exemption) |
| `src/server/storage/schema.ts` | Migration 6: `ALTER TABLE provider_cache ADD COLUMN dynamic_subscriptions_json TEXT` |
| `src/server/storage/repositories.ts` | `ProviderCacheRecord.dynamicSubscriptions?`; upsert SQL + decode include new column |
| `config/dashboard.config.ts` | Example cliproxy provider |
| `.env.example` | `CLIPROXY_BASE_URL=`, `CLIPROXY_MGMT_KEY=` |
| `tests/providers/cliproxy.test.ts` | Adapter tests |
| `tests/dashboard/project.test.ts` | Dynamic subscription projection tests |
| `tests/refresh/refresh-service.test.ts` | Dynamic subscription persistence tests |
| `tests/storage/repositories.test.ts` | `dynamic_subscriptions_json` round-trip |

## CLIProxyAPI Adapter (`cliproxy.ts`)

### Auth-files Endpoint

```
GET <baseUrl>/v0/management/auth-files
Authorization: Bearer <managementKey>
```

Response (filtered to relevant fields):
```json
{
  "files": [{
    "id": "...",
    "auth_index": "a3f9c1e0",
    "provider": "codex",
    "label": "alice@example.com",
    "disabled": false,
    "status": "active",
    "id_token": {
      "chatgpt_account_id": "acc_abc123",
      "plan_type": "pro"
    }
  }]
}
```

**`auth_index` is a per-credential hex hash** (`sha256(seed)[:8]`), stable across restarts and unaffected by other accounts being added/removed. It changes only on file rename, auth dir move, or key/type change. (Verified: CLIProxyAPI `types.go:331-401`.)

Filter rules:
- `provider` in `queryProviders` (default `["codex","claude","xai"]`)
- `disabled === true` -> skip
- `status !== "active"` -> skip (authoritative skip signal, checked alongside `disabled`)
- **`unavailable === true` -> DO NOT skip** (unavailable = quota exceeded / cooling down -- these are the accounts most worth showing)
- `codex` without `id_token.chatgpt_account_id` -> do NOT skip; query without `ChatGPT-Account-Id` header (cc-switch sends it conditionally: `subscription.rs:686-688`)
- **Management API not enabled (404)** -> non-retryable error "CLIProxyAPI management API not enabled. Set MANAGEMENT_PASSWORD or remote-management.secret-key."
- **auth_index empty string** -> skip (edge case: empty seed)

### API-call Endpoint

```
POST <baseUrl>/v0/management/api-call
Authorization: Bearer <managementKey>
Content-Type: application/json

{
  "auth_index": "<auth_index>",
  "method": "GET",
  "url": "<upstream quota URL>",
  "header": { "Authorization": "Bearer $TOKEN$", ... }
}
```

Response when management API succeeds (HTTP 200):
```json
{ "status_code": 200, "header": {...}, "body": "..." }
```

Response when management API itself fails (HTTP 502 transport error):
```json
{ "error": "request failed" }
```

Response when management API not found (HTTP 400, e.g. auth_index not found):
```json
{ "error": "auth token not found" }
```

**Critical: the adapter must check `resp.status` (the HTTP status of the management api-call response) BEFORE parsing the body.** Only HTTP 200 from management has `{status_code, header, body}`. Other statuses have `{error}`.

`$TOKEN$` is replaced server-side by CLIProxyAPI with the account's live token. The adapter never sees the real token. If `auth_index` doesn't match any credential, CLIProxyAPI sends the literal `$TOKEN$` upstream without substitution (`api_tools.go:147-149`) -- the upstream returns 401, which the adapter should report as "possible stale auth_index" in the error message.

### Per-Provider Quota Queries

#### Codex

Upstream URL: `GET https://chatgpt.com/backend-api/wham/usage`

Headers (verified against cc-switch `subscription.rs:680-688`):
```json
{
  "Authorization": "Bearer $TOKEN$",
  "User-Agent": "codex-cli",
  "Accept": "application/json"
}
```
`ChatGPT-Account-Id` header is **conditional** -- only sent when `id_token.chatgpt_account_id` is present. (cc-switch: `if let Some(id) = account_id { req = req.header("ChatGPT-Account-Id", id); }`)

Response parsing (verified: `subscription.rs:624-629`):
```json
{
  "rate_limit": {
    "primary_window": { "used_percent": 72.5, "limit_window_seconds": 18000, "reset_at": 1752735600 },
    "secondary_window": { "used_percent": 45.0, "limit_window_seconds": 604800, "reset_at": 1753254000 }
  }
}
```

**`reset_at` is a Unix epoch integer (seconds), NOT an ISO string.** Adapter converts: `new Date(reset_at * 1000).toISOString()`.

Window classification by `limit_window_seconds`:
- 18000 (5h) -> `five_hour`, duration `"5h"`
- 604800 (7d) -> `weekly`, duration `"7d"`
- 2592000 (30d) -> `monthly`, duration `"30d"`
- Other -> skip

Metrics: `providerMetricId: "codex:<auth_index>:<window>"`, `used = used_percent`, `limit = 100`, `sourceValueKind: "gauge-used"`, `sourceConfidence: "known"`, `window = { kind: "rolling", duration, resetAt }`.

#### Claude

Upstream URL: `GET https://api.anthropic.com/api/oauth/usage`

Headers (verified: `subscription.rs:342-346`):
```json
{
  "Authorization": "Bearer $TOKEN$",
  "anthropic-beta": "oauth-2025-04-20",
  "Accept": "application/json"
}
```

Response parsing (verified: `subscription.rs:284-427`):
```json
{
  "five_hour": { "utilization": 65.0, "resets_at": "2026-07-17T05:00:00Z" },
  "seven_day": { "utilization": 40.0, "resets_at": "2026-07-24T00:00:00Z" },
  "seven_day_opus": { "utilization": 20.0, "resets_at": "..." },
  "extra_usage": { "is_enabled": false }
}
```

**`utilization` is already 0-100, NOT 0-1. Do NOT multiply by 100.** (Verified: cc-switch `QuotaTier.utilization` is documented "0-100" at `subscription.rs:32`, assigned directly from API at `:399`.)

`resets_at` is an ISO string (verified: `subscription.rs:288`, `Option<String>`).

Adapter iterates ALL top-level keys with `{utilization, resets_at}` shape, not just known ones (cc-switch: `:410-427` iterates unknown windows). `extra_usage` is skipped.

Metrics: `providerMetricId: "claude:<auth_index>:<window_key>"`, `used = utilization`, `limit = 100`, `sourceValueKind: "gauge-used"`, `sourceConfidence: "known"`, `window = { kind: "rolling", duration: inferDuration(window_key), resetAt: resets_at }`.

`inferDuration`: `five_hour` -> `"5h"`, `seven_day*` -> `"7d"`, other -> `"7d"` (default).

#### Grok / xAI

**Two endpoints** queried and merged (verified: CPAMP `xai_probe.go:170-193`):
1. Weekly: `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`
2. Monthly: `GET https://cli-chat-proxy.grok.com/v1/billing`

Headers (verified: `xai_probe.go:159-168`):
```json
{
  "Authorization": "Bearer $TOKEN$",
  "x-xai-token-auth": "xai-grok-cli",
  "x-grok-client-version": "0.2.101",
  "User-Agent": "grok-pager/0.2.101 grok-shell/0.2.101 (macos; aarch64)",
  "Accept": "*/*"
}
```
Optionally `x-userid` header if `user_id`/`sub` is found in auth metadata.

Response parsing (verified: `xai_probe.go:464-525`). The response has a `config` object:
```json
{
  "config": {
    "credit_usage_percent": 30,
    "monthly_limit": { "val": 1000 },
    "used": { "val": 200 },
    "on_demand_cap": { "val": 500 },
    "on_demand_used": { "val": 100 },
    "current_period": { "type": "weekly", "end": "2026-07-24T00:00:00Z" },
    "billing_period_end": "2026-08-01T00:00:00Z",
    "product_usage": [{ "product": "grok-4", "usage_percent": 25 }]
  }
}
```

Field semantics (from `parseXAIBillingSummary`):
- `credit_usage_percent` -> weekly usage percent (0-100)
- `monthly_limit.val` / `used.val` -> monthly limit / used in cents
- `on_demand_cap.val` / `on_demand_used.val` -> on-demand cap / used in cents
- `current_period.end` -> weekly reset time
- `billing_period_end` -> monthly reset time
- Monthly used percent is computed: `min(used, monthly_limit) / monthly_limit * 100`
- On-demand used percent: `on_demand_used / on_demand_cap * 100`

Fields may be `{val: number}` objects or raw numbers -- `readXAICentFloat` handles both.

Metrics produced:
- `providerMetricId: "xai:<auth_index>:weekly"`: `used = credit_usage_percent`, `limit = 100`, `window = { kind: "rolling", duration: "7d", resetAt: current_period.end }`
- `providerMetricId: "xai:<auth_index>:monthly"`: `used = monthlyUsedPercent`, `limit = 100`, `window = { kind: "rolling", duration: "30d", resetAt: billing_period_end }`
- `providerMetricId: "xai:<auth_index>:on_demand"`: `used = onDemandUsedPercent`, `limit = 100`, `window = undefined` (not periodic)

Each metric only produced if the corresponding data is present (`HasWeeklyData` / `HasMonthlyData` flags).

### DynamicSubscription Generation

**Every discovered account (success or failure) produces a DynamicSubscription.** Failed accounts get an error metric so they stay visible (not silently disappearing).

```ts
{
  id: `cliproxy:${provider}:${auth_index}`,     // auth_index is hex hash, stable
  name: label ? `CLIProxy - ${label}` : `CLIProxy - ${provider} #${auth_index.slice(0, 8)}`,
  providerMetricIds: [/* only this account's metric IDs */],
  ui: { group: "CLIProxy" }
}
```

### Error Metric for Failed Accounts

When an account's api-call fails or parsing fails, the adapter produces a status metric:
```ts
{
  providerMetricId: `${provider}:${auth_index}:error`,
  label: "Status",
  unit: "",
  sourceValueKind: "status",
  sourceConfidence: "unknown",
  notes: "upstream error: <detail>"  // or "auth failed", "parse error", etc.
}
```
This metric is included in the account's `providerMetricIds` so the subscription renders a status card.

### Error Handling

| Scenario | Classification |
|---|---|
| auth-files 404 (management not enabled) | `retryable: false`, "CLIProxyAPI management API not enabled" |
| auth-files 401/403 | `retryable: false`, "CLIProxyAPI authentication failed" |
| auth-files 5xx/429 | `retryable: true` |
| auth-files network error | `retryable: true` |
| api-call management HTTP 502 | `retryable: true` (transport failure) |
| api-call management HTTP 400 "auth token not found" | Account-level error metric, `notes: "stale auth_index"` |
| api-call upstream status_code 401/403 | Account-level error metric, `notes: "upstream auth failed (possible stale auth_index)"` |
| api-call upstream status_code 5xx | Account-level error metric, `notes: "upstream error (NNN)"` |
| api-call body parse failure | Account-level error metric, `notes: "parse error"` |
| Management key missing | `retryable: false`, "unavailable" |

### Concurrency

- **Intra-adapter fan-out cap: 6** (not unbounded `Promise.allSettled`). Process accounts in batches of 6.
- **Per-api-call timeout: 70 seconds** (AbortController). CLIProxyAPI's own timeout is 60s; 70s lets its 502 trigger first.
- **Overall adapter deadline: 120 seconds.** Abort remaining requests if exceeded.
- **Fast-fail on auth**: if first batch of api-call requests all return 401 from management API, abort remaining (avoids triggering CLIProxyAPI's 5-failure -> 30-min IP ban).

### staleAfter

`fetchedAt + 5min`.

## Projection Layer Changes

### `projectProviderMetrics` Extension

After existing static subscription iteration, add dynamic subscription iteration:

```ts
for (const providerId of input.dynamicProviderIds ?? []) {
  const providerAccount = input.config.providers.get(providerId)
  if (!providerAccount) continue
  const providerType = providerAccount.type
  const providerProjection = input.providers.find(p => p.providerAccountId === providerId)
  const dynamicSubs = input.dynamicSubscriptions?.get(providerId) ?? []
  
  for (const dynSub of dynamicSubs) {
    for (const providerMetricId of dynSub.providerMetricIds) {
      const matchedMetric = providerProjection?.metrics.find(
        m => m.providerMetricId === providerMetricId,
      )
      if (!matchedMetric) continue
      
      const metricKey = buildMetricKey(providerId, dynSub.id, providerMetricId)
      result.push({
        subscriptionId: dynSub.id,
        subscriptionName: dynSub.name,
        ...(dynSub.ui ? { subscriptionUi: dynSub.ui } : {}),
        metricId: providerMetricId,
        metricKey,
        providerAccountId: providerId,
        providerType,
        providerMetricId,
        config: synthesizeMetricConfig(matchedMetric, providerMetricId),
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

### `synthesizeMetricConfig` Helper

```ts
function synthesizeMetricConfig(m: NormalizedMetric, providerMetricId: string): MetricConfig {
  return {
    id: providerMetricId,
    providerMetricId,
    label: m.label,
    unit: m.unit,
    sourceValueKind: m.sourceValueKind,
    display: { module: inferDisplayModule(m) },
    ...(m.notes ? { notes: m.notes } : {}),
    ...(m.window ? { window: m.window } : {}),
  }
}

function inferDisplayModule(m: NormalizedMetric): DisplayModule {
  if (m.sourceValueKind === "status") return "manual-status-card"
  if (m.window?.kind === "rolling") return "rolling-window-card"
  if (m.window?.kind === "calendar" || m.window?.kind === "fixed") return "period-quota-card"
  return "balance-card"
}
```

### `buildSubscriptions` -- Unchanged

Groups by `subscriptionId`. Dynamic IDs are distinct from static ones.

### `buildSummaryGroups` -- Dynamic Metrics Excluded

Dynamic metrics are excluded from summary aggregation (summing percentages across N accounts is meaningless). Implementation: skip `ProjectedMetric` entries where `subscriptionId` starts with `"cliproxy:"` in `buildSummaryGroups`, or tag them with a flag.

### `buildDashboardPayload` Input Extension

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

## Refresh Service Changes

### `collectVisibleProviderAccounts` -- Union Dynamic Providers

```ts
function collectVisibleProviderAccounts(profileId: string): string[] {
  const profile = config.profiles.get(profileId)
  if (!profile) return []
  const seen = new Set<string>()
  for (const subId of profile.subscriptionIds) {
    const sub = config.subscriptions.get(subId)
    if (sub) seen.add(sub.providerId)
  }
  // NEW: include dynamic providers
  for (const dynProviderId of profile.dynamicProviderIds ?? []) {
    seen.add(dynProviderId)
  }
  return Array.from(seen)
}
```

This is **the critical fix** -- without it, the adapter is never called.

### `writeProviderResult` -- Write Dynamic Snapshots

After the existing snapshot loop (which iterates `subMetrics` from config), add a second loop for dynamic subscriptions:

```ts
// Write snapshots for dynamic subscriptions
if (result.dynamicSubscriptions) {
  for (const dynSub of result.dynamicSubscriptions) {
    for (const providerMetricId of dynSub.providerMetricIds) {
      const matched = result.metrics.find(m => m.providerMetricId === providerMetricId)
      if (!matched || matched.remaining === undefined && matched.used === undefined) continue
      const metricKey = buildMetricKey(paId, dynSub.id, providerMetricId)
      snapshotRows.push({
        metricKey,
        timestamp: result.fetchedAt,
        ...(matched.authoritativeValue !== undefined ? { authoritativeValue: matched.authoritativeValue } : {}),
        ...(matched.used !== undefined ? { used: matched.used } : {}),
        ...(matched.remaining !== undefined ? { remaining: matched.remaining } : {}),
        ...(matched.limit !== undefined ? { limit: matched.limit } : {}),
        sourceValueKind: matched.sourceValueKind,
      })
    }
  }
}
```

### `writeProviderResult` -- Persist dynamicSubscriptions

Store `dynamicSubscriptions` on `ProviderCacheRecord` in the same transaction:

```ts
const cacheRecord: ProviderCacheRecord = {
  // ... existing fields ...
  ...(result.dynamicSubscriptions ? { dynamicSubscriptions: result.dynamicSubscriptions } : {}),
}
```

**Semantics**: on adapter success, `dynamicSubscriptions` is overwritten (including empty array if 0 accounts found). On adapter failure (no `dynamicSubscriptions` returned), the old cached value is preserved (last-good). This matches the existing `normalized_json` preservation behavior.

### `buildPayloadFromStorage` -- Load Dynamic Snapshots/History

After the existing loop over `profile.subscriptionIds`, add:

```ts
// Load snapshots/history for dynamic subscriptions
for (const dynProviderId of profile.dynamicProviderIds ?? []) {
  const cache = storage.providerCache.get(dynProviderId)
  const dynamicSubs = cache?.dynamicSubscriptions ?? []
  for (const dynSub of dynamicSubs) {
    for (const providerMetricId of dynSub.providerMetricIds) {
      const metricKey = buildMetricKey(dynProviderId, dynSub.id, providerMetricId)
      // Load history
      const history = storage.historyEvents.listForMetric(metricKey, rangeStartMs, nowMs)
      if (history.length > 0) {
        storedHistory.set(metricKey, history.map(/* ... */))
      }
      // Load snapshots
      const snaps = storage.snapshots.listForMetric(metricKey, rangeStartMs, nowMs)
      if (snaps.length > 0) {
        snapshots.set(metricKey, snaps)
      }
    }
  }
  // Pass dynamicSubscriptions to projection
  if (dynamicSubs.length > 0) {
    dynamicSubscriptions.set(dynProviderId, dynamicSubs)
  }
}
```

### `getPayload` -- Same Pattern

`getPayload` (reads from in-memory cache after refresh) also passes `dynamicSubscriptions` from the cache record.

## Storage Changes

### Migration (schema.ts)

```ts
// In MIGRATIONS array (type is { version: number; sql: string })
{
  version: 6,
  sql: "ALTER TABLE provider_cache ADD COLUMN dynamic_subscriptions_json TEXT",
}
```

### ProviderCacheRecord Extension (repositories.ts)

```ts
export type ProviderCacheRecord = {
  providerAccountId: string
  fetchedAt: string
  staleAfter: string
  status: "ok" | "stale" | "unavailable"
  normalized: { metrics: NormalizedMetric[] }
  errors: Array<{ message: string; retryable: boolean }>
  dynamicSubscriptions?: DynamicSubscription[]  // NEW
}
```

### Upsert SQL

Add `dynamic_subscriptions_json` to the INSERT and `on conflict do update`:

```sql
INSERT INTO provider_cache (
  provider_account_id, fetched_at, stale_after, status,
  normalized_json, error_json, dynamic_subscriptions_json
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(provider_account_id) DO UPDATE SET
  fetched_at = excluded.fetched_at,
  stale_after = excluded.stale_after,
  status = excluded.status,
  normalized_json = excluded.normalized_json,
  error_json = excluded.error_json,
  dynamic_subscriptions_json = excluded.dynamic_subscriptions_json
```

When `dynamicSubscriptions` is undefined (adapter failure, no update): pass `null` for the column in the SQL -- but **only when preserving old data** (adapter failure path). On success: pass `JSON.stringify(dynamicSubscriptions)` (including `[]` for zero accounts).

### Decode

```ts
function decodeProviderCache(row: Record<string, unknown>): ProviderCacheRecord {
  // ... existing fields ...
  const dynJson = row["dynamic_subscriptions_json"] as string | null
  return {
    // ... existing fields ...
    ...(dynJson ? { dynamicSubscriptions: JSON.parse(dynJson) as DynamicSubscription[] } : {}),
  }
}
```

## Config Loading Changes

### CLIProxyAPI Branch

**Do NOT add "cliproxy" to `API_KEY_PROVIDER_TYPES`.** Instead, add a dedicated branch BEFORE the `API_KEY_PROVIDER_TYPES` check:

```ts
if (provider.type === "cliproxy") {
  if (!provider.baseUrl || provider.baseUrl === "") {
    fail(`${providerPath}.baseUrl`, "cliproxy requires baseUrl")
  }
  // SSRF: cliproxy is a trusted local sidecar -- exempt from loopback rejection
  // (validateBaseUrl still rejects non-loopback private ranges like 10.x, 192.168.x)
  validateBaseUrlSkipLoopback(provider.baseUrl, `${providerPath}.baseUrl`)
  const { apiKey, reason } = resolveBearerCredential(provider)
  const state: ProviderRuntimeState = { available: apiKey !== undefined }
  if (apiKey !== undefined) state.apiKey = apiKey
  if (reason !== undefined) state.reason = reason
  providers.set(provider.id, provider)
  providerRuntime.set(provider.id, state)
} else if (API_KEY_PROVIDER_TYPES.has(provider.type)) {
  // ... existing branch ...
}
```

### SSRF Loopback Exemption for cliproxy

CLIProxyAPI is by design a local sidecar (`localhost:8317`). The loopback check must be exempted:

```ts
function validateBaseUrlSkipLoopback(baseUrl: string, path: string): void {
  let parsed: URL
  try { parsed = new URL(baseUrl) } catch { fail(path, `invalid URL`) }
  const host = parsed.hostname.toLowerCase()
  // Allow loopback for trusted local services (cliproxy sidecar)
  if (isLoopbackOrPrivateHost(host) && !isLoopbackOnly(host)) {
    fail(path, `host "${host}" is private (non-loopback)`)
  }
  // No allowlist for cliproxy -- user-supplied CLIProxyAPI address
}

function isLoopbackOnly(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|]$/g, "")
  if (h === "localhost") return true
  // IPv4 loopback
  if (/^127\./.test(h)) return true
  // IPv6 loopback
  if (h === "::1" || h === "::") return true
  return false
}
```

This allows `localhost`, `127.x.x.x`, `::1` but still rejects `10.x`, `192.168.x`, `172.16-31.x`, CGNAT, and all IPv6 private ranges.

### Validation

```ts
for (const profile of input.profiles) {
  for (const dynProviderId of profile.dynamicProviderIds ?? []) {
    if (!providers.has(dynProviderId)) {
      fail(`profiles[${profile.id}].dynamicProviderIds`,
        `references unknown provider "${dynProviderId}"`)
    }
  }
}
```

## main.ts Registration

```ts
["cliproxy", createCliproxyProvider()],
```

## Security Notes

- The management key grants full management API access (auth file CRUD, reset quota, api-call proxy). Store in env var, not config file. Document this risk.
- `dynamicProviderIds` is all-or-nothing per profile -- a profile sees ALL accounts of that CLIProxyAPI instance. No per-account filtering in this version (listed as Non-Goal). Multi-profile deployments should use separate CLIProxyAPI instances or accept shared visibility.
- `$TOKEN$` substitution is server-side; the dashboard never sees upstream tokens.

## Testing Strategy

### Adapter Tests (`tests/providers/cliproxy.test.ts`)

- Fake fetch intercepts both `/v0/management/auth-files` and `/v0/management/api-call`
- Assert:
  - auth-files: discovers accounts, filters by provider, skips disabled/status!=active, does NOT skip unavailable
  - Codex: correct api-call body (url + headers + conditional ChatGPT-Account-Id), `reset_at` Unix->ISO conversion, window classification
  - Claude: correct api-call body + `anthropic-beta` header, `utilization` used directly (no ×100), iterates unknown windows
  - Grok: two endpoints queried, required headers, `config` field parsing, merge weekly+monthly
  - DynamicSubscription: every account (success+failure) gets one, providerMetricIds only include own metrics
  - Error metric: failed account gets status metric with notes
  - api-call 502: retryable error
  - api-call 400 "auth token not found": account error with "stale auth_index"
  - auth-files 404: "management API not enabled"
  - auth-files 401: non-retryable
  - Concurrency cap: max 6 concurrent api-calls
  - Fast-fail: first batch all 401 -> abort remaining

### Projection Tests

- Dynamic subscription projection produces ProjectedMetric with synthetic MetricConfig
- `inferDisplayModule` mapping
- Mixed static + dynamic in same payload
- Dynamic absent (no refresh yet): no metrics (graceful)
- Dynamic excluded from `buildSummaryGroups`

### Refresh Service Tests

- `collectVisibleProviderAccounts` includes dynamic providers
- `writeProviderResult` writes dynamic snapshots
- `buildPayloadFromStorage` loads dynamic snapshots/history
- `dynamicSubscriptions` persisted to storage, survives restart simulation
- Adapter failure preserves old `dynamicSubscriptions` (last-good)

### Storage Tests

- Migration 6: column exists
- Round-trip: write -> read -> identical
- Null column: `dynamicSubscriptions` undefined

## Config & Environment

### `config/dashboard.config.ts` Example

```ts
providers: [
  { id: "cliproxy-main", type: "cliproxy",
    baseUrl: process.env.CLIPROXY_BASE_URL ?? "http://localhost:8317",
    apiKeyEnv: "CLIPROXY_MGMT_KEY" },
],
profiles: [{
  id: "self", name: "Personal", viewKey: "...",
  subscriptionIds: ["poe-api", "cursor"],
  dynamicProviderIds: ["cliproxy-main"],
}],
```

### `.env.example` Additions

```env
CLIPROXY_BASE_URL=http://localhost:8317
CLIPROXY_MGMT_KEY=
```

## Implementation Order

1. **Types**: `domain.ts` (`ProfileConfig.dynamicProviderIds`, `DynamicSubscription`, `cliproxy` union member), `types.ts` (`ProviderRefreshResult.dynamicSubscriptions`)
2. **Storage**: migration + `ProviderCacheRecord` + upsert SQL + decode
3. **Config loading**: cliproxy branch + SSRF exemption + `dynamicProviderIds` validation
4. **Projection**: `projectProviderMetrics` dynamic branch + `synthesizeMetricConfig` + `inferDisplayModule` + summary exclusion
5. **Refresh service**: `collectVisibleProviderAccounts` union + `writeProviderResult` dynamic snapshots + `buildPayloadFromStorage` dynamic loading
6. **CLIProxyAPI adapter**: `cliproxy.ts` (auth-files + api-call fan-out + 3 parsers + concurrency + error metrics)
7. **Registration**: main.ts
8. **Tests**: adapter + projection + refresh-service + storage
9. **Config & docs**: example config + .env.example

## Open Questions Resolved

| Question | Decision |
|---|---|
| Account discovery | Fully automatic via `GET /v0/management/auth-files` |
| Provider filter | Only codex/claude/xai |
| Codex account_id | Conditional header, not required (cc-switch parity) |
| Display | Each account = one DynamicSubscription (including failed) |
| Architecture | Storage-first (no in-memory cache); `dynamic_subscriptions_json` on ProviderCacheRecord |
| Dynamic metric config | Synthesized from NormalizedMetric |
| Storage | `provider_cache.dynamic_subscriptions_json` column (migration 6, type `{version, sql}`) |
| Codex reset_at | Unix epoch seconds -> ISO conversion in adapter |
| Claude utilization | 0-100, used directly (NO ×100) |
| Claude windows | Iterate ALL keys with {utilization, resets_at} (not just known) |
| Grok endpoints | Two URLs (weekly + monthly), merged; 5 required headers |
| Grok response shape | `config` object with `credit_usage_percent`, `monthly_limit.val`, `used.val`, `on_demand_cap.val`, `on_demand_used.val`, `current_period.end`, `billing_period_end` |
| SSRF | Loopback exempted for cliproxy (trusted sidecar); non-loopback private still rejected |
| Migration type | `{ version: number; sql: string }` (not `{version, up:[]}`) |
| Refresh visibility | `collectVisibleProviderAccounts` unions `dynamicProviderIds` |
| Snapshot persistence | `writeProviderResult` writes dynamic snapshots in same transaction |
| Snapshot loading | `buildPayloadFromStorage` loads dynamic snapshots/history |
| Failed accounts | Still produce DynamicSubscription with error metric |
| Unavailable accounts | NOT skipped (quota exceeded = most important to show) |
| Summary aggregation | Dynamic metrics excluded (summing cross-account % is meaningless) |
| Concurrency | Cap 6, per-call timeout 70s, overall deadline 120s, fast-fail on auth |
| 502 response shape | Check management HTTP status before parsing body |
| Config branch | Dedicated cliproxy branch (not in API_KEY_PROVIDER_TYPES) |
| Management 404 | Non-retryable, "management API not enabled" |
| dynamicSubscriptions on failure | Preserved (last-good); on success: overwritten (including empty []) |
