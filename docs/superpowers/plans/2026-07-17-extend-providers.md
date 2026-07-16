# Extend Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 10 new provider adapters (5 account-balance, 5 coding-plan including Volcengine AK/SK SigV4) to the subscription-quota-dashboard, sourced from cc-switch's proven implementations.

**Architecture:** One adapter file per provider under `src/server/providers/`, following the Poe template. Shared helpers extracted to `shared.ts`. Volcengine gets an auxiliary `volcengine-sig.ts` for its SigV4 variant. Config loading generalized for Bearer + AK/SK credentials with SSRF defense. Projection `isPoeOverLimit` generalized to `isOverLimit`.

**Tech Stack:** Bun, TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Hono, `bun:test`. All adapters accept `fetchImpl = fetch` for test injection.

**Spec:** `docs/superpowers/specs/2026-07-17-extend-providers-design.md`

**Reference:** cc-switch source at `/Users/dengqi/Source/langs/typescript/cc-switch/src-tauri/src/services/{balance,coding_plan}.rs`

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/server/providers/shared.ts` | `parseNumber`, `isRetryableStatus`, `authError`, `parseResetTime` helpers |
| `src/server/providers/deepseek.ts` | DeepSeek balance adapter |
| `src/server/providers/stepfun.ts` | StepFun balance adapter |
| `src/server/providers/siliconflow.ts` | SiliconFlow CN/EN balance adapter |
| `src/server/providers/openrouter.ts` | OpenRouter balance adapter |
| `src/server/providers/novita.ts` | Novita balance adapter |
| `src/server/providers/kimi.ts` | Kimi coding-plan adapter |
| `src/server/providers/zhipu.ts` | Zhipu personal coding-plan adapter |
| `src/server/providers/minimax.ts` | MiniMax coding-plan adapter |
| `src/server/providers/zenmux.ts` | ZenMux coding-plan adapter |
| `src/server/providers/volcengine-sig.ts` | Volcengine SigV4 signing utility |
| `src/server/providers/volcengine.ts` | Volcengine coding-plan adapter (uses volcengine-sig) |
| `tests/providers/shared.test.ts` | Shared helper tests |
| `tests/providers/deepseek.test.ts` | DeepSeek adapter tests |
| `tests/providers/stepfun.test.ts` | StepFun adapter tests |
| `tests/providers/siliconflow.test.ts` | SiliconFlow adapter tests |
| `tests/providers/openrouter.test.ts` | OpenRouter adapter tests |
| `tests/providers/novita.test.ts` | Novita adapter tests |
| `tests/providers/kimi.test.ts` | Kimi adapter tests |
| `tests/providers/zhipu.test.ts` | Zhipu adapter tests |
| `tests/providers/minimax.test.ts` | MiniMax adapter tests |
| `tests/providers/zenmux.test.ts` | ZenMux adapter tests |
| `tests/providers/volcengine-sig.test.ts` | SigV4 structure/determinism tests |
| `tests/providers/volcengine.test.ts` | Volcengine adapter tests |

### Modified files

| Path | Change |
|---|---|
| `src/shared/domain.ts` | Extend `ProviderAccountConfig` union (+10 variants); extend `ProviderRuntimeState` (+`ak?/sk?`) |
| `src/server/config/load-config.ts` | `resolveBearerCredential` extraction; `resolveAkSkCredential`; SSRF allowlist; Bearer branch for 9 new providers + Volcengine branch |
| `src/server/main.ts:25` | Map type widened to `Map<string, ProviderAdapter>`; register 10 adapters |
| `src/server/http/app.ts:25` | `AppDeps.providers` type widened to `Map<string, ProviderAdapter>` |
| `src/server/dashboard/project.ts` | `isPoeOverLimit` -> `isOverLimit` (generalized); `computeMetricStatus` param renamed |
| `src/server/refresh/refresh-service.ts:79` | `concurrencyLimit` default 2 -> 8 |
| `config/dashboard.config.ts` | Example config for 10 providers |
| `.env.example` | 12 new env var placeholders |

---

## Task 1: Shared utilities (`shared.ts`)

**Files:**
- Create: `src/server/providers/shared.ts`
- Test: `tests/providers/shared.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/shared.test.ts`:

```ts
import { expect, test } from "bun:test"
import { parseNumber, isRetryableStatus, authError, parseResetTime } from "../../src/server/providers/shared"

test("parseNumber accepts numbers", () => {
  expect(parseNumber(42)).toBe(42)
  expect(parseNumber(3.14)).toBe(3.14)
  expect(parseNumber(0)).toBe(0)
})

test("parseNumber accepts numeric strings", () => {
  expect(parseNumber("42")).toBe(42)
  expect(parseNumber("3.14")).toBe(3.14)
})

test("parseNumber rejects non-numeric", () => {
  expect(parseNumber("abc")).toBeUndefined()
  expect(parseNumber(null)).toBeUndefined()
  expect(parseNumber(undefined)).toBeUndefined()
  expect(parseNumber({})).toBeUndefined()
  expect(parseNumber(NaN)).toBeUndefined()
  expect(parseNumber(Infinity)).toBeUndefined()
  expect(parseNumber("")).toBeUndefined()
})

test("isRetryableStatus: 5xx and 429 are retryable", () => {
  expect(isRetryableStatus(500)).toBe(true)
  expect(isRetryableStatus(502)).toBe(true)
  expect(isRetryableStatus(503)).toBe(true)
  expect(isRetryableStatus(429)).toBe(true)
})

test("isRetryableStatus: 2xx and 4xx (non-429) are not retryable", () => {
  expect(isRetryableStatus(200)).toBe(false)
  expect(isRetryableStatus(400)).toBe(false)
  expect(isRetryableStatus(401)).toBe(false)
  expect(isRetryableStatus(403)).toBe(false)
  expect(isRetryableStatus(404)).toBe(false)
})

test("authError produces non-retryable error", () => {
  const err = authError("DeepSeek authentication failed")
  expect(err.retryable).toBe(false)
  expect(err.message).toBe("DeepSeek authentication failed")
})

test("parseResetTime accepts ISO string", () => {
  expect(parseResetTime("2026-07-01T00:00:00Z")).toBe("2026-07-01T00:00:00Z")
})

test("parseResetTime converts milliseconds", () => {
  // 1751328000000 ms = 2025-07-01T00:00:00Z
  expect(parseResetTime(1751328000000)).toBe("2025-07-01T00:00:00.000Z")
})

test("parseResetTime converts seconds", () => {
  // 1751328000 s = 2025-07-01T00:00:00Z
  expect(parseResetTime(1751328000)).toBe("2025-07-01T00:00:00.000Z")
})

test("parseResetTime rejects zero and negative", () => {
  expect(parseResetTime(0)).toBeUndefined()
  expect(parseResetTime(-1)).toBeUndefined()
})

