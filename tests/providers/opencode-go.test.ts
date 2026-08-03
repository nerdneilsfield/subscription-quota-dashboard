import { expect, test } from "bun:test"
import { createOpenCodeGoProvider, parseOpenCodeGoUsage } from "../../src/server/providers/opencode-go"
import type { MetricConfig } from "../../src/shared/domain"

const NOW = "2026-08-03T08:00:00.000Z"
const WORKSPACE = "wrk_TEST123"
const HTML = `<html><script>_$HY.r["lite.subscription.get[\\"${WORKSPACE}\\"]"]=$R[17];
$R[28]($R[18],$R[33]={mine:!0,useBalance:!1,region:$R[34]=["us","eu"],rollingUsage:$R[35]={status:"ok",resetInSec:18000,usagePercent:12},weeklyUsage:$R[36]={status:"ok",resetInSec:576745,usagePercent:34},monthlyUsage:$R[37]={status:"rate-limited",resetInSec:2015904,usagePercent:100}});</script></html>`
const SERVER_FUNCTION_STREAM = `;0x00000154;((self.$R=self.$R||{})["quota-dashboard:1"]=[],($R=>$R[0]={mine:!0,useBalance:!1,region:$R[1]=["us","eu"],rollingUsage:$R[2]={status:"ok",resetInSec:18000,usagePercent:12},weeklyUsage:$R[3]={status:"ok",resetInSec:576745,usagePercent:34},monthlyUsage:$R[4]={status:"rate-limited",resetInSec:2015904,usagePercent:100}})($R["quota-dashboard:1"]))`

const metrics: MetricConfig[] = [
  metric("five-hour", "go:five_hour", "5h"),
  metric("weekly", "go:weekly", "7d"),
  metric("monthly", "go:monthly", "30d"),
]

test("parses OpenCode SolidStart SSR quota payload without eval", () => {
  expect(parseOpenCodeGoUsage(HTML, WORKSPACE)).toEqual({
    useBalance: false,
    rollingUsage: { status: "ok", resetInSec: 18_000, usagePercent: 12 },
    weeklyUsage: { status: "ok", resetInSec: 576_745, usagePercent: 34 },
    monthlyUsage: { status: "rate-limited", resetInSec: 2_015_904, usagePercent: 100 },
  })
})

test("parses direct SolidStart server-function quota stream without eval", () => {
  expect(parseOpenCodeGoUsage(SERVER_FUNCTION_STREAM, WORKSPACE)?.weeklyUsage.usagePercent).toBe(34)
})

test("refresh maps 5h, weekly, and monthly Go quota and never exposes cookie", async () => {
  let requestedUrl = ""
  let request: RequestInit | undefined
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(url)
    request = init
    return new Response(SERVER_FUNCTION_STREAM, { status: 200, headers: { "content-type": "text/javascript" } })
  }) as typeof fetch
  const provider = createOpenCodeGoProvider(fetchImpl)

  const result = await provider.refresh({
    providerAccountId: "opencode-go-main",
    provider: { id: "opencode-go-main", type: "opencode-go" },
    runtime: { available: true, workspaceId: WORKSPACE, authCookie: "secret-cookie" },
    now: NOW,
    metrics,
  })

  expect(result.errors).toBeUndefined()
  expect(result.metrics.map((item) => [item.providerMetricId, item.used, item.remaining])).toEqual([
    ["go:five_hour", 12, 88],
    ["go:weekly", 34, 66],
    ["go:monthly", 100, 0],
  ])
  expect(result.metrics[0]?.window).toEqual({ kind: "rolling", duration: "5h", resetAt: "2026-08-03T13:00:00.000Z" })
  expect(result.metrics[2]?.notes).toContain("rate limited")
  expect(new Headers(request?.headers).get("cookie")).toBe("auth=secret-cookie")
  expect(requestedUrl).toStartWith("https://opencode.ai/_server?")
  expect(requestedUrl).not.toContain(`/workspace/${WORKSPACE}/go`)
  expect(new Headers(request?.headers).get("x-server-id")).toHaveLength(64)
})

test("expired auth redirect returns a clear non-retryable error", async () => {
  const provider = createOpenCodeGoProvider((async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, {
    status: 302,
    headers: { location: "/auth/authorize" },
  })) as typeof fetch)
  const result = await provider.refresh({
    providerAccountId: "opencode-go-main",
    provider: { id: "opencode-go-main", type: "opencode-go" },
    runtime: { available: true, workspaceId: WORKSPACE, authCookie: "expired" },
    now: NOW,
    metrics,
  })

  expect(result.metrics).toEqual([])
  expect(result.errors).toEqual([{ message: "OpenCode Go authentication expired; replace OPENCODE_AUTH_COOKIE", retryable: false }])
})

test("missing or changed SSR payload fails closed", async () => {
  const provider = createOpenCodeGoProvider((async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("<html>ok</html>", { status: 200 })) as typeof fetch)
  const result = await provider.refresh({
    providerAccountId: "opencode-go-main",
    provider: { id: "opencode-go-main", type: "opencode-go" },
    runtime: { available: true, workspaceId: WORKSPACE, authCookie: "cookie" },
    now: NOW,
    metrics,
  })

  expect(result.errors?.[0]?.message).toBe("OpenCode Go authenticated payload missing")
})

function metric(id: string, providerMetricId: string, duration: string): MetricConfig {
  return {
    id,
    providerMetricId,
    label: id,
    unit: "%",
    sourceValueKind: "gauge-used",
    window: { kind: "rolling", duration },
    display: { module: "period-quota-card" },
  }
}
