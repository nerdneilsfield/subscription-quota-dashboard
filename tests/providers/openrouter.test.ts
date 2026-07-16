import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createOpenrouterProvider } from "../../src/server/providers/openrouter"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "or-1", type: "openrouter", apiKey: "or-key" }
const metric: MetricConfig = {
  id: "balance", providerMetricId: "balance",
  label: "Credits", unit: "USD",
  display: { module: "balance-card" },
}
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id, provider,
    runtime: { available: true, apiKey: "or-key" },
    now: NOW, metrics: [metric], ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

// Bun's `typeof fetch` carries static members (e.g. `preconnect`); cast the
// plain async fake through `unknown` to satisfy `typeof fetch`.
type FakeFetch = typeof fetch

test("openrouter computes remaining = total_credits - total_usage", async () => {
  const calls: string[] = []
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { data: { total_credits: 100, total_usage: 30 } })
  }
  const result = await createOpenrouterProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(calls).toEqual(["https://openrouter.ai/api/v1/credits"])
  const m = result.metrics[0]!
  expect(m.remaining).toBe(70)
  expect(m.limit).toBe(100)
  expect(m.used).toBe(30)
  expect(m.sourceValueKind).toBe("gauge-remaining")
})

test("openrouter notes no credits when remaining <= 0", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, { data: { total_credits: 10, total_usage: 15 } })
  const result = await createOpenrouterProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(-5)
  expect(result.metrics[0]!.notes).toContain("No credits remaining")
})

test("openrouter handles string numbers", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, { data: { total_credits: "100", total_usage: "25" } })
  const result = await createOpenrouterProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics[0]!.remaining).toBe(75)
})

test("openrouter 401 non-retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(401, {})
  const result = await createOpenrouterProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("openrouter 503 retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(503, {})
  const result = await createOpenrouterProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("openrouter network error retryable", async () => {
  const raw = async (): Promise<Response> => { throw new Error("dns") }
  const result = await createOpenrouterProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})
