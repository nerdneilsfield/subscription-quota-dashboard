import type { LimitWindow, MetricConfig } from "../../shared/domain"
import { silentLogger, type Logger } from "../logging/logger"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"

const OPENCODE_ORIGIN = "https://opencode.ai"
// SolidStart server-function ID used by the current OpenCode Go quota query.
// Calling the server function directly avoids the workspace page loader, which
// performs an unrelated `user.time_seen` write and can fail with a 500 when
// OpenCode's PlanetScale transaction pool is exhausted.
const LITE_SUBSCRIPTION_SERVER_ID = "c7389bd0e731f80f49593e5ee53835475f4e28594dd6bd83eb229bab753498cd"
const REQUEST_TIMEOUT_MS = 15_000
const MAX_REQUEST_ATTEMPTS = 4
const RETRY_DELAYS_MS = [500, 1_500, 3_000]

type UsageWindow = {
  status: string
  resetInSec: number
  usagePercent: number
}

export type OpenCodeGoUsage = {
  useBalance: boolean
  rollingUsage: UsageWindow
  weeklyUsage: UsageWindow
  monthlyUsage: UsageWindow
}

export function createOpenCodeGoProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "opencode-go",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const logger = (input.logger ?? silentLogger).child({ component: "provider.opencode_go" })
      const base = makeBase(input)
      const workspaceId = input.runtime.workspaceId
      const authCookie = input.runtime.authCookie
      if (!workspaceId || !authCookie) {
        logger.error("opencode_go.configuration.invalid", { reason: "workspace_or_cookie_missing" })
        return { ...base, errors: [{ message: "OpenCode Go unavailable: workspace ID or auth cookie not configured", retryable: false }] }
      }

      const url = makeSubscriptionUrl(workspaceId)
      logger.info("opencode_go.refresh.started", { workspaceId, metricCount: input.metrics.length })
      let response: Response
      try {
        response = await requestPage(fetchImpl, url, authCookie, logger)
      } catch (error) {
        logger.error("opencode_go.request.exhausted", { attempts: MAX_REQUEST_ATTEMPTS, error })
        return { ...base, errors: [{ message: `OpenCode Go request failed after ${MAX_REQUEST_ATTEMPTS} attempts`, retryable: true }] }
      }

      if (response.status === 401 || response.status === 403 || isAuthRedirect(response)) {
        logger.error("opencode_go.authentication.failed", { status: response.status })
        return { ...base, errors: [{ message: "OpenCode Go authentication expired; replace OPENCODE_AUTH_COOKIE", retryable: false }] }
      }
      if (!response.ok) {
        logger.error("opencode_go.request.failed", { status: response.status })
        return { ...base, errors: [{ message: `OpenCode Go request failed (${response.status})`, retryable: response.status >= 500 || response.status === 429 }] }
      }

      const html = await response.text()
      const usage = parseOpenCodeGoUsage(html, workspaceId)
      if (!usage) {
        const hasQuery = html.includes("lite.subscription.get")
        logger.error("opencode_go.payload.invalid", { bytes: html.length, hasLiteSubscriptionQuery: hasQuery })
        return {
          ...base,
          errors: [{
            message: hasQuery ? "OpenCode Go subscription not found or response format changed" : "OpenCode Go authenticated payload missing",
            retryable: false,
          }],
        }
      }

      const metrics = mapUsage(usage, input.metrics, input.now)
      logger.info("opencode_go.refresh.completed", {
        metricCount: metrics.length,
        metricIds: metrics.map((metric) => metric.providerMetricId),
        useBalance: usage.useBalance,
      })
      return { ...base, metrics }
    },
  }
}

function makeBase(input: ProviderRefreshInput): ProviderRefreshResult {
  return {
    providerAccountId: input.providerAccountId,
    fetchedAt: input.now,
    staleAfter: new Date(Date.parse(input.now) + 10 * 60 * 1000).toISOString(),
    metrics: [],
  }
}

async function requestPage(fetchImpl: typeof fetch, url: string, authCookie: string, logger: Logger): Promise<Response> {
  const cookie = authCookie.startsWith("auth=") ? authCookie : `auth=${authCookie}`
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      logger.debug("opencode_go.request.started", { attempt, maxAttempts: MAX_REQUEST_ATTEMPTS })
      const response = await fetchImpl(url, {
        headers: {
          Accept: "text/javascript,application/json,text/plain,*/*",
          Cookie: cookie,
          "X-Server-Id": LITE_SUBSCRIPTION_SERVER_ID,
          "X-Server-Instance": `quota-dashboard:${Date.now()}:${attempt}`,
          "User-Agent": "subscription-quota-dashboard/0.1",
        },
        redirect: "manual",
        signal: controller.signal,
      })
      logger.debug("opencode_go.request.completed", { attempt, status: response.status })
      if (response.status !== 429 && response.status < 500) return response
      if (attempt === MAX_REQUEST_ATTEMPTS) return response
      logger.warn("opencode_go.request.retrying", { attempt, status: response.status, nextDelayMs: RETRY_DELAYS_MS[attempt - 1] })
    } catch (error) {
      lastError = error
      if (attempt === MAX_REQUEST_ATTEMPTS) throw error
      logger.warn("opencode_go.request.retrying", { attempt, reason: error instanceof Error ? error.name : "network_error", nextDelayMs: RETRY_DELAYS_MS[attempt - 1] })
    } finally {
      clearTimeout(timer)
    }
    await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 0)
  }
  throw lastError ?? new Error("OpenCode Go request exhausted")
}

