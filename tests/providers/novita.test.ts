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

// Bun's `typeof fetch` carries static members (e.g. `preconnect`); cast the
// plain async fake through `unknown` to satisfy `typeof fetch`.
type FakeFetch = typeof fetch

test("novita divides availableBalance by 10000", async () => {
  const calls: string[] = []
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { availableBalance: 500000 })
  }
  const result = await createNovitaProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(calls).toEqual(["https://api.novita.ai/v3/user/balance"])
  expect(result.metrics[0]!.remaining).toBe(50) // 500000 / 10000
})

test("novita handles string availableBalance", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, { availableBalance: "250000" })
  const result = await createNovitaProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(25)
})

test("novita notes no balance when remaining <= 0", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, { availableBalance: 0 })
  const result = await createNovitaProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(0)
  expect(result.metrics[0]!.notes).toContain("No balance remaining")
})

test("novita 403 non-retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(403, {})
  const result = await createNovitaProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("novita 500 retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(500, {})
  const result = await createNovitaProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("novita network error retryable", async () => {
  const raw = async (): Promise<Response> => { throw new Error("reset") }
  const result = await createNovitaProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})
