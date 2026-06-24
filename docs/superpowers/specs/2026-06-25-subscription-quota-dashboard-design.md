# Subscription Quota Dashboard Design

Date: 2026-06-25

## Goal

Build a TypeScript dashboard, managed with Bun, for viewing quota and usage limits across multiple subscriptions. Different viewers enter through different profile URLs and only see the subscriptions configured for that profile.

The MVP focuses on a local or internal long-running service. It supports Poe API usage as the first real provider and manual quota entries for other subscriptions.

## Non-Goals

- No admin UI for editing config.
- No user account system or OAuth.
- No browser-cookie scraping of Poe web or app subscription limits.
- No charting library in the first UI pass.
- No public-internet hardening beyond view-key access, secret filtering, API `no-store` headers, referrer protection, and rate limiting.

## Recommended Approach

Use a single full-stack app:

- Runtime: Bun
- API server: Hono
- Frontend: Vite React SPA
- Storage: SQLite file
- Config: typed TypeScript config
- Deployment target: local or internal long-running service

This keeps the MVP small while preserving clear boundaries for providers, cache, stats, API, and UI.

## Architecture

One Bun process owns API, static frontend serving, provider refresh, cache, and snapshot storage.

- Hono exposes dashboard APIs.
- Hono serves the Vite production build in production.
- React renders a dark, dense operations dashboard.
- SQLite stores provider cache, quota snapshots, and usage aggregates.
- `config/dashboard.config.ts` defines profiles, view keys, provider accounts, subscriptions, and manual quotas.
- Provider layer starts with `poe` and `manual` providers.

Request flow:

1. Viewer opens `/d/:profileId`.
2. Frontend asks for the `viewKey` locally if no session exists.
3. Frontend sends `viewKey` through an `Authorization: Bearer <viewKey>` header.
4. Backend validates `profileId + viewKey` and sets a short-lived HttpOnly session cookie.
5. Later frontend requests use the session cookie.
6. Backend loads configured subscriptions for that profile.
7. Backend returns cached quota data and calculated stats.
8. Viewer can click refresh.
9. Refresh queries provider accounts used by that profile, stores new snapshots, then returns updated dashboard payload.

`viewKey` must not appear in URLs. This avoids leaks through browser history, server logs, reverse-proxy logs, and `Referer` headers.

## Core Data Model

### Profile

A profile is one viewer-facing dashboard entry.

Fields:

- `id`
- `name`
- `viewKey`
- `subscriptionIds`

The profile only controls what a viewer can see. It does not own provider credentials.

`viewKey` requirements:

- Use a cryptographically random value with at least 128 bits of entropy.
- Store plain `viewKey` only in local config for MVP; later versions may support hashed keys.
- Compare keys with constant-time comparison.
- Rate-limit failed attempts by IP and profile ID.
- Document rotation by changing config and restarting the service.

### Subscription

A subscription is one item shown on a dashboard.

Fields:

- `id`
- `name`
- `providerId`
- `metrics`
- `ui`

`ui` may hold subscription-level color, group, and sort metadata. Metric layout is controlled by each metric's `display.module`.

### Provider Account

A provider account is a backend credential and data source.

Fields:

- `id`
- `type: "poe" | "manual"`
- `apiKeyEnv?`
- `apiKey?`

Poe credentials may use `apiKeyEnv` or `apiKey`. `apiKeyEnv` is preferred. Direct `apiKey` is allowed for personal local use but should not be committed.

If multiple profiles reference subscriptions backed by the same provider account, backend cache and stats are shared. The frontend only shows the subscriptions configured for the active profile and does not expose account sharing.

### Quota Metric

A quota metric is one limit or balance displayed in a subscription card.

Fields:

- `id`
- `label`
- `unit`
- `providerMetricId?`
- `limit?`
- `used?`
- `remaining?`
- `sourceValueKind?`
- `window?`
- `display?`
- `updatedAt?`
- `notes?`
- `usageFilter?`

`window` describes how the limit resets or rolls. Providers can infer it when the API returns enough information, and config can override it when the provider does not expose reset details.

`providerMetricId` is the provider-side metric identifier used to join normalized provider output back to configured metrics. It defaults to the config metric `id` when omitted.

`sourceValueKind` is optional in config and required in snapshots/provider-normalized metrics. It selects stats delta semantics. Manual metrics infer it from numeric fields when omitted; provider metrics should set it explicitly.

`usageFilter` is provider-specific filtering metadata for provider-native usage history. MVP supports `{ usageTypes?: string[]; apiKeyName?: string; botName?: string }` for Poe. Normalization sorts array values and omits empty fields so filter identity is stable in summary grouping and history projection. Poe history filters default to `usage_type == "API"` unless config sets `usageTypes`.

Supported window shape:

```ts
type LimitWindow =
  | {
      kind: "calendar"
      period: "day" | "week" | "month" | "year"
      timezone: string
      resetAt?: string
      anchor?: {
        dayOfWeek?: number
        dayOfMonth?: number
        monthOfYear?: number
        timeOfDay?: string
      }
    }
  | {
      kind: "rolling"
      duration: string
      resetAt?: string
    }
  | {
      kind: "fixed"
      startsAt: string
      resetAt: string
    }
```

Window semantics:

- Normalized reset timing lives under `window.resetAt`. Do not keep a separate metric-level reset field in API payloads.
- `resetAt` always means the next known reset timestamp, not a recurring rule.
- `anchor` is the recurring reset rule used to compute future `resetAt` values.
- Config must not specify both `resetAt` and `anchor` for a `calendar` window. Provider-normalized data may include both, but then `resetAt` is the computed next reset and `anchor` remains the recurring rule.
- `timezone` is required for calendar windows.
- Configured `calendar` windows should use `anchor` for recurring quotas. A config-only `resetAt` calendar window is a one-cycle calendar window; after `resetAt` passes, future reset is unknown unless provider data supplies a new reset. Use `fixed` for one-time windows when no recurrence exists.
- `dayOfWeek` uses ISO numbering: `1` is Monday and `7` is Sunday.
- `dayOfMonth` uses `1` through `31`; if a month lacks that day, reset on that month's last day.
- `monthOfYear` uses `1` through `12` and is required when `period` is `year` and `anchor` is used.
- `timeOfDay` uses `HH:mm` in the configured timezone.
- `period: "day"` with `anchor` requires `timeOfDay`.
- `period: "week"` with `anchor` requires `dayOfWeek` and `timeOfDay`.
- `period: "month"` with `anchor` requires `dayOfMonth` and `timeOfDay`.
- `period: "year"` with `anchor` requires `monthOfYear`, `dayOfMonth`, and `timeOfDay`.
- Calendar reset calculations must be timezone-aware and handle DST by using local wall-clock time in `timezone`.
- If a configured local reset time does not exist during a DST jump, use the next valid local time. If a local reset time occurs twice during a DST fallback, use the first occurrence.
- Rolling `duration` must match `/^\d+(m|h|d)$/`, where `m` is minutes, `h` is hours, and `d` is days.
- Rolling `resetAt`, when provider supplied, wins over any client-side estimate. If provider does not supply it, the UI may show duration but must not invent a precise reset time unless event history supports it.
- Rolling windows need either provider current-window data or event history. If neither exists, current-window consumption and next reset are `unknown` rather than inferred from sparse snapshots.
- Fixed windows are one-time windows. After `resetAt`, the metric status becomes `expired` unless a provider or config supplies a new fixed window.

Window precedence:

- Config is authoritative for declared metric window policy by default.
- Provider data can fill missing runtime fields, such as computed `window.resetAt` or current rolling-window state.
- Provider data must not replace configured recurring `anchor`, `timezone`, or `duration` unless a metric later adds `windowOverride: "provider"`.
- Client estimates are last resort and must be marked `sourceConfidence: "estimated"`.
- If both config and provider supply runtime `resetAt`, use provider `resetAt` only when it represents the same configured window policy; otherwise keep config-derived reset and log a safe warning.

Examples:

- Poe monthly points: `kind: "calendar"`, `period: "month"`, manual `anchor` when Poe does not return reset timing; runtime computes next `resetAt`.
- Five-hour limit: `kind: "rolling"`, `duration: "5h"`, optional next `resetAt` if known.
- Weekly limit: `kind: "calendar"`, `period: "week"`, `anchor.dayOfWeek` and `timezone`.

`display` selects how a metric appears. Supported modules:

- `balance-card`: balance-focused metric such as Poe monthly points.
- `rolling-window-card`: rolling limits such as a five-hour quota.
- `period-quota-card`: fixed day, week, month, or year quotas.
- `manual-status-card`: manually maintained status without reliable usage counters.

Providers may return a default module, but config can override it per metric.

### Quota Snapshot

A snapshot captures observed provider state for stats.

Fields:

- `providerAccountId`
- `subscriptionId`
- `metricId`
- `metricKey`
- `timestamp`
- `used?`
- `remaining?`
- `limit?`
- `authoritativeValue`
- `sourceValueKind`
- `rawPayload?`

Snapshots support consumption and burn-rate calculations for `1h`, `24h`, `7d`, and `30d` ranges. `metricKey` is canonical and must include enough scope to avoid collisions, for example `providerAccountId + subscriptionId + metricId`.

`authoritativeValue` is the only numeric field used for deltas and burn-rate calculations. `used`, `remaining`, and `limit` may still be returned for display, but if they conflict with `authoritativeValue`, stats use `authoritativeValue` and UI marks source confidence as estimated or unknown.

`sourceValueKind` defines delta semantics for `authoritativeValue`:

- `counter`: monotonically increasing usage counter. Delta is later minus earlier, with reset handling.
- `gauge-remaining`: remaining balance. Consumption is earlier minus later, with reset handling.
- `gauge-used`: current period used amount. Delta is later minus earlier, with reset handling.
- `status`: not usable for numeric burn-rate calculations.

Reset-aware delta rules:

- If two samples do not cross a known reset boundary, calculate normal deltas: `counter` and `gauge-used` use `later - earlier`; `gauge-remaining` uses `earlier - later`.
- If two samples cross a known reset boundary, snapshot-only consumption is unknown unless there is a sample within five minutes before the boundary and a sample within five minutes after the boundary.
- When boundary-adjacent samples exist, use an estimated boundary formula and mark `sourceConfidence: "estimated"`:
  - `counter` and `gauge-used`: `max(preBoundary - earlier, 0) + max(later - postBoundary, 0)`.
  - `gauge-remaining`: `max(earlier - preBoundary, 0) + max(postBoundary - later, 0)`.
  - The unobserved gap between `preBoundary` and reset, and between reset and `postBoundary`, is intentionally not invented. Provider-native history wins whenever available.
- If a reset boundary is crossed and boundary samples are missing, prefer provider-native history; otherwise return stats as unknown.
- `counter`: later value lower than earlier value without a known crossed reset boundary means stats are unknown.
- `gauge-used`: later value lower than earlier value without a known crossed reset boundary means stats are unknown.
- `gauge-remaining`: later value higher than earlier value without a known crossed reset boundary means stats are unknown.
- Negative numeric values and internally inconsistent `used`/`remaining`/`limit` values should mark `percentUsed` and stats unknown unless provider semantics explicitly allow them. `used > limit` is treated as quota overflow: keep raw values, compute `percentUsed`, cap the visual bar at 100%, and mark status `critical`.

Poe balance metrics must use `sourceValueKind: "gauge-remaining"`. If configured limit exists and `current_point_balance > configuredLimit`, display `used` as `0`, omit `percentUsed`, keep status `ok`, and keep burn-rate based on history events rather than `used`.

`rawPayload` is disabled by default. If enabled for debugging, store only redacted allowlisted fields, set a short retention policy, and never store provider secrets.

## Config Design

Use `config/dashboard.config.ts` as the primary config file. Types should be exported by application code so config authors get type checking.

