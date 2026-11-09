import { expect, test } from "bun:test"
import type { ProviderAccountConfig } from "../../src/shared/domain"
import { createGptLoadProvider } from "../../src/server/providers/gpt-load"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

type FakeFetch = typeof fetch

const provider: ProviderAccountConfig = {
  id: "gl-1", type: "gpt-load",
  baseUrl: "http://localhost:3001", apiKey: "admin-token",
}
const NOW = "2026-11-09T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id,
    provider,
    runtime: { available: true, apiKey: "admin-token" },
    now: NOW,
    metrics: [],
    ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function envelope<T>(data: T, code = 0): unknown {
  return { code, message: code === 0 ? "ok" : "boom", data }
}

const GROUPS_BODY = envelope({
  items: [
    { id: 3, name: "Codex Pool", channel_id: "codex", connection_type: "subscription", status: "available" },
    { id: 7, name: "Claude Pool", channel_id: "claude", connection_type: "subscription", status: "available" },
  ],
  pagination: { page: 1, page_size: 100, total_items: 2, total_pages: 1 },
})

function makeCredentialsBody(items: unknown[], page = 1, totalPages = 1): unknown {
  return envelope({ items, pagination: { page, page_size: 100, total_items: items.length, total_pages: totalPages } })
}

const WINDOW_5H = {
  id: "five_hour", label: "5h quota", scope: "user", unit: "percent",
  used: 72, limit: 100, utilization: 72, reset_at_ms: 1765242000000, window_seconds: 18000, state: "ok",
}
const WINDOW_WEEKLY = {
  id: "weekly", label: "Weekly quota", scope: "user", unit: "percent",
  used: 45, limit: 100, utilization: 45, reset_at_ms: 1765674000000, window_seconds: 604800, state: "ok",
}

test("gpt-load discovers groups and maps quota windows to metrics and dynamic subscriptions", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/api/groups?")) return makeResp(200, GROUPS_BODY)
    if (url.includes("/api/groups/3/credentials?")) {
      return makeResp(200, makeCredentialsBody([
        { credential_id: 11, name: "display-name", configured_status: "enabled", effective_status: "available",
          auth_state: "ready", connection_type: "subscription",
          account: { email: "alice@example.com" },
          observation: { state: "fresh", observed_at_ms: 1765240000000,
            snapshot: { plan_summary: { name: "Pro", level: "plus" },
            quota_windows: [WINDOW_5H, WINDOW_WEEKLY] } } },
      ]))
    }
    if (url.includes("/api/groups/7/credentials?")) {
      return makeResp(200, makeCredentialsBody([
        { credential_id: 21, name: "bob-claude", configured_status: "enabled", effective_status: "cooldown",
          auth_state: "ready", connection_type: "subscription",
          observation: { state: "fresh", snapshot: { quota_windows: [WINDOW_WEEKLY] } } },
      ]))
    }
    return makeResp(404, envelope(null, 404))
  }
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors).toBeUndefined()
  expect(result.metrics).toHaveLength(3)

  const fiveHour = result.metrics.find((m) => m.providerMetricId === "codex:3:11:five_hour")
  expect(fiveHour).toMatchObject({
    label: "5h quota", unit: "%", used: 72, limit: 100,
    sourceValueKind: "gauge-used", sourceConfidence: "known",
    updatedAt: new Date(1765240000000).toISOString(),
  })
  expect(fiveHour?.window).toMatchObject({ kind: "rolling", duration: "5h", resetAt: new Date(1765242000000).toISOString() })

  const weekly = result.metrics.find((m) => m.providerMetricId === "claude:7:21:weekly")
  expect(weekly).toMatchObject({ used: 45, window: { duration: "7d" } })

  const codexSub = result.dynamicSubscriptions?.find((s) => s.id === "gpt-load:3:11")
  expect(codexSub).toMatchObject({
    name: "Codex",
    providerMetricIds: ["codex:3:11:five_hour", "codex:3:11:weekly"],
    identity: { provider: "gpt-load", providerLabel: "Codex", account: "alice@example.com", plan: "Pro plus", transport: "GPT Load" },
    ui: { group: "Codex" },
  })
  expect(result.dynamicSubscriptions).toHaveLength(2)
})

