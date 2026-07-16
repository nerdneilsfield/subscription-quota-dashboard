# Extend Providers Design

Date: 2026-07-17
Revised: 2026-07-17 (after adversarial review - corrected Volcengine SigV4, per-provider projection rules, business-error envelopes, MiniMax/Zhipu/ZenMux parsing details, SSRF defense, concurrency, `isOverLimit` generalization)

## Goal

Add 10 new provider adapters to the Subscription Quota Dashboard, sourced from the cc-switch project's proven balance/quota-checking implementations. Covers two families:

- **A 类 - Account Balance (5 providers)**: DeepSeek, StepFun, SiliconFlow, OpenRouter, Novita AI
- **B 类 - Coding Plan / Token Plan (5 providers)**: Kimi, Zhipu (personal), MiniMax, ZenMux, Volcengine

Each adapter fetches current quota/balance via the provider's HTTP API, normalizes to `NormalizedMetric[]`, and integrates with the existing refresh/projection/storage pipeline.

## Non-Goals

- No OAuth-based providers (Claude/Codex/Gemini official subscriptions, GitHub Copilot) - these need separate credential-storage design.
- No Zhipu Team support (only personal); team variant requires org/project IDs and a separate endpoint.
- No currency conversion between CNY and USD; `unit` is a display-only string field.
- No history events (`ProviderHistoryEvent[]`) for these providers - none of the 10 exposes a per-call history endpoint. **All new providers emit `historyEvents: []`; range stats use the existing snapshot-delta path exclusively** (refresh-service already implements snapshot-delta consumption). The adapter contract still accepts `historyEvents`, so future providers that add history endpoints can populate it without contract changes.
- No new UI components - all 10 providers render through existing `balance-card`, `period-quota-card`, `rolling-window-card` modules.

## Architecture

### Per-Provider Adapter Files

Each provider gets its own adapter file under `src/server/providers/`. The Poe adapter (`poe.ts`) is the canonical template. Volcengine is the only one needing an auxiliary file for SigV4 signing.

```
src/server/providers/
├── poe.ts              (existing)
├── manual.ts           (existing)
├── deepseek.ts         ← new
├── stepfun.ts          ← new
├── siliconflow.ts      ← new
├── openrouter.ts       ← new
├── novita.ts           ← new
├── kimi.ts             ← new
├── zhipu.ts            ← new
├── minimax.ts          ← new
├── zenmux.ts           ← new
├── volcengine.ts       ← new (AK/SK SigV4)
├── volcengine-sig.ts   ← new (SigV4 signing utility, imported by volcengine.ts)
└── shared.ts           ← new (parseNumber, isRetryableStatus, authError helpers)
```

### Change Surface

| File | Change |
|---|---|
| `src/shared/domain.ts` | Extend `ProviderAccountConfig` union with 10 new variants; extend `ProviderRuntimeState` with `ak?/sk?` |
| `src/server/config/load-config.ts` | Extract `resolveBearerCredential` (shared by poe + 9 Bearer providers); add `resolveAkSkCredential` (separate, for Volcengine); add SSRF allowlist for `baseUrl` |
| `src/server/main.ts` | Map type `Map<"manual" \| "poe", ...>` -> `Map<string, ProviderAdapter>`; register 10 new adapters |
| `src/server/http/app.ts` | `AppDeps.providers` type synced to `Map<string, ProviderAdapter>` |
| `src/server/dashboard/project.ts` | Generalize `isPoeOverLimit` -> `isOverLimit` (drop Poe-specific condition; cover percent-based and absolute over-limit); `resolveUsageFilter` unchanged |
| `src/server/refresh/refresh-service.ts` | Raise default `concurrencyLimit` from 2 to 8 (12+ adapters at 2 serializes too long) |
| `config/dashboard.config.ts` | Add 10 provider declarations + matching subscriptions/metrics (example config) |
| `.env.example` | Add 12 new env var placeholders |
| `tests/providers/<name>.test.ts` | 10 new test files + `volcengine-sig.test.ts` |
| `tests/providers/shared.test.ts` | New: `parseNumber`, `isRetryableStatus`, auth-error helpers |
| `tests/server/project.test.ts` | New regression: non-Poe gauge-remaining over-limit hits `isOverLimit`; percent-based over-limit (used=100, limit=100) hits critical |
| `tests/config/load-config.test.ts` | New regression: Volcengine AK/SK resolution, Bearer credential shared path, SSRF rejection |

### Unchanged

- **storage / schema**: no new tables or migrations.
- **frontend**: no new components; existing display modules cover all cases.
- **auth**: no credential-storage changes (all secrets via env vars).

## Shared Utilities (`src/server/providers/shared.ts`)

All adapters share helpers extracted from cc-switch's repeated patterns:

### `parseNumber(value: unknown): number | undefined`

Accepts JSON number or numeric string. Mirrors cc-switch's `parse_f64` / `parse_f64_field` (`balance.rs:415-420`, `coding_plan.rs:81-85`). Real provider APIs return numbers as strings in some cases; strict `Number()` would throw.

```ts
export function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string") {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
```

### `isRetryableStatus(status: number): boolean`

