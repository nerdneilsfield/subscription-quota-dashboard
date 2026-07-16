import { expect, test } from "bun:test"
import type { MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import { createVolcengineProvider } from "../../src/server/providers/volcengine"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "vol-1", type: "volcengine", region: "cn-beijing", ak: "ak-test", sk: "sk-test" }
const metrics: MetricConfig[] = [
  { id: "5h", providerMetricId: "afp:five_hour", label: "AFP 5h", unit: "tokens", display: { module: "rolling-window-card" } },
  { id: "wk", providerMetricId: "afp:weekly_limit", label: "AFP Weekly", unit: "tokens", display: { module: "period-quota-card" } },
  { id: "mo", providerMetricId: "afp:monthly", label: "AFP Monthly", unit: "tokens", display: { module: "period-quota-card" } },
]
const NOW = "2026-07-17T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id, provider,
    runtime: { available: true, ak: "ak-test", sk: "sk-test" },
    now: NOW, metrics, ...overrides,
  }
}

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

// Bun's `typeof fetch` carries static members (e.g. `preconnect`); cast the
// plain async fake through `unknown` to satisfy `typeof fetch`.
type FakeFetch = typeof fetch

test("volcengine AFP non-empty -> emit AFP tiers, no CodingPlan call", async () => {
  const calls: string[] = []
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    if (url.includes("GetAFPUsage")) {
      return makeResp(200, {
        ResponseMetadata: {},
        Result: {
          PlanType: "Pro",
          AFPFiveHour: { Quota: 1000, Used: 300, ResetTime: "2026-07-17T05:00:00Z" },
          AFPWeekly: { Quota: 10000, Used: 5000, ResetTime: "2026-07-24T00:00:00Z" },
          AFPMonthly: { Quota: 100000, Used: 20000, ResetTime: "2026-08-01T00:00:00Z" },
        },
      })
    }
    return makeResp(200, {})
  }
  const result = await createVolcengineProvider(raw as unknown as FakeFetch).refresh(buildInput())
  // Only GetAFPUsage called (no fallback)
  expect(calls.filter((u) => u.includes("GetAFPUsage"))).toHaveLength(1)
  expect(calls.filter((u) => u.includes("GetCodingPlanUsage"))).toHaveLength(0)
  expect(result.metrics).toHaveLength(3)
  const fiveHour = result.metrics.find((m) => m.providerMetricId === "afp:five_hour")!
  expect(fiveHour.limit).toBe(1000)
  expect(fiveHour.used).toBe(300)
  expect(fiveHour.remaining).toBe(700)
  expect(fiveHour.sourceValueKind).toBe("gauge-used")
  expect(fiveHour.notes).toContain("Agent Plan Pro")
})

test("volcengine AFP empty -> fallback to CodingPlanUsage", async () => {
  const calls: string[] = []
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    if (url.includes("GetAFPUsage")) {
      return makeResp(200, { ResponseMetadata: {}, Result: { AFPFiveHour: { Quota: 0, Used: 0 } } })
    }
    if (url.includes("GetCodingPlanUsage")) {
      return makeResp(200, {
        ResponseMetadata: {},
        Result: {
          QuotaUsage: [
            { Level: "session", Percent: 40, ResetTime: "2026-07-17T05:00:00Z" },
            { Level: "weekly", Percent: 60, ResetTime: "2026-07-24T00:00:00Z" },
          ],
        },
      })
    }
    return makeResp(200, {})
  }
  const result = await createVolcengineProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(calls.filter((u) => u.includes("GetAFPUsage"))).toHaveLength(1)
  expect(calls.filter((u) => u.includes("GetCodingPlanUsage"))).toHaveLength(1)
  // AFP returned empty (Quota<=0), so CodingPlan tiers are authoritative
  expect(result.metrics).toHaveLength(2)
  expect(result.metrics[0]!.providerMetricId).toBe("cp:five_hour")
  expect(result.metrics[0]!.used).toBe(40)
  expect(result.metrics[0]!.limit).toBe(100)
  expect(result.metrics[0]!.notes).toContain("Coding Plan")
})

test("volcengine skips AFP windows with Quota <= 0", async () => {
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).includes("GetAFPUsage")) {
      return makeResp(200, {
        ResponseMetadata: {},
        Result: {
          AFPFiveHour: { Quota: 1000, Used: 500, ResetTime: "2026-07-17T05:00:00Z" },
          AFPWeekly: { Quota: 0, Used: 0 },  // skipped
          AFPMonthly: { Quota: 0, Used: 0 },  // skipped
        },
      })
    }
    return makeResp(200, {})
  }
  const result = await createVolcengineProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(1)
  expect(result.metrics[0]!.providerMetricId).toBe("afp:five_hour")
})

test("volcengine auth error (401) non-retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(401, {})
  const result = await createVolcengineProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.errors![0]!.message).toContain("authentication")
})

test("volcengine auth error via ResponseMetadata.Error code", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, {
      ResponseMetadata: { Error: { Code: "SignatureDoesNotMatch", Message: "bad sig" } },
    })
  const result = await createVolcengineProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(false)
  expect(result.errors![0]!.message).toContain("signature")
})

test("volcengine non-auth API error retryable", async () => {
  const raw = async (): Promise<Response> =>
    makeResp(200, {
      ResponseMetadata: { Error: { Code: "InternalError", Message: "oops" } },
    })
  const result = await createVolcengineProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("volcengine 500 retryable", async () => {
  const raw = async (): Promise<Response> => makeResp(500, {})
  const result = await createVolcengineProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("volcengine network error retryable", async () => {
  const raw = async (): Promise<Response> => { throw new Error("timeout") }
  const result = await createVolcengineProvider(raw as unknown as FakeFetch).refresh(buildInput())
  expect(result.errors![0]!.retryable).toBe(true)
})

test("volcengine unavailable without AK/SK", async () => {
  const result = await createVolcengineProvider().refresh(buildInput({
    runtime: { available: false, reason: "missing AK" },
  }))
  expect(result.metrics).toHaveLength(0)
  expect(result.errors![0]!.retryable).toBe(false)
})