Config TypeScript types may accept `viewKey: string | undefined` and provider `apiKey: string | undefined` so `process.env.*` can be used directly. Runtime validation must reject missing profile `viewKey` values with profile-specific errors and mark unresolved provider secrets unavailable as described below.

Example shape:

```ts
export default {
  providers: [
    {
      id: "poe-main",
      type: "poe",
      apiKeyEnv: "POE_API_KEY"
    },
    {
      id: "manual-main",
      type: "manual"
    }
  ],
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
          limit: 1_000_000,
          usageFilter: { usageTypes: ["API"] },
          display: { module: "balance-card" },
          window: {
            kind: "calendar",
            period: "month",
            timezone: "Asia/Shanghai",
            anchor: { dayOfMonth: 1, timeOfDay: "00:00" }
          }
        }
      ]
    },
    {
      id: "cursor",
      name: "Cursor Pro",
      providerId: "manual-main",
      metrics: [
        {
          id: "fast-requests",
          label: "Fast requests",
          limit: 500,
          used: 124,
          unit: "requests",
          window: {
            kind: "calendar",
            period: "month",
            timezone: "Asia/Shanghai",
            anchor: { dayOfMonth: 1, timeOfDay: "00:00" }
          },
          display: { module: "period-quota-card" }
        },
        {
          id: "trial-window",
          label: "Trial quota",
          limit: 100,
          used: 20,
          unit: "credits",
          window: {
            kind: "fixed",
            startsAt: "2026-06-25T00:00:00+08:00",
            resetAt: "2026-07-01T00:00:00+08:00"
          },
          display: { module: "period-quota-card" }
        },
        {
          id: "five-hour-messages",
          label: "5h messages",
          limit: 50,
          used: 18,
          unit: "messages",
          updatedAt: "2026-06-25T10:00:00+08:00",
          window: {
            kind: "rolling",
            duration: "5h"
          },
          display: { module: "rolling-window-card" }
        }
      ]
    }
  ],
  profiles: [
    {
      id: "self",
      name: "Personal",
      viewKey: process.env.SELF_DASHBOARD_VIEW_KEY,
      subscriptionIds: ["poe-api", "cursor"]
    }
  ]
}
```

Config validation rules:

- Provider IDs must be unique.
- Subscription IDs must be unique.
- Profile IDs must be unique.
- Every subscription must reference an existing provider.
- Every profile subscription reference must exist.
- Each profile must have a non-empty `viewKey`.
- `viewKey` values resolved from `process.env` must be checked at startup; missing env values should produce profile-specific validation errors.
- Poe providers may use `apiKeyEnv` or direct `apiKey`. If `apiKeyEnv` resolves, use it. If `apiKeyEnv` is configured but missing and direct `apiKey` is present, use direct `apiKey` with a safe warning. If neither resolves, the provider is unavailable for refresh but the dashboard can still serve other subscriptions.
- Metric IDs must be unique within each subscription.
- Calendar windows must set `timezone` and exactly one of `resetAt` or `anchor` in config.
- Calendar `anchor` fields must match the selected `period`.
- Rolling windows must set `duration` matching `/^\d+(m|h|d)$/`.
- Fixed windows must set both `startsAt` and `resetAt`, with `startsAt < resetAt`.
- Metric display modules must be one of `balance-card`, `rolling-window-card`, `period-quota-card`, or `manual-status-card`.
- Manual metrics with `window.kind: "rolling"` must set `updatedAt`; after `updatedAt + duration`, current-window usage and range stats become unknown unless refreshed.
- Manual metrics may set `sourceValueKind`. If omitted, infer `gauge-used` when `used` is present, `gauge-remaining` when only `remaining` is present, and `status` when neither numeric field is present. If both `used` and `remaining` exist, use `gauge-used` unless `sourceValueKind` says otherwise.
- Invalid manual metrics should produce config-path-specific errors.

Missing provider secrets should mark that provider unavailable instead of crashing the whole dashboard. Structural config errors unrelated to secrets should fail startup.

## Poe Provider

Poe is the first real provider. It tracks Poe API points and usage history through Poe's Usage API.

Provider behavior:

- Resolve API key from `apiKeyEnv` first when that environment variable is set. If `apiKeyEnv` is configured but missing and `apiKey` is also configured, fall back to `apiKey` and emit a safe warning. If neither resolves, mark the provider unavailable.
- Query Poe Usage API for balance and usage history.
- Normalize Poe response into quota metrics.
- Prefer API-provided usage history for range consumption.
- Fall back to snapshot deltas when history is insufficient.
- Treat unsupported or absent Poe fields as `unknown` rather than fabricating `used`, `remaining`, reset time, or history.

Verified Poe Usage API contract for MVP:

- Auth: `Authorization: Bearer <POE_API_KEY>`.
- Balance endpoint: `GET https://api.poe.com/usage/current_balance`.
- Balance response: `{ "current_point_balance": number }`.
- History endpoint: `GET https://api.poe.com/usage/points_history`.
- History query params: `limit` with max `100`; optional `starting_after` cursor using the last entry's `query_id`.
- History response: `{ has_more: boolean, length: number, data: PoeUsageEntry[] }`.
- `PoeUsageEntry` fields used by MVP: `query_id`, `creation_time` in microseconds, `cost_points`, `bot_name`, `usage_type`, and optional `api_key_name`.
- History order: descending by creation time. The API can fetch data up to 30 days old.
- Auth failure: `401` with JSON error. Dashboard should mark provider unavailable and keep stale cache if present.
- Poe API subscription history filters default to `usage_type == "API"`. Config may override filters by `usageTypes`, `apiKeyName`, or model/bot name later. Balance remains account-wide because Poe exposes account balance, not per-filter balance.

Poe history uses `query_id` as the provider event ID. If a response lacks `query_id`, import it as an aggregate row keyed by source timestamp and page cursor, not as a unique event.

Poe incremental import watermark:

- Store watermark as `(maxCreationTime, importedQueryIdsAtMaxCreationTime)`, not `query_id` lexical order.
- Fetch pages in descending creation time.
- Import entries with `creation_time == maxCreationTime` idempotently if their `query_id` is not already in `importedQueryIdsAtMaxCreationTime`.
- Stop pagination once all remaining entries on the current page are strictly older than `maxCreationTime`, or equal to it with already imported `query_id` values.
- Use `query_id` only for pagination cursor and event identity.

Initial Poe metrics:

- API points balance
- Remaining points from `current_point_balance`
- Monthly limit from config when the Poe API does not expose plan limit
- Used points as `configuredLimit - current_point_balance` only when a configured limit exists
- Monthly reset policy from config when Poe does not return reset timing
- Recent consumption by range: `1h`, `24h`, `7d`, `30d`
- Burn rate by selected range
- Estimated exhaustion time when remaining and burn rate are both available

Metric projection rules:

- Each configured metric may set `providerMetricId`; default is its `id`.
- Provider-returned metrics are matched to configured metrics by `providerAccountId + providerMetricId`, then projected into each configured subscription metric that references that provider metric.
- If two subscriptions intentionally show the same provider metric, each gets its own `metricKey` and display config but shares the same provider source data.
- Provider-returned metrics not declared in config are stored only as provider debug metadata when enabled, not rendered and not snapshotted as first-class metrics.
- Config-declared metrics missing from provider output render with `sourceConfidence: "unknown"` and a safe error or unavailable state.
- Snapshot writes use the configured `subscriptionId` and `metricId`; no undeclared provider metric can create a user-visible `metricKey`.
- Provider-native history is projected into metric-specific history events after applying each configured metric's filter. For Poe, default filter is `usage_type == "API"`; `apiKeyName` and `botName` filters narrow the history further when configured.
- Summary aggregation dedupes balance/remaining metrics by provider source identity `providerAccountId + providerMetricId` unless a metric explicitly opts into duplicate summary inclusion later. Consumption and burn-rate aggregation uses `providerAccountId + providerMetricId + normalizedUsageFilter`, so filtered Poe metrics do not collapse into unfiltered account totals.

## Manual Provider

Manual provider lets config define quotas for subscriptions without an API.

Manual metrics may include:

- `limit`
- `used`
- `remaining`
- `unit`
- `window`
- `display.module`
- `notes`
- `updatedAt`

Manual config should prefer explicit `window` definitions. A top-level `resetAt` shorthand is not part of MVP; use `window: { kind: "fixed", startsAt, resetAt }` for one-time windows.

Manual metrics can still be snapshotted on service start and refresh. Because MVP has no admin UI or hot reload, changes made to `dashboard.config.ts` appear after service restart or an explicit future config reload command.

## Storage

Use SQLite under `data/dashboard.db` by default.

Tables:

- `provider_cache`: latest normalized provider payload per provider account, with `providerAccountId`, `fetchedAt`, `staleAfter`, `status`, and safe error summary.
- `quota_snapshots`: append-only metric observations, keyed by `metricKey`, `timestamp`, and `source`.
- `provider_history_events`: projected provider-native usage events, keyed by provider account, provider event ID or source timestamp, metric key, and normalized usage filter.
- `provider_import_state`: provider pagination and watermark state per provider account after importing account-wide raw history.
- `refresh_runs`: refresh status, duration, provider errors, and affected provider accounts.

Initial schema details:

- `schema_migrations(version integer primary key, applied_at text not null)` tracks schema version.
- `provider_cache(provider_account_id text primary key, fetched_at text not null, stale_after text not null, status text not null, normalized_json text not null, error_json text)` stores normalized account data as JSON for MVP.
- `provider_cache.normalized_json` stores a redacted JSON object shaped as `{ metrics: NormalizedMetric[] }`. Provider-native history lives in `provider_history_events`; provider errors live in `error_json`.
- `quota_snapshots(id integer primary key, provider_account_id text not null, subscription_id text not null, metric_id text not null, metric_key text not null, timestamp text not null, source text not null, source_value_kind text not null, authoritative_value real, used real, remaining real, limit_value real)` stores stats inputs.
- `provider_history_events(provider_account_id text not null, metric_key text not null, provider_metric_id text not null, normalized_usage_filter text not null, provider_event_id text not null, source_timestamp text not null, value real not null, value_kind text not null, raw_json text, primary key(provider_account_id, metric_key, provider_event_id))` stores provider-native events after projection to configured metrics.
- `provider_import_state(provider_account_id text primary key, max_creation_time integer, imported_query_ids_at_max_json text not null default '[]', updated_at text not null)` stores Poe and future provider watermarks.
- `refresh_runs(id integer primary key, started_at text not null, finished_at text, status text not null, provider_account_ids_json text not null, error_json text)` stores refresh audit data.

Stats source precedence:

1. Provider-native history events, when the verified provider contract exposes enough data for the requested range.
2. Local snapshot deltas when provider history is unavailable.
3. Unknown stats when neither source has enough samples or semantics.

Provider history imports must use idempotent upserts. Provider adapters return raw account-level history events; refresh projection applies each configured metric's `usageFilter` and writes projected metric-specific rows to `provider_history_events`. Use provider event ID when available. If no provider event ID exists, import aggregate rows with a generated key formatted as `fallback:${providerAccountId}:${metricKey}:${sourceTimestamp}:${pageCursor}:${rowIndex}`, or skip event-level import if that cannot be stable. Keep a high-watermark per provider account only after importing raw history for all configured metrics on that provider account, not only the currently visible profile.

`metricKey` format is `providerAccountId/subscriptionId/metricId`, with each segment URL-encoded before joining. Storage and API must use the same helper to build this key.

SQLite operational rules:

- Use migrations for schema changes.
- Enable WAL mode and a busy timeout.
- Serialize writes through one storage layer.
- Wrap refresh writes in transactions.
- Create `data/` with owner-only permissions where possible.
- Define retention for raw debug payloads and old snapshots.
- Keep backup guidance in README for long-running local use.

Retention defaults:

- Keep `quota_snapshots` for 90 days.
- Keep `provider_history_events` for 35 days for Poe because Poe history is limited to 30 days.
- Keep `refresh_runs` for 30 days.
- Keep raw debug payloads for 7 days only when debug storage is enabled.

Refresh cadence:

- MVP supports manual refresh.
- Optional scheduler can refresh configured provider accounts at a coarse cadence, for example every 15 minutes.
- Burn-rate stats require at least two usable samples inside or around the selected range; otherwise show `unknown` or `insufficient data`.

Concurrency control:

- Refresh uses a per-`providerAccountId` singleflight lock.
- Storage writes happen inside one transaction per provider account refresh.
- Duplicate refresh requests for the same provider account wait for the in-flight refresh result instead of writing duplicate snapshots.
- Global provider refresh concurrency defaults to `2`.

Provider interface:

```ts
type ProviderAdapter = {
  type: string
  refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult>
}

type ProviderRuntimeState = {
  available: boolean
  apiKey?: string
  reason?: string
}

type ProviderImportState = {
  maxCreationTime?: number
  importedQueryIdsAtMaxCreationTime: string[]
}

type ProviderRefreshInput = {
  providerAccountId: string
  provider: ProviderAccountConfig
  runtime: ProviderRuntimeState
  now: string
  metrics: MetricConfig[]
  importState?: ProviderImportState
}

type ProviderRefreshResult = {
  providerAccountId: string
  fetchedAt: string
  staleAfter: string
  metrics: NormalizedMetric[]
  historyEvents?: ProviderHistoryEvent[]
  nextImportState?: ProviderImportState
  errors?: Array<{ message: string; retryable: boolean }>
}

type NormalizedMetric = {
  providerMetricId: string
  label: string
  unit: string
  limit?: number
  used?: number
  remaining?: number
  authoritativeValue?: number
  sourceValueKind: "counter" | "gauge-remaining" | "gauge-used" | "status"
  window?: LimitWindow
  suggestedDisplayModule?: "balance-card" | "rolling-window-card" | "period-quota-card" | "manual-status-card"
  sourceConfidence: "known" | "estimated" | "unknown"
  notes?: string
  updatedAt?: string
}

type ProviderHistoryEvent = {
  providerMetricId: string
  providerEventId?: string
  sourceTimestamp: string
  value: number
  valueKind: "used" | "remaining" | "consumption" | "percentUsed"
  usageType?: string
  apiKeyName?: string
  botName?: string
  pageCursor?: string
  rowIndex?: number
  raw?: unknown
}
```

Provider adapters return normalized metrics, optional raw provider-native history events, suggested display modules, and source confidence. Config can override display modules and reset policy. Refresh projection, not provider adapters, maps raw history events to configured `metricKey` rows after applying default and configured usage filters.

Provider adapter factories are stateless. Resolved credentials and watermark state are passed through `ProviderRefreshInput.runtime` and `ProviderRefreshInput.importState` so one adapter instance can refresh multiple provider accounts without storing secrets in closures.

## API Design

### `GET /health`

Returns process health for local long-running service monitoring.

Behavior:

- Return `200` when server is alive and SQLite can be opened.
- Return `503` when SQLite is unavailable.
- Do not check external providers.

### `POST /api/session/:profileId`

Validates a profile `viewKey` and creates a short-lived HttpOnly session.

Behavior:

- Accept `viewKey` in request body or `Authorization` header, not URL query.
- Validate with constant-time comparison.
- Rate-limit failed attempts by IP and profile ID.
- Return only session status and safe profile metadata.
- Session cookie attributes: `HttpOnly`, `SameSite=Lax` for local UX, `Secure` when served over HTTPS, `Path=/`, and `Max-Age=86400` by default.
- Use a signed cookie containing profile ID, key version or view-key hash, issued-at, and expiry. Changing the profile `viewKey` invalidates old sessions because the hash no longer matches.
- Cookie names are profile-scoped as `sqd_session_${encodeURIComponent(profileId)}`, and the signed payload profile ID must match the route profile ID. Opening two profiles in the same browser must not invalidate the other profile's session cookie.
- Session signing uses `SESSION_SECRET`, a stable secret with at least 256 bits of entropy. If missing in development, generate an in-memory dev secret and warn that sessions will be invalidated on restart. If missing when `NODE_ENV=production`, fail startup. Rotating `SESSION_SECRET` invalidates all sessions.
- Require `Content-Type: application/json` for body-based `viewKey` submission.
- Validate `Origin` for cookie-authenticated or body-authenticated session requests when an `Origin` header is present.

### `GET /api/dashboard/:profileId`

Returns the dashboard payload for one profile.

Behavior:

- Validate session cookie or `Authorization: Bearer <viewKey>`.
- Do not trigger external provider requests.
- Return cached provider data, manual metrics, stat ranges, stale state, and errors.
- Project account-scoped cache through the active profile's `subscriptionIds` allowlist before creating the response.
- Filter all secrets from response.
- Send `Cache-Control: no-store`.
- Accept optional `range=1h|24h|7d|30d`; default is `24h`.

### `POST /api/dashboard/:profileId/refresh`

Refreshes provider data for subscriptions visible in the profile.

Behavior:

- Validate session cookie or `Authorization: Bearer <viewKey>`.
- Rate-limit manual refresh by profile ID, IP, and provider account ID.
- Use singleflight per `providerAccountId` so simultaneous profiles share one refresh.
- Apply global provider-refresh concurrency caps.
- Validate `Origin` for cookie-authenticated mutating requests when an `Origin` header is present.
- Query required provider accounts.
- Write cache and snapshots.
- Return updated dashboard payload.
- If a provider fails and old cache exists, return stale data with an error marker.
- Send `Cache-Control: no-store`.

### Optional History Endpoint

`GET /api/dashboard/:profileId/subscriptions/:subscriptionId/metrics/:metricId/history?range=1h|24h|7d|30d`

This may be deferred. MVP can include history data directly in the dashboard payload.

## Dashboard Payload