`status >= 500 || status === 429`. Shared by all adapters.

### `authError(message: string): { message: string; retryable: false }`

Helper for 401/403. Message format: `"<Provider> authentication failed"`.

## A 类 - Account Balance Providers (5)

### API Summary

Sourced from `cc-switch/src-tauri/src/services/balance.rs`.

| Provider | Endpoint | Auth | Response Path | Unit | Scaling |
|---|---|---|---|---|---|
| DeepSeek | `GET https://api.deepseek.com/user/balance` | `Bearer` | `balance_infos[].total_balance` | CNY | none |
| StepFun | `GET https://api.stepfun.com/v1/accounts` | `Bearer` | `balance` (top-level) | CNY | none |
| SiliconFlow | `GET <baseUrl>/v1/user/info` | `Bearer` | `data.totalBalance` | CNY (CN) / USD (EN) | none |
| OpenRouter | `GET https://openrouter.ai/api/v1/credits` | `Bearer` | `remaining = data.total_credits - data.total_usage` | USD | derived |
| Novita AI | `GET https://api.novita.ai/v3/user/balance` | `Bearer` | `availableBalance` | USD | **÷10000** (raw unit = 0.0001 USD) |

All balance fields use `parseNumber` (string-or-number tolerant). SiliconFlow CN/EN share one adapter with a `baseUrl` field (default `https://api.siliconflow.cn` for CN, user sets `https://api.siliconflow.com` for EN). Currency is implied by host (`.cn` -> CNY, `.com` -> USD) and set in config's `unit` field.

### ProviderAccountConfig Variants

```ts
| { id: string; type: "deepseek"; apiKeyEnv?: string; apiKey?: string }
| { id: string; type: "stepfun"; apiKeyEnv?: string; apiKey?: string }
| { id: string; type: "siliconflow"; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }
| { id: string; type: "openrouter"; apiKeyEnv?: string; apiKey?: string }
| { id: string; type: "novita"; apiKeyEnv?: string; apiKey?: string }
```

### Adapter Output (NormalizedMetric)

All A-class providers emit a single metric with `providerMetricId: "balance"`, `sourceValueKind: "gauge-remaining"`, `sourceConfidence: "known"`.

| Provider | `remaining` | `limit` | `used` | Extra |
|---|---|---|---|---|
| DeepSeek | `balance_infos[0].total_balance` | undefined | undefined | `notes`: "Insufficient balance" if `is_available === false` |
| StepFun | `balance` | undefined | undefined | - |
| SiliconFlow | `data.totalBalance` | undefined | undefined | - |
| OpenRouter | `total_credits - total_usage` | `total_credits` | `total_usage` | `notes`: "No credits remaining" if `remaining <= 0` |
| Novita | `availableBalance / 10000` | undefined | undefined | `notes`: "No balance remaining" if `remaining <= 0` |

DeepSeek iterates all `balance_infos[]` entries but emits only the first (cc-switch does the same - one currency per account is the norm). `window` is undefined for all (balance has no period).

### Error Handling

Identical to Poe:
- 401/403 -> `authError("<Provider> authentication failed")`, `retryable: false`
- 5xx / 429 -> `retryable: true` (via `isRetryableStatus`)
- Network error -> `retryable: true`
- JSON parse failure or missing field -> `retryable: false`, `metrics: []`

### staleAfter

`fetchedAt + 15min` (same as Poe).

## B 类 - Coding Plan Providers (5)

### API Summary

Sourced from `cc-switch/src-tauri/src/services/coding_plan.rs`.

| Provider | Endpoint | Auth | Business Error Envelope | Response Structure |
|---|---|---|---|---|
| Kimi | `GET https://api.kimi.com/coding/v1/usages` | `Bearer` | none (HTTP status only) | `limits[].detail.{limit, remaining, resetTime}` OR `usage.{limit, remaining, resetTime}` |
| Zhipu (personal) | `GET <baseUrl>/api/monitor/usage/quota/limit` (default `https://open.bigmodel.cn`, EN: `https://api.z.ai`) | `Authorization: <key>` **(NO Bearer prefix)** | `success: false` -> error from `msg` | `data.limits[]` with `type=="TOKENS_LIMIT"`, classified by `unit` field |
| MiniMax | `GET <baseUrl>/v1/api/openplatform/coding_plan/remains` (CN: `https://api.minimaxi.com`, EN: `https://api.minimax.io`) | `Bearer` | `base_resp.status_code != 0` -> error from `status_msg` | `model_remains[]` filtered to `model_name=="general"` |
| ZenMux | `GET <baseUrl>` (required, user-supplied) | `Bearer` | `success != true` -> error from `message` | `data.{quota_5_hour, quota_7_day}.{usage_percentage, resets_at, used_value_usd, max_value_usd}`, `data.plan.tier` |
| Volcengine | Control plane `POST https://open.volcengineapi.com` (two actions, fallback) | AK/SK SigV4 | `ResponseMetadata.Error` with auth-code classification | `GetAFPUsage` -> AFPFiveHour/AFPWeekly/AFPMonthly; `GetCodingPlanUsage` -> percentage (fallback) |

