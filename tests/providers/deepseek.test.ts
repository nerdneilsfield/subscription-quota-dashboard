import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
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

// Bun's `typeof fetch` carries static members (e.g. `preconnect`); cast the
// plain async fake to satisfy `typeof fetch`.
type FakeFetch = typeof fetch

test("deepseek parses balance_infos[0].total_balance", async () => {
  const calls: string[] = []
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    return makeResp(200, {
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: 42.5 }],
    })
  }
  const result = await createDeepseekProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(calls).toEqual(["https://api.deepseek.com/user/balance"])
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]!.providerMetricId).toBe("balance")
  expect(result.metrics[0]!.remaining).toBe(42.5)
  expect(result.metrics[0]!.sourceValueKind).toBe("gauge-remaining")
  expect(result.metrics[0]!.sourceConfidence).toBe("known")
  expect(result.errors).toBeUndefined()
})

test("deepseek emits all balance_infos entries", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, {
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: 42.5 },
        { currency: "USD", total_balance: 10 },
      ],
    })
  const result = await createDeepseekProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(2)
  expect(result.metrics[0]!.remaining).toBe(42.5)
  expect(result.metrics[1]!.remaining).toBe(10)
})

test("deepseek handles numeric string total_balance", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "100.5" }] })
  const result = await createDeepseekProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(100.5)
})

test("deepseek 401 returns non-retryable auth error", async () => {
  const raw = async (): Promise<Response> => makeResp(401, { error: "unauthorized" })
  const result = await createDeepseekProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors).toHaveLength(1)
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.errors![0]!.message).toContain("authentication failed")
})

test("deepseek 500 returns retryable error", async () => {
  const raw = async (): Promise<Response> => makeResp(500, { error: "server" })
  const result = await createDeepseekProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("deepseek network error returns retryable error", async () => {
  const raw = async (): Promise<Response> => { throw new Error("connection refused") }
  const result = await createDeepseekProvider(raw as unknown as FakeFetch).refresh(buildInput())
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
  const raw = async (): Promise<Response> =>
    makeResp(200, { is_available: false, balance_infos: [{ currency: "CNY", total_balance: 0 }] })
  const result = await createDeepseekProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.notes).toContain("Insufficient balance")
})
