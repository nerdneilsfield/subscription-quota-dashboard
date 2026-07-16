import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createMiniMaxProvider } from "../../src/server/providers/minimax"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "mm-1", type: "minimax", apiKey: "mm-key" }
const metrics: MetricConfig[] = [
  { id: "5h", providerMetricId: "five_hour", label: "5h", unit: "%", display: { module: "rolling-window-card" } },
  { id: "wk", providerMetricId: "weekly_limit", label: "Weekly", unit: "%", display: { module: "period-quota-card" } },
]
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id, provider,
    runtime: { available: true, apiKey: "mm-key" },
    now: NOW, metrics, ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

// Bun's `typeof fetch` carries static members (e.g. `preconnect`); cast the
// plain async fake through `unknown` to satisfy `typeof fetch`.
type FakeFetch = typeof fetch

test("minimax produces two metrics when status==1", async () => {
  const calls: string[] = []
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, {
      base_resp: { status_code: 0, status_msg: "success" },
      model_remains: [{
        model_name: "general",
        current_interval_remaining_percent: 80,
        end_time: 1752747600000,
        current_weekly_status: 1,
        current_weekly_remaining_percent: 90,
        weekly_end_time: 1753329600000,
      }],
    })
  }
  const result = await createMiniMaxProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(calls[0]).toBe("https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains")
  expect(result.metrics).toHaveLength(2)
  const fiveHour = result.metrics.find((m) => m.providerMetricId === "five_hour")!
  expect(fiveHour.remaining).toBe(80)
  expect(fiveHour.limit).toBe(100)
  expect(fiveHour.used).toBe(20)
  expect(fiveHour.sourceValueKind).toBe("gauge-remaining")
  const weekly = result.metrics.find((m) => m.providerMetricId === "weekly_limit")!
  expect(weekly.remaining).toBe(90)
  expect(weekly.used).toBe(10)
})

test("minimax skips video model, only processes general", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, {
      base_resp: { status_code: 0 },
      model_remains: [
        { model_name: "video", current_interval_remaining_percent: 50, current_weekly_status: 1 },
        { model_name: "general", current_interval_remaining_percent: 80, end_time: 1752747600000, current_weekly_status: 1, current_weekly_remaining_percent: 90, weekly_end_time: 1753329600000 },
      ],
    })
  const result = await createMiniMaxProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(2)
  expect(result.metrics[0]!.remaining).toBe(80) // general, not video (50)
})

test("minimax omits weekly when status != 1", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, {
      base_resp: { status_code: 0 },
      model_remains: [{
        model_name: "general",
        current_interval_remaining_percent: 80,
        end_time: 1752747600000,
        current_weekly_status: 3,
        current_weekly_remaining_percent: 100,
        weekly_end_time: 1753329600000,
      }],
    })
  const result = await createMiniMaxProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]!.providerMetricId).toBe("five_hour")
})

test("minimax uses EN baseUrl", async () => {
  const calls: string[] = []
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return makeResp(200, { base_resp: { status_code: 0 }, model_remains: [] })
  }
  await createMiniMaxProvider(raw as unknown as FakeFetch).refresh(buildInput({
    provider: { id: "mm-1", type: "minimax", baseUrl: "https://api.minimax.io", apiKey: "k" },
  }))
  expect(calls[0]).toBe("https://api.minimax.io/v1/api/openplatform/coding_plan/remains")
})

test("minimax business error base_resp.status_code != 0", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, { base_resp: { status_code: 1001, status_msg: "Quota exceeded" } })
  const result = await createMiniMaxProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.message).toContain("Quota exceeded")
  expect(result.errors![0]!.retryable).toBe(false)
})

test("minimax 401 non-retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(401, {})
  const result = await createMiniMaxProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
})

test("minimax network error retryable", async () => {
  const raw = async (): Promise<Response> => { throw new Error("reset") }
  const result = await createMiniMaxProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("minimax no general model returns empty metrics", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, { base_resp: { status_code: 0 }, model_remains: [{ model_name: "video" }] })
  const result = await createMiniMaxProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
})
