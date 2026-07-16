# Extend Providers Design

Date: 2026-07-17

## Goal

Add 10 new provider adapters to the Subscription Quota Dashboard, sourced from the cc-switch project's proven balance/quota-checking implementations. Covers two families:

- **A 类 - Account Balance (5 providers)**: DeepSeek, StepFun, SiliconFlow, OpenRouter, Novita AI
- **B 类 - Coding Plan / Token Plan (5 providers)**: Kimi, Zhipu (personal), MiniMax, ZenMux, Volcengine

Each adapter fetches current quota/balance via the provider's HTTP API, normalizes to `NormalizedMetric[]`, and integrates with the existing refresh/projection/storage pipeline.

## Non-Goals

- No OAuth-based providers (Claude/Codex/Gemini official subscriptions, GitHub Copilot) - these need separate credential-storage design.
- No Zhipu Team support (only personal); team variant requires org/project IDs and a separate endpoint.
- No currency conversion between CNY and USD; `unit` is a display-only string field.
- No history events (`ProviderHistoryEvent[]`) for these providers - none of the 10 exposes a per-call history endpoint. Range stats fall back to the existing snapshot-delta path (refresh-service already implements snapshot-delta consumption). The adapter contract still accepts `historyEvents`, so future providers that add history endpoints can populate it without contract changes.
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
└── volcengine-sig.ts   ← new (SigV4 signing utility, imported by volcengine.ts)
```

### Change Surface

| File | Change |
|---|---|
| `src/shared/domain.ts` | Extend `ProviderAccountConfig` union with 10 new variants; extend `ProviderRuntimeState` with `ak?/sk?` |
| `src/server/config/load-config.ts` | Extract `resolveBearerCredential` (shared by poe + 9 Bearer providers); add Volcengine AK/SK resolution branch |
| `src/server/main.ts` | Map type `Map<"manual" \| "poe", ...>` → `Map<string, ProviderAdapter>`; register 10 new adapters |
| `src/server/http/app.ts` | `AppDeps.providers` type synced to `Map<string, ProviderAdapter>` |
| `src/server/dashboard/project.ts` | Rename `isPoeOverLimit` → `isOverLimit` (drop Poe-specific condition); `resolveUsageFilter` unchanged |
| `config/dashboard.config.ts` | Add 10 provider declarations + matching subscriptions/metrics (example config) |
| `.env.example` | Add 12 new env var placeholders |
| `tests/providers/<name>.test.ts` | 10 new test files + `volcengine-sig.test.ts` |
| `tests/server/project.test.ts` | New regression: non-Poe gauge-remaining over-limit hits `isOverLimit` |
| `tests/config/load-config.test.ts` | New regression: Volcengine AK/SK resolution, Bearer credential shared path |

### Unchanged

- **refresh-service**: adapter abstraction already isolates new providers.
- **storage / schema**: no new tables or migrations.
- **frontend**: no new components; existing display modules cover all cases.
- **auth**: no credential-storage changes (all secrets via env vars).

## A 类 - Account Balance Providers (5)

### API Summary

Sourced from `cc-switch/src-tauri/src/services/balance.rs`.

| Provider | Endpoint | Auth | Response Path | Unit |
|---|---|---|---|---|
| DeepSeek | `GET https://api.deepseek.com/user/balance` | `Bearer` | `balance_infos[0].total_balance` | CNY |
| StepFun | `GET https://api.stepfun.com/v1/accounts` | `Bearer` | `balance` (top-level) | CNY |
| SiliconFlow | `GET <baseUrl>/v1/user/info` | `Bearer` | `data.totalBalance` | CNY (CN) / USD (EN) |
| OpenRouter | `GET https://openrouter.ai/api/v1/credits` | `Bearer` | `remaining = data.total_credits - data.total_usage` | USD |
| Novita AI | `GET https://api.novita.ai/v3/user/balance` | `Bearer` | `availableBalance / 10000` (raw unit = 0.0001 USD) | USD |

SiliconFlow CN/EN are the same company on two domains. One adapter handles both via a `baseUrl` config field (default `https://api.siliconflow.cn`, EN users set `https://api.siliconflow.com`).

### ProviderAccountConfig Variants