test("parseResetTime rejects non-numeric non-string", () => {
  expect(parseResetTime(null)).toBeUndefined()
  expect(parseResetTime(undefined)).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/providers/shared.test.ts`
Expected: FAIL with "Cannot find module '../../src/server/providers/shared'"

- [ ] **Step 3: Write minimal implementation**

Create `src/server/providers/shared.ts`:

```ts
// Shared helpers for provider adapters. Extracted from cc-switch's repeated
// patterns (parse_f64, extract_reset_time, error classification).

export type ProviderError = { message: string; retryable: boolean }

/// Parse a JSON value as a number, accepting both JSON numbers and numeric
/// strings. Mirrors cc-switch's `parse_f64` (balance.rs:415-420,
/// coding_plan.rs:81-85). Real provider APIs sometimes return numbers as
/// strings; strict Number() would throw.
export function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string") {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/// HTTP status >= 500 or 429 -> retryable. Shared by all adapters.
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429
}

/// Helper for 401/403 auth errors. Always non-retryable.
export function authError(message: string): ProviderError {
  return { message, retryable: false }
}

/// Parse a reset-time field that may be an ISO string, seconds, or
/// milliseconds. Mirrors cc-switch's `extract_reset_time`
/// (coding_plan.rs:64-78). Zero/negative -> undefined (no reset).
export function parseResetTime(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number") {
    if (value <= 0) return undefined
    // < 1e12 -> seconds; >= 1e12 -> milliseconds
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  return undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/providers/shared.test.ts`
Expected: PASS (all 10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/providers/shared.ts tests/providers/shared.test.ts
git commit -m "feat(providers): add shared helpers (parseNumber, isRetryableStatus, authError, parseResetTime)"
```

---

## Task 2: Domain types extension

**Files:**
- Modify: `src/shared/domain.ts:41-43` (ProviderAccountConfig union)
- Modify: `src/shared/domain.ts:55` (ProviderRuntimeState)
- Test: `tests/config/load-config.test.ts` (extended in Task 3)

- [ ] **Step 1: Extend ProviderAccountConfig union**

In `src/shared/domain.ts`, replace the `ProviderAccountConfig` type (lines 41-43):

```ts
export type ProviderAccountConfig =
  | { id: string; type: "poe"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "manual" }
  // A class - account balance (Bearer auth)
  | { id: string; type: "deepseek"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "stepfun"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "siliconflow"; baseUrl?: string | undefined; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "openrouter"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "novita"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  // B class - coding plan (Bearer auth, except Zhipu raw-key and Volcengine AK/SK)
  | { id: string; type: "kimi"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "zhipu"; baseUrl?: string | undefined; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "minimax"; baseUrl?: string | undefined; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "zenmux"; baseUrl: string; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "volcengine"; region?: string | undefined; akEnv?: string | undefined; ak?: string | undefined; skEnv?: string | undefined; sk?: string | undefined }
```

- [ ] **Step 2: Extend ProviderRuntimeState**

In `src/shared/domain.ts`, replace the `ProviderRuntimeState` type (line 55):

```ts
export type ProviderRuntimeState = {
  available: boolean
  apiKey?: string
  ak?: string
  sk?: string
  reason?: string
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no type errors - the new union members aren't constructed anywhere yet, but the types are valid)

- [ ] **Step 4: Commit**

```bash
git add src/shared/domain.ts
git commit -m "feat(domain): extend ProviderAccountConfig (+10 types) and ProviderRuntimeState (+ak/sk)"
```

---

## Task 3: Config loading - Bearer credential extraction + SSRF

**Files:**
- Modify: `src/server/config/load-config.ts` (extract `resolveBearerCredential`, add SSRF validation, add branches for 9 Bearer providers)
- Test: `tests/config/load-config.test.ts`

- [ ] **Step 1: Write failing tests for Bearer credential extraction**

Append to `tests/config/load-config.test.ts`:

```ts
test("deepseek provider resolves apiKeyEnv", () => {
  process.env.DEEPSEEK_TEST_KEY = "ds-secret"
  const config = loadDashboardConfig({
    providers: [{ id: "ds", type: "deepseek", apiKeyEnv: "DEEPSEEK_TEST_KEY" }],
    subscriptions: [{ id: "ds-sub", name: "DS", providerId: "ds", metrics: [{ id: "bal", label: "Balance", unit: "CNY", display: { module: "balance-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["ds-sub"] }],
  })
  expect(config.providerRuntime.get("ds")?.available).toBe(true)
  expect(config.providerRuntime.get("ds")?.apiKey).toBe("ds-secret")
  delete process.env.DEEPSEEK_TEST_KEY
})

test("deepseek provider unavailable when env missing and no fallback", () => {
  const config = loadDashboardConfig({
    providers: [{ id: "ds", type: "deepseek", apiKeyEnv: "DEEPSEEK_MISSING_KEY" }],
    subscriptions: [{ id: "ds-sub", name: "DS", providerId: "ds", metrics: [{ id: "bal", label: "Balance", unit: "CNY", display: { module: "balance-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["ds-sub"] }],
  })
  expect(config.providerRuntime.get("ds")?.available).toBe(false)
  expect(config.providerRuntime.get("ds")?.reason).toContain("DEEPSEEK_MISSING_KEY")
})

test("siliconflow rejects loopback baseUrl (SSRF)", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "sf", type: "siliconflow", baseUrl: "http://127.0.0.1:8080", apiKey: "k" }],
    subscriptions: [{ id: "sf-sub", name: "SF", providerId: "sf", metrics: [{ id: "bal", label: "B", unit: "CNY", display: { module: "balance-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["sf-sub"] }],
  })).toThrow("baseUrl")
})

test("siliconflow rejects non-allowlisted host (SSRF)", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "sf", type: "siliconflow", baseUrl: "https://api.evil.com", apiKey: "k" }],
    subscriptions: [{ id: "sf-sub", name: "SF", providerId: "sf", metrics: [{ id: "bal", label: "B", unit: "CNY", display: { module: "balance-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["sf-sub"] }],
  })).toThrow("baseUrl")
})

test("siliconflow accepts allowlisted CN host", () => {
  const config = loadDashboardConfig({
    providers: [{ id: "sf", type: "siliconflow", baseUrl: "https://api.siliconflow.cn", apiKey: "k" }],
    subscriptions: [{ id: "sf-sub", name: "SF", providerId: "sf", metrics: [{ id: "bal", label: "B", unit: "CNY", display: { module: "balance-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["sf-sub"] }],
  })
  expect(config.providerRuntime.get("sf")?.available).toBe(true)
})

test("zenmux rejects private IP baseUrl (SSRF)", () => {
  expect(() => loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "http://10.0.0.1", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })).toThrow("baseUrl")
})

test("zenmux accepts arbitrary public host", () => {
  const config = loadDashboardConfig({
    providers: [{ id: "zm", type: "zenmux", baseUrl: "https://my-zenmux.example.com", apiKey: "k" }],
    subscriptions: [{ id: "zm-sub", name: "ZM", providerId: "zm", metrics: [{ id: "5h", label: "5h", unit: "USD", display: { module: "rolling-window-card" } }] }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["zm-sub"] }],
  })
  expect(config.providerRuntime.get("zm")?.available).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/config/load-config.test.ts`
Expected: FAIL (new tests fail - deepseek type not handled in load-config)

- [ ] **Step 3: Implement `resolveBearerCredential`, SSRF validation, and new provider branches**

In `src/server/config/load-config.ts`, add after the `VALID_DISPLAY_MODULES` constant (line 21):

```ts
const PROVIDER_HOST_ALLOWLIST: Record<string, string[]> = {
  siliconflow: ["api.siliconflow.cn", "api.siliconflow.com"],
  zhipu: ["open.bigmodel.cn", "api.z.ai"],
  minimax: ["api.minimaxi.com", "api.minimax.io"],
}

const BEARER_PROVIDER_TYPES = new Set([
  "poe", "deepseek", "stepfun", "siliconflow", "openrouter", "novita",
  "kimi", "zhipu", "minimax", "zenmux",
])

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

function isLoopbackOrPrivateHost(host: string): boolean {
  const lower = host.toLowerCase()
  // Strip port
  const hostname = lower.split(":")[0]!
  if (hostname === "localhost" || hostname === "::1") return true
  // IPv4 loopback / private
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 127) return true
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true // link-local / cloud metadata
  }
  return false
}

function validateBaseUrl(baseUrl: string | undefined, providerType: string, path: string): void {
  if (baseUrl === undefined) return
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    fail(path, `baseUrl "${baseUrl}" is not a valid URL`)
  }
  const host = parsed.hostname.toLowerCase()
  if (isLoopbackOrPrivateHost(host)) {
    fail(path, `baseUrl host "${host}" is loopback or private (SSRF defense)`)
  }
  const allowlist = PROVIDER_HOST_ALLOWLIST[providerType]
  if (allowlist !== undefined && !allowlist.includes(host)) {
    fail(path, `baseUrl host "${host}" not in allowlist for ${providerType}: ${allowlist.join(", ")}`)
  }
}
```

Then replace the provider loop body (lines 87-118) with:

```ts
  for (const provider of input.providers) {
    if (providers.has(provider.id)) {
      fail(`providers[${provider.id}]`, "duplicate provider id")
    }
    const providerPath = `providers[${provider.id}]`

    if (provider.type === "volcengine") {
      const region = provider.region ?? "cn-beijing"
      const { ak, sk, reason } = resolveAkSkCredential(provider)
      const state: ProviderRuntimeState =
        ak !== undefined && sk !== undefined
          ? { available: true, ak, sk }
          : { available: false, reason: reason ?? "missing AK or SK" }
      providers.set(provider.id, { ...provider, region })
      providerRuntime.set(provider.id, state)
    } else if (BEARER_PROVIDER_TYPES.has(provider.type)) {
      // Validate baseUrl for providers that accept it
      if ("baseUrl" in provider && provider.baseUrl !== undefined) {
        validateBaseUrl(provider.baseUrl, provider.type, `${providerPath}.baseUrl`)
      }
      // zenmux requires baseUrl
      if (provider.type === "zenmux" && !("baseUrl" in provider) ) {
        fail(`${providerPath}.baseUrl`, "zenmux requires baseUrl")
      }
      if (provider.type === "zenmux" && provider.baseUrl === undefined) {
        fail(`${providerPath}.baseUrl`, "zenmux requires baseUrl")
      }
      const { apiKey, reason } = resolveBearerCredential(provider)
      const state: ProviderRuntimeState = { available: apiKey !== undefined }
      if (apiKey !== undefined) state.apiKey = apiKey
      if (reason !== undefined) state.reason = reason
      providers.set(provider.id, provider)
      providerRuntime.set(provider.id, state)
    } else {
      // manual
      providers.set(provider.id, provider)
      providerRuntime.set(provider.id, { available: true })
    }
  }
```

Note: the original Poe branch's logic is now inside the `BEARER_PROVIDER_TYPES` branch, which includes `"poe"`. The `resolveBearerCredential` function is identical to the inline Poe logic it replaces.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/config/load-config.test.ts`
Expected: PASS (all tests including new ones)

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `bun test`
Expected: PASS (existing tests still pass - Poe config behavior unchanged)

- [ ] **Step 6: Commit**

```bash
git add src/server/config/load-config.ts tests/config/load-config.test.ts
git commit -m "feat(config): extract resolveBearerCredential, add AK/SK + SSRF validation for 10 new providers"
```

---

## Task 4: Type widening in main.ts and app.ts + concurrency bump

**Files:**
- Modify: `src/server/main.ts:25`
- Modify: `src/server/http/app.ts:25`
- Modify: `src/server/refresh/refresh-service.ts:79`

- [ ] **Step 1: Widen main.ts provider map type**

In `src/server/main.ts`, replace line 25:

```ts
const providers = new Map<string, ProviderAdapter>([
  ["manual", createManualProvider()],
  ["poe", createPoeProvider()],
])
```

Add the import for `ProviderAdapter` type if not already present (it's used via `ReturnType<typeof createManualProvider>` currently):

```ts
import type { ProviderAdapter } from "./providers/types"
```

- [ ] **Step 2: Widen app.ts AppDeps type**

In `src/server/http/app.ts`, replace line 25:

```ts
  providers: Map<string, ProviderAdapter>
```

- [ ] **Step 3: Bump concurrency limit**

In `src/server/refresh/refresh-service.ts`, replace line 79:

```ts
  const concurrencyLimit = deps.concurrencyLimit ?? 8
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/main.ts src/server/http/app.ts src/server/refresh/refresh-service.ts
git commit -m "refactor: widen provider map type to Map<string, ProviderAdapter>, bump concurrency 2->8"
```

---

## Task 5: Projection generalization (`isPoeOverLimit` -> `isOverLimit`)

**Files:**
- Modify: `src/server/dashboard/project.ts:309-314, 333, 628-656`
- Test: `tests/dashboard/project.test.ts`

- [ ] **Step 1: Write failing tests for generalized over-limit**

Append to `tests/dashboard/project.test.ts`:

```ts
test("non-poe gauge-remaining over limit shows ok status (isOverLimit)", () => {
  const config = makeConfig({
    providers: [{ id: "ds", type: "deepseek", apiKey: "k" }],
    subscriptions: [{
      id: "ds-sub", name: "DS", providerId: "ds",
      metrics: [{
        id: "bal", providerMetricId: "balance", label: "Balance", unit: "CNY",
        limit: 50, sourceValueKind: "gauge-remaining",
        display: { module: "balance-card" },
      }],
    }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["ds-sub"] }],
  })
  const providers: ProviderAccountProjection[] = [{
    providerAccountId: "ds",
    metrics: [{
      providerMetricId: "balance", label: "Balance", unit: "CNY",
      remaining: 100, sourceValueKind: "gauge-remaining", sourceConfidence: "known",
    }],
    cache: okCache,
  }]
  const payload = buildDashboardPayload({
    config, profileId: "self", generatedAt: NOW,
    selectedRange: "24h", providers,
  })
  const metric = payload.subscriptions[0]!.metrics[0]!
  expect(metric.status).toBe("ok")
  expect(metric.used).toBe(0)
  expect(metric.percentUsed).toBeUndefined()
})

test("gauge-used over limit shows ok status (isOverLimit)", () => {
  const config = makeConfig({
    providers: [{ id: "vol", type: "volcengine", ak: "a", sk: "s" }],
    subscriptions: [{
      id: "vol-sub", name: "Vol", providerId: "vol",
      metrics: [{
        id: "afp", providerMetricId: "afp:5h", label: "AFP 5h", unit: "tokens",
        limit: 1000, sourceValueKind: "gauge-used",
        display: { module: "period-quota-card" },
      }],
    }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["vol-sub"] }],
  })
  const providers: ProviderAccountProjection[] = [{
    providerAccountId: "vol",
    metrics: [{
      providerMetricId: "afp:5h", label: "AFP 5h", unit: "tokens",
      used: 1500, limit: 1000, sourceValueKind: "gauge-used", sourceConfidence: "known",
    }],
    cache: okCache,
  }]
  const payload = buildDashboardPayload({
    config, profileId: "self", generatedAt: NOW,
    selectedRange: "24h", providers,
  })
  expect(payload.subscriptions[0]!.metrics[0]!.status).toBe("ok")
})

test("percent-based metric at 100% without over-limit shows critical", () => {
  const config = makeConfig({
    providers: [{ id: "mm", type: "minimax", apiKey: "k" }],
    subscriptions: [{
      id: "mm-sub", name: "MM", providerId: "mm",
      metrics: [{
        id: "5h", providerMetricId: "five_hour", label: "5h", unit: "%",
        limit: 100, sourceValueKind: "gauge-remaining",
        display: { module: "rolling-window-card", thresholds: { criticalPercentUsed: 95 } },
      }],
    }],
    profiles: [{ id: "self", name: "P", viewKey: "k", subscriptionIds: ["mm-sub"] }],
  })
  const providers: ProviderAccountProjection[] = [{
    providerAccountId: "mm",
    metrics: [{
      providerMetricId: "five_hour", label: "5h", unit: "%",
      remaining: 0, limit: 100, sourceValueKind: "gauge-remaining", sourceConfidence: "known",
    }],
    cache: okCache,
  }]
  const payload = buildDashboardPayload({
    config, profileId: "self", generatedAt: NOW,
    selectedRange: "24h", providers,
  })
  // used=100, percentUsed=100, hits critical threshold, NOT isOverLimit (used=100 is not > limit=100)
  expect(payload.subscriptions[0]!.metrics[0]!.status).toBe("critical")
})
```

Note: add `ProviderAccountProjection` to the imports at the top of the file if not already imported. It is exported from `src/server/dashboard/project.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/dashboard/project.test.ts`
Expected: FAIL (first test: deepseek provider type not registered in test config's provider map; or `isPoeOverLimit` still Poe-specific)

- [ ] **Step 3: Generalize `isPoeOverLimit` to `isOverLimit`**

In `src/server/dashboard/project.ts`, replace the `isPoeOverLimit` computation in `buildDashboardMetric` (around line 309):

```ts
  const limit = config.limit ?? pm?.limit
  const providerRemaining = config.remaining ?? pm?.remaining
  const providerUsed = config.used ?? pm?.used

  // Over-limit: balance/used exceeds configured limit. Generalized from
  // Poe-specific to cover gauge-remaining (balance > limit), gauge-used
  // (used > limit), and percent-based (used >= limit, e.g. limit=100).
  const isOverLimit =
    (pm?.sourceValueKind === "gauge-remaining" &&
      limit !== undefined && providerRemaining !== undefined &&
      providerRemaining > limit) ||
    (pm?.sourceValueKind === "gauge-used" &&
      limit !== undefined && providerUsed !== undefined &&
      providerUsed > limit) ||
    (limit !== undefined && providerUsed !== undefined && limit > 0 &&
      providerUsed >= limit && pm?.sourceValueKind !== "status")

  let used: number | undefined = providerUsed
  let remaining: number | undefined = providerRemaining
  if (isOverLimit) {
    used = 0
  } else if (used === undefined && limit !== undefined && remaining !== undefined) {
    used = Math.max(0, limit - remaining)
  }

  let percentUsed: number | undefined
  if (!isOverLimit && limit !== undefined && limit > 0 && used !== undefined) {
    percentUsed = (used / limit) * 100
  }
```

Then update the `computeMetricStatus` call (around line 333) - rename the parameter:

```ts
  const status = computeMetricStatus({
    providerType,
    cache: p.cache,
    providerMetric: pm,
    limit,
    used,
    percentUsed,
    isOverLimit,
    window,
    generatedAt,
    thresholds: config.display.thresholds,
  })
```

Then update the `computeMetricStatus` function signature (around line 628) - rename `isPoeOverLimit` to `isOverLimit`:

```ts
function computeMetricStatus(input: {
  providerType: string
  cache: ProviderCacheSummary | undefined
  providerMetric: NormalizedMetric | undefined
  limit: number | undefined
  used: number | undefined
  percentUsed: number | undefined
  isOverLimit: boolean
  window: DashboardWindow | undefined
  generatedAt: string
  thresholds: MetricConfig["display"]["thresholds"] | undefined
}): MetricStatus {
  const { cache, providerMetric, limit, used, percentUsed, isOverLimit, window, generatedAt, thresholds } = input
```

And replace the `isPoeOverLimit` references in the function body (around line 650):

```ts
  if (isOverLimit) {
    // Over-limit: status ok unless stale forces a higher-precedence mark.
    if (cache?.staleAfter && Date.parse(cache.staleAfter) < Date.parse(generatedAt)) {
      return "stale"
    }
    return "ok"
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/dashboard/project.test.ts`
Expected: PASS (all tests including new ones)

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/dashboard/project.ts tests/dashboard/project.test.ts
git commit -m "refactor(projection): generalize isPoeOverLimit to isOverLimit (gauge-remaining + gauge-used + percent)"
```

---

## Task 6: DeepSeek adapter

**Files:**
- Create: `src/server/providers/deepseek.ts`
- Test: `tests/providers/deepseek.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/deepseek.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig, ProviderRuntimeState } from "../../src/shared/domain"
import { createDeepseekProvider } from "../../src/server/providers/deepseek"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "ds-1", type: "deepseek", apiKey: "ds-key" }
const metric: MetricConfig = {
  id: "balance", providerMetricId: "balance",
  label: "Balance", unit: "CNY",
  display: { module: "balance-card" },
}
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id,
    provider,
    runtime: { available: true, apiKey: "ds-key" },
    now: NOW,
    metrics: [metric],
    ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("deepseek parses balance_infos[0].total_balance", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    return makeResp(200, {
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: 42.5 }],
    })
  }
  const result = await createDeepseekProvider(fakeFetch).refresh(buildInput())
  expect(calls).toEqual(["https://api.deepseek.com/user/balance"])
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]!.providerMetricId).toBe("balance")
  expect(result.metrics[0]!.remaining).toBe(42.5)
  expect(result.metrics[0]!.sourceValueKind).toBe("gauge-remaining")
  expect(result.metrics[0]!.sourceConfidence).toBe("known")
  expect(result.errors).toBeUndefined()
})

test("deepseek handles numeric string total_balance", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "100.5" }] })
  const result = await createDeepseekProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(100.5)
})