The frontend should receive a normalized, UI-ready payload:

```ts
type DashboardPayload = {
  profile: {
    id: string
    name: string
  }
  generatedAt: string
  ranges: Array<"1h" | "24h" | "7d" | "30d">
  selectedRange: "1h" | "24h" | "7d" | "30d"
  summaryGroups: Array<{
    id: string
    label: string
    unit: string
    providerType?: string
    sourceValueKind: "counter" | "gauge-remaining" | "gauge-used" | "status"
    windowGroup: "same-reset" | "mixed-reset" | "rolling" | "none"
    normalizedUsageFilter?: string
    remaining?: number
    consumption?: number
    burnRate?: { value: number; per: "hour" }
    estimatedExhaustionAt?: string
    estimatedExhaustionConfidence?: "known" | "conservative"
  }>
  subscriptions: Array<{
    id: string
    name: string
    ui?: {
      color?: string
      group?: string
      sort?: number
    }
    status: "ok" | "warn" | "critical" | "stale" | "unavailable" | "expired"
    lastRefreshAt?: string
    metrics: Array<{
      id: string
      providerMetricId?: string
      metricKey: string
      label: string
      unit: string
      status: "ok" | "warn" | "critical" | "stale" | "unavailable" | "expired"
      limit?: number
      used?: number
      remaining?: number
      window?: {
        kind: "calendar" | "rolling" | "fixed"
        label: string
        resetAt?: string
        timezone?: string
        duration?: string
        windowStartAt?: string
        anchor?: {
          dayOfWeek?: number
          dayOfMonth?: number
          monthOfYear?: number
          timeOfDay?: string
        }
      }
      display: {
        module: "balance-card" | "rolling-window-card" | "period-quota-card" | "manual-status-card"
        title?: string
        subtitle?: string
        notes?: string
        updatedAt?: string
        sourceConfidence?: "known" | "estimated" | "unknown"
        usageFilter?: {
          usageTypes?: string[]
          apiKeyName?: string
          botName?: string
        }
        thresholds?: {
          warnPercentUsed?: number
          criticalPercentUsed?: number
          warnRemaining?: number
          criticalRemaining?: number
        }
      }
      percentUsed?: number
      rangeStats?: {
        range: "1h" | "24h" | "7d" | "30d"
        source: "provider-history" | "snapshot-delta" | "manual" | "unknown"
        consumption?: number
        burnRate?: { value: number; per: "hour" }
        estimatedExhaustionAt?: string
        series?: Array<{ timestamp: string; value: number; valueKind: "used" | "remaining" | "consumption" | "percentUsed" }>
      }
    }>
    errors?: Array<{ message: string; stale: boolean }>
  }>
}
```

Payload mapping rules:

- `selectedRange` defaults to `24h` unless API `range` is provided.
- `summaryGroups` aggregate only metrics with the same `unit`, `sourceValueKind`, and compatible window semantics. Do not add points, requests, and messages into one total.
- `summaryGroups.id` is a stable key built from unit, provider type, source value kind, window group, and normalized usage filter when consumption or burn-rate is filter-specific.
- Summary aggregation dedupes account-scoped provider metrics by `providerAccountId + providerMetricId` to avoid counting the same provider balance twice when multiple subscriptions display it.
- `summaryGroups.estimatedExhaustionAt` is emitted only when all included metrics share compatible reset semantics. Otherwise omit it or use the earliest member exhaustion time and set `estimatedExhaustionConfidence: "conservative"`; known values use `"known"` or omit the confidence field.
- `burnRate` is always normalized to units per hour.
- `window.label` is server-generated from normalized window data, for example `Monthly`, `Weekly`, `Rolling 5h`, or `Fixed window` plus reset text when known. Config may later add a label override.
- Calendar payload may include `anchor` so UI can describe recurring reset rules.
- Rolling payload includes `duration`; it includes `windowStartAt` only when provider/event history supports it.
- `percentUsed` is omitted when `limit` is absent or zero. When `used > limit`, keep the raw value and cap visual bar width at 100% while status becomes `critical`.
- `percentUsed` uses a `0..100` scale.
- `series` values must set `valueKind`, so UI knows whether the series is used, remaining, consumption, or percent. Every item in one `series` must have the same `valueKind`; split multiple kinds into separate series later if needed. For `valueKind: "consumption"`, each point is the bucket sum for the interval ending at `timestamp`, not a cumulative total.
- Range series should be downsampled to at most 60 points per metric per range using uniform time-bucket sampling for MVP, preserving first and last point in the range.
- For rolling metrics, range stats are available only when provider history or sufficient event data covers that range. If selected range is shorter than rolling duration, stats describe consumption inside the selected subrange; if selected range is longer, stats describe total consumption across the selected range, not current-window occupancy.

## UI Design

Use a dark, dense operations-dashboard style.

Frontend routing:

- Client routing uses `/d/:profileId` and reads optional `range=1h|24h|7d|30d` from the query string. `/d/:profileId` defaults to `range=24h`.
- `/d/:profileId?range=24h` is the canonical range URL form. Do not use path segments for range selection in MVP.
- Invalid client range values render a 404 view and do not call the dashboard API. Invalid API `range` query values return `400` with a safe error body.
- Unknown client routes render a 404 view. Server SPA fallback may serve the shell for `/d/:profileId/*`, but the client decides whether that path is a valid route.
- `/api/*`, `/health`, and `/assets/*` must never fall through to the SPA shell.

Auth gate state machine:

- `checking-session`: initial state for direct route visits. Call `getDashboard(profileId, range)` with existing cookies. `200` transitions to `authenticated` and passes the payload to the dashboard component so it does not re-fetch; `401` before any prior authenticated state transitions to `unauthenticated`; network or `5xx` transitions to the full-page network error state.
- `unauthenticated`: show a centered view-key form with `<input type="password">`, a visible `<label>`, and copy `Enter view key for this dashboard`.
- `submitting`: disable the form submit button and show `Checking view key...`.
- `authenticated`: fetch and display dashboard data for the parsed profile ID and selected range.
- `expired`: API `401` after a prior authenticated state clears the stale session state, preserves the current route and range, shows the view-key form, and displays `Session expired. Enter your view key again.`.
- `createSession()` `401` keeps the user in `unauthenticated`, clears the input value, focuses it, and shows `Invalid view key.`. `429` shows `Too many attempts. Try again later.`. The client does not maintain its own failed-attempt counter.
- Direct visits to `/d/:profileId?range=<range>` parse and store the range before auth, so successful login returns to the intended range.

Loading, empty, and error states:

- Initial dashboard fetch uses a full-page skeleton with header and card silhouettes, not a blank screen.
- Profiles with no visible subscriptions show an empty state: `No subscriptions configured for this profile.`.
- Network failure or API `500` shows a full-page error with a retry button that re-runs `getDashboard` for the same profile and range.
- If every visible subscription is `unavailable`, keep the header and summary shell, then show a dashboard-level unavailable banner plus greyed subscription cards.

Refresh interaction:

- Refresh button states are `idle`, `refreshing`, `success`, `rate-limited`, and `error`.
- `refreshing` disables the button and shows spinner text `Refreshing...`.
- `success` shows `Updated` for 2 seconds, then returns to `idle`.
- `error` shows `Refresh failed` and a retry button state until the next successful refresh or range/dashboard reload.
- `rate-limited` uses `Retry-After` response header when present, otherwise `30` seconds. The button stays disabled and shows `Retry in Ns` until the countdown ends, then returns to `idle`.
- Partial success with one or more stale provider errors returns to `idle` and shows a warning icon in the header plus subscription-level stale banners.
- Refresh provider failure with stale cache returns to `idle`; the payload error banner communicates the stale state.

Range switching:

- Range buttons update the query string to `?range=<range>` and call `getDashboard(profileId, range)`.
- Range changes do not optimistically recalculate stats from old series. They show a small range-stat skeleton inside metric cards while keeping the previous dashboard shell visible until the new payload arrives.
- In-flight range requests use `AbortController`; stale responses must not overwrite newer range state.

Time display:

- All timestamps render in the browser's local timezone.
- Use semantic `<time dateTime="ISO">` elements. The visible label uses relative copy when useful, such as `3m ago`, `in 2h`, or `tomorrow 00:00`; the `title` attribute contains the original ISO string.
- Reset text can combine relative and absolute context, for example `resets tomorrow 00:00`.
- `estimatedExhaustionAt` in the past displays `overdue`.
- Config/provider timezone can be shown as secondary text only when it differs from the browser timezone and the window policy depends on it.

Number display:

- `formatNumber(value)` uses browser locale formatting: values below `1000` show the raw rounded value, values below `1_000_000` use thousands separators, and values at or above `1_000_000` use compact one-decimal notation such as `1.2M`.
- Burn rate displays two decimals plus `/h`, for example `123.46/h`.
- Percent used displays `Math.round(percentUsed)%`. If `used > limit`, display `>100%` while capping the visual bar at 100%.

Summary row:

- Each `summaryGroup` renders as one compact summary card.
- Card contents: `label`, large `remaining` when present otherwise `-`, selected-range `consumption`, `burnRate`, and `estimatedExhaustionAt` or `-` when unavailable.
- Conservative exhaustion estimates use an `≈` prefix and accessible label `conservative estimate` only when `estimatedExhaustionConfidence === "conservative"`.

Sparkline:

- Sparkline is an inline SVG component using one `<polyline>`, `width="100%"`, height `24`, no charting library.
- Stroke uses the metric status color; fill is transparent.
- Hide sparkline entirely when `rangeStats.series` is absent or shorter than two points.
- `balance-card` sparklines use remaining-like series when present; `period-quota-card` uses used-like series; `rolling-window-card` uses selected-range consumption.

Design tokens:

```css
:root {
  --bg-app: #0d1117;
  --bg-card: #161b22;
  --bg-elevated: #1f2937;
  --text-primary: #e6edf3;
  --text-secondary: #8b949e;
  --text-muted: #6e7681;
  --border-subtle: #30363d;
  --status-ok: #3fb950;
  --status-warn: #d29922;
  --status-critical: #f85149;
  --status-stale: #8b949e;
  --status-unavailable: #6e7681;
  --status-expired: #bc8cff;
  --accent: #58a6ff;
}
```

- Status is never conveyed by color alone. Use icon plus text: `ok` uses `✓`, `warn` uses `!`, `critical` uses `x`, `stale` uses `~`, `unavailable` uses `⊘`, and `expired` uses `⌛`.
- `ui.color` controls subscription accent border and small decorative elements. Status color controls the status icon/badge and critical progress states.

Responsive layout:

- `>= 1200px`: subscription grid uses 3 columns; summary grid uses 4 columns.
- `768px` through `1199px`: subscription grid uses 2 columns; summary grid uses 2 columns.
- `< 768px`: subscription grid uses 1 column; summary uses one column with optional horizontal scroll for dense groups.

Accessibility:

- Progress bars use `role="progressbar"`, `aria-valuemin="0"`, `aria-valuemax="100"`, and `aria-valuenow` when known.
- Error banners use `role="alert"`.
- View-key input has a visible `<label>`, `type="password"`, and focus returns to the field on auth failure.
- Range buttons expose `aria-pressed`; refresh button has accessible loading text.
- Metric cards and controls follow DOM order: header, auth/range controls, summary, subscription cards, metric cards.
- Respect `prefers-reduced-motion: reduce` by disabling spinner animation and sparkline transitions.
- Add `prefers-contrast: more` styles with stronger borders and text contrast.

Error display rules:

- Subscription `unavailable` greys the card, shows a centered error message, and hides metric details unless cached metric data exists.
- `stale: true` subscription errors render a warning banner at the card top. `stale: false` errors render a critical banner.
- Metric `rangeStats.source: "unknown"` renders `insufficient data` where consumption/burn-rate would appear.
- Provider errors never reveal provider secrets or raw request data.

