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

// Bun's `typeof fetch` carries static members (e.g. `preconnect`); cast the
// plain async fake through `unknown` to satisfy `typeof fetch`.
type FakeFetch = typeof fetch

test("kimi parses limits[].detail (five_hour) and usage (weekly_limit)", async () => {
  const calls: string[] = []
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, {
      limits: [{ detail: { limit: 1000, remaining: 800, resetTime: "2026-07-17T05:00:00Z" } }],
      usage: { limit: 10000, remaining: 7000, resetTime: "2026-07-24T00:00:00Z" },
    })
  }
  const result = await createKimiProvider(raw as unknown as FakeFetch).refresh(buildInput())
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
  const raw = async (): Promise<Response> =>
    makeResp(200, { limits: [{ detail: { limit: 500, remaining: 400, resetTime: "2026-07-17T05:00:00Z" } }] })
  const result = await createKimiProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]!.providerMetricId).toBe("five_hour")
})

test("kimi handles numeric string fields", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, {
      limits: [{ detail: { limit: "1000", remaining: "800", resetTime: "2026-07-17T05:00:00Z" } }],
      usage: { limit: "10000", remaining: "7000", resetTime: "2026-07-24T00:00:00Z" },
    })
  const result = await createKimiProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.limit).toBe(1000)
  expect(result.metrics[1]!.remaining).toBe(7000)
})

test("kimi 401 non-retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(401, {})
  const result = await createKimiProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("kimi 429 retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(429, {})
  const result = await createKimiProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("kimi network error retryable", async () => {
  const raw = async (): Promise<Response> => { throw new Error("reset") }
  const result = await createKimiProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})