test("gpt-load paginates groups and credentials until total_pages", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/api/groups?")) {
      if (url.includes("page=1")) return makeResp(200, envelope({
        items: [{ id: 3, name: "Codex Pool", channel_id: "codex", connection_type: "subscription" }],
        pagination: { page: 1, page_size: 100, total_items: 2, total_pages: 2 },
      }))
      if (url.includes("page=2")) return makeResp(200, envelope({
        items: [{ id: 7, name: "Claude Pool", channel_id: "claude", connection_type: "subscription" }],
        pagination: { page: 2, page_size: 100, total_items: 2, total_pages: 2 },
      }))
      return makeResp(400, envelope(null, 400))
    }
    if (url.includes("/api/groups/3/credentials?")) return makeResp(200, makeCredentialsBody([], 1, 2))
    if (url.includes("/api/groups/7/credentials?")) {
      if (url.includes("page=1")) return makeResp(200, makeCredentialsBody([], 1, 2))
      if (url.includes("page=2")) return makeResp(200, makeCredentialsBody([
        { credential_id: 12, configured_status: "enabled", observation: { snapshot: { quota_windows: [WINDOW_5H] } } },
      ], 2, 2))
      return makeResp(400, envelope(null, 400))
    }
    return makeResp(404, envelope(null, 404))
  }
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors).toBeUndefined()
  expect(result.metrics.map((m) => m.providerMetricId)).toEqual(["claude:7:12:five_hour"])
})

test("gpt-load skips disabled credentials", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/api/groups?")) return makeResp(200, GROUPS_BODY)
    if (url.includes("/api/groups/3/credentials?")) {
      return makeResp(200, makeCredentialsBody([
        { credential_id: 13, name: "disabled-account", configured_status: "disabled",
          observation: { snapshot: { quota_windows: [WINDOW_5H] } } },
      ]))
    }
    if (url.includes("/api/groups/7/credentials?")) return makeResp(200, makeCredentialsBody([]))
    return makeResp(404, envelope(null, 404))
  }
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.dynamicSubscriptions).toHaveLength(0)
  expect(result.errors).toBeUndefined()
})

test("gpt-load skips api-key groups entirely (no quota data exists for them)", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/api/groups?")) {
      return makeResp(200, envelope({
        items: [{ id: 9, name: "API Pool", channel_id: "deepseek", connection_type: "api_key", status: "available" }],
        pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
      }))
    }
    return makeResp(404, envelope(null, 404))
  }
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.dynamicSubscriptions).toHaveLength(0)
  expect(result.errors).toBeUndefined()
})

test("gpt-load auth-broken credential yields error metric and preserve prefix", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/api/groups?")) return makeResp(200, GROUPS_BODY)
    if (url.includes("/api/groups/3/credentials?")) {
      return makeResp(200, makeCredentialsBody([
        { credential_id: 14, name: "stale-account", configured_status: "enabled",
          auth_state: "reauthorization_required", auth_error_code: "refresh_failed",
          connection_type: "subscription", observation: null },
      ]))
    }
    if (url.includes("/api/groups/7/credentials?")) return makeResp(200, makeCredentialsBody([]))
    return makeResp(404, envelope(null, 404))
  }
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors?.length).toBeGreaterThan(0)
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]).toMatchObject({
    providerMetricId: "codex:3:14:error",
    sourceValueKind: "status",
    notes: "auth_state: reauthorization_required (refresh_failed)",
  })
  expect(result.preserveMetricIds).toEqual(["codex:3:14:"])
  expect(result.dynamicSubscriptions).toHaveLength(1)
})

test("gpt-load ready credential without windows shows awaiting status, no provider error", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/api/groups?")) return makeResp(200, GROUPS_BODY)
    if (url.includes("/api/groups/3/credentials?")) {
      return makeResp(200, makeCredentialsBody([
        { credential_id: 15, configured_status: "enabled", auth_state: "ready",
          connection_type: "subscription", observation: null },
      ]))
    }
    if (url.includes("/api/groups/7/credentials?")) return makeResp(200, makeCredentialsBody([]))
    return makeResp(404, envelope(null, 404))
  }
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors).toBeUndefined()
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]).toMatchObject({
    providerMetricId: "codex:3:15:status",
    sourceValueKind: "status",
    notes: "awaiting first observation",
  })
  expect(result.dynamicSubscriptions).toHaveLength(1)
})

test("gpt-load stale observation downgrades confidence and stamps updatedAt", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/api/groups?")) return makeResp(200, GROUPS_BODY)
    if (url.includes("/api/groups/3/credentials?")) {
      return makeResp(200, makeCredentialsBody([
        { credential_id: 16, configured_status: "enabled", auth_state: "ready",
          observation: { state: "stale", observed_at_ms: 1700000000000,
            snapshot: { quota_windows: [WINDOW_5H] } } },
      ]))
    }
    if (url.includes("/api/groups/7/credentials?")) return makeResp(200, makeCredentialsBody([]))
    return makeResp(404, envelope(null, 404))
  }
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors).toBeUndefined()
  expect(result.metrics[0]).toMatchObject({
    providerMetricId: "codex:3:16:five_hour",
    sourceConfidence: "estimated",
    updatedAt: new Date(1700000000000).toISOString(),
    notes: "observation state: stale",
  })
})