### ProviderAccountConfig Variants

```ts
| { id: string; type: "kimi"; apiKeyEnv?: string; apiKey?: string }
| { id: string; type: "zhipu"; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }
| { id: string; type: "minimax"; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }
| { id: string; type: "zenmux"; baseUrl: string; apiKeyEnv?: string; apiKey?: string }
| { id: string; type: "volcengine"; region?: string; akEnv?: string; ak?: string; skEnv?: string; sk?: string }
```

`zenmux.baseUrl` is required (each deployment has a unique domain). Others have optional `baseUrl` with documented defaults.

### Zhipu Auth Quirk

Zhipu's `Authorization` header carries the raw API key with **no "Bearer " prefix** (cc-switch `coding_plan.rs:325`):

```ts
headers.set("Authorization", apiKey)  // NOT `Bearer ${apiKey}`
```

Credential resolution in load-config stays uniform (apiKeyEnv/apiKey); only the adapter's header construction differs.

### Per-Adapter Metric Output

#### Kimi

Produces up to 2 metrics (cc-switch `coding_plan.rs:148-194`):

- **five_hour** (from `limits[].detail`): `providerMetricId: "five_hour"`, `limit = detail.limit`, `remaining = detail.remaining`, `used = max(0, limit - remaining)`, `window.resetAt = detail.resetTime`, `sourceValueKind: "gauge-remaining"`
- **weekly_limit** (from top-level `usage`): `providerMetricId: "weekly_limit"`, same fields from `usage.{limit, remaining, resetTime}`, `sourceValueKind: "gauge-remaining"`

Each metric present only if the corresponding JSON section exists. No business-error envelope (HTTP status only).

#### Zhipu (personal)

Produces up to 2 metrics (cc-switch `coding_plan.rs:224-298`). **Not "analogous to Kimi"** - uses `unit` field classification:

- Filters `data.limits[]` to `type == "TOKENS_LIMIT"` (case-insensitive)
- **`unit: 3`** -> `five_hour` window: `providerMetricId: "five_hour"`
- **`unit: 6`** -> `weekly_limit` window: `providerMetricId: "weekly_limit"`
- **Fallback heuristic** (when `unit` missing/unrecognized): no-`nextResetTime` entries -> five_hour first; remaining by `nextResetTime` ascending
- Each entry: `percentage` field -> `used`, `limit = 100`, `remaining = 100 - percentage`, `window.resetAt = nextResetTime`, `sourceValueKind: "gauge-used"`
- `notes`: `data.level` (plan tier name) if present

Business envelope: `body.success === false` -> error from `body.msg`, emit `metrics: []` + error.

#### MiniMax

Produces 1 or 2 metrics (cc-switch `coding_plan.rs:639-695`). **Critical filter**: only `model_name == "general"` entries are processed; `video`/`audio`/etc. are skipped.

- **five_hour** (always present for general): `providerMetricId: "five_hour"`, `remaining = current_interval_remaining_percent`, `limit = 100`, `used = 100 - remaining`, `resetAt = end_time`, `sourceValueKind: "gauge-remaining"`
- **weekly_limit** (only when `current_weekly_status == 1`): `providerMetricId: "weekly_limit"`, `remaining = current_weekly_remaining_percent`, `limit = 100`, `used = 100 - remaining`, `resetAt = weekly_end_time`, `sourceValueKind: "gauge-remaining"`
- `notes`: `"Weekly status: <current_weekly_status>"` when weekly tier present

`current_weekly_status == 3` (or other non-1 values) means the plan has no weekly limit -> weekly tier omitted entirely.

Business envelope: `body.base_resp.status_code != 0` -> error from `status_msg`, emit `metrics: []` + error.

#### ZenMux

Produces exactly 2 metrics (cc-switch `coding_plan.rs:555-597`). **Critical**: `usage_percentage` is a 0-1 fraction, must be ×100.

- **five_hour** (from `data.quota_5_hour`): `providerMetricId: "five_hour"`, `limit = max_value_usd`, `used = used_value_usd`, `remaining = max_value_usd - used_value_usd`, `percentUsed = usage_percentage * 100`, `resetAt = resets_at`, `sourceValueKind: "gauge-remaining"`
- **weekly_limit** (from `data.quota_7_day`): `providerMetricId: "weekly_limit"`, same fields from `quota_7_day`
- `notes`: `"Plan: <data.plan.tier> (<data.account_status>)"` if tier non-empty

Business envelope: `body.success !== true` -> error from `body.message`, emit `metrics: []` + error.

#### Volcengine

**Fallback semantics** (cc-switch `coding_plan.rs:1097-1153`):

1. Call `GetAFPUsage`. Parse tiers via `parse_afp_tiers` (skip windows with `Quota <= 0`, skip `AFPDaily`).
2. If AFP tiers non-empty -> emit them as authoritative metrics. `notes: "Agent Plan <PlanType>"` if PlanType present. **Stop.**
3. If AFP tiers empty (no Agent Plan) -> call `GetCodingPlanUsage`. Parse tiers via `parse_coding_plan_tiers` (match `Level` field to window names). Emit as authoritative metrics. `notes: "Coding Plan"`.