```ts
| { id: string; type: "deepseek"; apiKeyEnv?: string; apiKey?: string }
| { id: string; type: "stepfun"; apiKeyEnv?: string; apiKey?: string }
| { id: string; type: "siliconflow"; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }
| { id: string; type: "openrouter"; apiKeyEnv?: string; apiKey?: string }
| { id: string; type: "novita"; apiKeyEnv?: string; apiKey?: string }
```

### Adapter Output

- `providerMetricId: "balance"` (uniform)
- `sourceValueKind: "gauge-remaining"`
- `sourceConfidence: "known"`
- `remaining`: parsed balance value
- `limit`: undefined (provider does not return) - except OpenRouter
- `window`: undefined (balance has no period)
- `unit`: from config (CNY / USD)

OpenRouter special case: provider returns `total_credits` and `total_usage`. Adapter fills three fields:
- `remaining = total_credits - total_usage`
- `limit = total_credits`
- `used = total_usage`

Other A-class providers fill only `remaining`.

Novita special case: raw `availableBalance` is in 0.0001 USD units. Adapter divides by 10000 before exposing.

### Error Handling

Identical to Poe:
- 401/403 → `{ message: "<Provider> authentication failed", retryable: false }`
- 5xx / 429 → `retryable: true`
- Network error → `retryable: true`
- JSON parse failure or missing field → `retryable: false`, `metrics: []`

### staleAfter

`fetchedAt + 15min` (same as Poe).

## B 类 - Coding Plan Providers (5)

### API Summary

Sourced from `cc-switch/src-tauri/src/services/coding_plan.rs`.

| Provider | Endpoint | Auth | Response Structure |
|---|---|---|---|
| Kimi | `GET https://api.kimi.com/coding/v1/usages` | `Bearer` | `limits[].detail.{limit, remaining, resetTime}` OR `usage.{limit, remaining, resetTime}` |
| Zhipu (personal) | `GET <baseUrl>` (default `https://open.bigmodel.cn`, EN: `https://api.z.ai`) | `Authorization: <key>` (NO Bearer prefix) | `data.limits[]` |
| MiniMax | `GET <baseUrl>/v1/api/openplatform/coding_plan/remains` (CN: `https://api.minimaxi.com`, EN: `https://api.minimax.io`) | `Bearer` | `model_remains[].{current_interval_remaining_percent, end_time, current_weekly_status, current_weekly_remaining_percent, weekly_end_time}` (percentages 0-100) |
| ZenMux | `GET <baseUrl>` (required, user-supplied) | `Bearer` | `data.{quota_5_hour, quota_7_day}.{usage_percentage, resets_at, used_value_usd, max_value_usd}`, `data.plan.tier` (USD absolute values) |
| Volcengine | Control plane `POST https://open.volcengineapi.com` (two calls) | AK/SK SigV4 | `GetAFPUsage` → AFPFiveHour/AFPWeekly/AFPMonthly Quota/Used; `GetCodingPlanUsage` → percentage |

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

Zhipu's `Authorization` header carries the raw API key with **no "Bearer " prefix**:

```ts
headers.set("Authorization", apiKey)  // NOT `Bearer ${apiKey}`
```

Credential resolution in load-config stays uniform (apiKeyEnv/apiKey); only the adapter's header construction differs.

### Per-Adapter Metric Output

#### Kimi

Each `limits[]` item produces one `NormalizedMetric`:
- `providerMetricId`: item window identifier (e.g. `"five_hour"`, `"seven_day"`)
- `limit` / `remaining` from `detail`
- `window.resetAt` from `detail.resetTime`
- `sourceValueKind: "gauge-remaining"`
- Falls back to `usage.{limit, remaining, resetTime}` when `limits[]` is absent.

#### Zhipu

Each `data.limits[]` item produces one metric, structure analogous to Kimi.

#### MiniMax

Each `model_remains[]` item produces **two** metrics:
- **Interval (5h)**: `providerMetricId: "<model>:interval"`, `remaining = current_interval_remaining_percent`, `limit = 100`, `resetAt = end_time`
- **Weekly**: `providerMetricId: "<model>:weekly"`, `remaining = current_weekly_remaining_percent`, `limit = 100`, `resetAt = weekly_end_time`
- `notes`: derived from `current_weekly_status`
- `sourceValueKind: "gauge-remaining"` (MiniMax reports remaining percentage; projection auto-computes `percentUsed = (limit - remaining) / limit * 100`)

#### ZenMux