test("deepseek 401 returns non-retryable auth error", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(401, { error: "unauthorized" })
  const result = await createDeepseekProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors).toHaveLength(1)
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.errors![0]!.message).toContain("authentication failed")
})

test("deepseek 500 returns retryable error", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(500, { error: "server" })
  const result = await createDeepseekProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("deepseek network error returns retryable error", async () => {
  const fakeFetch = async (): Promise<Response> => { throw new Error("connection refused") }
  const result = await createDeepseekProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
  expect(result.errors![0]!.message).toContain("network")
})

test("deepseek unavailable when no apiKey", async () => {
  const result = await createDeepseekProvider().refresh(buildInput({
    runtime: { available: false, reason: "no key" },
  }))
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.errors![0]!.message).toContain("unavailable")
})

test("deepseek notes insufficient balance when is_available false", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, { is_available: false, balance_infos: [{ currency: "CNY", total_balance: 0 }] })
  const result = await createDeepseekProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.notes).toContain("Insufficient balance")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/providers/deepseek.test.ts`
Expected: FAIL ("Cannot find module '../../src/server/providers/deepseek'")

- [ ] **Step 3: Implement the adapter**

Create `src/server/providers/deepseek.ts`:

```ts
import type { MetricConfig } from "../../shared/domain"
import type {
  NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult,
} from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// DeepSeek balance adapter.
// GET https://api.deepseek.com/user/balance
// Auth: Bearer <key>
// Response: { is_available: boolean, balance_infos: [{ currency, total_balance }] }
// Source: cc-switch balance.rs:74-146

const DEEPSEEK_URL = "https://api.deepseek.com/user/balance"
const BALANCE_METRIC_ID = "balance"

export function createDeepseekProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "deepseek",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "DeepSeek provider unavailable: API key not configured", retryable: false }] }
      }

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: { is_available?: boolean; balance_infos?: Array<{ currency?: string; total_balance?: unknown }> }
      try {
        const res = await fetchImpl(DEEPSEEK_URL, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("DeepSeek authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `DeepSeek balance request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "DeepSeek balance request network error", retryable: true }] }
      }

      const metric = mapBalance(body, input.metrics)
      return { ...base, metrics: metric ? [metric] : [] }
    },
  }
}

function mapBalance(
  body: { is_available?: boolean; balance_infos?: Array<{ currency?: string; total_balance?: unknown }> },
  metrics: MetricConfig[],
): NormalizedMetric | undefined {
  const info = body.balance_infos?.[0]
  if (!info) return undefined
  const remaining = parseNumber(info.total_balance)
  if (remaining === undefined) return undefined
  const cfg = metrics.find((m) => m.providerMetricId === BALANCE_METRIC_ID) ?? metrics[0]
  const metric: NormalizedMetric = {
    providerMetricId: BALANCE_METRIC_ID,
    label: cfg?.label ?? "Balance",
    unit: cfg?.unit ?? "CNY",
    remaining,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
  }
  if (body.is_available === false) {
    metric.notes = "Insufficient balance"
  }
  return metric
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/providers/deepseek.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Register adapter in main.ts**

In `src/server/main.ts`, add imports and map entries. The final providers map should look like:

```ts
import { createDeepseekProvider } from "./providers/deepseek"
// ... other imports later

const providers = new Map<string, ProviderAdapter>([
  ["manual", createManualProvider()],
  ["poe", createPoeProvider()],
  ["deepseek", createDeepseekProvider()],
])
```

(Only add deepseek now; subsequent tasks add the rest.)

- [ ] **Step 6: Run typecheck and full test suite**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/server/providers/deepseek.ts tests/providers/deepseek.test.ts src/server/main.ts
git commit -m "feat(providers): add DeepSeek balance adapter"
```

---

## Task 7: StepFun adapter

**Files:**
- Create: `src/server/providers/stepfun.ts`
- Test: `tests/providers/stepfun.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/stepfun.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createStepfunProvider } from "../../src/server/providers/stepfun"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "sf-1", type: "stepfun", apiKey: "sf-key" }
const metric: MetricConfig = {
  id: "balance", providerMetricId: "balance",
  label: "Balance", unit: "CNY",
  display: { module: "balance-card" },
}
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id, provider,
    runtime: { available: true, apiKey: "sf-key" },
    now: NOW, metrics: [metric], ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("stepfun parses top-level balance", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { object: "account", type: "cash", balance: 88.8 })
  }
  const result = await createStepfunProvider(fakeFetch).refresh(buildInput())
  expect(calls).toEqual(["https://api.stepfun.com/v1/accounts"])
  expect(result.metrics[0]!.remaining).toBe(88.8)
  expect(result.errors).toBeUndefined()
})

test("stepfun handles numeric string balance", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(200, { balance: "200" })
  const result = await createStepfunProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(200)
})

test("stepfun 401 non-retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(401, {})
  const result = await createStepfunProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("stepfun 429 retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(429, {})
  const result = await createStepfunProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("stepfun network error retryable", async () => {
  const fakeFetch = async (): Promise<Response> => { throw new Error("timeout") }
  const result = await createStepfunProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("stepfun unavailable without key", async () => {
  const result = await createStepfunProvider().refresh(buildInput({
    runtime: { available: false, reason: "no key" },
  }))
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.metrics).toHaveLength(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/providers/stepfun.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

Create `src/server/providers/stepfun.ts`:

```ts
import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// StepFun balance adapter.
// GET https://api.stepfun.com/v1/accounts
// Auth: Bearer <key>
// Response: { balance: number } (top-level)
// Source: cc-switch balance.rs:152-204

const STEPFUN_URL = "https://api.stepfun.com/v1/accounts"
const BALANCE_METRIC_ID = "balance"

export function createStepfunProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "stepfun",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "StepFun provider unavailable: API key not configured", retryable: false }] }
      }

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: { balance?: unknown }
      try {
        const res = await fetchImpl(STEPFUN_URL, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("StepFun authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `StepFun balance request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "StepFun balance request network error", retryable: true }] }
      }

      const metric = mapBalance(body, input.metrics)
      return { ...base, metrics: metric ? [metric] : [] }
    },
  }
}

function mapBalance(body: { balance?: unknown }, metrics: MetricConfig[]): NormalizedMetric | undefined {
  const remaining = parseNumber(body.balance)
  if (remaining === undefined) return undefined
  const cfg = metrics.find((m) => m.providerMetricId === BALANCE_METRIC_ID) ?? metrics[0]
  return {
    providerMetricId: BALANCE_METRIC_ID,
    label: cfg?.label ?? "Balance",
    unit: cfg?.unit ?? "CNY",
    remaining,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
  }
}
```

- [ ] **Step 4: Register in main.ts**

Add `import { createStepfunProvider } from "./providers/stepfun"` and `["stepfun", createStepfunProvider()],` to the map.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run typecheck && bun test tests/providers/stepfun.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/providers/stepfun.ts tests/providers/stepfun.test.ts src/server/main.ts
git commit -m "feat(providers): add StepFun balance adapter"
```

---

## Task 8: SiliconFlow adapter

**Files:**
- Create: `src/server/providers/siliconflow.ts`
- Test: `tests/providers/siliconflow.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/siliconflow.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createSiliconflowProvider } from "../../src/server/providers/siliconflow"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "sf-1", type: "siliconflow", apiKey: "sf-key" }
const metric: MetricConfig = {
  id: "balance", providerMetricId: "balance",
  label: "Balance", unit: "CNY",
  display: { module: "balance-card" },
}
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id, provider,
    runtime: { available: true, apiKey: "sf-key" },
    now: NOW, metrics: [metric], ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("siliconflow parses data.totalBalance (CN default)", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { code: 200, data: { totalBalance: 55.5, status: "normal" } })
  }
  const result = await createSiliconflowProvider(fakeFetch).refresh(buildInput())
  expect(calls[0]).toBe("https://api.siliconflow.cn/v1/user/info")
  expect(result.metrics[0]!.remaining).toBe(55.5)
})

test("siliconflow uses EN baseUrl when configured", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { data: { totalBalance: 10 } })
  }
  const result = await createSiliconflowProvider(fakeFetch).refresh(buildInput({
    provider: { id: "sf-1", type: "siliconflow", baseUrl: "https://api.siliconflow.com", apiKey: "k" },
  }))
  expect(calls[0]).toBe("https://api.siliconflow.com/v1/user/info")
  expect(result.metrics[0]!.remaining).toBe(10)
})

test("siliconflow handles string totalBalance", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, { data: { totalBalance: "99.9" } })
  const result = await createSiliconflowProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(99.9)
})

test("siliconflow 401 non-retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(401, {})
  const result = await createSiliconflowProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("siliconflow missing data field -> non-retryable error", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(200, { code: 200 })
  const result = await createSiliconflowProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.retryable).toBe(false)
})

test("siliconflow network error retryable", async () => {
  const fakeFetch = async (): Promise<Response> => { throw new Error("timeout") }
  const result = await createSiliconflowProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/providers/siliconflow.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

Create `src/server/providers/siliconflow.ts`:

```ts
import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// SiliconFlow balance adapter (CN + EN share one adapter, baseUrl selects host).
// GET <baseUrl>/v1/user/info  (default https://api.siliconflow.cn)
// Auth: Bearer <key>
// Response: { data: { totalBalance: number } }
// Source: cc-switch balance.rs:210-281

const DEFAULT_BASE_URL = "https://api.siliconflow.cn"
const BALANCE_METRIC_ID = "balance"

type SiliconflowProvider = { id: string; type: "siliconflow"; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }

export function createSiliconflowProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "siliconflow",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "SiliconFlow provider unavailable: API key not configured", retryable: false }] }
      }

      const providerConfig = input.provider as SiliconflowProvider
      const baseUrl = providerConfig.baseUrl ?? DEFAULT_BASE_URL
      const url = `${baseUrl}/v1/user/info`

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: { data?: { totalBalance?: unknown } }
      try {
        const res = await fetchImpl(url, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("SiliconFlow authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `SiliconFlow balance request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "SiliconFlow balance request network error", retryable: true }] }
      }

      if (!body.data) {
        return { ...base, errors: [{ message: "SiliconFlow response missing 'data' field", retryable: false }] }
      }
      const metric = mapBalance(body.data, input.metrics)
      return { ...base, metrics: metric ? [metric] : [] }
    },
  }
}

function mapBalance(data: { totalBalance?: unknown }, metrics: MetricConfig[]): NormalizedMetric | undefined {
  const remaining = parseNumber(data.totalBalance)
  if (remaining === undefined) return undefined
  const cfg = metrics.find((m) => m.providerMetricId === BALANCE_METRIC_ID) ?? metrics[0]
  return {
    providerMetricId: BALANCE_METRIC_ID,
    label: cfg?.label ?? "Balance",
    unit: cfg?.unit ?? "CNY",
    remaining,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
  }
}
```

- [ ] **Step 4: Register in main.ts**

Add import and `["siliconflow", createSiliconflowProvider()],`.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run typecheck && bun test tests/providers/siliconflow.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/providers/siliconflow.ts tests/providers/siliconflow.test.ts src/server/main.ts
git commit -m "feat(providers): add SiliconFlow balance adapter (CN/EN via baseUrl)"
```

---

## Task 9: OpenRouter adapter

