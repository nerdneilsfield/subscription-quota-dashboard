# CLIProxyAPI Provider Design

Date: 2026-07-17

## Goal

Add a CLIProxyAPI provider adapter that discovers upstream accounts (Codex, Claude, Grok) at runtime via CLIProxyAPI's management API and queries their real quota through CLIProxyAPI's stored credentials. Each discovered account becomes a dynamic subscription in the dashboard.

## Non-Goals

- No CPAMP (CPA-Manager-Plus) dependency -- queries CLIProxyAPI directly.
- No support for providers other than codex/claude/xai (gemini, openai-compatibility, etc. skipped -- no meaningful quota endpoint).
- No write operations -- adapter only reads quota; does not call reset-quota or modify auth files.
- No usage-queue consumption -- adapter queries live upstream quota, not historical request records.

## Architecture

### Dynamic Subscription Concept

Existing providers use config-declared subscriptions with static `providerMetricId` matching. CLIProxyAPI accounts are discovered at runtime via `GET /v0/management/auth-files`, so the adapter returns `dynamicSubscriptions[]` alongside `metrics[]`. The projection layer merges static and dynamic subscriptions into one unified `DashboardPayload`.

### ProviderAccountConfig

```ts
| {
    id: string
    type: "cliproxy"
    baseUrl: string                    // CLIProxyAPI address, e.g. http://localhost:8317
    apiKeyEnv?: string                 // management key env var name
    apiKey?: string                    // or literal key
    queryProviders?: string[]          // optional, default ["codex","claude","xai"]
  }
```

### ProfileConfig Extension

```ts
export type ProfileConfig = {
  id: string
  name: string
  viewKey: string | undefined
  subscriptionIds: string[]
  dynamicProviderIds?: string[]       // NEW: references dynamic providers like "cliproxy-main"
}
```

### DynamicSubscription Type

```ts
export type DynamicSubscription = {
  id: string                          // e.g. "cliproxy:codex:0"
  name: string                        // e.g. "CLIProxy - Codex #1" (or label if available)
  providerMetricIds: string[]         // metric IDs belonging to this subscription
  ui?: { color?: string; group?: string; sort?: number }
}
```

### ProviderRefreshResult Extension

```ts
export type ProviderRefreshResult = {
  // ... existing fields ...
  dynamicSubscriptions?: DynamicSubscription[]  // NEW
}
```

### Change Surface

| File | Change |
|---|---|
| `src/shared/domain.ts` | `ProfileConfig.dynamicProviderIds?`; `DynamicSubscription` type |
| `src/server/providers/types.ts` | `ProviderRefreshResult.dynamicSubscriptions?`; `DynamicSubscription` import |
| `src/server/providers/cliproxy.ts` | New adapter file |
| `src/server/refresh/refresh-service.ts` | Cache `dynamicSubscriptions` per provider account; pass to projection |
| `src/server/dashboard/project.ts` | `projectProviderMetrics` handles `dynamicProviderIds`; `inferDisplayModule` helper |
| `src/server/config/load-config.ts` | Validate `dynamicProviderIds` references existing providers |
| `src/server/http/app.ts` | Pass dynamic subscription data through to projection |
| `src/server/storage/schema.ts` | Migration: `provider_cache.dynamic_subscriptions_json TEXT` |
| `src/server/storage/repositories.ts` | Read/write `dynamic_subscriptions_json` |
| `config/dashboard.config.ts` | Example cliproxy provider declaration |
| `.env.example` | `CLIPROXY_MGMT_KEY=`, `CLIPROXY_BASE_URL=` |
| `tests/providers/cliproxy.test.ts` | Adapter tests |
| `tests/dashboard/project.test.ts` | Dynamic subscription projection tests |
| `tests/refresh/refresh-service.test.ts` | Dynamic subscription caching tests |

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
    "auth_index": "0",
    "provider": "codex",
    "label": "Codex Pro #1",
    "disabled": false,
    "unavailable": false,
    "id_token": {
      "chatgpt_account_id": "acc_abc123",
      "plan_type": "pro"
    },
    "status": "active",
    "success": 1523,
    "failed": 12
  }]
}
```

Filter rules:
- `provider` must be in `queryProviders` (default `["codex","claude","xai"]`)
- `disabled === true` -> skip
- `unavailable === true` -> skip
- For `codex` provider: if `id_token.chatgpt_account_id` is missing -> skip with error

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

Response:
```json
{ "status_code": 200, "header": {...}, "body": "..." }
```

`$TOKEN$` is replaced by CLIProxyAPI with the account's live credential token. The adapter never sees the actual token.

### Per-Provider Quota Queries

#### Codex

Upstream URL: `GET https://chatgpt.com/backend-api/wham/usage`