Fixed two metrics:
- `providerMetricId: "5h"` / `"7d"`
- `limit = max_value_usd`, `used = used_value_usd`, `remaining = max_value_usd - used_value_usd`
- `resetAt = resets_at`
- `sourceValueKind: "gauge-remaining"`
- `notes: "Plan: <tier>"` (from `data.plan.tier`)

Projection auto-computes `percentUsed = used / limit * 100`, which should match the API's `usage_percentage` (cross-check, not authoritative).

#### Volcengine

Two POST calls to control-plane `https://open.volcengineapi.com`:

1. `Action=GetAFPUsage&Region=<region>&Version=2024-01-01` → absolute Quota/Used across `AFPFiveHour`, `AFPWeekly`, `AFPMonthly` windows
2. `Action=GetCodingPlanUsage` → percentage (supplementary)

Produces 3 metrics:
- `providerMetricId: "afp:5h"` / `"afp:weekly"` / `"afp:monthly"`
- `limit`, `used` from GetAFPUsage absolute values
- `window.resetAt` from GetAFPUsage tier reset times
- `sourceValueKind: "gauge-used"`
- `notes`: percentage from GetCodingPlanUsage (supplementary, not authoritative)

### Volcengine SigV4 Variant (`volcengine-sig.ts`)

Volcengine uses a SigV4 variant with these deviations from standard AWS SigV4 (per cc-switch `coding_plan.rs`):

- **Fixed header order** (NOT alphabetical): `host;x-date;x-content-sha256;content-type`
- `VOLCENGINE_SERVICE = "ark"`
- Region from config (default `cn-beijing`)
- HTTP method: POST
- Body format: query-string (`Action=...&Version=...&Region=...`)
- Content-Type: `application/x-www-form-urlencoded`

`volcengine-sig.ts` exports:

```ts
export function signVolcengineRequest(input: {
  method: string
  url: URL
  body: string
  ak: string
  sk: string
  region: string
  service?: string  // default "ark"
}): Headers
```

Pure function, independently unit-testable. `volcengine.ts` adapter calls it.

### Error Handling

Same as A class with one addition:
- Volcengine signature failure → `retryable: false`, message contains "signature"

### staleAfter

`fetchedAt + 15min` (same as A class).

## Projection Layer Changes

### `isPoeOverLimit` → `isOverLimit`

Current code in `buildDashboardMetric`:

```ts
const isPoeOverLimit =
  providerType === "poe" &&
  pm?.sourceValueKind === "gauge-remaining" &&
  limit !== undefined &&
  providerRemaining !== undefined &&
  providerRemaining > limit
```

Generalize by dropping the `providerType === "poe"` condition:

```ts
const isOverLimit =
  pm?.sourceValueKind === "gauge-remaining" &&
  limit !== undefined &&
  providerRemaining !== undefined &&
  providerRemaining > limit
```

`computeMetricStatus` parameter renamed `isPoeOverLimit` → `isOverLimit`. Poe behavior unchanged (Poe still hits this branch). Any `gauge-remaining` provider (DeepSeek, SiliconFlow, etc.) with a configured `limit` below the current balance naturally applies.

### `resolveUsageFilter` - Unchanged

The Poe default `usageTypes: ["API"]` is retained unchanged. New 10 providers return no `historyEvents`, so usageFilter has no effect on them. If a future provider adds a history endpoint and needs a default filter, a new branch can be added then.

## Config Loading Changes (`load-config.ts`)

### Extract `resolveBearerCredential`

Poe's current `apiKeyEnv → apiKey fallback → unavailable` resolution is extracted to a shared function used by Poe + all 9 Bearer providers (A class 5 + Kimi/Zhipu/MiniMax/ZenMux):

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

### Volcengine AK/SK Branch