**Files:**
- Create: `src/server/providers/openrouter.ts`
- Test: `tests/providers/openrouter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/openrouter.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createOpenrouterProvider } from "../../src/server/providers/openrouter"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "or-1", type: "openrouter", apiKey: "or-key" }
const metric: MetricConfig = {
  id: "balance", providerMetricId: "balance",
  label: "Credits", unit: "USD",
  display: { module: "balance-card" },
}
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id, provider,
    runtime: { available: true, apiKey: "or-key" },
    now: NOW, metrics: [metric], ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("openrouter computes remaining = total_credits - total_usage", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { data: { total_credits: 100, total_usage: 30 } })
  }
  const result = await createOpenrouterProvider(fakeFetch).refresh(buildInput())
  expect(calls).toEqual(["https://openrouter.ai/api/v1/credits"])
  const m = result.metrics[0]!
  expect(m.remaining).toBe(70)
  expect(m.limit).toBe(100)
  expect(m.used).toBe(30)
  expect(m.sourceValueKind).toBe("gauge-remaining")
})

test("openrouter notes no credits when remaining <= 0", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, { data: { total_credits: 10, total_usage: 15 } })
  const result = await createOpenrouterProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(-5)
  expect(result.metrics[0]!.notes).toContain("No credits remaining")
})

test("openrouter handles string numbers", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, { data: { total_credits: "100", total_usage: "25" } })
  const result = await createOpenrouterProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(75)
})

test("openrouter 401 non-retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(401, {})
  const result = await createOpenrouterProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("openrouter 503 retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(503, {})
  const result = await createOpenrouterProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("openrouter network error retryable", async () => {
  const fakeFetch = async (): Promise<Response> => { throw new Error("dns") }
  const result = await createOpenrouterProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/providers/openrouter.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

Create `src/server/providers/openrouter.ts`:

```ts
import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// OpenRouter balance adapter.
// GET https://openrouter.ai/api/v1/credits
// Auth: Bearer <key>
// Response: { data: { total_credits: number, total_usage: number } }
// remaining = total_credits - total_usage; limit = total_credits; used = total_usage
// Source: cc-switch balance.rs:287-346

const OPENROUTER_URL = "https://openrouter.ai/api/v1/credits"
const BALANCE_METRIC_ID = "balance"

export function createOpenrouterProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "openrouter",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "OpenRouter provider unavailable: API key not configured", retryable: false }] }
      }

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: { data?: { total_credits?: unknown; total_usage?: unknown } }
      try {
        const res = await fetchImpl(OPENROUTER_URL, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("OpenRouter authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `OpenRouter balance request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "OpenRouter balance request network error", retryable: true }] }
      }

      const data = body.data ?? {}
      const totalCredits = parseNumber(data.total_credits) ?? 0
      const totalUsage = parseNumber(data.total_usage) ?? 0
      const metric = mapBalance(totalCredits, totalUsage, input.metrics)
      return { ...base, metrics: metric ? [metric] : [] }
    },
  }
}

function mapBalance(totalCredits: number, totalUsage: number, metrics: MetricConfig[]): NormalizedMetric | undefined {
  const remaining = totalCredits - totalUsage
  const cfg = metrics.find((m) => m.providerMetricId === BALANCE_METRIC_ID) ?? metrics[0]
  const metric: NormalizedMetric = {
    providerMetricId: BALANCE_METRIC_ID,
    label: cfg?.label ?? "Credits",
    unit: cfg?.unit ?? "USD",
    remaining,
    limit: totalCredits,
    used: totalUsage,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
  }
  if (remaining <= 0) {
    metric.notes = "No credits remaining"
  }
  return metric
}
```

- [ ] **Step 4: Register in main.ts**

Add import and `["openrouter", createOpenrouterProvider()],`.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run typecheck && bun test tests/providers/openrouter.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/providers/openrouter.ts tests/providers/openrouter.test.ts src/server/main.ts
git commit -m "feat(providers): add OpenRouter balance adapter (limit/used/remaining)"
```

---

## Task 10: Novita adapter

**Files:**
- Create: `src/server/providers/novita.ts`
- Test: `tests/providers/novita.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/novita.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createNovitaProvider } from "../../src/server/providers/novita"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "nv-1", type: "novita", apiKey: "nv-key" }
const metric: MetricConfig = {
  id: "balance", providerMetricId: "balance",
  label: "Balance", unit: "USD",
  display: { module: "balance-card" },
}
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id, provider,
    runtime: { available: true, apiKey: "nv-key" },
    now: NOW, metrics: [metric], ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("novita divides availableBalance by 10000", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { availableBalance: 500000 })
  }
  const result = await createNovitaProvider(fakeFetch).refresh(buildInput())
  expect(calls).toEqual(["https://api.novita.ai/v3/user/balance"])
  expect(result.metrics[0]!.remaining).toBe(50) // 500000 / 10000
})

test("novita handles string availableBalance", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, { availableBalance: "250000" })
  const result = await createNovitaProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(25)
})

test("novita notes no balance when remaining <= 0", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, { availableBalance: 0 })
  const result = await createNovitaProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(0)
  expect(result.metrics[0]!.notes).toContain("No balance remaining")
})

test("novita 403 non-retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(403, {})
  const result = await createNovitaProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("novita 500 retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(500, {})
  const result = await createNovitaProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("novita network error retryable", async () => {
  const fakeFetch = async (): Promise<Response> => { throw new Error("reset") }
  const result = await createNovitaProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/providers/novita.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

Create `src/server/providers/novita.ts`:

```ts
import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// Novita AI balance adapter.
// GET https://api.novita.ai/v3/user/balance
// Auth: Bearer <key>
// Response: { availableBalance: number }  (raw unit = 0.0001 USD, divide by 10000)
// Source: cc-switch balance.rs:353-410

const NOVITA_URL = "https://api.novita.ai/v3/user/balance"
const BALANCE_METRIC_ID = "balance"
const NOVITA_UNIT_DIVISOR = 10000

export function createNovitaProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "novita",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "Novita provider unavailable: API key not configured", retryable: false }] }
      }

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: { availableBalance?: unknown }
      try {
        const res = await fetchImpl(NOVITA_URL, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("Novita authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `Novita balance request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "Novita balance request network error", retryable: true }] }
      }

      const raw = parseNumber(body.availableBalance) ?? 0
      const remaining = raw / NOVITA_UNIT_DIVISOR
      const metric = mapBalance(remaining, input.metrics)
      return { ...base, metrics: metric ? [metric] : [] }
    },
  }
}

function mapBalance(remaining: number, metrics: MetricConfig[]): NormalizedMetric {
  const cfg = metrics.find((m) => m.providerMetricId === BALANCE_METRIC_ID) ?? metrics[0]
  const metric: NormalizedMetric = {
    providerMetricId: BALANCE_METRIC_ID,
    label: cfg?.label ?? "Balance",
    unit: cfg?.unit ?? "USD",
    remaining,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
  }
  if (remaining <= 0) {
    metric.notes = "No balance remaining"
  }
  return metric
}
```

- [ ] **Step 4: Register in main.ts**

Add import and `["novita", createNovitaProvider()],`.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run typecheck && bun test tests/providers/novita.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/providers/novita.ts tests/providers/novita.test.ts src/server/main.ts
git commit -m "feat(providers): add Novita balance adapter (÷10000 unit scaling)"
```

---

## Task 11: Kimi adapter

**Files:**
- Create: `src/server/providers/kimi.ts`
- Test: `tests/providers/kimi.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/kimi.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createKimiProvider } from "../../src/server/providers/kimi"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "kimi-1", type: "kimi", apiKey: "kimi-key" }
const metrics: MetricConfig[] = [
  { id: "5h", providerMetricId: "five_hour", label: "5h", unit: "tokens", display: { module: "rolling-window-card" } },
  { id: "wk", providerMetricId: "weekly_limit", label: "Weekly", unit: "tokens", display: { module: "period-quota-card" } },
]
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id, provider,
    runtime: { available: true, apiKey: "kimi-key" },
    now: NOW, metrics, ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("kimi parses limits[].detail (five_hour) and usage (weekly_limit)", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, {
      limits: [{ detail: { limit: 1000, remaining: 800, resetTime: "2026-07-17T05:00:00Z" } }],
      usage: { limit: 10000, remaining: 7000, resetTime: "2026-07-24T00:00:00Z" },
    })
  }
  const result = await createKimiProvider(fakeFetch).refresh(buildInput())
  expect(calls).toEqual(["https://api.kimi.com/coding/v1/usages"])
  expect(result.metrics).toHaveLength(2)
  const fiveHour = result.metrics.find((m) => m.providerMetricId === "five_hour")!
  expect(fiveHour.limit).toBe(1000)
  expect(fiveHour.remaining).toBe(800)
  expect(fiveHour.used).toBe(200)
  expect(fiveHour.window?.kind).toBe("rolling")
  expect(fiveHour.sourceValueKind).toBe("gauge-remaining")
  const weekly = result.metrics.find((m) => m.providerMetricId === "weekly_limit")!
  expect(weekly.limit).toBe(10000)
  expect(weekly.remaining).toBe(7000)
})

test("kimi only returns five_hour when usage absent", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, { limits: [{ detail: { limit: 500, remaining: 400, resetTime: "2026-07-17T05:00:00Z" } }] })
  const result = await createKimiProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]!.providerMetricId).toBe("five_hour")
})

test("kimi handles numeric string fields", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, {
      limits: [{ detail: { limit: "1000", remaining: "800", resetTime: "2026-07-17T05:00:00Z" } }],
      usage: { limit: "10000", remaining: "7000", resetTime: "2026-07-24T00:00:00Z" },
    })
  const result = await createKimiProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.limit).toBe(1000)
  expect(result.metrics[1]!.remaining).toBe(7000)
})

test("kimi 401 non-retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(401, {})
  const result = await createKimiProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("kimi 429 retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(429, {})
  const result = await createKimiProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("kimi network error retryable", async () => {
  const fakeFetch = async (): Promise<Response> => { throw new Error("reset") }
  const result = await createKimiProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/providers/kimi.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

Create `src/server/providers/kimi.ts`:

```ts
import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber, parseResetTime } from "./shared"

// Kimi coding-plan adapter.
// GET https://api.kimi.com/coding/v1/usages
// Auth: Bearer <key>
// Response: { limits: [{ detail: { limit, remaining, resetTime } }], usage: { limit, remaining, resetTime } }
// limits[].detail -> five_hour; usage -> weekly_limit
// Source: cc-switch coding_plan.rs:100-206

const KIMI_URL = "https://api.kimi.com/coding/v1/usages"

export function createKimiProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "kimi",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "Kimi provider unavailable: API key not configured", retryable: false }] }
      }

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: {
        limits?: Array<{ detail?: { limit?: unknown; remaining?: unknown; resetTime?: unknown } }>
        usage?: { limit?: unknown; remaining?: unknown; resetTime?: unknown }
      }
      try {
        const res = await fetchImpl(KIMI_URL, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("Kimi authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `Kimi usage request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "Kimi usage request network error", retryable: true }] }
      }

      const metrics: NormalizedMetric[] = []
      // five_hour from limits[].detail (first entry)
      const firstLimit = body.limits?.[0]?.detail
      if (firstLimit) {
        const m = mapTier("five_hour", firstLimit, input.metrics)
        if (m) metrics.push(m)
      }
      // weekly_limit from top-level usage
      if (body.usage) {
        const m = mapTier("weekly_limit", body.usage, input.metrics)
        if (m) metrics.push(m)
      }
      return { ...base, metrics }
    },
  }
}

function mapTier(
  providerMetricId: string,
  detail: { limit?: unknown; remaining?: unknown; resetTime?: unknown },
  metrics: MetricConfig[],
): NormalizedMetric | undefined {
  const limit = parseNumber(detail.limit)
  const remaining = parseNumber(detail.remaining)
  if (limit === undefined || remaining === undefined) return undefined
  const used = Math.max(0, limit - remaining)
  const resetAt = parseResetTime(detail.resetTime)
  const cfg = metrics.find((m) => m.providerMetricId === providerMetricId)
  const metric: NormalizedMetric = {
    providerMetricId,
    label: cfg?.label ?? providerMetricId,
    unit: cfg?.unit ?? "tokens",
    limit,
    remaining,
    used,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
    ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration: providerMetricId === "five_hour" ? "5h" : "7d", resetAt } } : {}),
  }
  return metric
}
```

- [ ] **Step 4: Register in main.ts**

Add import and `["kimi", createKimiProvider()],`.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run typecheck && bun test tests/providers/kimi.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/providers/kimi.ts tests/providers/kimi.test.ts src/server/main.ts
git commit -m "feat(providers): add Kimi coding-plan adapter (five_hour + weekly_limit)"
```

---

## Task 12: Zhipu adapter