**NOT** "both calls always run, second is notes" - that was wrong in v1. GetCodingPlanUsage tiers are authoritative when AFP returns nothing.

Metric count is **variable** (0-3), not fixed at 3:
- AFP path: one per non-zero-quota window among `AFPFiveHour`, `AFPWeekly`, `AFPMonthly`
- Coding Plan path: one per recognized `Level` (`session`/`5h`/`five_hour` -> five_hour; `weekly`/`week`/`7d` -> weekly_limit; `monthly`/`month` -> monthly)

Per AFP tier: `providerMetricId: "afp:five_hour"` / `"afp:weekly_limit"` / `"afp:monthly"`, `limit = Quota`, `used = Used`, `remaining = Quota - Used`, `percentUsed = Used / Quota * 100`, `window.resetAt = ResetTime`, `sourceValueKind: "gauge-used"`.

Per Coding Plan tier: `providerMetricId: "cp:five_hour"` / `"cp:weekly_limit"` / `"cp:monthly"`, `limit = 100`, `used = Percent`, `remaining = 100 - Percent`, `percentUsed = Percent`, `window.resetAt = ResetTime`, `sourceValueKind: "gauge-used"`.

Auth-error detection (cc-switch `coding_plan.rs:749-759`): classify by `ResponseMetadata.Error.Code` (lowercased) - auth codes contain `auth`, `signature`, `accessdenied`, `denied`, `unauthorized`, `forbidden`, `credential`, or `token`. Auth errors -> `retryable: false` + message including AKSK hint. Non-auth errors (e.g. `InvalidParameter.Action`) -> `retryable: true`. Also: HTTP 401/403 -> auth error. HTTP 4xx with auth-code body -> auth error. HTTP 4xx with non-auth-code body -> soft error.

### Volcengine SigV4 Variant (`volcengine-sig.ts`)

Sourced verbatim from cc-switch `coding_plan.rs:788-891`. **AWS SigV4 variant with three critical deviations** (cc-switch comment at line 791-796):

1. **Fixed header order** (NOT alphabetical): `host;x-date;x-content-sha256;content-type`
2. Algorithm string `HMAC-SHA256` (no `AWS4` prefix); credential scope ends with `request` (not `aws4_request`); signing key `kDate = HMAC(SK, date)` (SK has no `AWS4` prefix)
3. Canonical query still alphabetical (standard SigV4)

**Constants** (cc-switch `coding_plan.rs:798-800`):
- `VOLCENGINE_SERVICE = "ark"`
- `VOLCENGINE_CONTENT_TYPE = "application/json; charset=utf-8"`
- `VOLCENGINE_SIGNED_HEADERS = "host;x-date;x-content-sha256;content-type"`
- `VOLCENGINE_OPENAPI_HOST = "open.volcengineapi.com"`
- `VOLCENGINE_API_VERSION = "2024-01-01"`
- `VOLCENGINE_DEFAULT_REGION = "cn-beijing"`

**Request shape** (cc-switch `coding_plan.rs:893-922`):
- Method: `POST`
- URL: `https://open.volcengineapi.com/?<canonical_query>`
- **Body: empty** (`b""`). `x-content-sha256` = SHA-256 of empty string = fixed value `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- Canonical query: `Action=<action>&Region=<region>&Version=2024-01-01` (alphabetical by key, URI-encoded per RFC3986 unreserved)
- Headers sent: `X-Date`, `X-Content-Sha256`, `Content-Type: application/json; charset=utf-8`, `Authorization`

**Signing algorithm** (`volcengine_sign`, cc-switch `coding_plan.rs:851-891`):

```
x_date = now.format("%Y%m%dT%H%M%SZ")           // UTC
short_date = now.format("%Y%m%d")
x_content_sha256 = sha256_hex(body)              // body is empty

canonical_headers = "host:open.volcengineapi.com\nx-date:{x_date}\nx-content-sha256:{x_content_sha256}\ncontent-type:application/json; charset=utf-8\n"
canonical_request = "POST\n/\n{canonical_query}\n{canonical_headers}\n{VOLCENGINE_SIGNED_HEADERS}\n{x_content_sha256}"

credential_scope = "{short_date}/{region}/ark/request"
string_to_sign = "HMAC-SHA256\n{x_date}\n{credential_scope}\n{sha256_hex(canonical_request)}"

k_date = HMAC-SHA256(SK, short_date)            // SK as-is, no prefix
k_region = HMAC-SHA256(k_date, region)
k_service = HMAC-SHA256(k_region, "ark")
k_signing = HMAC-SHA256(k_service, "request")
signature = hex(HMAC-SHA256(k_signing, string_to_sign))

