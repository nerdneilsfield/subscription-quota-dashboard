import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../../src/server/http/app"
import type { AppDeps } from "../../src/server/http/app"
import { openDashboardDatabase } from "../../src/server/storage/database"
import { createRepositories } from "../../src/server/storage/repositories"
import type { DashboardStorage } from "../../src/server/storage/repositories"
import { loadDashboardConfig } from "../../src/server/config/load-config"
import type { DashboardConfigInput, MetricConfig, ProviderAccountConfig } from "../../src/shared/domain"
import type {
  NormalizedMetric,
  ProviderAdapter,
  ProviderRefreshInput,
  ProviderRefreshResult,
} from "../../src/server/providers/types"
import { createManualProvider } from "../../src/server/providers/manual"

const NOW_MS = Date.parse("2026-06-25T12:00:00.000Z")
const NOW_ISO = "2026-06-25T12:00:00.000Z"
// Mirrors the real provider 15-min staleAfter TTL (spec ~950).
const STALE_AFTER_ISO = "2026-06-25T12:15:00.000Z"
const SESSION_SECRET = "test-secret-very-long-and-random-xxx"
const VIEW_KEY = "view-secret-key"
const ALLOWED_ORIGIN = "http://localhost:5173"

function makeStorage(): DashboardStorage {
  return createRepositories(openDashboardDatabase(":memory:"))
}

function poeProvider(id: string): ProviderAccountConfig {
  return { id, type: "poe", apiKey: "poe-key" }
}

function pointsMetric(id = "points"): MetricConfig {
  return {
    id,
    providerMetricId: "points",
    label: "API points",
    unit: "points",
    limit: 1_000_000,
    display: { module: "balance-card" },
    window: { kind: "calendar", period: "month", timezone: "UTC", anchor: { dayOfMonth: 1, timeOfDay: "00:00" } },
  }
}

function baseConfig(): DashboardConfigInput {
  return {
    providers: [poeProvider("poe-main"), { id: "manual-main", type: "manual" }],
    subscriptions: [
      { id: "poe-api", name: "Poe API", providerId: "poe-main", metrics: [pointsMetric()] },
      {
        id: "manual-sub", name: "Manual", providerId: "manual-main",
        metrics: [{ id: "credits", label: "Credits", unit: "credits", used: 5, limit: 100, display: { module: "manual-status-card" } }],
      },
    ],
    profiles: [{ id: "self", name: "Personal", viewKey: VIEW_KEY, subscriptionIds: ["poe-api", "manual-sub"] }],
  }
}

function balanceMetric(remaining: number): NormalizedMetric {
  return {
    providerMetricId: "points", label: "API points", unit: "points",
    remaining, sourceValueKind: "gauge-remaining", sourceConfidence: "known",
  }
}

function historyEvent(id: string, cost: number, ts = NOW_ISO) {
  return { providerMetricId: "points", providerEventId: id, sourceTimestamp: ts, value: cost, valueKind: "consumption" as const, usageType: "API" }
}

type FakePoeOpts = {
  result?: (input: ProviderRefreshInput) => ProviderRefreshResult
  error?: string
  delay?: () => Promise<void>
}
function fakePoeProvider(opts: FakePoeOpts = {}, calls?: ProviderRefreshInput[]): ProviderAdapter {
  return {
    type: "poe",
    async refresh(input) {
      calls?.push(input)
      if (opts.delay) await opts.delay()
      if (opts.error) throw new Error(opts.error)
      return opts.result?.(input) ?? {
        providerAccountId: input.providerAccountId, fetchedAt: NOW_ISO, staleAfter: STALE_AFTER_ISO,
        metrics: [balanceMetric(500_000)],
        historyEvents: [historyEvent("q1", 100)],
      }
    },
  }
}