**Files:**
- Create: `src/server/providers/zhipu.ts`
- Test: `tests/providers/zhipu.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/zhipu.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createZhipuProvider } from "../../src/server/providers/zhipu"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "zp-1", type: "zhipu", apiKey: "zp-key" }
const metrics: MetricConfig[] = [
  { id: "5h", providerMetricId: "five_hour", label: "5h", unit: "%", display: { module: "rolling-window-card" } },
  { id: "wk", providerMetricId: "weekly_limit", label: "Weekly", unit: "%", display: { module: "period-quota-card" } },
]
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id, provider,
    runtime: { available: true, apiKey: "zp-key" },
    now: NOW, metrics, ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("zhipu classifies by unit field (3=five_hour, 6=weekly_limit)", async () => {
  const calls: { url: string; auth: string }[] = []
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), auth: init?.headers instanceof Headers ? init.headers.get("Authorization") ?? "" : "" })
    return makeResp(200, {
      success: true,
      data: {
        level: "PRO",
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 20, nextResetTime: "2026-07-17T05:00:00Z" },
          { type: "TOKENS_LIMIT", unit: 6, number: 7, percentage: 50, nextResetTime: "2026-07-24T00:00:00Z" },
        ],
      },
    })
  }
  const result = await createZhipuProvider(fakeFetch).refresh(buildInput())
  expect(calls[0]!.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit")
  // NO Bearer prefix
  expect(calls[0]!.auth).toBe("zp-key")
  expect(result.metrics).toHaveLength(2)
  const fiveHour = result.metrics.find((m) => m.providerMetricId === "five_hour")!
  expect(fiveHour.used).toBe(20)
  expect(fiveHour.limit).toBe(100)
  expect(fiveHour.remaining).toBe(80)
  expect(fiveHour.sourceValueKind).toBe("gauge-used")
  const weekly = result.metrics.find((m) => m.providerMetricId === "weekly_limit")!
  expect(weekly.used).toBe(50)
  expect(result.metrics[0]!.notes).toContain("PRO")
})

test("zhipu uses EN baseUrl", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { success: true, data: { limits: [] } })
  }
  await createZhipuProvider(fakeFetch).refresh(buildInput({
    provider: { id: "zp-1", type: "zhipu", baseUrl: "https://api.z.ai", apiKey: "k" },
  }))
  expect(calls[0]).toBe("https://api.z.ai/api/monitor/usage/quota/limit")
})

test("zhipu filters non-TOKENS_LIMIT entries", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, {
      success: true,
      data: { limits: [
        { type: "OTHER_LIMIT", unit: 3, percentage: 10 },
        { type: "TOKENS_LIMIT", unit: 3, percentage: 30, nextResetTime: "2026-07-17T05:00:00Z" },
      ] },
    })
  const result = await createZhipuProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]!.used).toBe(30)
})

test("zhipu business error success=false", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, { success: false, msg: "Invalid token" })
  const result = await createZhipuProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.message).toContain("Invalid token")
  expect(result.errors![0]!.retryable).toBe(false)
})

test("zhipu 401 non-retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(401, {})
  const result = await createZhipuProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("zhipu network error retryable", async () => {
  const fakeFetch = async (): Promise<Response> => { throw new Error("dns") }
  const result = await createZhipuProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/providers/zhipu.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

Create `src/server/providers/zhipu.ts`:

```ts
import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber, parseResetTime } from "./shared"

// Zhipu (personal) coding-plan adapter.
// GET <baseUrl>/api/monitor/usage/quota/limit  (default https://open.bigmodel.cn, EN: https://api.z.ai)
// Auth: Authorization: <key>  (NO Bearer prefix - Zhipu-specific)
// Response: { success: boolean, msg?: string, data: { level?: string, limits: [{ type, unit, percentage, nextResetTime }] } }
// Window classification by `unit`: 3 -> five_hour, 6 -> weekly_limit
// Source: cc-switch coding_plan.rs:208-406

const DEFAULT_BASE_URL = "https://open.bigmodel.cn"
const ZHIPU_PATH = "/api/monitor/usage/quota/limit"

type ZhipuProvider = { id: string; type: "zhipu"; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }

type ZhipuLimitItem = {
  type?: string
  unit?: number
  percentage?: unknown
  nextResetTime?: unknown
}

export function createZhipuProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "zhipu",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "Zhipu provider unavailable: API key not configured", retryable: false }] }
      }

      const providerConfig = input.provider as ZhipuProvider
      const baseUrl = providerConfig.baseUrl ?? DEFAULT_BASE_URL
      const url = `${baseUrl}${ZHIPU_PATH}`

      // Zhipu: NO Bearer prefix
      const headers = new Headers()
      headers.set("Authorization", apiKey)
      headers.set("Content-Type", "application/json")
      headers.set("Accept", "application/json")

      let body: { success?: boolean; msg?: string; data?: { level?: string; limits?: ZhipuLimitItem[] } }
      try {
        const res = await fetchImpl(url, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("Zhipu authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `Zhipu usage request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "Zhipu usage request network error", retryable: true }] }
      }

      // Business error envelope
      if (body.success === false) {
        const msg = body.msg ?? "Unknown error"
        return { ...base, errors: [{ message: `Zhipu API error: ${msg}`, retryable: false }] }
      }

      if (!body.data) {
        return { ...base, errors: [{ message: "Zhipu response missing 'data' field", retryable: false }] }
      }

      const metrics = parseTiers(body.data, input.metrics)
      return { ...base, metrics }
    },
  }
}

function classifyWindow(unit: number | undefined): "five_hour" | "weekly_limit" | undefined {
  if (unit === 3) return "five_hour"
  if (unit === 6) return "weekly_limit"
  return undefined
}

function parseTiers(
  data: { level?: string; limits?: ZhipuLimitItem[] },
  configs: MetricConfig[],
): NormalizedMetric[] {
  const limits = data.limits ?? []
  let fiveHour: { percentage: number; resetAt: string | undefined } | undefined
  let weekly: { percentage: number; resetAt: string | undefined } | undefined
  const unclassified: Array<{ percentage: number; resetAt: string | undefined; resetMs: number | undefined }> = []

  for (const item of limits) {
    const type = item.type ?? ""
    if (!type.equalsIgnoreCase?.("TOKENS_LIMIT") && type.toUpperCase() !== "TOKENS_LIMIT") continue
    const percentage = parseNumber(item.percentage) ?? 0
    const resetAt = parseResetTime(item.nextResetTime)
    const resetMs = typeof item.nextResetTime === "number" ? item.nextResetTime : undefined
    const window = classifyWindow(item.unit)
    if (window === "five_hour" && !fiveHour) {
      fiveHour = { percentage, resetAt }
    } else if (window === "weekly_limit" && !weekly) {
      weekly = { percentage, resetAt }
    } else {
      unclassified.push({ percentage, resetAt, resetMs })
    }
  }

  // Fallback heuristic: no-resetTime -> five_hour first; rest by reset ascending
  unclassified.sort((a, b) => {
    const aHas = a.resetMs !== undefined ? 1 : 0
    const bHas = b.resetMs !== undefined ? 1 : 0
    if (aHas !== bHas) return aHas - bHas
    return (a.resetMs ?? 0) - (b.resetMs ?? 0)
  })
  for (const u of unclassified) {
    if (!fiveHour) fiveHour = { percentage: u.percentage, resetAt: u.resetAt }
    else if (!weekly) weekly = { percentage: u.percentage, resetAt: u.resetAt }
  }

  const metrics: NormalizedMetric[] = []
  const level = data.level
  if (fiveHour) metrics.push(makeMetric("five_hour", fiveHour.percentage, fiveHour.resetAt, configs, level))
  if (weekly) metrics.push(makeMetric("weekly_limit", weekly.percentage, weekly.resetAt, configs, level))
  return metrics
}

function makeMetric(
  providerMetricId: string,
  percentage: number,
  resetAt: string | undefined,
  configs: MetricConfig[],
  level: string | undefined,
): NormalizedMetric {
  const cfg = configs.find((m) => m.providerMetricId === providerMetricId)
  const metric: NormalizedMetric = {
    providerMetricId,
    label: cfg?.label ?? providerMetricId,
    unit: cfg?.unit ?? "%",
    limit: 100,
    used: percentage,
    remaining: 100 - percentage,
    sourceValueKind: "gauge-used",
    sourceConfidence: "known",
    ...(resetAt !== undefined ? { window: { kind: providerMetricId === "five_hour" ? "rolling" as const : "rolling" as const, duration: providerMetricId === "five_hour" ? "5h" : "7d", resetAt } } : {}),
  }
  if (level) metric.notes = `Plan: ${level}`
  return metric
}
```

Note: `String.prototype.equalsIgnoreCase` doesn't exist in JS - use `.toUpperCase() === "TOKENS_LIMIT"` instead. Fix the implementation:

```ts
    if (type.toUpperCase() !== "TOKENS_LIMIT") continue
```

- [ ] **Step 4: Register in main.ts**

Add import and `["zhipu", createZhipuProvider()],`.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run typecheck && bun test tests/providers/zhipu.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/providers/zhipu.ts tests/providers/zhipu.test.ts src/server/main.ts
git commit -m "feat(providers): add Zhipu personal coding-plan adapter (unit-based window classification, no Bearer prefix)"
```

---

## Task 13: MiniMax adapter

**Files:**
- Create: `src/server/providers/minimax.ts`
- Test: `tests/providers/minimax.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/minimax.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createMiniMaxProvider } from "../../src/server/providers/minimax"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "mm-1", type: "minimax", apiKey: "mm-key" }
const metrics: MetricConfig[] = [
  { id: "5h", providerMetricId: "five_hour", label: "5h", unit: "%", display: { module: "rolling-window-card" } },
  { id: "wk", providerMetricId: "weekly_limit", label: "Weekly", unit: "%", display: { module: "period-quota-card" } },
]
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id, provider,
    runtime: { available: true, apiKey: "mm-key" },
    now: NOW, metrics, ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("minimax produces two metrics when status==1", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, {
      base_resp: { status_code: 0, status_msg: "success" },
      model_remains: [{
        model_name: "general",
        current_interval_remaining_percent: 80,
        end_time: 1752747600000,
        current_weekly_status: 1,
        current_weekly_remaining_percent: 90,
        weekly_end_time: 1753329600000,
      }],
    })
  }
  const result = await createMiniMaxProvider(fakeFetch).refresh(buildInput())
  expect(calls[0]).toBe("https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains")
  expect(result.metrics).toHaveLength(2)
  const fiveHour = result.metrics.find((m) => m.providerMetricId === "five_hour")!
  expect(fiveHour.remaining).toBe(80)
  expect(fiveHour.limit).toBe(100)
  expect(fiveHour.used).toBe(20)
  expect(fiveHour.sourceValueKind).toBe("gauge-remaining")
  const weekly = result.metrics.find((m) => m.providerMetricId === "weekly_limit")!
  expect(weekly.remaining).toBe(90)
  expect(weekly.used).toBe(10)
})

test("minimax skips video model, only processes general", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, {
      base_resp: { status_code: 0 },
      model_remains: [
        { model_name: "video", current_interval_remaining_percent: 50, current_weekly_status: 1 },
        { model_name: "general", current_interval_remaining_percent: 80, end_time: 1752747600000, current_weekly_status: 1, current_weekly_remaining_percent: 90, weekly_end_time: 1753329600000 },
      ],
    })
  const result = await createMiniMaxProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(2)
  expect(result.metrics[0]!.remaining).toBe(80) // general, not video (50)
})

test("minimax omits weekly when status != 1", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, {
      base_resp: { status_code: 0 },
      model_remains: [{
        model_name: "general",
        current_interval_remaining_percent: 80,
        end_time: 1752747600000,
        current_weekly_status: 3,
        current_weekly_remaining_percent: 100,
        weekly_end_time: 1753329600000,
      }],
    })
  const result = await createMiniMaxProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]!.providerMetricId).toBe("five_hour")
})

test("minimax uses EN baseUrl", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { base_resp: { status_code: 0 }, model_remains: [] })
  }
  await createMiniMaxProvider(fakeFetch).refresh(buildInput({
    provider: { id: "mm-1", type: "minimax", baseUrl: "https://api.minimax.io", apiKey: "k" },
  }))
  expect(calls[0]).toBe("https://api.minimax.io/v1/api/openplatform/coding_plan/remains")
})

test("minimax business error base_resp.status_code != 0", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, { base_resp: { status_code: 1001, status_msg: "Quota exceeded" } })
  const result = await createMiniMaxProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.message).toContain("Quota exceeded")
  expect(result.errors![0]!.retryable).toBe(false)
})

test("minimax 401 non-retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(401, {})
  const result = await createMiniMaxProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("minimax network error retryable", async () => {
  const fakeFetch = async (): Promise<Response> => { throw new Error("reset") }
  const result = await createMiniMaxProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("minimax no general model returns empty metrics", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, { base_resp: { status_code: 0 }, model_remains: [{ model_name: "video" }] })
  const result = await createMiniMaxProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/providers/minimax.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

Create `src/server/providers/minimax.ts`:

```ts
import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseResetTime } from "./shared"

// MiniMax coding-plan adapter.
// GET <baseUrl>/v1/api/openplatform/coding_plan/remains  (CN: api.minimaxi.com, EN: api.minimax.io)
// Auth: Bearer <key>
// Response: { base_resp: { status_code, status_msg }, model_remains: [{ model_name, current_interval_remaining_percent, end_time, current_weekly_status, current_weekly_remaining_percent, weekly_end_time }] }
// Only model_name=="general" is processed. Weekly tier only when current_weekly_status==1.
// Source: cc-switch coding_plan.rs:408-491, 631-695

const DEFAULT_BASE_URL = "https://api.minimaxi.com"
const MINIMAX_PATH = "/v1/api/openplatform/coding_plan/remains"

type MiniMaxProvider = { id: string; type: "minimax"; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }

type ModelRemain = {
  model_name?: string
  current_interval_remaining_percent?: number
  end_time?: unknown
  current_weekly_status?: number
  current_weekly_remaining_percent?: number
  weekly_end_time?: unknown
}

