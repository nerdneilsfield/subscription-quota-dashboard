import { expect, test } from "bun:test"
import { createCommandCodeProvider } from "../../src/server/providers/command-code"
import { loadDashboardConfig } from "../../src/server/config/load-config"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const input: ProviderRefreshInput = {
  providerAccountId: "cc", provider: { id: "cc", type: "command-code", sessionCookie: "session=test" },
  runtime: { available: true, authCookie: "session=test" }, now: "2026-09-25T00:00:00Z", metrics: [],
}
const fixture = {
  credits: { monthlyCredits: 44.6827204733, purchasedCredits: 0, premiumMonthlyCredits: 0,
    opensourceMonthlyCredits: 44.6827204733, monthlyCreditsGranted: 70 },
  windowLimits: { limited: true, exceeded: null,
    fiveHour: { used: 0.016697002, cap: 14, exceeded: false, resetAt: 1790289657432 },
    weekly: { used: 25.3172795267, cap: 35, exceeded: false, resetAt: 1790479181266 } },
}
function mock(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

test("command code maps supplied credits and millisecond reset windows using Cookie", async () => {
  const fetcher = (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.commandcode.ai/internal/billing/credits")
    expect(new Headers(init.headers).get("cookie")).toBe("session=test")
    expect(new Headers(init.headers).has("authorization")).toBe(false)
    expect(init.redirect).toBe("error")
    return new Response(JSON.stringify(fixture))
  }) as unknown as typeof fetch
  const result = await createCommandCodeProvider(fetcher).refresh(input)
  expect(result.errors).toBeUndefined()
  expect(result.metrics).toHaveLength(4)
  expect(result.metrics[0]).toMatchObject({ remaining: 44.6827204733, limit: 70 })
  expect(result.metrics[0]!.used).toBeCloseTo(25.3172795267)
  expect(result.metrics[1]).toMatchObject({ remaining: 0 })
  expect(result.metrics[2]).toMatchObject({ used: 0.016697002, limit: 14,
    window: { duration: "5h", resetAt: new Date(1790289657432).toISOString() } })
  expect(result.metrics[3]!.remaining).toBeCloseTo(9.6827204733)
})

test("command code skips inactive windows and rejects missing credits", async () => {
  const result = await createCommandCodeProvider(mock({ ...fixture, windowLimits: { limited: false } })).refresh(input)
  expect(result.metrics).toHaveLength(2)
  const invalid = await createCommandCodeProvider(mock({})).refresh(input)
  expect(invalid.metrics).toEqual([])
  expect(invalid.errors?.[0]?.retryable).toBe(false)
})

test("command code classifies expired cookies and temporary upstream failure", async () => {
  for (const status of [401, 403, 429, 503]) {
    const result = await createCommandCodeProvider(mock({}, status)).refresh(input)
    expect(result.errors?.[0]?.retryable).toBe(status >= 429)
  }
})

test("command code resolves cookie env and rejects newline injection", () => {
  process.env.COMMAND_CODE_TEST_COOKIE = "session=env-test"
  try {
    const config = loadDashboardConfig({
      providers: [{ id: "cc", type: "command-code", sessionCookieEnv: "COMMAND_CODE_TEST_COOKIE" }],
      subscriptions: [], profiles: [],
    })
    expect(config.providerRuntime.get("cc")).toMatchObject({ available: true, authCookie: "session=env-test" })
    process.env.COMMAND_CODE_TEST_COOKIE = "session=bad\r\nOther: header"
    const invalid = loadDashboardConfig({
      providers: [{ id: "cc", type: "command-code", sessionCookieEnv: "COMMAND_CODE_TEST_COOKIE" }],
      subscriptions: [], profiles: [],
    })
    expect(invalid.providerRuntime.get("cc")?.available).toBe(false)
  } finally { delete process.env.COMMAND_CODE_TEST_COOKIE }
})