function makeDeps(overrides: {
  storage?: DashboardStorage
  poe?: ProviderAdapter
  now?: () => Date
  staticDir?: string
  environment?: "development" | "production" | "test"
  trustedProxies?: string[]
  publicOrigin?: string
} = {}): AppDeps {
  const config = loadDashboardConfig(baseConfig())
  const storage = overrides.storage ?? makeStorage()
  const providers = new Map<"manual" | "poe", ProviderAdapter>([
    ["manual", createManualProvider()],
    ["poe", overrides.poe ?? fakePoeProvider()],
  ])
  return {
    config,
    storage,
    providers,
    sessionSecret: SESSION_SECRET,
    now: overrides.now ?? (() => new Date(NOW_MS)),
    ...(overrides.staticDir !== undefined ? { staticDir: overrides.staticDir } : {}),
    ...(overrides.environment !== undefined ? { environment: overrides.environment } : {}),
    ...(overrides.trustedProxies !== undefined ? { trustedProxies: overrides.trustedProxies } : {}),
    ...(overrides.publicOrigin !== undefined ? { publicOrigin: overrides.publicOrigin } : {}),
  }
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${VIEW_KEY}`, ...extra }
}

function extractCookie(setCookie: string): string {
  return setCookie.split(";")[0]!
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

// --- Route: GET /health ---

test("createApp with no deps still returns 200 {ok:true} for /health (scaffold compat)", async () => {
  const res = await createApp().request("/health")
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
})

test("/health returns 503 when injected storage healthCheck fails", async () => {
  const unhealthy: DashboardStorage = {
    ...makeStorage(),
    healthCheck: () => false,
  }
  const app = createApp(makeDeps({ storage: unhealthy }))
  const res = await app.request("/health")
  expect(res.status).toBe(503)
})

// --- Route: POST /api/session/:profileId ---

test("POST /api/session/self with JSON body sets HttpOnly cookie", async () => {
  const app = createApp(makeDeps())
  const res = await app.request("/api/session/self", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ viewKey: VIEW_KEY }),
  })
  expect(res.status).toBe(200)
  const setCookie = res.headers.get("set-cookie") ?? ""
  expect(setCookie).toContain("HttpOnly")
  expect(setCookie).toContain("sqd_session_self=")
})

test("POST /api/session/self rejects missing Content-Type when body auth is used", async () => {
  const app = createApp(makeDeps())
  const res = await app.request("/api/session/self", {
    method: "POST",
    headers: { Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ viewKey: VIEW_KEY }),
  })
  expect(res.status).toBe(400)
})

test("POST /api/session/self rejects non-JSON Content-Type when body auth is used", async () => {
  const app = createApp(makeDeps())
  const res = await app.request("/api/session/self", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: ALLOWED_ORIGIN },
    body: `viewKey=${VIEW_KEY}`,
  })
  expect(res.status).toBe(400)
})

test("POST /api/session/self rejects a disallowed Origin header", async () => {
  const app = createApp(makeDeps())
  const res = await app.request("/api/session/self", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
    body: JSON.stringify({ viewKey: VIEW_KEY }),
  })
  expect(res.status).toBe(403)
})

test("POST /api/session/self accepts Authorization: Bearer without a request body", async () => {
  const app = createApp(makeDeps())
  const res = await app.request("/api/session/self", {
    method: "POST",
    headers: { Authorization: `Bearer ${VIEW_KEY}`, Origin: ALLOWED_ORIGIN },
  })
  expect(res.status).toBe(200)
  expect(res.headers.get("set-cookie")).toContain("sqd_session_self=")
})

// --- Route: GET /api/dashboard/:profileId ---

test("GET /api/dashboard/self with a viewKey query parameter returns 401", async () => {
  const app = createApp(makeDeps())
  const res = await app.request("/api/dashboard/self?viewKey=" + VIEW_KEY, {
    headers: authHeaders(),
  })
  expect(res.status).toBe(401)
})

test("GET /api/dashboard/self with cookie returns profile payload", async () => {
  const app = createApp(makeDeps())
  const session = await app.request("/api/session/self", {
    method: "POST",
    headers: { Authorization: `Bearer ${VIEW_KEY}`, Origin: ALLOWED_ORIGIN },
  })
  const cookie = extractCookie(session.headers.get("set-cookie")!)
  const res = await app.request("/api/dashboard/self", { headers: { Cookie: cookie } })
  expect(res.status).toBe(200)
  const body = await res.json() as { profile: { id: string } }
  expect(body.profile.id).toBe("self")
})

test("GET /api/dashboard/self accepts Authorization: Bearer without query secrets", async () => {
  const app = createApp(makeDeps())
  const res = await app.request("/api/dashboard/self", { headers: authHeaders() })
  expect(res.status).toBe(200)
})

test("GET /api/dashboard/self?range=bad returns 400 with a safe error body", async () => {
  const app = createApp(makeDeps())
  const res = await app.request("/api/dashboard/self?range=bad", { headers: authHeaders() })
  expect(res.status).toBe(400)
  const body = await res.json() as Record<string, unknown>
  expect(body.error).toBeDefined()
})

test("GET /api/dashboard/self reads storage and never calls provider adapters", async () => {
  const calls: ProviderRefreshInput[] = []
  const app = createApp(makeDeps({ poe: fakePoeProvider({}, calls) }))
  await app.request("/api/dashboard/self", { headers: authHeaders() })
  expect(calls).toHaveLength(0)
})

// --- Route: POST /api/dashboard/:profileId/refresh ---

test("POST /api/dashboard/self/refresh validates Origin", async () => {
  const app = createApp(makeDeps())
  const res = await app.request("/api/dashboard/self/refresh", {
    method: "POST",
    headers: { ...authHeaders(), Origin: "http://evil.example" },
  })
  expect(res.status).toBe(403)
})

test("POST /api/dashboard/self/refresh joins an existing singleflight without a second provider call", async () => {
  const calls: ProviderRefreshInput[] = []
  let release: () => void = () => {}
  const block = new Promise<void>((r) => { release = r })
  const app = createApp(makeDeps({ poe: fakePoeProvider({ delay: () => block }, calls) }))
  const a = app.request("/api/dashboard/self/refresh", { method: "POST", headers: { ...authHeaders(), Origin: ALLOWED_ORIGIN } })
  const b = app.request("/api/dashboard/self/refresh", { method: "POST", headers: { ...authHeaders(), Origin: ALLOWED_ORIGIN } })
  await flush()
  await flush()
  release()
  const [aRes, bRes] = await Promise.all([a, b])
  expect(aRes.status).toBe(200)
  expect(bRes.status).toBe(200)
  expect(calls).toHaveLength(1)
})

test("POST /api/dashboard/self/refresh returns 429 on the second new refresh within 30 seconds", async () => {
  const app = createApp(makeDeps())
  const first = await app.request("/api/dashboard/self/refresh", {
    method: "POST", headers: { ...authHeaders(), Origin: ALLOWED_ORIGIN },
  })
  expect(first.status).toBe(200)
  const second = await app.request("/api/dashboard/self/refresh", {
    method: "POST", headers: { ...authHeaders(), Origin: ALLOWED_ORIGIN },
  })
  expect(second.status).toBe(429)
})

test("POST /api/dashboard/self/refresh returns stale cache with a safe provider error when refresh fails after cache exists", async () => {
  const storage = makeStorage()
  storage.providerCache.upsert({
    providerAccountId: "poe-main",
    fetchedAt: "2026-06-25T11:00:00.000Z",
    staleAfter: "2026-06-25T11:05:00.000Z",
    status: "stale",
    normalized: { metrics: [balanceMetric(300)] },
    errors: [],
  })
  const app = createApp(makeDeps({ storage, poe: fakePoeProvider({ error: "Poe is down" }) }))
  const res = await app.request("/api/dashboard/self/refresh", {
    method: "POST", headers: { ...authHeaders(), Origin: ALLOWED_ORIGIN },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { subscriptions: Array<{ metrics: Array<{ remaining?: number }> }> }
  expect(body.subscriptions[0]?.metrics[0]?.remaining).toBe(300)
})

test("POST /api/dashboard/self/refresh?range=7d returns a 7d payload (range is honored)", async () => {
  const app = createApp(makeDeps())
  const res = await app.request("/api/dashboard/self/refresh?range=7d", {
    method: "POST", headers: { ...authHeaders(), Origin: ALLOWED_ORIGIN },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { selectedRange: string }
  expect(body.selectedRange).toBe("7d")
})

test("POST /api/dashboard/self/refresh?range=bad returns 400", async () => {
  const app = createApp(makeDeps())
  const res = await app.request("/api/dashboard/self/refresh?range=bad", {
    method: "POST", headers: { ...authHeaders(), Origin: ALLOWED_ORIGIN },
  })
  expect(res.status).toBe(400)
})

// --- Cache-Control: no-store on all API responses ---

test("all API responses include Cache-Control: no-store", async () => {
  const app = createApp(makeDeps())
  const health = await app.request("/health")
  expect(health.headers.get("cache-control")).toBe("no-store")
  const dash = await app.request("/api/dashboard/self", { headers: authHeaders() })
  expect(dash.headers.get("cache-control")).toBe("no-store")
})

// --- SPA fallback (production static mode) ---

test("/d/self and /d/self?range=24h return the Vite HTML shell in production static mode", async () => {
  const staticDir = mkdtempSync(join(tmpdir(), "sqd-spa-"))
  writeFileSync(join(staticDir, "index.html"), "<!DOCTYPE html><div id=\"root\">vite-shell</div>")
  const app = createApp(makeDeps({ staticDir, environment: "production" }))
  const a = await app.request("/d/self")
  expect(a.status).toBe(200)
  expect(await a.text()).toContain("vite-shell")
  const b = await app.request("/d/self?range=24h")
  expect(b.status).toBe(200)
  expect(await b.text()).toContain("vite-shell")
})

test("/d/self/extra/deep returns the Vite HTML shell; /api/*, /health, /assets/* do not fall through", async () => {
  const staticDir = mkdtempSync(join(tmpdir(), "sqd-spa2-"))
  writeFileSync(join(staticDir, "index.html"), "<!DOCTYPE html><div id=\"root\">vite-shell</div>")
  const app = createApp(makeDeps({ staticDir, environment: "production" }))
  const deep = await app.request("/d/self/extra/deep")
  expect(deep.status).toBe(200)
  expect(await deep.text()).toContain("vite-shell")

  const api = await app.request("/api/dashboard/self", { headers: authHeaders() })
  expect(await api.text()).not.toContain("vite-shell")

  const health = await app.request("/health")
  expect(await health.text()).not.toContain("vite-shell")

  const asset = await app.request("/assets/missing.js")
  expect(asset.status).toBe(404)
  expect(await asset.text()).not.toContain("vite-shell")
})

// --- E2E flow ---

test("E2E: refresh writes cache/history/snapshots, then GET returns points, range stats, summary, no secrets", async () => {
  const app = createApp(makeDeps())
  await app.request("/api/dashboard/self/refresh", {
    method: "POST", headers: { ...authHeaders(), Origin: ALLOWED_ORIGIN },
  })
  const res = await app.request("/api/dashboard/self", { headers: authHeaders() })
  expect(res.status).toBe(200)
  const body = await res.json() as {
    subscriptions: Array<{ id: string; metrics: Array<{ remaining?: number; rangeStats?: { consumption?: number } }> }>
    summaryGroups: unknown[]
  }
  // API points present.
  const poeSub = body.subscriptions.find((s) => s.id === "poe-api")
  expect(poeSub?.metrics[0]?.remaining).toBe(500_000)
  // Range stats from provider history.
  expect(poeSub?.metrics[0]?.rangeStats?.consumption).toBe(100)
  // Summary group present.
  expect(body.summaryGroups.length).toBeGreaterThan(0)
  // No secrets leaked.
  const raw = JSON.stringify(body)
  expect(raw).not.toContain(VIEW_KEY)
  expect(raw).not.toContain("poe-key")
  expect(raw).not.toContain(SESSION_SECRET)
})

// --- P1.2: Production Origin check allows same-origin ---

test("P1.2: production same-origin POST is allowed (not 403)", async () => {
  const app = createApp(makeDeps({ environment: "production" }))
  // In production, Origin matches the request URL origin.
  // app.request uses http://localhost by default.
  const res = await app.request("/api/dashboard/self/refresh", {
    method: "POST",
    headers: { ...authHeaders(), Origin: "http://localhost" },
  })
  // Should NOT be 403 - same-origin is allowed in production.
  expect(res.status).not.toBe(403)
})

test("P1.2: production cross-origin POST is rejected (403)", async () => {
  const app = createApp(makeDeps({ environment: "production" }))
  const res = await app.request("/api/dashboard/self/refresh", {
    method: "POST",
    headers: { ...authHeaders(), Origin: "https://evil.example.com" },
  })
  expect(res.status).toBe(403)
})

test("P1.2: dev mode allows Vite origin", async () => {
  const app = createApp(makeDeps({ environment: "development" }))
  const res = await app.request("/api/dashboard/self/refresh", {
    method: "POST",
    headers: { ...authHeaders(), Origin: "http://localhost:5173" },
  })
  expect(res.status).not.toBe(403)
})

test("P1.2: production with PUBLIC_ORIGIN allows matching HTTPS origin", async () => {
  const app = createApp(makeDeps({ environment: "production", publicOrigin: "https://dashboard.example.com" }))
  const res = await app.request("/api/dashboard/self/refresh", {
    method: "POST",
    headers: { ...authHeaders(), Origin: "https://dashboard.example.com" },
  })
  expect(res.status).not.toBe(403)
})

test("P1.2: production with PUBLIC_ORIGIN rejects non-matching origin", async () => {
  const app = createApp(makeDeps({ environment: "production", publicOrigin: "https://dashboard.example.com" }))
  const res = await app.request("/api/dashboard/self/refresh", {
    method: "POST",
    headers: { ...authHeaders(), Origin: "http://localhost" },
  })
  expect(res.status).toBe(403)
})

// --- P2.1: Login rate limiting ---

test("P2.1: 6th login attempt within 5min returns 429", async () => {
  const app = createApp(makeDeps())
  // Make 5 failed attempts (they consume rate-limit tokens).
  for (let i = 0; i < 5; i++) {
    const res = await app.request("/api/session/self", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ viewKey: "wrong" }),
    })
    expect(res.status).toBe(401)
  }
  // 6th attempt should be rate-limited.
  const res = await app.request("/api/session/self", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ viewKey: "wrong" }),
  })
  expect(res.status).toBe(429)
  expect(res.headers.get("Retry-After")).toBeTruthy()
})

test("P2.1: successful login resets rate-limit bucket", async () => {
  const app = createApp(makeDeps())
  // 4 failed attempts.
  for (let i = 0; i < 4; i++) {
    await app.request("/api/session/self", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ viewKey: "wrong" }),
    })
  }
  // 5th: successful login.
  const ok = await app.request("/api/session/self", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ viewKey: VIEW_KEY }),
  })
  expect(ok.status).toBe(200)
  // After success, bucket is reset: 5 more attempts should work.
  for (let i = 0; i < 5; i++) {
    const res = await app.request("/api/session/self", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ viewKey: "wrong" }),
    })
    expect(res.status).toBe(401)
  }
})

test("P2.1: oversized login body returns 413", async () => {
  const app = createApp(makeDeps())
  // Build a body > 4KB.
  const big = "x".repeat(5000)
  const res = await app.request("/api/session/self", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(big.length + 20),
      Origin: ALLOWED_ORIGIN,
    },
    body: JSON.stringify({ viewKey: big }),
  })
  expect(res.status).toBe(413)
})