export function createMiniMaxProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "minimax",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "MiniMax provider unavailable: API key not configured", retryable: false }] }
      }

      const providerConfig = input.provider as MiniMaxProvider
      const baseUrl = providerConfig.baseUrl ?? DEFAULT_BASE_URL
      const url = `${baseUrl}${MINIMAX_PATH}`

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Content-Type", "application/json")
      headers.set("Accept", "application/json")

      let body: { base_resp?: { status_code?: number; status_msg?: string }; model_remains?: ModelRemain[] }
      try {
        const res = await fetchImpl(url, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("MiniMax authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `MiniMax usage request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "MiniMax usage request network error", retryable: true }] }
      }

      // Business error envelope
      const baseResp = body.base_resp
      if (baseResp && baseResp.status_code !== undefined && baseResp.status_code !== 0) {
        const msg = baseResp.status_msg ?? "Unknown error"
        return { ...base, errors: [{ message: `MiniMax API error (code ${baseResp.status_code}): ${msg}`, retryable: false }] }
      }

      // Find general model
      const general = (body.model_remains ?? []).find((m) => m.model_name === "general")
      if (!general) return { ...base, metrics: [] }

      const metrics: NormalizedMetric[] = []
      // 5h tier (always present for general)
      if (general.current_interval_remaining_percent !== undefined) {
        const resetAt = parseResetTime(general.end_time)
        metrics.push(makeMetric("five_hour", general.current_interval_remaining_percent, resetAt, input.metrics, general.current_weekly_status))
      }
      // Weekly tier (only when status == 1)
      if (general.current_weekly_status === 1 && general.current_weekly_remaining_percent !== undefined) {
        const resetAt = parseResetTime(general.weekly_end_time)
        metrics.push(makeMetric("weekly_limit", general.current_weekly_remaining_percent, resetAt, input.metrics, general.current_weekly_status))
      }
      return { ...base, metrics }
    },
  }
}

function makeMetric(
  providerMetricId: string,
  remainingPercent: number,
  resetAt: string | undefined,
  configs: MetricConfig[],
  weeklyStatus: number | undefined,
): NormalizedMetric {
  const cfg = configs.find((m) => m.providerMetricId === providerMetricId)
  const metric: NormalizedMetric = {
    providerMetricId,
    label: cfg?.label ?? providerMetricId,
    unit: cfg?.unit ?? "%",
    limit: 100,
    remaining: remainingPercent,
    used: 100 - remainingPercent,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
    ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration: providerMetricId === "five_hour" ? "5h" : "7d", resetAt } } : {}),
  }
  if (providerMetricId === "weekly_limit" && weeklyStatus !== undefined) {
    metric.notes = `Weekly status: ${weeklyStatus}`
  }
  return metric
}
```

- [ ] **Step 4: Register in main.ts**

Add import and `["minimax", createMiniMaxProvider()],`.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run typecheck && bun test tests/providers/minimax.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/providers/minimax.ts tests/providers/minimax.test.ts src/server/main.ts
git commit -m "feat(providers): add MiniMax coding-plan adapter (general-only filter, status==1 weekly)"
```

---

## Task 14: ZenMux adapter

**Files:**
- Create: `src/server/providers/zenmux.ts`
- Test: `tests/providers/zenmux.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/zenmux.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createZenmuxProvider } from "../../src/server/providers/zenmux"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "zm-1", type: "zenmux", baseUrl: "https://zenmux.example.com", apiKey: "zm-key" }
const metrics: MetricConfig[] = [
  { id: "5h", providerMetricId: "five_hour", label: "5h", unit: "USD", display: { module: "rolling-window-card" } },
  { id: "7d", providerMetricId: "weekly_limit", label: "7d", unit: "USD", display: { module: "period-quota-card" } },
]
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id, provider,
    runtime: { available: true, apiKey: "zm-key" },
    now: NOW, metrics, ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("zenmux multiplies usage_percentage by 100", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, {
      success: true,
      data: {
        quota_5_hour: { usage_percentage: 0.3, resets_at: "2026-07-17T05:00:00Z", used_value_usd: 3, max_value_usd: 10 },
        quota_7_day: { usage_percentage: 0.5, resets_at: "2026-07-24T00:00:00Z", used_value_usd: 50, max_value_usd: 100 },
        plan: { tier: "PRO" },
        account_status: "active",
      },
    })
  }
  const result = await createZenmuxProvider(fakeFetch).refresh(buildInput())
  expect(calls[0]).toBe("https://zenmux.example.com")
  expect(result.metrics).toHaveLength(2)
  const fiveHour = result.metrics.find((m) => m.providerMetricId === "five_hour")!
  expect(fiveHour.limit).toBe(10)
  expect(fiveHour.used).toBe(3)
  expect(fiveHour.remaining).toBe(7)
  // percentUsed is derived by projection, but adapter sets used/limit so it computes to 30
  expect(result.metrics[0]!.notes).toContain("PRO")
  expect(result.metrics[0]!.notes).toContain("active")
})

test("zenmux business error success != true", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, { success: false, message: "Unauthorized plan" })
  const result = await createZenmuxProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.message).toContain("Unauthorized plan")
  expect(result.errors![0]!.retryable).toBe(false)
})

test("zenmux 401 non-retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(401, {})
  const result = await createZenmuxProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("zenmux 502 retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(502, {})
  const result = await createZenmuxProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("zenmux network error retryable", async () => {
  const fakeFetch = async (): Promise<Response> => { throw new Error("timeout") }
  const result = await createZenmuxProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/providers/zenmux.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

Create `src/server/providers/zenmux.ts`:

```ts
import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// ZenMux coding-plan adapter.
// GET <baseUrl>  (required, user-supplied)
// Auth: Bearer <key>
// Response: { success: boolean, message?: string, data: { quota_5_hour: { usage_percentage (0-1), resets_at, used_value_usd, max_value_usd }, quota_7_day: {...}, plan: { tier }, account_status } }
// usage_percentage is a 0-1 fraction; adapter sets limit/used/remaining as USD absolute values.
// Source: cc-switch coding_plan.rs:493-629

type ZenmuxProvider = { id: string; type: "zenmux"; baseUrl: string; apiKeyEnv?: string; apiKey?: string }

type QuotaWindow = {
  usage_percentage?: unknown
  resets_at?: string
  used_value_usd?: unknown
  max_value_usd?: unknown
}

export function createZenmuxProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "zenmux",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "ZenMux provider unavailable: API key not configured", retryable: false }] }
      }

      const providerConfig = input.provider as ZenmuxProvider
      const url = providerConfig.baseUrl

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: { success?: boolean; message?: string; data?: { quota_5_hour?: QuotaWindow; quota_7_day?: QuotaWindow; plan?: { tier?: string }; account_status?: string } }
      try {
        const res = await fetchImpl(url, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("ZenMux authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `ZenMux usage request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "ZenMux usage request network error", retryable: true }] }
      }

      // Business error envelope
      if (body.success !== true) {
        const msg = body.message ?? "Unknown error"
        return { ...base, errors: [{ message: `ZenMux API error: ${msg}`, retryable: false }] }
      }

      if (!body.data) {
        return { ...base, errors: [{ message: "ZenMux response missing 'data' field", retryable: false }] }
      }

      const metrics: NormalizedMetric[] = []
      const data = body.data
      const tier = data.plan?.tier
      const accountStatus = data.account_status
      let planNote: string | undefined
      if (tier || accountStatus) {
        const parts: string[] = []
        if (tier) parts.push(`Plan: ${tier}`)
        if (accountStatus) parts.push(accountStatus)
        planNote = parts.join(" ")
      }

      if (data.quota_5_hour) {
        const m = mapWindow("five_hour", "5h", data.quota_5_hour, input.metrics, planNote)
        if (m) metrics.push(m)
      }
      if (data.quota_7_day) {
        const m = mapWindow("weekly_limit", "7d", data.quota_7_day, input.metrics, planNote)
        if (m) metrics.push(m)
      }
      return { ...base, metrics }
    },
  }
}

function mapWindow(
  providerMetricId: string,
  duration: string,
  win: QuotaWindow,
  configs: MetricConfig[],
  planNote: string | undefined,
): NormalizedMetric | undefined {
  const maxUsd = parseNumber(win.max_value_usd)
  const usedUsd = parseNumber(win.used_value_usd)
  if (maxUsd === undefined || usedUsd === undefined) return undefined
  const remaining = maxUsd - usedUsd
  // usage_percentage is 0-1; multiply by 100 for percentUsed (but projection computes
  // percentUsed from used/limit, so we just set used/limit and let it derive)
  const cfg = configs.find((m) => m.providerMetricId === providerMetricId)
  const metric: NormalizedMetric = {
    providerMetricId,
    label: cfg?.label ?? providerMetricId,
    unit: cfg?.unit ?? "USD",
    limit: maxUsd,
    used: usedUsd,
    remaining,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
    ...(win.resets_at !== undefined ? { window: { kind: "rolling" as const, duration, resetAt: win.resets_at } } : {}),
  }
  if (planNote) metric.notes = planNote
  return metric
}
```

- [ ] **Step 4: Register in main.ts**

Add import and `["zenmux", createZenmuxProvider()],`.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run typecheck && bun test tests/providers/zenmux.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/providers/zenmux.ts tests/providers/zenmux.test.ts src/server/main.ts
git commit -m "feat(providers): add ZenMux coding-plan adapter (USD absolute values, plan tier notes)"
```

---

## Task 15: Volcengine SigV4 utility (`volcengine-sig.ts`)

**Files:**
- Create: `src/server/providers/volcengine-sig.ts`
- Test: `tests/providers/volcengine-sig.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/volcengine-sig.test.ts`:

```ts
import { expect, test } from "bun:test"
import { signVolcengineRequest } from "../../src/server/providers/volcengine-sig"

const FIXED_NOW = new Date("2026-07-17T12:00:00Z")
const AK = "AKTEST123"
const SK = "SKtest456"
const REGION = "cn-beijing"

test("produces correct URL with canonical query (alphabetical)", () => {
  const result = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  expect(result.url).toBe("https://open.volcengineapi.com/?Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01")
})

test("sets required headers", () => {
  const result = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  expect(result.headers.get("X-Date")).toBe("20260717T120000Z")
  expect(result.headers.get("X-Content-Sha256")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  expect(result.headers.get("Content-Type")).toBe("application/json; charset=utf-8")
  expect(result.headers.get("Authorization")).toBeTruthy()
})

test("Authorization uses HMAC-SHA256 algorithm (not AWS4)", () => {
  const result = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  const auth = result.headers.get("Authorization")!
  expect(auth.startsWith("HMAC-SHA256 Credential=")).toBe(true)
  expect(auth).not.toContain("AWS4")
  expect(auth).toContain("SignedHeaders=host;x-date;x-content-sha256;content-type")
  expect(auth).toContain(`/cn-beijing/ark/request`)
})

test("credential scope uses short date", () => {
  const result = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  const auth = result.headers.get("Authorization")!
  expect(auth).toContain("20260717/cn-beijing/ark/request")
})

test("signature is deterministic for same input", () => {
  const r1 = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  const r2 = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  expect(r1.headers.get("Authorization")).toBe(r2.headers.get("Authorization"))
})

test("different actions produce different signatures", () => {
  const r1 = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  const r2 = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetCodingPlanUsage", now: FIXED_NOW })
  expect(r1.headers.get("Authorization")).not.toBe(r2.headers.get("Authorization"))
})

test("canonical query is alphabetically sorted", () => {
  const result = signVolcengineRequest({ ak: AK, sk: SK, region: "us-east-1", action: "GetAFPUsage", now: FIXED_NOW })
  // Action < Region < Version alphabetically
  expect(result.url).toContain("Action=GetAFPUsage&Region=us-east-1&Version=2024-01-01")
})

test("default region is cn-beijing", () => {
  const result = signVolcengineRequest({ ak: AK, sk: SK, region: "cn-beijing", action: "GetAFPUsage", now: FIXED_NOW })
  expect(result.url).toContain("Region=cn-beijing")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/providers/volcengine-sig.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the SigV4 utility**

Create `src/server/providers/volcengine-sig.ts`:

```ts
// Volcengine SigV4 signing utility.
// Implements the Volcengine variant of AWS SigV4 (NOT standard SigV4).
// Three critical deviations from AWS SigV4 (per cc-switch coding_plan.rs:791-796):
//   1. Fixed header order (NOT alphabetical): host;x-date;x-content-sha256;content-type
//   2. Algorithm "HMAC-SHA256" (no "AWS4" prefix); credential scope ends with "request"
//      (not "aws4_request"); signing key kDate=HMAC(SK, date) (SK has no "AWS4" prefix)
//   3. Canonical query IS alphabetical (standard SigV4)
// Source: cc-switch coding_plan.rs:788-891

const VOLCENGINE_SERVICE = "ark"
const VOLCENGINE_CONTENT_TYPE = "application/json; charset=utf-8"
const VOLCENGINE_SIGNED_HEADERS = "host;x-date;x-content-sha256;content-type"
const VOLCENGINE_OPENAPI_HOST = "open.volcengineapi.com"
const VOLCENGINE_API_VERSION = "2024-01-01"

// SHA-256 of empty string (body is always empty for Volcengine OpenAPI calls)
const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

export type SignedVolcengineRequest = {
  url: string
  headers: Headers
}

