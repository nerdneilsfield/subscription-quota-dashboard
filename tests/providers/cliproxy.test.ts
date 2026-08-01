import { expect, test } from "bun:test"
import type { ProviderAccountConfig } from "../../src/shared/domain"
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
    // Quota-exhausted account: status:"error" + unavailable:true - must NOT be filtered
    { auth_index: "err001", provider: "codex", label: "exhausted@example.com", disabled: false, status: "error", unavailable: true },
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

// Weekly (?format=credits) and monthly (no format) endpoints return distinct
// payloads so tests can verify the adapter merges them correctly instead of
// blindly using the same body for both calls.
function makeXaiWeeklyBody(): unknown {
  return {
    status_code: 200,
    body: JSON.stringify({
      config: {
        credit_usage_percent: 30,
        current_period: { type: "weekly", end: "2026-07-24T00:00:00Z" },
      },
    }),
  }
}

function makeXaiMonthlyBody(): unknown {
  return {
    status_code: 200,
    body: JSON.stringify({
      config: {
        monthly_limit: { val: 1000 },
        used: { val: 200 },
        on_demand_cap: { val: 500 },
        on_demand_used: { val: 100 },
        billing_period_end: "2026-08-01T00:00:00Z",
      },
    }),
  }
}

function makeFakeFetch(codexBody = makeCodexBody(), claudeBody = makeClaudeBody(), _xaiBody?: unknown) {
  const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) return makeResp(200, AUTH_FILES_BODY)
    if (url.includes("/api-call")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
      if (body.auth_index === "abc123") return makeResp(200, codexBody)
      if (body.auth_index === "def456") return makeResp(200, claudeBody)
      if (body.auth_index === "ghi789") {
        // Differentiate by upstream URL: ?format=credits vs plain /billing
        const isWeekly = body.url?.includes("format=credits")
        return makeResp(200, isWeekly ? makeXaiWeeklyBody() : makeXaiMonthlyBody())
      }
      // err001 (exhausted account) - return a valid codex body so it produces metrics
      if (body.auth_index === "err001") return makeResp(200, codexBody)
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
  expect(result.dynamicSubscriptions!.length).toBe(4) // skip1 filtered, err001 kept
  const codex = result.dynamicSubscriptions!.find((subscription) => subscription.id === "cliproxy:codex:abc123")!
  expect(codex.name).toBe("Codex")
  expect(codex.identity).toEqual({
    provider: "codex",
    providerLabel: "Codex",
    account: "alice@example.com",
    plan: "Pro",
    transport: "CLIProxy",
  })
  expect(codex.ui?.group).toBe("Codex")
  const grok = result.dynamicSubscriptions!.find((subscription) => subscription.id === "cliproxy:xai:ghi789")!
  expect(grok.identity?.plan).toBe("SuperGrok")
})

test("codex: reset_at converted from Unix seconds to ISO", async () => {
  const fetchImpl = makeFakeFetch()
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  const codex5h = result.metrics.find(m => m.providerMetricId === "codex:abc123:five_hour")!
  expect(codex5h.used).toBe(72)
  expect(codex5h.limit).toBe(100)
  // 1783275600 seconds -> 2026-07-05T18:20:00.000Z (verified via Date)
  expect(codex5h.window?.resetAt).toBe("2026-07-05T18:20:00.000Z")
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
  expect(fiveHour.window?.kind).toBe("rolling")
  expect(fiveHour.window?.kind === "rolling" ? fiveHour.window.duration : undefined).toBe("5h")
  const monthly = result.metrics.find(m => m.providerMetricId === "codex:abc123:monthly")!
  expect(monthly).toBeDefined()
  expect(monthly.window?.kind === "rolling" ? monthly.window.duration : undefined).toBe("30d")
})

test("claude: utilization used directly (NOT x100)", async () => {
  const fetchImpl = makeFakeFetch()
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  const claude5h = result.metrics.find(m => m.providerMetricId === "claude:def456:five_hour")!
  expect(claude5h.used).toBe(65) // NOT 6500
  expect(claude5h.limit).toBe(100)
})

test("xai: two endpoints merged, monthly credits preserve monetary overage", async () => {
  // cents: used=1500, monthly_limit=1000 -> $15 / $10 and 150% in projection
  const xaiOverageWeekly = {
    status_code: 200,
    body: JSON.stringify({
      config: {
        credit_usage_percent: 80,
        current_period: { type: "weekly", end: "2026-07-24T00:00:00Z" },
      },
    }),
  }
  const xaiOverageMonthly = {
    status_code: 200,
    body: JSON.stringify({
      config: {
        monthly_limit: { val: 1000 },
        used: { val: 1500 },
        on_demand_cap: { val: 500 },
        on_demand_used: { val: 200 },
        billing_period_end: "2026-08-01T00:00:00Z",
      },
    }),
  }
  const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) return makeResp(200, AUTH_FILES_BODY)
    if (url.includes("/api-call")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
      if (body.auth_index === "ghi789") {
        const isWeekly = body.url?.includes("format=credits")
        return makeResp(200, isWeekly ? xaiOverageWeekly : xaiOverageMonthly)
      }
      if (body.auth_index === "abc123") return makeResp(200, makeCodexBody())
      if (body.auth_index === "def456") return makeResp(200, makeClaudeBody())
      return makeResp(200, { status_code: 500, body: "{}" })
    }
    return makeResp(404, {})
  }
  const result = await createCliproxyProvider(raw as unknown as FakeFetch).refresh(buildInput())
  const monthly = result.metrics.find(m => m.providerMetricId === "xai:ghi789:monthly")!
  expect(monthly.used).toBe(15)
  expect(monthly.limit).toBe(10)
  expect(monthly.unit).toBe("$")
})

