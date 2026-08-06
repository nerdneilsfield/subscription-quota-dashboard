import { Hono, type Context } from "hono"
import { getConnInfo } from "@hono/node-server/conninfo"
import { bodyLimit } from "hono/body-limit"
import { readFileSync, existsSync } from "node:fs"
import { join, extname } from "node:path"
import { randomUUID } from "node:crypto"
import type { NormalizedConfig } from "../../shared/domain"
import type { RangeKey } from "../../shared/domain"
import type { DashboardStorage } from "../storage/repositories"
import type { ProviderAdapter } from "../providers/types"
import {
  clearSessionCookie,
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
import { resolveClientIp } from "./client-ip"
import { createRefreshService, type RefreshService } from "../refresh/refresh-service"
import { silentLogger, type Logger } from "../logging/logger"

type AppVariables = {
  loginRateLimitKey: string
  requestId: string
  requestLogger: Logger
}

export type AppDeps = {
  config: NormalizedConfig
  storage: DashboardStorage
  providers: Map<string, ProviderAdapter>
  sessionSecret: string
  now?: () => Date
  staticDir?: string
  environment?: "development" | "production" | "test"
  trustedProxies?: string[]
  publicOrigin?: string
  logger?: Logger
  refreshService?: RefreshService
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

// Parse + validate the `?range=` query parameter shared by GET dashboard and
// POST refresh. Absent → default range; present-but-invalid → { ok: false }
// (caller returns 400). Mirrors behavior across both routes.
function resolveRangeParam(url: URL): { ok: true; range: RangeKey } | { ok: false } {
  const rangeParam = url.searchParams.get("range")
  if (rangeParam === null) return { ok: true, range: DEFAULT_RANGE }
  if (!VALID_RANGES.has(rangeParam)) return { ok: false }
  return { ok: true, range: rangeParam as RangeKey }
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

function originAllowed(origin: string | undefined, c: Context, isProduction: boolean, publicOrigin: string | undefined, allowDevCors: boolean): boolean {
  if (origin === undefined || origin === "") return true
  // In production, allow same-origin requests.
  // PUBLIC_ORIGIN takes precedence (for HTTPS reverse proxy where c.req.url
  // is http:// but the browser sees https://).
  if (isProduction) {
    if (publicOrigin !== undefined) {
      if (origin === publicOrigin) return true
    } else {
      try {
        const reqOrigin = new URL(c.req.url).origin
        if (origin === reqOrigin) return true
      } catch {
        // fall through
      }
    }
    // In production, do NOT fall through to the dev CORS allowlist.
    // Only same-origin or PUBLIC_ORIGIN is allowed.
    return false
  }
  // In development, allow Vite dev server origins.
  if (allowDevCors) return isAllowedDevCorsOrigin(origin)
  return false
}

export function createApp(deps?: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>()
  const logger = deps?.logger ?? silentLogger
  const trustedProxies = new Set(deps?.trustedProxies ?? [])

  function clientIp(c: Context): string {
    const xff = c.req.header("x-forwarded-for")
    let socketIp: string | undefined
    try {
      socketIp = getConnInfo(c).remote.address
    } catch {
      socketIp = undefined
    }
    return resolveClientIp(socketIp, xff, trustedProxies)
  }

  app.use("*", async (c, next) => {
    const suppliedRequestId = c.req.header("x-request-id")?.trim()
    const requestId = suppliedRequestId && suppliedRequestId.length <= 128 ? suppliedRequestId : randomUUID()
    const requestLogger = logger.child({ component: "http", requestId })
    const startedAt = performance.now()
    c.set("requestId", requestId)
    c.set("requestLogger", requestLogger)
    c.header("X-Request-Id", requestId)
    requestLogger.debug("http.request.received", {
      method: c.req.method,
      path: c.req.path,
      queryKeys: [...new URL(c.req.url).searchParams.keys()],
      origin: c.req.header("origin"),
      userAgent: c.req.header("user-agent"),
      ip: clientIp(c),
    })
    try {
      await next()
    } catch (error) {
      requestLogger.error("http.request.unhandled_error", { method: c.req.method, path: c.req.path, error })
      throw error
    } finally {
      const fields = {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      }
      if (c.res.status >= 500) requestLogger.error("http.request.completed", fields)
      else if (c.res.status >= 400) requestLogger.warn("http.request.completed", fields)
      else requestLogger.info("http.request.completed", fields)
    }
  })

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
  const publicOrigin = deps.publicOrigin
  const loginRateLimiter = createRateLimiter({
    maxAttempts: 5,
    windowMs: 5 * 60 * 1000,
    now: nowMs,
  })

  const refreshService = deps.refreshService ?? createRefreshService({
    config: deps.config,
    storage: deps.storage,
    providers: deps.providers,
    now,
    logger,
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
    const requestLogger = c.get("requestLogger") as Logger
    const profile = deps!.config.profiles.get(profileId)
    if (!profile) {
      requestLogger.warn("auth.request.denied", { profileId, reason: "unknown_profile" })
      return unauthorized()
    }
    // Reject viewKey query parameter on any authenticated route.
    const url = new URL(c.req.url)
    if (url.searchParams.get("viewKey") !== null) {
      requestLogger.warn("auth.request.denied", { profileId, reason: "view_key_in_query" })
      return unauthorized()
    }

    const bearer = bearerViewKey(c.req.header("authorization"))
    if (bearer !== undefined) {
      if (verifyViewKey(profile, bearer)) {
        requestLogger.debug("auth.request.accepted", { profileId, mechanism: "bearer" })
        return null
      }
      requestLogger.warn("auth.request.denied", { profileId, reason: "invalid_bearer" })
      return unauthorized()
    }
    const cookieName = sessionCookieName(profile.id)
    const cookieHeader = c.req.header("cookie") ?? ""
    const pair = findCookiePair(cookieHeader, cookieName)
    if (pair !== undefined) {
      if (verifySessionCookie(pair, profile, deps!.sessionSecret, nowMs())) {
        requestLogger.debug("auth.request.accepted", { profileId, mechanism: "session_cookie" })
        return null
      }
      requestLogger.warn("auth.request.denied", { profileId, reason: "invalid_or_expired_cookie" })
      return unauthorized()
    }
    requestLogger.warn("auth.request.denied", { profileId, reason: "missing_credentials" })
    return unauthorized()
  }

  function unauthorized(): Response {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    })
  }

  // --- POST /api/session/:profileId ---
  // Order: profileId validation + Origin check + IP rate-limit FIRST (cheap,
  // no body read), then bodyLimit + auth. This prevents slowloris-style attacks
  // and limits Map key cardinality to known profiles only.
  app.post(
    "/api/session/:profileId",
    async (c, next) => {
      // Validate profileId exists BEFORE rate-limiting to prevent unbounded
      // Map key growth from arbitrary path segments.
      const profileId = c.req.param("profileId")
      if (!deps!.config.profiles.has(profileId)) {
        c.get("requestLogger").warn("auth.login.denied", { profileId, reason: "unknown_profile" })
        return c.json({ error: "unauthorized" }, 401)
      }
      // Origin check
      const origin = c.req.header("origin")
      if (!originAllowed(origin, c, secure, publicOrigin, !secure)) {
        c.get("requestLogger").warn("auth.login.denied", { profileId, reason: "origin_rejected", origin })
        return c.json({ error: "forbidden" }, 403)
      }
      // IP rate-limit check (before body parsing)
      const ip = clientIp(c)
      const rateLimitKey = `login:${ip}:${profileId}`
      if (!loginRateLimiter.peek(rateLimitKey)) {
        c.get("requestLogger").warn("auth.login.rate_limited", { profileId, ip })
        c.header("Retry-After", String(5 * 60))
        return c.json({ error: "rate_limited" }, 429)
      }
      c.set("loginRateLimitKey", rateLimitKey)
      await next()
    },
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ error: "request body too large" }, 413),
    }),
    async (c) => {
    const profileId = c.req.param("profileId")
    const profile = deps!.config.profiles.get(profileId)
    // Profile was already validated in the middleware above, but TypeScript
    // doesn't know that. Re-check is a no-op in practice.
    if (!profile) return c.json({ error: "unauthorized" }, 401)

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
      // Record failure against rate limiter (overflow-safe: only records on
      // the resolved bucket, never clears it on success).
      const rateLimitKey = c.get("loginRateLimitKey") as string | undefined
      if (rateLimitKey) loginRateLimiter.recordFailure(rateLimitKey)
      c.get("requestLogger").warn("auth.login.failed", {
        profileId,
        mechanism: bearer !== undefined ? "bearer" : "json_body",
        reason: viewKey ? "invalid_view_key" : "missing_view_key",
      })
      return c.json({ error: "unauthorized" }, 401)
    }

    // Successful login: reset the rate-limit bucket so the user isn't penalized.
    const rateLimitKey = c.get("loginRateLimitKey") as string | undefined
    if (rateLimitKey) loginRateLimiter.reset(rateLimitKey)
    const cookie = createSessionCookie(profile.id, viewKey, deps!.sessionSecret, nowMs(), SESSION_MAX_AGE_SECONDS, secure)
    c.header("set-cookie", cookie)
    c.get("requestLogger").info("auth.login.succeeded", {
      profileId,
      mechanism: bearer !== undefined ? "bearer" : "json_body",
      secureCookie: secure,
    })
    return c.json({ ok: true }, 200)
    },
  )

  // --- POST /api/session/:profileId/logout ---
  app.post("/api/session/:profileId/logout", (c) => {
    const profileId = c.req.param("profileId")
    if (!deps!.config.profiles.has(profileId)) return c.json({ error: "not found" }, 404)
    const origin = c.req.header("origin")
    if (!originAllowed(origin, c, secure, publicOrigin, !secure)) {
      c.get("requestLogger").warn("auth.logout.denied", { profileId, reason: "origin_rejected", origin })
      return c.json({ error: "forbidden" }, 403)
    }
    c.header("set-cookie", clearSessionCookie(profileId, secure))
    c.get("requestLogger").info("auth.logout.succeeded", { profileId })
    return c.json({ ok: true }, 200)
  })

  // --- GET /api/dashboard/:profileId ---
  app.get("/api/dashboard/:profileId", (c) => {
    const profileId = c.req.param("profileId")
    const authFail = authenticate(c, profileId)
    if (authFail !== null) return authFail

    const parsed = resolveRangeParam(new URL(c.req.url))
    if (!parsed.ok) return c.json({ error: "invalid range" }, 400)

    const payload = refreshService.getPayload(profileId, parsed.range)
    c.get("requestLogger").debug("dashboard.payload.served", {
      profileId,
      range: parsed.range,
      subscriptionCount: payload.subscriptions.length,
    })
    return c.json(payload, 200)
  })

  // --- POST /api/dashboard/:profileId/refresh ---
  app.post("/api/dashboard/:profileId/refresh", async (c) => {
    const profileId = c.req.param("profileId")
    const requestLogger = c.get("requestLogger")

    const origin = c.req.header("origin")
    if (!originAllowed(origin, c, secure, publicOrigin, !secure)) {
      requestLogger.warn("refresh.http.denied", { profileId, reason: "origin_rejected", origin })
      return c.json({ error: "forbidden" }, 403)
    }

    const authFail = authenticate(c, profileId)
    if (authFail !== null) return authFail

    const parsed = resolveRangeParam(new URL(c.req.url))
    if (!parsed.ok) {
      requestLogger.warn("refresh.http.denied", { profileId, reason: "invalid_range" })
      return c.json({ error: "invalid range" }, 400)
    }

    const ip = clientIp(c)
    requestLogger.info("refresh.http.requested", { profileId, range: parsed.range, ip })
    const outcome = await refreshService.refreshProfile({ profileId, ip, range: parsed.range, requestId: c.get("requestId") })
    requestLogger.info("refresh.http.outcome", {
      profileId,
      range: parsed.range,
      status: outcome.status,
      ...(outcome.status === "degraded" || outcome.status === "fatal" ? { error: outcome.error } : {}),
      ...(outcome.status === "rate_limited" ? { providerAccountId: outcome.providerAccountId } : {}),
    })

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
