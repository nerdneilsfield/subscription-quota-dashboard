import { expect, test } from "bun:test"
import { createMiMoTokenPlanProvider, mapMiMoUsage } from "../../src/server/providers/mimo-token-plan"
import type { MetricConfig } from "../../src/shared/domain"

const NOW = "2026-08-03T08:00:00.000Z"
const metric: MetricConfig = {
  id: "plan-credits",
  providerMetricId: "mimo:plan_credits",
  label: "Plan credits",
  unit: "credits",
  sourceValueKind: "gauge-used",
  display: { module: "period-quota-card" },
}
const usage = {
  monthUsage: { percent: 0.9149, items: [{ name: "month_total_token", used: 10_064_448_712, limit: 11_000_000_000, percent: 0.9149 }] },
  usage: { percent: 0.91, items: [
    { name: "plan_total_token", used: 10_064_448_712, limit: 11_000_000_000, percent: 0.91 },
    { name: "compensation_total_token", used: 0, limit: 0, percent: 0 },
  ] },
}
const detail = {
  planCode: "standard",
  planName: "Standard",
  currentPeriodEnd: "2026-08-04 23:59:59",
  expired: false,
  enableAutoRenew: true,
  hasAutoRenewSubscribed: true,
  clawEnabled: true,
}

test("maps real MiMo Standard Credits, remaining, plan metadata, and UTC expiry", () => {
  const result = mapMiMoUsage(usage, detail, [metric], NOW)

  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({
    providerMetricId: "mimo:plan_credits",
    label: "Standard credits",
    unit: "credits",
    limit: 11_000_000_000,
    used: 10_064_448_712,
    remaining: 935_551_288,
    notes: "Standard · Auto-renew enabled · MiMo Claw enabled",
    window: {
      kind: "fixed",
      startsAt: "2026-07-04T23:59:59.000Z",
      resetAt: "2026-08-04T23:59:59.000Z",
    },
  })
})

test("provider fetches usage and detail with session cookie", async () => {
  const seen: Array<{ path: string; cookie: string | null }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    seen.push({ path: url.pathname, cookie: new Headers(init?.headers).get("cookie") })
    const data = url.pathname.endsWith("/usage") ? usage : detail
    return Response.json({ code: 0, message: "", data })
  }) as typeof fetch
  const result = await createMiMoTokenPlanProvider(fetchImpl).refresh({
    providerAccountId: "mimo-token-main",
    provider: { id: "mimo-token-main", type: "mimo-token-plan" },
    runtime: { available: true, authCookie: "api-platform_ph=secret" },
    now: NOW,
    metrics: [metric],
  })

  expect(result.errors).toBeUndefined()
  expect(result.metrics[0]?.used).toBe(10_064_448_712)
  expect(seen.map((item) => item.path).sort()).toEqual([
    "/api/v1/tokenPlan/detail",
    "/api/v1/tokenPlan/usage",
  ])
  expect(seen.every((item) => item.cookie === "api-platform_ph=secret")).toBe(true)
})

test("HTTP 401 returns explicit expired-session error", async () => {
  const fetchImpl = (async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(
    { code: 401, message: "login required" },
    { status: 401 },
  )) as typeof fetch
  const result = await createMiMoTokenPlanProvider(fetchImpl).refresh({
    providerAccountId: "mimo-token-main",
    provider: { id: "mimo-token-main", type: "mimo-token-plan" },
    runtime: { available: true, authCookie: "expired" },
    now: NOW,
    metrics: [metric],
  })

  expect(result.metrics).toEqual([])
  expect(result.errors).toEqual([{ message: "MiMo Token Plan authentication expired; replace MIMO_SESSION_COOKIE", retryable: false }])
})

test("missing plan_total_token fails closed", () => {
  expect(mapMiMoUsage({ usage: { items: [] } }, detail, [metric], NOW)).toEqual([])
})