test("xai: weekly and pay-as-you-go status metrics produced", async () => {
  const fetchImpl = makeFakeFetch()
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  const weekly = result.metrics.find(m => m.providerMetricId === "xai:ghi789:weekly")!
  expect(weekly.used).toBe(30)
  const onDemand = result.metrics.find(m => m.providerMetricId === "xai:ghi789:on_demand")!
  expect(onDemand.sourceValueKind).toBe("status")
  expect(onDemand.notes).toContain("Enabled")
  expect(onDemand.notes).toContain("$5.00 cap")
})

test("xai: unified billing camelCase shape yields weekly, pay-as-you-go, and monthly credits", async () => {
  const weekly = {
    status_code: 200,
    body: JSON.stringify({ config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-07-27T20:00:05Z", end: "2026-08-03T20:00:05Z" },
      onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, isUnifiedBillingUser: true,
    } }),
  }
  const monthly = {
    status_code: 200,
    body: JSON.stringify({ config: {
      monthlyLimit: { val: 15000 }, used: { val: 0 }, onDemandCap: { val: 0 },
      billingPeriodEnd: "2026-09-01T00:00:00Z",
    } }),
  }
  const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) return makeResp(200, { files: [{ auth_index: "camel1", provider: "xai", label: "x@example.com" }] })
    const body = JSON.parse(init?.body as string)
    return makeResp(200, body.url.includes("format=credits") ? weekly : monthly)
  }
  const result = await createCliproxyProvider(raw as unknown as FakeFetch).refresh(buildInput())
  const accountMetrics = result.metrics.filter((metric) => metric.providerMetricId.startsWith("xai:camel1:"))
  expect(accountMetrics).toHaveLength(3)
  const weeklyMetric = accountMetrics.find((metric) => metric.providerMetricId.endsWith(":weekly"))!
  expect(weeklyMetric.label).toBe("Weekly quota")
  expect(weeklyMetric.used).toBe(0)
  expect(weeklyMetric.window?.resetAt).toBe("2026-08-03T20:00:05Z")
  const payg = accountMetrics.find((metric) => metric.providerMetricId.endsWith(":on_demand"))!
  expect(payg.notes).toBe("Disabled")
  const monthlyMetric = accountMetrics.find((metric) => metric.providerMetricId.endsWith(":monthly"))!
  expect(monthlyMetric.label).toBe("Monthly credits")
  expect(monthlyMetric.limit).toBe(150)
  expect(monthlyMetric.used).toBe(0)
  expect(monthlyMetric.window?.resetAt).toBe("2026-09-01T00:00:00Z")
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
        // Return weekly body for ?format=credits, monthly body otherwise
        const isWeekly = body.url?.includes("format=credits")
        return makeResp(200, isWeekly ? makeXaiWeeklyBody() : makeXaiMonthlyBody())
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
    undefined, // xai uses weekly/monthly bodies via makeFakeFetch internal logic
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
  expect(result.dynamicSubscriptions!.length).toBe(4) // all accounts produced
  const errorMetrics = result.metrics.filter(m => m.sourceValueKind === "status")
  expect(errorMetrics.length).toBe(4) // all accounts failed
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
    return makeResp(200, { status_code: 429, body: '{"error":"rate limited"}' })
  }
  const result = await createCliproxyProvider(raw as unknown as FakeFetch).refresh(buildInput())
  const codexError = result.metrics.find(m => m.providerMetricId === "codex:abc123:error")
  expect(codexError).toBeDefined()
  expect(codexError!.notes).toContain("429")
})

// P1.4: status:"error" + unavailable:true accounts must NOT be filtered
test("quota-exhausted account (status:error + unavailable:true) is kept and queried", async () => {
  const fetchImpl = makeFakeFetch()
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  // err001 should appear in dynamicSubscriptions
  const errSub = result.dynamicSubscriptions!.find(ds => ds.id === "cliproxy:codex:err001")
  expect(errSub).toBeDefined()
  // And should have real metrics (not just an error metric)
  const errMetric = result.metrics.find(m => m.providerMetricId === "codex:err001:five_hour")
  expect(errMetric).toBeDefined()
})