Headers:
```json
{
  "Authorization": "Bearer $TOKEN$",
  "User-Agent": "codex-cli",
  "ChatGPT-Account-Id": "<id_token.chatgpt_account_id>"
}
```

Response parsing (from cc-switch `subscription.rs:672`):
```json
{
  "rate_limit": {
    "primary_window": { "used_percent": 72.5, "limit_window_seconds": 18000, "reset_at": "2026-07-17T05:00:00Z" },
    "secondary_window": { "used_percent": 45.0, "limit_window_seconds": 604800, "reset_at": "2026-07-24T00:00:00Z" }
  }
}
```

Metrics produced:
- `providerMetricId: "codex:<auth_index>:five_hour"`: `used = used_percent`, `limit = 100`, `window = { kind: "rolling", duration: "5h", resetAt: reset_at }`, `sourceValueKind: "gauge-used"`
- `providerMetricId: "codex:<auth_index>:weekly"`: same with `"7d"` duration

Window classification by `limit_window_seconds`:
- 18000 (5h) -> `five_hour`
- 604800 (7d) -> `weekly`
- 2592000 (30d) -> `monthly`
- Other -> skip

#### Claude

Upstream URL: `GET https://api.anthropic.com/api/oauth/usage`

Headers:
```json
{
  "Authorization": "Bearer $TOKEN$",
  "anthropic-beta": "oauth-2025-04-20",
  "Accept": "application/json"
}
```

Response parsing (from cc-switch `subscription.rs:338`):
```json
{
  "five_hour": { "utilization": 0.65, "resets_at": "2026-07-17T05:00:00Z" },
  "seven_day": { "utilization": 0.40, "resets_at": "2026-07-24T00:00:00Z" },
  "extra_usage": { "is_enabled": false }
}
```

Metrics produced:
- `providerMetricId: "claude:<auth_index>:five_hour"`: `used = utilization * 100`, `limit = 100`, `window = { kind: "rolling", duration: "5h", resetAt: resets_at }`, `sourceValueKind: "gauge-used"`
- `providerMetricId: "claude:<auth_index>:seven_day"`: same with `"7d"`

`utilization` is a 0-1 fraction; adapter multiplies by 100.

#### Grok / xAI

Upstream URL: `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`

Headers:
```json
{
  "Authorization": "Bearer $TOKEN$"
}
```

Response parsing (from CPAMP `xai_probe.go`):
```json
{
  "config": {
    "usage_percent": 30,
    "period_end": "2026-07-24T00:00:00Z",
    "monthly_limit_cents": 1000,
    "on_demand_cap_cents": 500,
    "on_demand_used_cents": 200
  }
}
```

Metrics produced:
- `providerMetricId: "xai:<auth_index>:weekly"`: `used = usage_percent`, `limit = 100`, `window = { kind: "rolling", duration: "7d", resetAt: period_end }`, `sourceValueKind: "gauge-used"`
- `providerMetricId: "xai:<auth_index>:on_demand"`: `used = on_demand_used_cents`, `limit = on_demand_cap_cents`, `unit = "cents"`, `sourceValueKind: "gauge-used"` (no window -- on-demand is not periodic)

### DynamicSubscription Generation

For each discovered account:

```ts
{
  id: `cliproxy:${provider}:${auth_index}`,           // e.g. "cliproxy:codex:0"
  name: label ? `CLIProxy - ${label}` : `CLIProxy - ${Provider} #${auth_index}`,
  providerMetricIds: metrics.map(m => m.providerMetricId),
  ui: { group: "CLIProxy", sort: <index> }
}
```

### Concurrency

Adapter internally fans out `api-call` requests for all discovered accounts using `Promise.allSettled`. Each account failure produces an error metric (status type) without affecting other accounts. Overall adapter failure (auth-files request fails) returns a single retryable error.

### Error Handling

| Scenario | Classification |
|---|---|
| auth-files 401/403 | `retryable: false`, "CLIProxyAPI authentication failed" |
| auth-files 5xx/429 | `retryable: true` |
| auth-files network error | `retryable: true` |
| Individual api-call upstream 401/403 | Account-level error metric, `sourceValueKind: "status"`, `notes: "auth failed"` |
| Individual api-call upstream 5xx | Account-level error metric, `notes: "upstream error"` |
| Individual api-call parse failure | Account-level error metric, `notes: "parse error"` |
| Codex missing chatgpt_account_id | Skip account, collect error in adapter-level errors[] |
| CLIProxyAPI api-call returns 502 (transport failure) | `retryable: true` |

### staleAfter

`fetchedAt + 5min` (shorter than other adapters -- quota state changes frequently and api-call is lightweight).

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
      if (!matchedMetric) continue  // account not returned this refresh
      
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

Dynamic metrics have no `MetricConfig` in the config file. Synthesize one from the `NormalizedMetric`:

```ts
function synthesizeMetricConfig(m: NormalizedMetric, providerMetricId: string): MetricConfig {
  return {
    id: providerMetricId,
    providerMetricId,
    label: m.label,
    unit: m.unit,
    sourceValueKind: m.sourceValueKind,
    display: { module: inferDisplayModule(m) },
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

`buildSubscriptions` groups `ProjectedMetric[]` by `subscriptionId`. Dynamic subscription IDs (e.g. `cliproxy:codex:0`) are distinct from static ones (e.g. `poe-api`), so they naturally form new `DashboardSubscription` entries without conflict.

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
  dynamicSubscriptions?: Map<string, DynamicSubscription[]>  // NEW
}

export type ProjectProviderMetricsInput = {
  config: NormalizedConfig
  subscriptionIds: string[]
  dynamicProviderIds?: string[]                               // NEW
  providers: Array<ProviderAccountProjection>
  snapshots?: Map<string, SnapshotPoint[]>
  storedHistory?: Map<string, ProjectedHistoryPoint[]>
  dynamicSubscriptions?: Map<string, DynamicSubscription[]>  // NEW
  now: string
}
```

### `buildDashboardPayload` Passes Dynamic Data

```ts
const profile = input.config.profiles.get(input.profileId)
const projected = projectProviderMetrics({
  config: input.config,
  subscriptionIds: profile.subscriptionIds,
  ...(profile.dynamicProviderIds ? { dynamicProviderIds: profile.dynamicProviderIds } : {}),
  providers: input.providers,
  now: input.generatedAt,
  ...(input.snapshots ? { snapshots: input.snapshots } : {}),
  ...(input.storedHistory ? { storedHistory: input.storedHistory } : {}),
  ...(input.dynamicSubscriptions ? { dynamicSubscriptions: input.dynamicSubscriptions } : {}),
})
```

## Refresh Service Changes

### Dynamic Subscription Caching

```ts
// In-memory cache: providerAccountId -> latest dynamicSubscriptions
const dynamicSubscriptionsCache = new Map<string, DynamicSubscription[]>()

// After refreshProviderAccount succeeds:
if (result.dynamicSubscriptions) {
  dynamicSubscriptionsCache.set(paId, result.dynamicSubscriptions)
}

// In getPayload / buildPayloadFromStorage:
const dynamicSubscriptions = new Map<string, DynamicSubscription[]>()
for (const paId of collectDynamicProviderAccounts(profileId)) {
  const cached = dynamicSubscriptionsCache.get(paId)
  if (cached) {
    dynamicSubscriptions.set(paId, cached)
  } else {
    // Fallback: read from storage (provider_cache.dynamic_subscriptions_json)
    const stored = storage.providerCache.getDynamicSubscriptions(paId)
    if (stored) dynamicSubscriptions.set(paId, stored)
  }
}
```

### `collectDynamicProviderAccounts` Helper

```ts
function collectDynamicProviderAccounts(profileId: string): string[] {
  const profile = config.profiles.get(profileId)
  if (!profile?.dynamicProviderIds) return []
  return profile.dynamicProviderIds
}
```

### `getPayload` and `buildPayloadFromStorage` Pass Dynamic Data

Both functions build the `DashboardProjectionInput`. They add:
```ts
...(dynamicSubscriptions.size > 0 ? { dynamicSubscriptions } : {})
```

## Storage Changes

### Migration (schema.ts)

```ts
// Migration 6 (or next available number)
migrations.push({
  version: 6,
  up: [
    `ALTER TABLE provider_cache ADD COLUMN dynamic_subscriptions_json TEXT`,
  ],
})
```

### repositories.ts

`provider_cache` upsert: if `dynamicSubscriptions` is present, JSON-serialize and store in `dynamic_subscriptions_json`.

`provider_cache` read: if `dynamic_subscriptions_json` is non-null, JSON-parse into `DynamicSubscription[]`.

## Config Loading Changes

### Validation

```ts
// Validate dynamicProviderIds references
for (const profile of input.profiles) {
  for (const dynProviderId of profile.dynamicProviderIds ?? []) {
    if (!providers.has(dynProviderId)) {
      fail(`profiles[${profile.id}].dynamicProviderIds`,
        `references unknown provider "${dynProviderId}"`)
    }
  }
}
```

### CLIProxyAPI Credential Resolution

CLIProxyAPI uses a management key (not a standard API key). Reuse `resolveBearerCredential`:

```ts
if (provider.type === "cliproxy") {
  if (!provider.baseUrl || provider.baseUrl === "") {
    fail(`${providerPath}.baseUrl`, "cliproxy requires baseUrl")
  }
  validateBaseUrl(provider.baseUrl, "cliproxy", `${providerPath}.baseUrl`)
  const { apiKey, reason } = resolveBearerCredential(provider)
  const state: ProviderRuntimeState = { available: apiKey !== undefined }
  if (apiKey !== undefined) state.apiKey = apiKey
  if (reason !== undefined) state.reason = reason
  providers.set(provider.id, provider)
  providerRuntime.set(provider.id, state)
}
```

Add `"cliproxy"` to `API_KEY_PROVIDER_TYPES` set.

## main.ts Registration

```ts
["cliproxy", createCliproxyProvider()],
```

## Testing Strategy

### Adapter Tests (`tests/providers/cliproxy.test.ts`)

- Fake fetch intercepts both `/v0/management/auth-files` and `/v0/management/api-call`
- Assert:
  - auth-files parsing: discovers accounts, filters by provider type, skips disabled
  - Codex: correct api-call body (url + headers + `$TOKEN$` + `ChatGPT-Account-Id`), parses `rate_limit` windows
  - Claude: correct api-call body (url + `anthropic-beta` header), parses `five_hour`/`seven_day` utilization
  - Grok: correct api-call body, parses `config` billing summary
  - DynamicSubscription generation: correct IDs, names, providerMetricIds
  - Concurrency: all accounts queried (not serial)
  - Individual account failure: error metric produced, other accounts unaffected
  - auth-files 401: non-retryable adapter-level error
  - auth-files 500: retryable
  - Codex missing chatgpt_account_id: skip with error
  - Management key missing: non-retryable "unavailable" error

### Projection Tests (`tests/dashboard/project.test.ts`)

- Dynamic subscription projection: `dynamicProviderIds` + `dynamicSubscriptions` -> produces ProjectedMetric with synthetic MetricConfig
- `inferDisplayModule`: rolling -> `rolling-window-card`, status -> `manual-status-card`, default -> `balance-card`
- Mixed: static subscription (poe-api) + dynamic subscription (cliproxy:codex:0) in same payload
- Dynamic subscription absent (not yet refreshed): no metrics for that subscription (graceful degradation)

### Refresh Service Tests (`tests/refresh/refresh-service.test.ts`)

- dynamicSubscriptions cached after refresh
- getPayload passes dynamicSubscriptions to projection
- Storage fallback: reads `dynamic_subscriptions_json` when in-memory cache empty

### Storage Tests

- Migration 6: `dynamic_subscriptions_json` column exists
- Round-trip: write dynamicSubscriptions -> read back -> identical

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

1. **Types**: `domain.ts` (`ProfileConfig.dynamicProviderIds`, `DynamicSubscription`), `types.ts` (`ProviderRefreshResult.dynamicSubscriptions`)
2. **Storage**: migration + repositories read/write `dynamic_subscriptions_json`
3. **Projection**: `projectProviderMetrics` dynamic subscription branch + `synthesizeMetricConfig` + `inferDisplayModule`
4. **Refresh service**: cache dynamicSubscriptions, pass to projection in getPayload/buildPayloadFromStorage
5. **Config loading**: validate `dynamicProviderIds`, add cliproxy to `API_KEY_PROVIDER_TYPES`
6. **CLIProxyAPI adapter**: `cliproxy.ts` (auth-files discovery + api-call fan-out + per-provider parsing)
7. **Registration**: main.ts
8. **Tests**: adapter + projection + refresh-service + storage
9. **Config & docs**: example config + .env.example

## Open Questions Resolved

| Question | Decision |
|---|---|
| Account discovery | Fully automatic via `GET /v0/management/auth-files` |
| Provider filter | Only codex/claude/xai (configurable via `queryProviders`) |
| Codex account ID | Extract from `id_token.chatgpt_account_id` in auth-files response |
| Display | Each account = one dynamic subscription; `ui.group: "CLIProxy"` |
| Architecture | Modified to support dynamic subscriptions via `dynamicProviderIds` on profile |
| Dynamic subscription source | Adapter returns `dynamicSubscriptions[]`; cached in memory + storage |
| Dynamic metric config | Synthesized from `NormalizedMetric` via `synthesizeMetricConfig` + `inferDisplayModule` |
| Storage | `provider_cache.dynamic_subscriptions_json` column (1 migration) |
| staleAfter | 5 min (shorter than others -- quota changes frequently) |
| Concurrency | `Promise.allSettled` for all accounts; individual failure -> error metric |