Document and lifecycle behavior:

- `document.title` is `${profile.name} · Quota Dashboard` after dashboard load. If dashboard-level unavailable state exists, prefix `! `.
- MVP has no auto-polling. It refreshes only via manual refresh and one `visibilitychange` refetch when the tab returns to foreground after at least 5 minutes hidden.
- Print styles use light background, dark text, hide refresh/auth controls, and preserve metric values.
- Favicon is not part of MVP.

Sections:

- Header: profile name, last refresh, stale badge, refresh button
- Summary row: grouped remaining, selected-range consumption, burn rate, and estimated exhaustion by unit or provider type
- Subscription card grid: one card per configured subscription
- Metric sub-cards or rows: each metric uses its own `display.module` layout inside the subscription card
- Usage panel: `1h / 24h / 7d / 30d` range switch
- Error banner: provider failed, stale cache, missing config, refresh limited

Display modules:

- `balance-card`: emphasizes remaining balance, monthly reset, and selected-range burn rate.
- `rolling-window-card`: emphasizes current rolling-window usage, window duration, and next reset when known.
- `period-quota-card`: emphasizes used versus limit for a calendar period and its reset rule.
- `manual-status-card`: emphasizes manually entered status, notes, and last update.

Status calculation:

- Status precedence is `expired > unavailable > critical > warn > stale > ok`.
- Subscription status is the highest-precedence status among its metric statuses and subscription-level errors.
- Default `warn` threshold: `percentUsed >= 80` when `percentUsed` exists.
- Default `critical` threshold: `percentUsed >= 95` when `percentUsed` exists.
- Metrics may override thresholds through `display.thresholds`.
- Rolling metric at or above limit is `critical`.
- Fixed metric past `resetAt` is `expired` unless provider/config supplies a new window.
- If usage is unknown but provider/cache is healthy, status is `ok` with unknown stats.
- If cached data is past `staleAfter`, status is `stale` only when no higher-precedence status applies.
- Metrics without `limit` do not show a percent progress bar; they show remaining or status text only.

Visual constraints:

- No charting library for MVP.
- Use CSS bars and small inline SVG or CSS sparklines if needed.
- Desktop uses compact grid.
- Mobile uses single-column cards and compact summary layout.

## Error Handling

- Invalid `viewKey`: `401`.
- Missing profile: `404`.
- Provider request failure: keep old cache if present, mark stale, include safe error text.
- Provider failure with no cache: mark subscription unavailable.
- Refresh too frequent: `429`.
- SQLite write failure during refresh: return refresh error while keeping old cache readable.
- Structural config errors: fail startup with actionable path-specific messages.
- Missing provider secret: provider unavailable; dashboard still loads where possible.
- Insufficient samples for a selected range: return stats with `source: "unknown"` and safe explanation.
- Unsupported provider data: show available metrics and mark unsupported fields unknown.

Operational defaults:

- Provider cache `staleAfter` defaults to 15 minutes unless provider/config overrides it.
- Manual refresh rate limit defaults to one accepted refresh per provider account every 30 seconds.
- Invalid auth attempts default to 10 attempts per IP/profile per 5 minutes.
- All rate-limit values should be configurable.

Environment:

- Production serves SPA and API from the same origin.
- Development may allow CORS from localhost Vite dev server only, with explicit origins such as `http://localhost:5173` and `http://127.0.0.1:5173`, methods `GET` and `POST`, headers `Content-Type` and `Authorization`, and credentials enabled for session cookies.
- Access logging must redact authorization headers, cookies, and request bodies; `viewKey` must never be accepted in query strings.

## Security

- `viewKey` protects dashboard read and refresh access. It is separate from Poe API credentials.
- `viewKey` must not be placed in URLs.
- Auth uses an `Authorization` header for first validation and a short-lived HttpOnly session cookie afterwards.
- Poe API keys stay server-side.
- Responses must never include `viewKey`, `apiKey`, or resolved `apiKeyEnv` values.
- Logs must not include secrets or raw authenticated request headers.
- Dashboard APIs must send `Cache-Control: no-store`.
- `Cache-Control: no-store` applies to API responses only. Vite static assets may use normal hashed-asset caching.
- App responses should set `Referrer-Policy: no-referrer`.
- Invalid auth attempts should be rate-limited by IP and profile ID.
- Refresh endpoint should rate-limit by profile ID, IP, and provider account ID.
- Direct `apiKey` in config is supported only for personal local use and should not be shown in committed examples.
- If exposed publicly later, add HTTPS, reverse-proxy hardening, and stronger auth.

## Testing Strategy

- Config validation unit tests for IDs, references, view keys, provider secrets, and manual metric shape.
- Poe provider unit tests using mocked fetch responses.
- Snapshot and stats tests for `1h`, `24h`, `7d`, and `30d` consumption and burn-rate calculations.
- API tests for auth, no URL secrets, dashboard payload, refresh, stale fallback, profile allowlist projection, and rate limiting.
- Window tests for calendar anchors, DST handling, rolling freshness, fixed expiry, and reset-aware delta rules.
- Poe contract tests for balance, paginated history, 401 errors, and 30-day cutoff behavior using mocked fetch responses.
- UI smoke tests for render, range switch, refresh state, error banner, and responsive layout basics.

## MVP Deliverables

- Bun TypeScript project scaffold.
- Hono server.
- Vite React app.
- SQLite schema and storage repository.
- Typed config and example config.
- Poe provider.
- Manual provider.
- Dark dashboard UI with CSS bars.
- README with setup, config, `.env`, run, refresh, and security notes.

## Open Implementation Notes

- Keep provider interfaces small and focused on normalized quota output.
- Keep dashboard API payload UI-ready to avoid duplicating stats logic in React.
- Treat SQLite snapshots as source for local stats, but allow Poe history to override or enrich calculations.
- Avoid admin features until the read-only dashboard works end to end.
- Schema downgrades are not part of MVP; backups plus forward migrations are sufficient for local personal deployment.