Authorization = "HMAC-SHA256 Credential={AK}/{credential_scope}, SignedHeaders={VOLCENGINE_SIGNED_HEADERS}, Signature={signature}"
```

**Region extraction** (cc-switch `coding_plan.rs:739-746`): parse host for first segment matching `cn-*` or `ap-*`; default `cn-beijing`. Adapter uses config `region` field (default `cn-beijing`) - no host parsing needed since we always hit `open.volcengineapi.com`.

`volcengine-sig.ts` exports:

```ts
export function signVolcengineRequest(input: {
  ak: string
  sk: string
  region: string
  action: string
  now: Date
}): { url: string; headers: Headers }
```

Pure function (takes `now` as param for deterministic tests). Returns the full URL (with canonical query) and headers to send. `volcengine.ts` adapter calls it twice (GetAFPUsage, conditionally GetCodingPlanUsage).

### Error Handling

Same as A class with additions:
- Volcengine signature/auth failure -> `retryable: false`, message contains "signature" or "authentication" + AKSK hint
- Volcengine non-auth API error -> `retryable: true`
- Business envelope violations (Zhipu `success:false`, MiniMax `base_resp.status_code != 0`, ZenMux `success != true`) -> `retryable: false`, `metrics: []`

### staleAfter

`fetchedAt + 15min` (same as A class).

## Projection Layer Changes

### `isPoeOverLimit` -> `isOverLimit` (generalized)

Current code in `buildDashboardMetric` (`project.ts:309-314`):

```ts
const isPoeOverLimit =
  providerType === "poe" &&
  pm?.sourceValueKind === "gauge-remaining" &&
  limit !== undefined &&
  providerRemaining !== undefined &&
  providerRemaining > limit
```

**Generalize** to cover both absolute and percent-based over-limit. New logic:

```ts
const isOverLimit =
  // Absolute gauge-remaining: balance exceeds configured limit (Poe, DeepSeek, etc.)
  (pm?.sourceValueKind === "gauge-remaining" &&
    limit !== undefined && providerRemaining !== undefined &&
    providerRemaining > limit) ||
  // Absolute gauge-used: used exceeds limit (Volcengine AFP, Kimi)
  (pm?.sourceValueKind === "gauge-used" &&
    limit !== undefined && providerUsed !== undefined &&
    providerUsed > limit) ||
  // Percent-based: 100%+ used (MiniMax, ZenMux, Zhipu, Volcengine Coding Plan)
  (limit !== undefined && used !== undefined && limit > 0 &&
    used >= limit)
