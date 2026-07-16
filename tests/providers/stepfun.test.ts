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

// Bun's `typeof fetch` carries static members (e.g. `preconnect`); cast the
// plain async fake through `unknown` to satisfy `typeof fetch`.
type FakeFetch = typeof fetch

test("stepfun parses top-level balance", async () => {
  const calls: string[] = []
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { object: "account", type: "cash", balance: 88.8 })
  }
  const result = await createStepfunProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(calls).toEqual(["https://api.stepfun.com/v1/accounts"])
  expect(result.metrics[0]!.remaining).toBe(88.8)
  expect(result.errors).toBeUndefined()
})

test("stepfun handles numeric string balance", async () => {
  const raw = async (): Promise<Response> => makeResp(200, { balance: "200" })
  const result = await createStepfunProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(200)
})

test("stepfun 401 non-retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(401, {})
  const result = await createStepfunProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("stepfun 429 retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(429, {})
  const result = await createStepfunProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("stepfun network error retryable", async () => {
  const raw = async (): Promise<Response> => { throw new Error("timeout") }
  const result = await createStepfunProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("stepfun unavailable without key", async () => {
  const result = await createStepfunProvider().refresh(buildInput({
    runtime: { available: false, reason: "no key" },
  }))
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.metrics).toHaveLength(0)
})
