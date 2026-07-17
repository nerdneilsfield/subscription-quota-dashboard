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

// Bun's `typeof fetch` carries static members (e.g. `preconnect`); cast the
// plain async fake through `unknown` to satisfy `typeof fetch`.
type FakeFetch = typeof fetch

test("zhipu classifies by unit field (3=five_hour, 6=weekly_limit)", async () => {
  const calls: { url: string; auth: string }[] = []
  const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
  const result = await createZhipuProvider(raw as unknown as FakeFetch).refresh(buildInput())
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
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { success: true, data: { limits: [] } })
  }
  await createZhipuProvider(raw as unknown as FakeFetch).refresh(buildInput({
    provider: { id: "zp-1", type: "zhipu", baseUrl: "https://api.z.ai", apiKey: "k" },
  }))
  expect(calls[0]).toBe("https://api.z.ai/api/monitor/usage/quota/limit")
})

test("zhipu filters non-TOKENS_LIMIT entries", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, {
      success: true,
      data: { limits: [
        { type: "OTHER_LIMIT", unit: 3, percentage: 10 },
        { type: "TOKENS_LIMIT", unit: 3, percentage: 30, nextResetTime: "2026-07-17T05:00:00Z" },
      ] },
    })
  const result = await createZhipuProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]!.used).toBe(30)
})

test("zhipu business error success=false", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, { success: false, msg: "Invalid token" })
  const result = await createZhipuProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.message).toContain("Invalid token")
  expect(result.errors![0]!.retryable).toBe(false)
})

test("zhipu 401 non-retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(401, {})
  const result = await createZhipuProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("zhipu network error retryable", async () => {
  const raw = async (): Promise<Response> => { throw new Error("dns") }
  const result = await createZhipuProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("zhipu fallback sorts unclassified numeric seconds reset times", async () => {
  // Two unclassified TOKENS_LIMIT entries with numeric seconds reset times.
  // Earlier reset should become five_hour, later reset should become weekly_limit.
  const raw = async (): Promise<Response> =>
    makeResp(200, {
      success: true,
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 30, nextResetTime: 1752796800 }, // 2025-07-18T00:00:00Z
          { type: "TOKENS_LIMIT", percentage: 50, nextResetTime: 1752192000 }, // 2025-07-11T00:00:00Z
        ],
      },
    })
  const result = await createZhipuProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(2)
  const fiveHour = result.metrics.find((m) => m.providerMetricId === "five_hour")!
  const weekly = result.metrics.find((m) => m.providerMetricId === "weekly_limit")!
  expect(fiveHour.used).toBe(50) // earlier reset -> five_hour
  expect(weekly.used).toBe(30) // later reset -> weekly_limit
  expect(fiveHour.window?.resetAt).toBe("2025-07-11T00:00:00.000Z")
  expect(weekly.window?.resetAt).toBe("2025-07-18T00:00:00.000Z")
})