```

`computeMetricStatus` parameter renamed `isPoeOverLimit` -> `isOverLimit`. Poe behavior unchanged (still hits the first branch). B-class providers now correctly show `ok` with `used=0` when over-limit, instead of `critical`.

### Per-Provider Projection Table

How `buildDashboardMetric` (`project.ts:295-364`) derives fields for each provider's metric shape:

| Provider | `limit` source | `used` source | `remaining` source | `percentUsed` derivation |
|---|---|---|---|---|
| DeepSeek | undefined (no limit) | `limit - remaining` if limit set, else undefined | provider | undefined (no limit) |
| StepFun | undefined | `limit - remaining` if limit set | provider | undefined |
| SiliconFlow | undefined | `limit - remaining` if limit set | provider | undefined |
| OpenRouter | provider `total_credits` | provider `total_usage` | provider | `(used / limit) * 100` |
| Novita | undefined | `limit - remaining` if limit set | provider | undefined |
| Kimi | provider `detail.limit` | `max(0, limit - remaining)` | provider `detail.remaining` | `(used / limit) * 100` |
| Zhipu | `100` (adapter) | provider `percentage` | `100 - percentage` | `(used / limit) * 100 = percentage` |
| MiniMax | `100` (adapter) | `100 - remaining` (adapter) | provider `current_*_remaining_percent` | `(used / limit) * 100` |
| ZenMux | provider `max_value_usd` | provider `used_value_usd` | `max - used` | `usage_percentage * 100` (adapter) |
| Volcengine AFP | provider `Quota` | provider `Used` | `Quota - Used` | `(Used / Quota) * 100` (adapter) |
| Volcengine CP | `100` (adapter) | provider `Percent` | `100 - Percent` | `Percent` (adapter) |

`buildDashboardMetric` already handles `used = max(0, limit - remaining)` when `used` is undefined and `limit`+`remaining` are set (`project.ts:316-327`). Adapters set fields directly when the API provides them; otherwise projection derives.

### `resolveUsageFilter` - Unchanged

The Poe default `usageTypes: ["API"]` is retained unchanged. New 10 providers return no `historyEvents`, so usageFilter has no effect on them.

### Declared-but-Unreturned Metrics

If config declares a metric (e.g. `providerMetricId: "weekly_limit"`) but the provider returns no matching metric (e.g. MiniMax plan with no weekly limit), the projection layer already handles this: `matchedProviderMetric` is `undefined`, `providerMetric` is `undefined` (not manual), and `computeMetricStatus` returns `"unavailable"`. No spec change needed - existing behavior is correct. Document this as expected: a metric showing `unavailable` status means "provider didn't return this window".

## Config Loading Changes (`load-config.ts`)

### Extract `resolveBearerCredential`

Poe's current `apiKeyEnv -> apiKey fallback -> unavailable` resolution is extracted to a shared function used by Poe + all 9 Bearer providers (A class 5 + Kimi/Zhipu/MiniMax/ZenMux):

```ts
function resolveBearerCredential(
  provider: { apiKeyEnv?: string; apiKey?: string },
): { apiKey?: string; reason?: string } {
  const envName = provider.apiKeyEnv
  let apiKey: string | undefined
  let reason: string | undefined
  if (envName !== undefined) {
    const fromEnv = process.env[envName]
    if (fromEnv !== undefined && fromEnv !== "") {
      apiKey = fromEnv
    } else if (provider.apiKey !== undefined) {
      apiKey = provider.apiKey
    } else {
      reason = `environment variable ${envName} is not set and no apiKey fallback was provided`
    }
  } else if (provider.apiKey !== undefined) {
    apiKey = provider.apiKey
  } else {
    reason = "no apiKeyEnv or apiKey configured"
  }
  return { apiKey, reason }
}
```

Poe's branch is refactored to call this function; behavior is identical.

### `resolveAkSkCredential` (separate, NOT reusing Bearer resolver)

Volcengine needs both AK and SK. Separate function (not overloading `apiKey`):

```ts
function resolveAkSkCredential(
  provider: { akEnv?: string; ak?: string; skEnv?: string; sk?: string },
): { ak?: string; sk?: string; reason?: string } {
  const ak = resolveBearerCredential({ apiKeyEnv: provider.akEnv, apiKey: provider.ak })
  const sk = resolveBearerCredential({ apiKeyEnv: provider.skEnv, apiKey: provider.sk })
  if (ak.apiKey !== undefined && sk.apiKey !== undefined) {
    return { ak: ak.apiKey, sk: sk.apiKey }
  }
  return { reason: ak.reason ?? sk.reason ?? "missing AK or SK" }
}
```

Volcengine branch in `loadDashboardConfig`:

```ts
if (provider.type === "volcengine") {
  const { ak, sk, reason } = resolveAkSkCredential(provider)
  const state: ProviderRuntimeState =
    ak !== undefined && sk !== undefined
      ? { available: true, ak, sk }
      : { available: false, reason: reason ?? "missing AK or SK" }
  providers.set(provider.id, provider)
  providerRuntime.set(provider.id, state)
}
```

### `ProviderRuntimeState` Extension

```ts
export type ProviderRuntimeState = {
  available: boolean
  apiKey?: string
  ak?: string
  sk?: string
  reason?: string
}
```

Volcengine adapter reads `runtime.ak` / `runtime.sk`. All other adapters read `runtime.apiKey`. `apiKey` is never used to carry AK/SK.

### SSRF Defense for `baseUrl`

Providers with configurable `baseUrl` (SiliconFlow, Zhipu, MiniMax, ZenMux) are validated against a hostname allowlist in `loadDashboardConfig`. Loopback/private IP ranges are rejected.

```ts
const PROVIDER_HOST_ALLOWLIST: Record<string, string[]> = {
  siliconflow: ["api.siliconflow.cn", "api.siliconflow.com"],
  zhipu: ["open.bigmodel.cn", "api.z.ai"],
  minimax: ["api.minimaxi.com", "api.minimax.io"],
  // zenmux: no allowlist (user-supplied private deployments) - but reject loopback/private
}
```

Validation: parse `baseUrl` hostname; for allowlisted providers reject if hostname not in list; for all providers reject if hostname resolves to loopback (`127.0.0.0/8`, `::1`) or private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`). On violation: `fail(path, "baseUrl hostname not allowed")`.

ZenMux has no hostname allowlist (private deployments expected) but still rejects loopback/private-link addresses to prevent cloud-metadata exfiltration.

## Concurrency

`refresh-service.ts` default `concurrencyLimit` raised from 2 to 8. With 12+ provider accounts, 2 serializes refreshes into ~90s worst case; 8 keeps it under ~20s. Per-provider timeout stays at the adapter level (fetch with 15s timeout, matching cc-switch).

## main.ts & app.ts Type Widening

```ts
// main.ts:25 - change from
const providers = new Map<"manual" | "poe", ReturnType<typeof createManualProvider>>([...])
// to
const providers = new Map<string, ProviderAdapter>([
  ["manual", createManualProvider()],
  ["poe", createPoeProvider()],
  ["deepseek", createDeepseekProvider()],
  ["stepfun", createStepfunProvider()],
  ["siliconflow", createSiliconflowProvider()],
  ["openrouter", createOpenrouterProvider()],
  ["novita", createNovitaProvider()],
  ["kimi", createKimiProvider()],
  ["zhipu", createZhipuProvider()],
  ["minimax", createMiniMaxProvider()],
  ["zenmux", createZenmuxProvider()],
  ["volcengine", createVolcengineProvider()],
])
```

```ts
// app.ts:25 - AppDeps.providers change from
providers: Map<"manual" | "poe", ProviderAdapter>
// to
providers: Map<string, ProviderAdapter>
```

## Testing Strategy

### Shared Utilities Tests (`tests/providers/shared.test.ts`)

- `parseNumber`: number passthrough, numeric string, invalid string -> undefined, null -> undefined, empty string -> undefined
- `isRetryableStatus`: 500/502/503/429 -> true; 200/400/401/403/404 -> false
- `authError`: correct message format, `retryable: false`

### Per-Adapter Tests

