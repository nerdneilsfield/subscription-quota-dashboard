import { Hono, type Context } from "hono"
import { readFileSync, existsSync } from "node:fs"
import { join, extname } from "node:path"
import type { NormalizedConfig } from "../../shared/domain"
import type { RangeKey } from "../../shared/domain"
import type { DashboardStorage } from "../storage/repositories"
import type { ProviderAdapter } from "../providers/types"
import {
  createSessionCookie,
  sessionCookieName,
  verifySessionCookie,
  verifyViewKey,
} from "../auth/session"
import { createRateLimiter } from "../auth/rate-limit"
import {
  apiNoStoreHeaders,
  appSecurityHeaders,
  isAllowedDevCorsOrigin,
} from "./security"
import { createRefreshService } from "../refresh/refresh-service"

export type AppDeps = {
  config: NormalizedConfig
  storage: DashboardStorage
  providers: Map<"manual" | "poe", ProviderAdapter>
  sessionSecret: string
  now?: () => Date
  staticDir?: string
  environment?: "development" | "production" | "test"
}

const VALID_RANGES: ReadonlySet<string> = new Set(["1h", "24h", "7d", "30d"])
const DEFAULT_RANGE: RangeKey = "24h"
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
}

function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false
  return header.toLowerCase().includes("application/json")
}

function bearerViewKey(authHeader: string | undefined): string | undefined {
  if (authHeader === undefined) return undefined
  const trimmed = authHeader.trim()
  if (!trimmed.toLowerCase().startsWith("bearer ")) return undefined
  return trimmed.slice(7).trim() || undefined
}

function findCookiePair(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const pair = part.trim()
    if (pair.startsWith(name + "=")) return pair
  }
  return undefined
}

function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true
  return isAllowedDevCorsOrigin(origin)
}