// P1.5: 400 (stale auth_index) should NOT trigger global fast-fail
test("batch of 400s does NOT abort remaining accounts", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) return makeResp(200, AUTH_FILES_BODY)
    // Every api-call returns 400
    return makeResp(400, { error: "auth token not found" })
  }
  const result = await createCliproxyProvider(raw as unknown as FakeFetch).refresh(buildInput())
  // All 4 non-disabled accounts should have error metrics, not "skipped"
  const skipped = result.metrics.filter(m => m.notes?.includes("skipped"))
  expect(skipped.length).toBe(0)
  const errors = result.metrics.filter(m => m.sourceValueKind === "status")
  expect(errors.length).toBe(4) // abc123, def456, ghi789, err001 - all queried, all got 400
})

// P2.4: unknown limit_window_seconds produces a generic metric
test("codex: unknown limit_window_seconds produces generic window metric", async () => {
  const unknownBody = {
    status_code: 200,
    body: JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 50, limit_window_seconds: 86400, reset_at: 1783275600 },
      },
    }),
  }
  const fetchImpl = makeFakeFetch(unknownBody)
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  const generic = result.metrics.find(m => m.providerMetricId === "codex:abc123:window_86400")
  expect(generic).toBeDefined()
  expect(generic!.used).toBe(50)
  expect(generic!.window?.kind).toBe("rolling")
  if (generic!.window?.kind === "rolling") {
    expect(generic!.window.duration).toBe("1d")
  }
})

test("codex: 5400s window labeled as 90m (not rounded to 2h)", async () => {
  const body = {
    status_code: 200,
    body: JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 5400, reset_at: 1783275600 },
      },
    }),
  }
  const fetchImpl = makeFakeFetch(body)
  const result = await createCliproxyProvider(fetchImpl).refresh(buildInput())
  const m = result.metrics.find(m => m.providerMetricId === "codex:abc123:window_5400")
  expect(m).toBeDefined()
  if (m!.window?.kind === "rolling") {
    expect(m!.window.duration).toBe("90m")
  }
})

// P2.3: xai partial failure - weekly fails, monthly succeeds
test("xai: weekly 500 + monthly 200 produces monthly metrics + partial warning", async () => {
  const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) return makeResp(200, AUTH_FILES_BODY)
    if (url.includes("/api-call")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
      if (body.auth_index === "ghi789") {
        const isWeekly = body.url?.includes("format=credits")
        if (isWeekly) return makeResp(502, { error: "bad gateway" })
        return makeResp(200, makeXaiMonthlyBody())
      }
      if (body.auth_index === "abc123") return makeResp(200, makeCodexBody())
      if (body.auth_index === "def456") return makeResp(200, makeClaudeBody())
      if (body.auth_index === "err001") return makeResp(200, makeCodexBody())
      return makeResp(200, { status_code: 500, body: "{}" })
    }
    return makeResp(404, {})
  }
  const result = await createCliproxyProvider(raw as unknown as FakeFetch).refresh(buildInput())
  // Monthly metric should still be present
  const monthly = result.metrics.find(m => m.providerMetricId === "xai:ghi789:monthly")
  expect(monthly).toBeDefined()
  expect(monthly!.used).toBe(2) // 200 cents -> $2.00
  expect(monthly!.limit).toBe(10)
  // Weekly should be absent (weekly endpoint failed)
  const weekly = result.metrics.find(m => m.providerMetricId === "xai:ghi789:weekly")
  expect(weekly).toBeUndefined()
  // An error should be recorded for this account
  const xaiError = result.errors?.find(e => e.message.includes("ghi789") && e.message.includes("weekly"))
  expect(xaiError).toBeDefined()
})

// P1.7: xai partial failure via upstream status_code (HTTP 200 wrapping 500)
test("P1.7: weekly upstream 500 (mgmt HTTP 200 + status_code:500) surfaces partial warning", async () => {
  const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes("/auth-files")) return makeResp(200, AUTH_FILES_BODY)
    if (url.includes("/api-call")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
      if (body.auth_index === "ghi789") {
        const isWeekly = body.url?.includes("format=credits")
        if (isWeekly) {
          // Management API returns 200, but upstream returned 500.
          // This is the real CLIProxy contract - status_code is in the body.
          return makeResp(200, { status_code: 500, body: '{"error":"internal"}' })
        }
        return makeResp(200, makeXaiMonthlyBody())
      }
      if (body.auth_index === "abc123") return makeResp(200, makeCodexBody())
      if (body.auth_index === "def456") return makeResp(200, makeClaudeBody())
      if (body.auth_index === "err001") return makeResp(200, makeCodexBody())
      return makeResp(200, { status_code: 500, body: "{}" })
    }
    return makeResp(404, {})
  }
  const result = await createCliproxyProvider(raw as unknown as FakeFetch).refresh(buildInput())
  // Monthly metric should still be present
  const monthly = result.metrics.find(m => m.providerMetricId === "xai:ghi789:monthly")
  expect(monthly).toBeDefined()
  // Weekly should be absent
  const weekly = result.metrics.find(m => m.providerMetricId === "xai:ghi789:weekly")
  expect(weekly).toBeUndefined()
  // Partial warning should be recorded (detects upstream status_code 500)
  const xaiError = result.errors?.find(e => e.message.includes("ghi789") && e.message.includes("weekly"))
  expect(xaiError).toBeDefined()
})