export function signVolcengineRequest(input: {
  ak: string
  sk: string
  region: string
  action: string
  now: Date
}): SignedVolcengineRequest {
  const { ak, sk, region, action, now } = input

  // x_date = 20260717T120000Z, short_date = 20260717
  const xDate = formatXDate(now)
  const shortDate = xDate.slice(0, 8)

  // Canonical query (alphabetical): Action=...&Region=...&Version=...
  const canonicalQuery = buildCanonicalQuery(action, region)

  // Canonical headers (FIXED order, NOT alphabetical)
  const canonicalHeaders = `host:${VOLCENGINE_OPENAPI_HOST}\nx-date:${xDate}\nx-content-sha256:${EMPTY_BODY_SHA256}\ncontent-type:${VOLCENGINE_CONTENT_TYPE}\n`

  // Canonical request (body is empty -> x-content-sha256 = empty body hash)
  const canonicalRequest = `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${VOLCENGINE_SIGNED_HEADERS}\n${EMPTY_BODY_SHA256}`

  // Credential scope: short_date/region/service/request
  const credentialScope = `${shortDate}/${region}/${VOLCENGINE_SERVICE}/request`

  // String to sign
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`

  // Signing key derivation (SK has NO "AWS4" prefix)
  const kDate = hmacSha256(sk, shortDate)
  const kRegion = hmacSha256Bytes(kDate, region)
  const kService = hmacSha256Bytes(kRegion, VOLCENGINE_SERVICE)
  const kSigning = hmacSha256Bytes(kService, "request")

  // Signature
  const signature = hmacSha256Bytes(kSigning, stringToSign)

  // Authorization header
  const authorization = `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${VOLCENGINE_SIGNED_HEADERS}, Signature=${signature}`

  const url = `https://${VOLCENGINE_OPENAPI_HOST}/?${canonicalQuery}`
  const headers = new Headers()
  headers.set("X-Date", xDate)
  headers.set("X-Content-Sha256", EMPTY_BODY_SHA256)
  headers.set("Content-Type", VOLCENGINE_CONTENT_TYPE)
  headers.set("Authorization", authorization)

  return { url, headers }
}

function formatXDate(now: Date): string {
  // Format: YYYYMMDDTHHMMSSZ (UTC)
  const iso = now.toISOString() // 2026-07-17T12:00:00.000Z
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "")
}

function buildCanonicalQuery(action: string, region: string): string {
  const pairs = [
    ["Action", action],
    ["Region", region],
    ["Version", VOLCENGINE_API_VERSION],
  ].sort((a, b) => a[0].localeCompare(b[0]))
  return pairs.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&")
}

function uriEncode(s: string): string {
  // RFC3986 unreserved only; everything else %XX
  let out = ""
  for (const byte of new TextEncoder().encode(s)) {
    if ((byte >= 0x41 && byte <= 0x5a) || // A-Z
        (byte >= 0x61 && byte <= 0x7a) || // a-z
        (byte >= 0x30 && byte <= 0x39) || // 0-9
        byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x7e) { // - _ . ~
      out += String.fromCharCode(byte)
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return out
}

async function sha256Hex(data: string): Promise<string> {
  const buf = new TextEncoder().encode(data)
  const hash = await crypto.subtle.digest("SHA-256", buf)
  return bytesToHex(new Uint8Array(hash))
}

function hmacSha256(key: string, data: string): Uint8Array {
  // Synchronous HMAC-SHA256 using Web Crypto is async-only; use a sync implementation.
  // Bun supports crypto.createHmac synchronously.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require("crypto")
  return Uint8Array.from(createHmac("sha256", key).update(data).digest())
}

function hmacSha256Bytes(key: Uint8Array, data: string): Uint8Array {
  const { createHmac } = require("crypto")
  return Uint8Array.from(createHmac("sha256", Buffer.from(key)).update(data).digest())
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}
```

Wait - `sha256Hex` is async but called in a sync function. Bun provides `crypto.subtle.digest` (async) but also `node:crypto` (sync). Fix: use `node:crypto` for sync SHA-256 too:

```ts
function sha256Hex(data: string): string {
  const { createHash } = require("crypto")
  return createHash("sha256").update(data).digest("hex")
}
```

And add the import at top:

```ts
import { createHash, createHmac } from "crypto"
```

Remove the `require` calls. Final corrected implementation:

```ts
import { createHash, createHmac } from "node:crypto"

// ... (constants same as above)

export function signVolcengineRequest(input: {
  ak: string
  sk: string
  region: string
  action: string
  now: Date
}): SignedVolcengineRequest {
  const { ak, sk, region, action, now } = input
  const xDate = formatXDate(now)
  const shortDate = xDate.slice(0, 8)
  const canonicalQuery = buildCanonicalQuery(action, region)
  const canonicalHeaders = `host:${VOLCENGINE_OPENAPI_HOST}\nx-date:${xDate}\nx-content-sha256:${EMPTY_BODY_SHA256}\ncontent-type:${VOLCENGINE_CONTENT_TYPE}\n`
  const canonicalRequest = `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${VOLCENGINE_SIGNED_HEADERS}\n${EMPTY_BODY_SHA256}`
  const credentialScope = `${shortDate}/${region}/${VOLCENGINE_SERVICE}/request`
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`
  const kDate = hmacSha256(sk, shortDate)
  const kRegion = hmacSha256Bytes(kDate, region)
  const kService = hmacSha256Bytes(kRegion, VOLCENGINE_SERVICE)
  const kSigning = hmacSha256Bytes(kService, "request")
  const signature = bytesToHex(hmacSha256Bytes(kSigning, stringToSign))
  const authorization = `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${VOLCENGINE_SIGNED_HEADERS}, Signature=${signature}`
  const url = `https://${VOLCENGINE_OPENAPI_HOST}/?${canonicalQuery}`
  const headers = new Headers()
  headers.set("X-Date", xDate)
  headers.set("X-Content-Sha256", EMPTY_BODY_SHA256)
  headers.set("Content-Type", VOLCENGINE_CONTENT_TYPE)
  headers.set("Authorization", authorization)
  return { url, headers }
}

function formatXDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
}

function buildCanonicalQuery(action: string, region: string): string {
  return [["Action", action], ["Region", region], ["Version", VOLCENGINE_API_VERSION]]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join("&")
}

function uriEncode(s: string): string {
  let out = ""
  for (const byte of new TextEncoder().encode(s)) {
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x7e) {
      out += String.fromCharCode(byte)
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return out
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex")
}

function hmacSha256(key: string, data: string): Uint8Array {
  return Uint8Array.from(createHmac("sha256", key).update(data).digest())
}

function hmacSha256Bytes(key: Uint8Array, data: string): Uint8Array {
  return Uint8Array.from(createHmac("sha256", Buffer.from(key)).update(data).digest())
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/providers/volcengine-sig.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/providers/volcengine-sig.ts tests/providers/volcengine-sig.test.ts
git commit -m "feat(providers): add Volcengine SigV4 signing utility (fixed header order, HMAC-SHA256)"
```

---

## Task 16: Volcengine adapter

**Files:**
- Create: `src/server/providers/volcengine.ts`
- Test: `tests/providers/volcengine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/volcengine.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createVolcengineProvider } from "../../src/server/providers/volcengine"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "vol-1", type: "volcengine", region: "cn-beijing", ak: "ak-test", sk: "sk-test" }
const metrics: MetricConfig[] = [
  { id: "5h", providerMetricId: "afp:five_hour", label: "AFP 5h", unit: "tokens", display: { module: "rolling-window-card" } },
  { id: "wk", providerMetricId: "afp:weekly_limit", label: "AFP Weekly", unit: "tokens", display: { module: "period-quota-card" } },
  { id: "mo", providerMetricId: "afp:monthly", label: "AFP Monthly", unit: "tokens", display: { module: "period-quota-card" } },
]
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id, provider,
    runtime: { available: true, ak: "ak-test", sk: "sk-test" },
    now: NOW, metrics, ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("volcengine AFP non-empty -> emit AFP tiers, no CodingPlan call", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    if (url.includes("GetAFPUsage")) {
      return makeResp(200, {
        ResponseMetadata: {},
        Result: {
          PlanType: "Pro",
          AFPFiveHour: { Quota: 1000, Used: 300, ResetTime: "2026-07-17T05:00:00Z" },
          AFPWeekly: { Quota: 10000, Used: 5000, ResetTime: "2026-07-24T00:00:00Z" },
          AFPMonthly: { Quota: 100000, Used: 20000, ResetTime: "2026-08-01T00:00:00Z" },
        },
      })
    }
    return makeResp(200, {})
  }
  const result = await createVolcengineProvider(fakeFetch).refresh(buildInput())
  // Only GetAFPUsage called (no fallback)
  expect(calls.filter((u) => u.includes("GetAFPUsage"))).toHaveLength(1)
  expect(calls.filter((u) => u.includes("GetCodingPlanUsage"))).toHaveLength(0)
  expect(result.metrics).toHaveLength(3)
  const fiveHour = result.metrics.find((m) => m.providerMetricId === "afp:five_hour")!
  expect(fiveHour.limit).toBe(1000)
  expect(fiveHour.used).toBe(300)
  expect(fiveHour.remaining).toBe(700)
  expect(fiveHour.sourceValueKind).toBe("gauge-used")
  expect(fiveHour.notes).toContain("Agent Plan Pro")
})

test("volcengine AFP empty -> fallback to CodingPlanUsage", async () => {
  const calls: string[] = []
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    if (url.includes("GetAFPUsage")) {
      return makeResp(200, { ResponseMetadata: {}, Result: { AFPFiveHour: { Quota: 0, Used: 0 } } })
    }
    if (url.includes("GetCodingPlanUsage")) {
      return makeResp(200, {
        ResponseMetadata: {},
        Result: {
          QuotaUsage: [
            { Level: "session", Percent: 40, ResetTime: "2026-07-17T05:00:00Z" },
            { Level: "weekly", Percent: 60, ResetTime: "2026-07-24T00:00:00Z" },
          ],
        },
      })
    }
    return makeResp(200, {})
  }
  const result = await createVolcengineProvider(fakeFetch).refresh(buildInput())
  expect(calls.filter((u) => u.includes("GetAFPUsage"))).toHaveLength(1)
  expect(calls.filter((u) => u.includes("GetCodingPlanUsage"))).toHaveLength(1)
  // AFP returned empty (Quota<=0), so CodingPlan tiers are authoritative
  expect(result.metrics).toHaveLength(2)
  expect(result.metrics[0]!.providerMetricId).toBe("cp:five_hour")
  expect(result.metrics[0]!.used).toBe(40)
  expect(result.metrics[0]!.limit).toBe(100)
  expect(result.metrics[0]!.notes).toContain("Coding Plan")
})

test("volcengine skips AFP windows with Quota <= 0", async () => {
  const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).includes("GetAFPUsage")) {
      return makeResp(200, {
        ResponseMetadata: {},
        Result: {
          AFPFiveHour: { Quota: 1000, Used: 500, ResetTime: "2026-07-17T05:00:00Z" },
          AFPWeekly: { Quota: 0, Used: 0 },  // skipped
          AFPMonthly: { Quota: 0, Used: 0 },  // skipped
        },
      })
    }
    return makeResp(200, {})
  }
  const result = await createVolcengineProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]!.providerMetricId).toBe("afp:five_hour")
})

test("volcengine auth error (401) non-retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(401, {})
  const result = await createVolcengineProvider(fakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.errors![0]!.message).toContain("authentication")
})

test("volcengine auth error via ResponseMetadata.Error code", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, {
      ResponseMetadata: { Error: { Code: "SignatureDoesNotMatch", Message: "bad sig" } },
    })
  const result = await createVolcengineProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.errors![0]!.message).toContain("signature")
})