export function createApp(deps?: AppDeps): Hono {
  const app = new Hono()

  app.use("*", async (c, next) => {
    await next()
    for (const [k, v] of Object.entries(appSecurityHeaders())) c.header(k, v)
  })

  // --- GET /health ---
  app.get("/health", (c) => {
    if (deps?.storage) {
      if (!deps.storage.healthCheck()) {
        return c.json({ ok: false }, 503, apiNoStoreHeaders())
      }
    }
    return c.json({ ok: true }, 200, apiNoStoreHeaders())
  })

  if (deps === undefined) return app

  const now = deps.now ?? (() => new Date())
  const nowMs = (): number => now().getTime()
  const secure = deps.environment === "production"

  const refreshService = createRefreshService({
    config: deps.config,
    storage: deps.storage,
    providers: deps.providers,
    now,
    rateLimiter: createRateLimiter({
      maxAttempts: 1,
      windowMs: 30_000,
      now: nowMs,
    }),
  })

  // Cache-Control: no-store on all API responses.
  app.use("/api/*", async (c, next) => {
    await next()
    c.header("Cache-Control", "no-store")
  })

  // Helper: authenticate a request against a profile (cookie OR bearer).
  function authenticate(c: Context, profileId: string): Response | null {
    const profile = deps!.config.profiles.get(profileId)
    if (!profile) return unauthorized()
    // Reject viewKey query parameter on any authenticated route.
    const url = new URL(c.req.url)
    if (url.searchParams.get("viewKey") !== null) return unauthorized()

    const bearer = bearerViewKey(c.req.header("authorization"))
    if (bearer !== undefined) {
      if (verifyViewKey(profile, bearer)) return null
      return unauthorized()
    }
    const cookieName = sessionCookieName(profile.id)
    const cookieHeader = c.req.header("cookie") ?? ""
    const pair = findCookiePair(cookieHeader, cookieName)
    if (pair !== undefined) {
      if (verifySessionCookie(pair, profile, deps!.sessionSecret, nowMs())) return null
    }
    return unauthorized()
  }

  function unauthorized(): Response {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    })
  }

  // --- POST /api/session/:profileId ---
  app.post("/api/session/:profileId", async (c) => {
    const profileId = c.req.param("profileId")
    const profile = deps!.config.profiles.get(profileId)
    if (!profile) return c.json({ error: "unauthorized" }, 401)

    const origin = c.req.header("origin")
    if (!originAllowed(origin)) return c.json({ error: "forbidden" }, 403)

    let viewKey: string | undefined
    const authHeader = c.req.header("authorization")
    const bearer = bearerViewKey(authHeader)
    if (bearer !== undefined) {
      viewKey = bearer
    } else {
      // Body auth: require JSON Content-Type.
      if (!isJsonContentType(c.req.header("content-type"))) {
        return c.json({ error: "content-type must be application/json" }, 400)
      }
      try {
        const body = (await c.req.json()) as { viewKey?: unknown }
        if (typeof body.viewKey === "string") viewKey = body.viewKey
      } catch {
        return c.json({ error: "invalid json body" }, 400)
      }
    }

    if (!viewKey || !verifyViewKey(profile, viewKey)) {
      return c.json({ error: "unauthorized" }, 401)
    }

    const cookie = createSessionCookie(profile.id, viewKey, deps!.sessionSecret, nowMs(), SESSION_MAX_AGE_SECONDS, secure)
    c.header("set-cookie", cookie)
    return c.json({ ok: true }, 200)
  })

  // --- GET /api/dashboard/:profileId ---
  app.get("/api/dashboard/:profileId", (c) => {
    const profileId = c.req.param("profileId")
    const authFail = authenticate(c, profileId)
    if (authFail !== null) return authFail

    const url = new URL(c.req.url)
    const rangeParam = url.searchParams.get("range")
    let range: RangeKey = DEFAULT_RANGE
    if (rangeParam !== null) {
      if (!VALID_RANGES.has(rangeParam)) {
        return c.json({ error: "invalid range" }, 400)
      }
      range = rangeParam as RangeKey
    }

    const payload = refreshService.getPayload(profileId, range)
    return c.json(payload, 200)
  })

  // --- POST /api/dashboard/:profileId/refresh ---
  app.post("/api/dashboard/:profileId/refresh", async (c) => {
    const profileId = c.req.param("profileId")

    const origin = c.req.header("origin")
    if (!originAllowed(origin)) return c.json({ error: "forbidden" }, 403)

    const authFail = authenticate(c, profileId)
    if (authFail !== null) return authFail

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
    const outcome = await refreshService.refreshProfile({ profileId, ip })

    switch (outcome.status) {
      case "ok":
        return c.json(outcome.payload, 200)
      case "degraded":
        c.header("X-Refresh-Warning", outcome.error)
        return c.json(outcome.payload, 200)
      case "rate_limited":
        return c.json({ error: "rate_limited" }, 429)
      case "fatal":
        return c.json({ error: "refresh_failed" }, 502)
    }
  })

  // --- Static assets (production) ---
  if (deps.staticDir !== undefined) {
    app.get("/assets/*", (c) => {
      const url = new URL(c.req.url)
      const rel = url.pathname
      const filePath = join(deps.staticDir!, rel)
      if (!existsSync(filePath)) return c.notFound()
      const body = readFileSync(filePath)
      const ct = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream"
      return new Response(body, { headers: { "content-type": ct } })
    })

    // SPA fallback ONLY for /d/:profileId and /d/:profileId/*.
    app.get("/d/:profileId", (c) => serveSpaShell(c, deps.staticDir!))
    app.get("/d/:profileId/*", (c) => serveSpaShell(c, deps.staticDir!))
  }

  return app
}

function serveSpaShell(c: Context, staticDir: string): Response {
  void c
  const indexPath = join(staticDir, "index.html")
  if (!existsSync(indexPath)) return new Response("not found", { status: 404 })
  const body = readFileSync(indexPath)
  return new Response(body, { headers: { "content-type": "text/html" } })
}
