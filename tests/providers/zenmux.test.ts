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

// Bun's `typeof fetch` carries static members (e.g. `preconnect`); cast the
// plain async fake through `unknown` to satisfy `typeof fetch`.
type FakeFetch = typeof fetch

test("zenmux multiplies usage_percentage by 100", async () => {
  const calls: string[] = []
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
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
  const result = await createZenmuxProvider(raw as unknown as FakeFetch).refresh(buildInput())
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
  const raw = async (): Promise<Response> =>
    makeResp(200, { success: false, message: "Unauthorized plan" })
  const result = await createZenmuxProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.message).toContain("Unauthorized plan")
  expect(result.errors![0]!.retryable).toBe(false)
})

test("zenmux 401 non-retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(401, {})
  const result = await createZenmuxProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("zenmux 502 retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(502, {})
  const result = await createZenmuxProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("zenmux network error retryable", async () => {
  const raw = async (): Promise<Response> => { throw new Error("timeout") }
  const result = await createZenmuxProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})