function isAuthRedirect(response: Response): boolean {
  if (response.status < 300 || response.status >= 400) return false
  const location = response.headers.get("location") ?? ""
  return location.includes("/auth/") || location.includes("auth.opencode.ai")
}

export function parseOpenCodeGoUsage(html: string, workspaceId?: string): OpenCodeGoUsage | undefined {
  const queryAt = workspaceId
    ? html.indexOf(`lite.subscription.get[\\"${workspaceId}\\"]`)
    : html.indexOf("lite.subscription.get")
  // The authenticated page embeds the value in SSR HTML. The direct
  // SolidStart server function returns only a Seroval stream, with no query key.
  const payload = queryAt >= 0
    ? html.slice(queryAt, html.indexOf("</script>", queryAt) < 0 ? undefined : html.indexOf("</script>", queryAt))
    : html
  const rollingUsage = parseUsageWindow(payload, "rollingUsage")
  const weeklyUsage = parseUsageWindow(payload, "weeklyUsage")
  const monthlyUsage = parseUsageWindow(payload, "monthlyUsage")
  if (!rollingUsage || !weeklyUsage || !monthlyUsage) return undefined
  return {
    useBalance: /useBalance:!0/.test(payload),
    rollingUsage,
    weeklyUsage,
    monthlyUsage,
  }
}

function makeSubscriptionUrl(workspaceId: string): string {
  const url = new URL("/_server", OPENCODE_ORIGIN)
  url.searchParams.set("id", LITE_SUBSCRIPTION_SERVER_ID)
  url.searchParams.set("args", JSON.stringify([workspaceId]))
  return url.toString()
}

function parseUsageWindow(payload: string, name: string): UsageWindow | undefined {
  const block = new RegExp(`${name}:\\$R\\[\\d+\\]=\\{([^{}]+)\\}`).exec(payload)?.[1]
  if (!block) return undefined
  const status = /status:"([^"]+)"/.exec(block)?.[1]
  const resetInSec = parseFiniteField(block, "resetInSec")
  const usagePercent = parseFiniteField(block, "usagePercent")
  if (!status || resetInSec === undefined || usagePercent === undefined) return undefined
  return { status, resetInSec, usagePercent }
}

function parseFiniteField(block: string, name: string): number | undefined {
  const raw = new RegExp(`${name}:(-?\\d+(?:\\.\\d+)?)`).exec(block)?.[1]
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function mapUsage(usage: OpenCodeGoUsage, configured: MetricConfig[], now: string): NormalizedMetric[] {
  const definitions = [
    { id: "go:five_hour", label: "5h quota", value: usage.rollingUsage, window: rollingWindow("5h", usage.rollingUsage, now) },
    { id: "go:weekly", label: "Weekly quota", value: usage.weeklyUsage, window: calendarWindow("week", usage.weeklyUsage, now) },
    { id: "go:monthly", label: "Monthly quota", value: usage.monthlyUsage, window: calendarWindow("month", usage.monthlyUsage, now) },
  ] as const
  const wanted = new Set(configured.map((metric) => metric.providerMetricId ?? metric.id))
  return definitions.filter((definition) => wanted.has(definition.id)).map((definition) => {
    const used = clampPercent(definition.value.usagePercent)
    return {
      providerMetricId: definition.id,
      label: definition.label,
      unit: "%",
      limit: 100,
      used,
      remaining: 100 - used,
      authoritativeValue: used,
      sourceValueKind: "gauge-used",
      window: definition.window,
      suggestedDisplayModule: "period-quota-card",
      sourceConfidence: "known",
      notes: `OpenCode Go${usage.useBalance ? " · balance fallback enabled" : ""}${definition.value.status === "rate-limited" ? " · rate limited" : ""}`,
      updatedAt: now,
    }
  })
}

function rollingWindow(duration: string, value: UsageWindow, now: string): LimitWindow {
  return { kind: "rolling", duration, resetAt: resetAt(value, now) }
}

function calendarWindow(period: "week" | "month", value: UsageWindow, now: string): LimitWindow {
  return { kind: "calendar", period, timezone: "UTC", resetAt: resetAt(value, now) }
}

function resetAt(value: UsageWindow, now: string): string {
  return new Date(Date.parse(now) + Math.max(0, value.resetInSec) * 1000).toISOString()
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
