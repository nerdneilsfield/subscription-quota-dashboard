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

test("xai: two endpoints merged, monthly percent not capped", async () => {
  // overage: used=1500, monthly_limit=1000 -> 150%
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
    return makeResp(200, { status_code: 429, body: '{"error":"rate limited"}' })
  }
  const result = await createCliproxyProvider(raw as unknown as FakeFetch).refresh(buildInput())
  const codexError = result.metrics.find(m => m.providerMetricId === "codex:abc123:error")
  expect(codexError).toBeDefined()
  expect(codexError!.notes).toContain("429")
})
