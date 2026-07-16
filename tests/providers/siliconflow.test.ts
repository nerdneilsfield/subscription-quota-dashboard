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

// Bun's `typeof fetch` carries static members (e.g. `preconnect`); cast the
// plain async fake through `unknown` to satisfy `typeof fetch`.
type FakeFetch = typeof fetch

test("siliconflow parses data.totalBalance (CN default)", async () => {
  const calls: string[] = []
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { code: 200, data: { totalBalance: 55.5, status: "normal" } })
  }
  const result = await createSiliconflowProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(calls[0]).toBe("https://api.siliconflow.cn/v1/user/info")
  expect(result.metrics[0]!.remaining).toBe(55.5)
})

test("siliconflow uses EN baseUrl when configured", async () => {
  const calls: string[] = []
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { data: { totalBalance: 10 } })
  }
  const result = await createSiliconflowProvider(raw as unknown as FakeFetch).refresh(buildInput({
    provider: { id: "sf-1", type: "siliconflow", baseUrl: "https://api.siliconflow.com", apiKey: "k" },
  }))
  expect(calls[0]).toBe("https://api.siliconflow.com/v1/user/info")
  expect(result.metrics[0]!.remaining).toBe(10)
})

test("siliconflow handles string totalBalance", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, { data: { totalBalance: "99.9" } })
  const result = await createSiliconflowProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(99.9)
})

test("siliconflow 401 non-retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(401, {})
  const result = await createSiliconflowProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("siliconflow missing data field -> non-retryable error", async () => {
  const raw = async (): Promise<Response> => makeResp(200, { code: 200 })
  const result = await createSiliconflowProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.retryable).toBe(false)
})

test("siliconflow network error retryable", async () => {
  const raw = async (): Promise<Response> => { throw new Error("timeout") }
  const result = await createSiliconflowProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})