Each provider gets `tests/providers/<name>.test.ts`, following `poe.test.ts` pattern:

- Inject fake `fetch` via the `fetchImpl` parameter (and fake `signVolcengineRequest` for Volcengine)
- Assert:
  - Balance/usage parsed correctly from sample response
  - All expected `NormalizedMetric` fields present and correctly typed
  - 401/403 -> non-retryable error
  - 5xx/429 -> retryable error
  - Network error -> retryable error
  - Missing field in response -> non-retryable error, `metrics: []`

### MiniMax Specific Tests

- Only `model_name == "general"` processed; `video` entry ignored
- 5h tier always present for general; weekly tier only when `current_weekly_status == 1`
- `current_weekly_status == 3` -> weekly tier omitted (not zero, omitted)
- `remaining` is the percentage, `limit` is 100
- `resetAt` from `end_time` (5h) vs `weekly_end_time` (weekly)
- `base_resp.status_code != 0` -> error from `status_msg`, no metrics

### Zhipu Specific Tests

- `unit: 3` -> five_hour; `unit: 6` -> weekly_limit
- Fallback heuristic: no-`nextResetTime` -> five_hour first; rest by reset ascending
- `type != "TOKENS_LIMIT"` entries skipped
- `success: false` -> error from `msg`, no metrics
- `Authorization` header has NO "Bearer " prefix

### ZenMux Specific Tests

- `usage_percentage` multiplied by 100 (0.3 -> 30%)
- Both `quota_5_hour` and `quota_7_day` produce metrics
- `success != true` -> error from `message`, no metrics
- `notes` includes plan tier and account status

### Volcengine-Specific Tests

- SigV4 signing input correctness (canonical header order `host;x-date;x-content-sha256;content-type`, service `ark`, empty body, `x-content-sha256` = empty-string hash)
- `GetAFPUsage` called first; if non-empty tiers -> emit, do NOT call `GetCodingPlanUsage`
- `GetAFPUsage` returns empty (all Quota<=0) -> call `GetCodingPlanUsage`, emit its tiers as authoritative
- AFP: `Quota <= 0` windows skipped; `AFPDaily` always skipped
- Coding Plan: unknown `Level` values skipped
- Auth error code classification: `SignatureDoesNotMatch`/`AccessDenied` -> non-retryable; `InvalidParameter.Action` -> retryable
- HTTP 401/403 -> auth error
- HTTP 4xx with auth-code body -> auth error; with non-auth-code body -> soft error

### `volcengine-sig.ts` Unit Tests (`tests/providers/volcengine-sig.test.ts`)

Port from cc-switch's `volcengine_sign_structure_and_determinism` test (`coding_plan.rs:1894+`):

- Canonical header order assertion (exact string `host;x-date;x-content-sha256;content-type`, NOT alphabetical)
- `x-content_sha256` = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (SHA-256 of empty string)
- Content-Type = `application/json; charset=utf-8`
- Algorithm string = `HMAC-SHA256` (no `AWS4`)
- Credential scope ends with `/request` (not `/aws4_request`)
- Canonical query alphabetical: `Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01`
- Determinism: same input -> same output
- URL format: `https://open.volcengineapi.com/?<canonical_query>`

### Projection Regression (`tests/server/project.test.ts`)

New test cases:
1. Non-Poe `gauge-remaining` provider with configured `limit` below current balance -> `isOverLimit` branch hit, `used = 0`, `percentUsed` omitted, status `ok`
2. `gauge-used` provider with `used > limit` -> `isOverLimit` branch hit, status `ok` (not critical)
3. Percent-based metric (`limit=100, used=100`) without `isOverLimit` -> status `critical` (via threshold); with `isOverLimit` -> status `ok`

### load-config Regression (`tests/config/load-config.test.ts`)

- Volcengine AK/SK resolution: both set -> available; one missing -> unavailable with reason
- Bearer credential shared path: Poe + DeepSeek produce identical `ProviderRuntimeState` for same env/literal inputs
- SSRF: SiliconFlow `baseUrl` with `api.siliconflow.cn` -> ok; with `http://127.0.0.1` -> fail; with `http://169.254.169.254` -> fail
- SSRF: ZenMux `baseUrl` with arbitrary public host -> ok; with `http://10.0.0.1` -> fail

## Config & Environment

### `config/dashboard.config.ts` Example

```ts
providers: [
  { id: "deepseek-main", type: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" },
  { id: "stepfun-main", type: "stepfun", apiKeyEnv: "STEPFUN_API_KEY" },
  { id: "siliconflow-main", type: "siliconflow", apiKeyEnv: "SILICONFLOW_API_KEY" },
  { id: "openrouter-main", type: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
  { id: "novita-main", type: "novita", apiKeyEnv: "NOVITA_API_KEY" },
  { id: "kimi-main", type: "kimi", apiKeyEnv: "KIMI_API_KEY" },
  { id: "zhipu-main", type: "zhipu", apiKeyEnv: "ZHIPU_API_KEY" },
  { id: "minimax-main", type: "minimax", apiKeyEnv: "MINIMAX_API_KEY" },
  { id: "zenmux-main", type: "zenmux", baseUrl: "https://your-zenmux-instance.example.com", apiKeyEnv: "ZENMUX_API_KEY" },
  { id: "volc-main", type: "volcengine", region: "cn-beijing",
    akEnv: "VOLCENGINE_AK", skEnv: "VOLCENGINE_SK" },
],
```