test("gpt-load maps usd window unit to $", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/api/groups?")) return makeResp(200, GROUPS_BODY)
    if (url.includes("/api/groups/3/credentials?")) {
      return makeResp(200, makeCredentialsBody([
        { credential_id: 17, configured_status: "enabled", auth_state: "ready",
          observation: { state: "fresh", snapshot: { quota_windows: [
            { id: "credits", label: "Credits", unit: "usd", used: 3.5, limit: 50, reset_at_ms: null, window_seconds: 2592000 },
          ] } } },
      ]))
    }
    if (url.includes("/api/groups/7/credentials?")) return makeResp(200, makeCredentialsBody([]))
    return makeResp(404, envelope(null, 404))
  }
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics[0]).toMatchObject({
    providerMetricId: "codex:3:17:credits",
    unit: "$", used: 3.5, limit: 50,
    window: { kind: "rolling", duration: "30d" },
  })
})

test("gpt-load group credentials failure keeps a placeholder card and records the error", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/api/groups?")) return makeResp(200, GROUPS_BODY)
    if (url.includes("/api/groups/3/credentials?")) return makeResp(500, envelope(null, 500))
    if (url.includes("/api/groups/7/credentials?")) {
      return makeResp(200, makeCredentialsBody([
        { credential_id: 22, configured_status: "enabled", observation: { snapshot: { quota_windows: [WINDOW_WEEKLY] } } },
      ]))
    }
    return makeResp(404, envelope(null, 404))
  }
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors?.some((e) => e.message.includes("group 3") && e.retryable)).toBe(true)
  expect(result.metrics.map((m) => m.providerMetricId)).toEqual(["codex:3:unavailable", "claude:7:22:weekly"])
  expect(result.metrics[0]?.notes).toContain("failed to fetch credentials")
  expect(result.dynamicSubscriptions?.map((s) => s.id)).toEqual(["gpt-load:3:unavailable", "gpt-load:7:22"])
  expect(result.dynamicSubscriptions?.[0]?.name).toBe("Codex Pool")
})

test("gpt-load retries a group credentials request once on retryable failure", async () => {
  let group3Attempts = 0
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/api/groups?")) return makeResp(200, GROUPS_BODY)
    if (url.includes("/api/groups/3/credentials?")) {
      group3Attempts++
      if (group3Attempts === 1) return makeResp(502, envelope(null, 502))
      return makeResp(200, makeCredentialsBody([
        { credential_id: 18, configured_status: "enabled", observation: { snapshot: { quota_windows: [WINDOW_5H] } } },
      ]))
    }
    if (url.includes("/api/groups/7/credentials?")) return makeResp(200, makeCredentialsBody([]))
    return makeResp(404, envelope(null, 404))
  }
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(group3Attempts).toBe(2)
  expect(result.errors).toBeUndefined()
  expect(result.metrics.map((m) => m.providerMetricId)).toContain("codex:3:18:five_hour")
})

test("gpt-load rejects invalid admin token as non-retryable auth error", async () => {
  const raw = async (): Promise<Response> => makeResp(401, { code: "UNAUTHORIZED", message: "invalid token" })
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors).toEqual([{ message: "gpt-load groups request failed: admin token rejected", retryable: false }])
  expect(result.metrics).toHaveLength(0)
  expect(result.dynamicSubscriptions).toBeUndefined()
})

test("gpt-load reports missing admin token as configuration error", async () => {
  const result = await createGptLoadProvider().refresh(buildInput({ runtime: { available: false, reason: "missing" } }))
  expect(result.errors?.[0]?.message).toContain("admin token not configured")
  expect(result.errors?.[0]?.retryable).toBe(false)
})

test("gpt-load propagates envelope errors as non-retryable", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> =>
    String(input).includes("/api/groups?") ? makeResp(200, envelope(null, 50001)) : makeResp(404, envelope(null, 404))
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors).toEqual([{ message: "gpt-load groups request failed: boom", retryable: false }])
})

test("gpt-load omits dynamic subscriptions when every group rejects the token", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/api/groups?")) return makeResp(200, GROUPS_BODY)
    if (url.includes("/credentials?")) return makeResp(403, { code: "FORBIDDEN", message: "forbidden" })
    return makeResp(404, envelope(null, 404))
  }
  const result = await createGptLoadProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors?.length).toBe(2)
  expect(result.errors?.every((e) => e.retryable === false)).toBe(true)
  expect(result.dynamicSubscriptions).toBeUndefined()
})