test("volcengine non-auth API error retryable", async () => {
  const fakeFetch = async (): Promise<Response> =>
    makeResp(200, {
      ResponseMetadata: { Error: { Code: "InternalError", Message: "oops" } },
    })
  const result = await createVolcengineProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("volcengine 500 retryable", async () => {
  const fakeFetch = async (): Promise<Response> => makeResp(500, {})
  const result = await createVolcengineProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("volcengine network error retryable", async () => {
  const fakeFetch = async (): Promise<Response> => { throw new Error("timeout") }
  const result = await createVolcengineProvider(fakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("volcengine unavailable without AK/SK", async () => {
  const result = await createVolcengineProvider().refresh(buildInput({
    runtime: { available: false, reason: "missing AK" },
  }))
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.retryable).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/providers/volcengine.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

Create `src/server/providers/volcengine.ts`:

```ts
import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { isRetryableStatus, parseNumber, parseResetTime } from "./shared"
import { signVolcengineRequest } from "./volcengine-sig"

// Volcengine coding-plan adapter (Agent Plan via GetAFPUsage, fallback to Coding Plan via GetCodingPlanUsage).
// Control-plane POST https://open.volcengineapi.com with AK/SK SigV4 signing.
// Source: cc-switch coding_plan.rs:1097-1153, 977-1069

type VolcengineProvider = { id: string; type: "volcengine"; region?: string; akEnv?: string; ak?: string; skEnv?: string; sk?: string }

const DEFAULT_REGION = "cn-beijing"

// Auth-error code keywords (lowercased contains match). Per cc-switch coding_plan.rs:749-759.
const AUTH_ERROR_KEYWORDS = ["auth", "signature", "accessdenied", "denied", "unauthorized", "forbidden", "credential", "token"]

export function createVolcengineProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "volcengine",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const ak = input.runtime.ak
      const sk = input.runtime.sk
      if (!ak || !sk) {
        return { ...base, errors: [{ message: "Volcengine provider unavailable: AK/SK not configured", retryable: false }] }
      }

      const providerConfig = input.provider as VolcengineProvider
      const region = providerConfig.region ?? DEFAULT_REGION
      const now = new Date(input.now)

      // 1) GetAFPUsage
      const afpResult = await callOpenApi(fetchImpl, ak, sk, region, "GetAFPUsage", now)
      if ("error" in afpResult) return { ...base, errors: [afpResult.error] }

      const afpTiers = parseAfpTiers(afpResult.body, input.metrics)
      if (afpTiers.length > 0) {
        const planType = extractPlanType(afpResult.body)
        const notes = planType ? `Agent Plan ${planType}` : undefined
        if (notes) for (const m of afpTiers) m.notes = notes
        return { ...base, metrics: afpTiers }
      }

      // 2) Fallback: GetCodingPlanUsage
      const cpResult = await callOpenApi(fetchImpl, ak, sk, region, "GetCodingPlanUsage", now)
      if ("error" in cpResult) return { ...base, errors: [cpResult.error] }

      const cpTiers = parseCodingPlanTiers(cpResult.body, input.metrics)
      for (const m of cpTiers) m.notes = "Coding Plan"
      return { ...base, metrics: cpTiers }
    },
  }
}

type OpenApiResult =
  | { body: Record<string, unknown> }
  | { error: { message: string; retryable: boolean } }

async function callOpenApi(
  fetchImpl: typeof fetch,
  ak: string,
  sk: string,
  region: string,
  action: string,
  now: Date,
): Promise<OpenApiResult> {
  const { url, headers } = signVolcengineRequest({ ak, sk, region, action, now })

  let res: Response
  try {
    res = await fetchImpl(url, { method: "POST", headers, body: "" })
  } catch {
    return { error: { message: `Volcengine ${action} network error`, retryable: true } }
  }

  if (res.status === 401 || res.status === 403) {
    return { error: { message: `Volcengine ${action} authentication failed`, retryable: false } }
  }
  if (!res.ok) {
    // Parse body for error envelope (Volcengine returns 4xx with ResponseMetadata.Error)
    let body: unknown
    try { body = await res.json() } catch { body = {} }
    const errInfo = extractError(body)
    if (errInfo && isAuthErrorCode(errInfo.code)) {
      return { error: { message: `Volcengine ${action} authentication failed (${errInfo.code}): ${errInfo.message}`, retryable: false } }
    }
    return { error: { message: `Volcengine ${action} request failed (${res.status})`, retryable: isRetryableStatus(res.status) } }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { error: { message: `Volcengine ${action} response parse error`, retryable: false } }
  }

  // 200 + ResponseMetadata.Error (business error)
  const errInfo = extractError(body)
  if (errInfo) {
    if (isAuthErrorCode(errInfo.code)) {
      return { error: { message: `Volcengine ${action} authentication failed (${errInfo.code}): ${errInfo.message}`, retryable: false } }
    }
    return { error: { message: `Volcengine ${action} API error (${errInfo.code}): ${errInfo.message}`, retryable: true } }
  }

  return { body: body as Record<string, unknown> }
}

function extractError(body: unknown): { code: string; message: string } | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const meta = (body as Record<string, unknown>)["ResponseMetadata"] as Record<string, unknown> | undefined
  const err = (meta?.["Error"] ?? (body as Record<string, unknown>)["Error"]) as Record<string, unknown> | undefined
  if (!err) return undefined
  const code = typeof err["Code"] === "string" ? err["Code"] : ""
  const message = typeof err["Message"] === "string" ? err["Message"] : ""
  if (!code && !message) return undefined
  return { code, message }
}

function isAuthErrorCode(code: string): boolean {
  const lower = code.toLowerCase()
  return AUTH_ERROR_KEYWORDS.some((kw) => lower.includes(kw))
}

function extractPlanType(body: Record<string, unknown>): string | undefined {
  const result = (body["Result"] ?? body) as Record<string, unknown>
  const planType = result["PlanType"]
  if (typeof planType === "string" && planType.trim() !== "") return planType.trim()
  return undefined
}

type AfpWindow = { quota: number; used: number; resetAt: string | undefined }

function parseAfpTiers(body: Record<string, unknown>, configs: MetricConfig[]): NormalizedMetric[] {
  const result = (body["Result"] ?? body) as Record<string, unknown>
  const windows: Array<{ key: string; metricId: string; label: string }> = [
    { key: "AFPFiveHour", metricId: "afp:five_hour", label: "five_hour" },
    { key: "AFPWeekly", metricId: "afp:weekly_limit", label: "weekly_limit" },
    { key: "AFPMonthly", metricId: "afp:monthly", label: "monthly" },
  ]
  const metrics: NormalizedMetric[] = []
  for (const w of windows) {
    const win = result[w.key] as Record<string, unknown> | undefined
    if (!win) continue
    const quota = parseNumber(win["Quota"]) ?? 0
    if (quota <= 0) continue // Skip unbound windows
    const used = parseNumber(win["Used"]) ?? 0
    const resetAt = parseResetTime(win["ResetTime"])
    metrics.push(makeAfpMetric(w.metricId, w.label, quota, used, resetAt, configs))
  }
  return metrics
}

function makeAfpMetric(
  providerMetricId: string,
  label: string,
  quota: number,
  used: number,
  resetAt: string | undefined,
  configs: MetricConfig[],
): NormalizedMetric {
  const cfg = configs.find((m) => m.providerMetricId === providerMetricId)
  const metric: NormalizedMetric = {
    providerMetricId,
    label: cfg?.label ?? label,
    unit: cfg?.unit ?? "tokens",
    limit: quota,
    used,
    remaining: quota - used,
    sourceValueKind: "gauge-used",
    sourceConfidence: "known",
    ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration: providerMetricId.includes("five_hour") ? "5h" : providerMetricId.includes("weekly") ? "7d" : "30d", resetAt } } : {}),
  }
  return metric
}

function parseCodingPlanTiers(body: Record<string, unknown>, configs: MetricConfig[]): NormalizedMetric[] {
  const result = (body["Result"] ?? body) as Record<string, unknown>
  const arr = (result["QuotaUsage"] ?? result["Usages"] ?? result["Details"]) as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(arr)) return []

  const metrics: NormalizedMetric[] = []
  for (const item of arr) {
    const label = (item["Level"] ?? item["Type"] ?? item["Period"] ?? item["Label"] ?? item["Window"]) as string | undefined
    if (!label) continue
    const windowName = classifyCodingWindow(label)
    if (!windowName) continue
    const percent = parseNumber(item["Percent"] ?? item["UsedPercent"] ?? item["UsagePercent"]) ?? 0
    const resetAt = parseResetTime(item["ResetTime"] ?? item["ResetTimestamp"])
    metrics.push(makeCpMetric(windowName, percent, resetAt, configs))
  }
  return metrics
}

function classifyCodingWindow(label: string): "five_hour" | "weekly_limit" | "monthly" | undefined {
  const lower = label.toLowerCase()
  if (["session", "5h", "fivehour", "five_hour", "rolling_5h"].includes(lower)) return "five_hour"
  if (["weekly", "week", "7d"].includes(lower)) return "weekly_limit"
  if (["monthly", "month"].includes(lower)) return "monthly"
  return undefined
}

function makeCpMetric(
  windowName: "five_hour" | "weekly_limit" | "monthly",
  percent: number,
  resetAt: string | undefined,
  configs: MetricConfig[],
): NormalizedMetric {
  const providerMetricId = `cp:${windowName}`
  const cfg = configs.find((m) => m.providerMetricId === providerMetricId)
  const metric: NormalizedMetric = {
    providerMetricId,
    label: cfg?.label ?? windowName,
    unit: cfg?.unit ?? "%",
    limit: 100,
    used: percent,
    remaining: 100 - percent,
    sourceValueKind: "gauge-used",
    sourceConfidence: "known",
    ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration: windowName === "five_hour" ? "5h" : windowName === "weekly_limit" ? "7d" : "30d", resetAt } } : {}),
  }
  return metric
}
```

- [ ] **Step 4: Register in main.ts**

Add import and `["volcengine", createVolcengineProvider()],`.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run typecheck && bun test tests/providers/volcengine.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: PASS (all provider tests + existing tests)

- [ ] **Step 7: Commit**

```bash
git add src/server/providers/volcengine.ts tests/providers/volcengine.test.ts src/server/main.ts
git commit -m "feat(providers): add Volcengine coding-plan adapter (AFP fallback to CodingPlan, AK/SK SigV4)"
```

---

## Task 17: Example config and .env.example

**Files:**
- Modify: `config/dashboard.config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add example provider declarations to config**

In `config/dashboard.config.ts`, add the new providers to the `providers` array (after the existing `manual-main` entry). Comment them out by default since users need to set env vars:

```ts
providers: [
  { id: "poe-main", type: "poe", apiKeyEnv: "POE_API_KEY" },
  { id: "manual-main", type: "manual" },
  // --- A class: account balance providers ---
  // { id: "deepseek-main", type: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" },
  // { id: "stepfun-main", type: "stepfun", apiKeyEnv: "STEPFUN_API_KEY" },
  // { id: "siliconflow-main", type: "siliconflow", apiKeyEnv: "SILICONFLOW_API_KEY" },
  // { id: "openrouter-main", type: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
  // { id: "novita-main", type: "novita", apiKeyEnv: "NOVITA_API_KEY" },
  // --- B class: coding plan providers ---
  // { id: "kimi-main", type: "kimi", apiKeyEnv: "KIMI_API_KEY" },
  // { id: "zhipu-main", type: "zhipu", apiKeyEnv: "ZHIPU_API_KEY" },
  // { id: "minimax-main", type: "minimax", apiKeyEnv: "MINIMAX_API_KEY" },
  // { id: "zenmux-main", type: "zenmux", baseUrl: "https://your-zenmux.example.com", apiKeyEnv: "ZENMUX_API_KEY" },
  // { id: "volc-main", type: "volcengine", region: "cn-beijing", akEnv: "VOLCENGINE_AK", skEnv: "VOLCENGINE_SK" },
],
```

- [ ] **Step 2: Update .env.example**

Append to `.env.example`:

```env

# --- A class: account balance providers ---
DEEPSEEK_API_KEY=
STEPFUN_API_KEY=
SILICONFLOW_API_KEY=
OPENROUTER_API_KEY=
NOVITA_API_KEY=

# --- B class: coding plan providers ---
KIMI_API_KEY=
ZHIPU_API_KEY=
MINIMAX_API_KEY=
ZENMUX_API_KEY=
ZENMUX_BASE_URL=https://your-zenmux-instance.example.com

# --- Volcengine (AK/SK, not apiKey) ---
VOLCENGINE_AK=
VOLCENGINE_SK=
```

- [ ] **Step 3: Run typecheck and full test suite**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add config/dashboard.config.ts .env.example
git commit -m "docs(config): add example declarations for 10 new providers + env vars"
```

---

## Task 18: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `bun run typecheck`
Expected: PASS (0 errors)

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: PASS (all tests pass)

- [ ] **Step 3: Verify all adapters registered**

Run: `grep -c "create.*Provider" src/server/main.ts`
Expected: 12 (manual + poe + 10 new)

- [ ] **Step 4: Verify no Poe behavior regression**

Run: `bun test tests/providers/poe.test.ts tests/dashboard/project.test.ts tests/config/load-config.test.ts`
Expected: PASS

- [ ] **Step 5: Final commit (if any cleanup needed)**

If there are any uncommitted changes from cleanup:

```bash
git add -A
git commit -m "chore: final cleanup after provider extension"
```

---

## Self-Review Notes

**Spec coverage check:**
- ✅ A class 5 providers (DeepSeek/StepFun/SiliconFlow/OpenRouter/Novita) - Tasks 6-10
- ✅ B class 4 Bearer providers (Kimi/Zhipu/MiniMax/ZenMux) - Tasks 11-14
- ✅ Volcengine SigV4 + adapter - Tasks 15-16
- ✅ shared.ts helpers - Task 1
- ✅ domain.ts extension - Task 2
- ✅ load-config (Bearer + AK/SK + SSRF) - Task 3
- ✅ main.ts/app.ts type widening + concurrency - Task 4
- ✅ projection isOverLimit generalization - Task 5
- ✅ config + .env.example - Task 17
- ✅ Business error envelopes (Zhipu success, MiniMax base_resp, ZenMux success, Volcengine ResponseMetadata.Error) - in Tasks 12-16
- ✅ Volcengine fallback semantics (AFP first, CodingPlan only if empty) - Task 16
- ✅ MiniMax general-only filter + status==1 weekly - Task 13
- ✅ Zhipu unit classification (3=five_hour, 6=weekly) - Task 12
- ✅ ZenMux ×100 (via setting used/limit directly) - Task 14
- ✅ parseNumber string-or-number - Task 1
- ✅ parseResetTime seconds/millis/string - Task 1

**Placeholder scan:** No TBD/TODO. All code blocks complete.

**Type consistency:** `createMiniMaxProvider` (Task 13) vs `createMinimaxProvider` - using `createMiniMaxProvider` consistently in code and main.ts. `ProviderAccountConfig` variant `type: "minimax"` matches `createMiniMaxProvider`'s `type: "minimax"` return.