Each provider gets a matching subscription with simplified metrics (see per-provider sections). Users uncomment/edit as needed.

### `.env.example` Additions

```env
# A class - account balance providers
DEEPSEEK_API_KEY=
STEPFUN_API_KEY=
SILICONFLOW_API_KEY=
OPENROUTER_API_KEY=
NOVITA_API_KEY=

# B class - coding plan providers
KIMI_API_KEY=
ZHIPU_API_KEY=
MINIMAX_API_KEY=
ZENMUX_API_KEY=
ZENMUX_BASE_URL=https://your-zenmux-instance.example.com

# Volcengine (AK/SK, not apiKey)
VOLCENGINE_AK=
VOLCENGINE_SK=
```

## Implementation Order

Six logical commits, designed for incremental reviewability:

1. **Infrastructure**: `domain.ts` union extension + `ProviderRuntimeState.ak/sk` + `load-config.ts` (`resolveBearerCredential` + `resolveAkSkCredential` + SSRF allowlist) + `main.ts`/`app.ts` type widening + `shared.ts` utilities + `refresh-service.ts` concurrency bump. No new adapters yet - existing Poe/manual must still pass full test suite.
2. **Projection generalization**: `isPoeOverLimit` -> `isOverLimit` rename + per-provider projection table regression tests.
3. **A class adapters**: DeepSeek -> StepFun -> SiliconFlow -> OpenRouter -> Novita (5 adapters + 5 test files). Can split into 1-2 commits.
4. **B class Bearer adapters**: Kimi -> Zhipu -> MiniMax -> ZenMux (4 adapters + 4 test files).
5. **Volcengine**: `volcengine-sig.ts` + `volcengine.ts` + 2 test files (most complex, isolated commit). Port cc-switch's `volcengine_sign_structure_and_determinism` test as the SigV4 regression anchor.
6. **Config & docs**: `config/dashboard.config.ts` example + `.env.example` + this spec reference in README.

## Open Questions Resolved During Brainstorming & Review

| Question | Decision |
|---|---|
| Provider scope | A class (5) + B class (5) + Volcengine. No OAuth providers. |
| Adapter structure | One file per provider (not generic HTTP-balance config). |
| Currency | Single `unit` field, no conversion. |
| History events | Not fetched; range stats use existing snapshot-delta path exclusively. Contract supports future addition. |
| Volcengine | Full AK/SK SigV4 implementation. |
| Zhipu Team | Deferred; personal only. |
| MiniMax metrics | Both interval + weekly per general model (2 metrics max); weekly only when `current_weekly_status == 1`. |
| MiniMax model filter | Only `model_name == "general"`; video/audio skipped. |
| Volcengine two-call | Fallback semantics: GetAFPUsage first; GetCodingPlanUsage only if AFP empty, then its tiers are authoritative (not notes). |
| Volcengine metric count | Variable (0-3), not fixed. Skip `Quota <= 0` windows and `AFPDaily`. |
| Volcengine SigV4 Content-Type | `application/json; charset=utf-8` (NOT form-urlencoded). |
| Volcengine SigV4 body | Empty body; params in URL query string. `x-content-sha256` = SHA-256 of empty string. |
| Volcengine region | Config field (default `cn-beijing`); no host parsing needed. |
| Volcengine auth errors | Code-based classification (auth/signature/denied/etc. -> non-retryable; others -> retryable). |
| ZenMux percentage | `usage_percentage` is 0-1 fraction; adapter multiplies by 100. |
| Zhipu window classification | `unit` field: 3 -> five_hour, 6 -> weekly_limit; fallback heuristic for missing `unit`. |
| Zhipu auth | No "Bearer " prefix on `Authorization` header. |
| `volcengine-sig.ts` | Independent utility file, only auxiliary file split out. |
| `ProviderRuntimeState` | Extended with `ak?/sk?` (not packed into `apiKey` string). |
| `resolveAkSkCredential` | Separate function, does NOT reuse `resolveBearerCredential` for AK/SK semantics. |
| `resolveUsageFilter` | Unchanged (Poe default retained). |
| `isOverLimit` | Generalized to cover `gauge-remaining`, `gauge-used`, and percent-based (`used >= limit`) over-limit. |
| Business error envelopes | Per-provider: Zhipu `success`, MiniMax `base_resp.status_code`, ZenMux `success`, Volcengine `ResponseMetadata.Error`. |
| `parseNumber` | Shared helper, string-or-number tolerant (ports cc-switch `parse_f64`). |
| Concurrency | Raised from 2 to 8 (12+ adapters). |
| SSRF | Hostname allowlist for SiliconFlow/Zhipu/MiniMax; loopback/private rejection for all `baseUrl` providers. |
| Declared-but-unreturned metrics | Existing behavior correct: `unavailable` status. No change needed. |