```ts
if (provider.type === "volcengine") {
  const ak = resolveBearerCredential({ apiKeyEnv: provider.akEnv, apiKey: provider.ak })
  const sk = resolveBearerCredential({ apiKeyEnv: provider.skEnv, apiKey: provider.sk })
  const state: ProviderRuntimeState =
    ak.apiKey !== undefined && sk.apiKey !== undefined
      ? { available: true, ak: ak.apiKey, sk: sk.apiKey }
      : { available: false, reason: ak.reason ?? sk.reason ?? "missing AK or SK" }
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

Volcengine adapter reads `runtime.ak` / `runtime.sk`. All other adapters read `runtime.apiKey`.

## main.ts & app.ts Type Widening

```ts
// main.ts
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
// app.ts AppDeps
providers: Map<string, ProviderAdapter>
```

## Testing Strategy

### Per-Adapter Tests

Each provider gets `tests/providers/<name>.test.ts`, following `poe.test.ts` pattern:

- Inject fake `fetch` via the `fetchImpl` parameter (and fake `signVolcengineRequest` for Volcengine)
- Assert:
  - Balance/usage parsed correctly from sample response
  - All expected `NormalizedMetric` fields present and correctly typed
  - 401/403 → non-retryable error
  - 5xx/429 → retryable error
  - Network error → retryable error
  - Missing field in response → non-retryable error, `metrics: []`

### MiniMax Specific Tests

- Each `model_remains[]` item produces 2 metrics (interval + weekly)
- `remaining` is the percentage, `limit` is 100
- Projection computes `percentUsed = 100 - remaining` (not the adapter)
- `resetAt` from the correct field per metric type (`end_time` vs `weekly_end_time`)
- `notes` populated from `current_weekly_status`

### Volcengine-Specific Tests

- SigV4 signing input correctness (canonical header order, correct service/region)
- Two POST calls execute in order (GetAFPUsage then GetCodingPlanUsage)
- AFP absolute values become metric `limit`/`used`
- GetCodingPlanUsage percentage goes into `notes`, not authoritative fields
- Signature failure → non-retryable error with "signature" in message

### `volcengine-sig.ts` Unit Tests (`tests/providers/volcengine-sig.test.ts`)

- Canonical header order assertion (`host;x-date;x-content-sha256;content-type`, NOT alphabetical)
- Signature hex length and format
- Fixed test vectors (sourced from cc-switch fixtures or RFC 6.0 SigV4 examples adapted to Volcengine variant)
- Determinism: same input → same output

### Projection Regression (`tests/server/project.test.ts`)

New test case: non-Poe provider with `gauge-remaining` + configured `limit` below current balance → `isOverLimit` branch hit, `used = 0`, `percentUsed` omitted, status `ok`.

### load-config Regression (`tests/config/load-config.test.ts`)

- Volcengine AK/SK resolution: both set → available; one missing → unavailable with reason
- Bearer credential shared path: Poe + DeepSeek produce identical `ProviderRuntimeState` for same env/literal inputs

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

Each provider gets a matching subscription with simplified metrics (see Section examples in A/B class detail). Users uncomment/edit as needed.

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

1. **Infrastructure**: `domain.ts` union extension + `ProviderRuntimeState.ak/sk` + `load-config.ts` `resolveBearerCredential` extraction + Volcengine AK/SK branch + `main.ts`/`app.ts` type widening. No new adapters yet - existing Poe/manual must still pass.
2. **Projection generalization**: `isPoeOverLimit` → `isOverLimit` rename + regression test.
3. **A class adapters**: DeepSeek → StepFun → SiliconFlow → OpenRouter → Novita (5 adapters + 5 test files). Can split into 1-2 commits.
4. **B class Bearer adapters**: Kimi → Zhipu → MiniMax → ZenMux (4 adapters + 4 test files).
5. **Volcengine**: `volcengine-sig.ts` + `volcengine.ts` + 2 test files (most complex, isolated commit).
6. **Config & docs**: `config/dashboard.config.ts` example + `.env.example` + this spec reference in README.

## Open Questions Resolved During Brainstorming

| Question | Decision |
|---|---|
| Provider scope | A class (5) + B class (5) + Volcengine. No OAuth providers. |
| Adapter structure | One file per provider (not generic HTTP-balance config). |
| Currency | Single `unit` field, no conversion. |
| History events | Not fetched; range stats use existing snapshot-delta path. Contract supports future addition. |
| Volcengine | Full AK/SK SigV4 implementation. |
| Zhipu Team | Deferred; personal only. |
| MiniMax metrics | Both interval + weekly per model (2 metrics). |
| Volcengine second call | GetAFPUsage absolute values authoritative; GetCodingPlanUsage percentage → `notes` only. |
| `volcengine-sig.ts` | Independent utility file, only auxiliary file split out. |
| `ProviderRuntimeState` | Extended with `ak?/sk?` (not packed into `apiKey` string). |
| `resolveUsageFilter` | Unchanged (Poe default retained). |
