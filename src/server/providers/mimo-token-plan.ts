import type { LimitWindow, MetricConfig } from "../../shared/domain"
import { silentLogger, type Logger } from "../logging/logger"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"

const MIMO_API = "https://platform.xiaomimimo.com/api/v1/tokenPlan"
const REQUEST_TIMEOUT_MS = 15_000
const MAX_REQUEST_ATTEMPTS = 4
const RETRY_DELAYS_MS = [500, 1_500, 3_000]

type UsageItem = { name?: unknown; used?: unknown; limit?: unknown; percent?: unknown }
type UsageData = { monthUsage?: { percent?: unknown; items?: unknown }; usage?: { percent?: unknown; items?: unknown } }
type DetailData = {
  planCode?: unknown
  planName?: unknown
  currentPeriodEnd?: unknown
  expired?: unknown
  enableAutoRenew?: unknown
  hasAutoRenewSubscribed?: unknown
  clawEnabled?: unknown
}
type Envelope<T> = { code?: unknown; message?: unknown; data?: T }

export function createMiMoTokenPlanProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "mimo-token-plan",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const logger = (input.logger ?? silentLogger).child({ component: "provider.mimo_token_plan" })
      const base = makeBase(input)
      const cookie = input.runtime.authCookie
      if (!cookie) {
        logger.error("mimo_token_plan.configuration.invalid", { reason: "session_cookie_missing" })
        return { ...base, errors: [{ message: "MiMo Token Plan unavailable: session cookie not configured", retryable: false }] }
      }

      logger.info("mimo_token_plan.refresh.started", { metricCount: input.metrics.length })
      try {
        const [usageResponse, detailResponse] = await Promise.all([
          requestJson<UsageData>(fetchImpl, `${MIMO_API}/usage`, cookie, "usage", logger),
          requestJson<DetailData>(fetchImpl, `${MIMO_API}/detail`, cookie, "detail", logger),
        ])
        const authFailure = [usageResponse, detailResponse].find((result) => result.authFailed)
        if (authFailure) {
          logger.error("mimo_token_plan.authentication.failed", { endpoint: authFailure.endpoint, status: authFailure.status, code: authFailure.code })
          return { ...base, errors: [{ message: "MiMo Token Plan authentication expired; replace MIMO_SESSION_COOKIE", retryable: false }] }
        }
        const failure = [usageResponse, detailResponse].find((result) => result.error)
        if (failure) {
          logger.error("mimo_token_plan.request.failed", { endpoint: failure.endpoint, status: failure.status, code: failure.code, reason: failure.error })
          return { ...base, errors: [{ message: failure.error!, retryable: failure.retryable }] }
        }

        const metrics = mapMiMoUsage(usageResponse.data!, detailResponse.data!, input.metrics, input.now)
        if (metrics.length === 0) {
          logger.error("mimo_token_plan.payload.invalid", { reason: "plan_total_token_missing" })
          return { ...base, errors: [{ message: "MiMo Token Plan usage payload missing plan credits", retryable: false }] }
        }
        logger.info("mimo_token_plan.refresh.completed", {
          metricCount: metrics.length,
          metricIds: metrics.map((metric) => metric.providerMetricId),
          planName: stringValue(detailResponse.data?.planName),
          expired: detailResponse.data?.expired === true,
        })
        return { ...base, metrics }
      } catch (error) {
        logger.error("mimo_token_plan.request.exhausted", { attempts: MAX_REQUEST_ATTEMPTS, error })
        return { ...base, errors: [{ message: `MiMo Token Plan request failed after ${MAX_REQUEST_ATTEMPTS} attempts`, retryable: true }] }
      }
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

type RequestResult<T> = {
  endpoint: string
  status: number
  code?: number
  data?: T
  error?: string
  retryable: boolean
  authFailed?: boolean
}

async function requestJson<T>(fetchImpl: typeof fetch, url: string, cookie: string, endpoint: string, logger: Logger): Promise<RequestResult<T>> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      logger.debug("mimo_token_plan.request.started", { endpoint, attempt, maxAttempts: MAX_REQUEST_ATTEMPTS })
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "Accept-Language": "en", "x-timeZone": "UTC", Cookie: cookie },
        redirect: "manual",
        signal: controller.signal,
      })
      const envelope = await readEnvelope<T>(response)
      const code = numberValue(envelope?.code)
      logger.debug("mimo_token_plan.request.completed", { endpoint, attempt, status: response.status, code })
      const authFailed = response.status === 401 || response.status === 403 || code === 401
      if (authFailed) return { endpoint, status: response.status, ...(code !== undefined ? { code } : {}), retryable: false, authFailed: true }
      const retryable = response.status === 429 || response.status >= 500 || code === 429
      if (retryable && attempt < MAX_REQUEST_ATTEMPTS) {
        logger.warn("mimo_token_plan.request.retrying", { endpoint, attempt, status: response.status, code, nextDelayMs: RETRY_DELAYS_MS[attempt - 1] })
      } else if (!response.ok || code !== 0 || envelope?.data === undefined) {
        return {
          endpoint,
          status: response.status,
          ...(code !== undefined ? { code } : {}),
          error: `MiMo Token Plan ${endpoint} request failed (${response.status}${code !== undefined ? `, code ${code}` : ""})`,
          retryable,
        }
      } else {
        return { endpoint, status: response.status, code: 0, data: envelope.data, retryable: false }
      }
    } catch (error) {
      lastError = error
      if (attempt === MAX_REQUEST_ATTEMPTS) throw error
      logger.warn("mimo_token_plan.request.retrying", { endpoint, attempt, reason: error instanceof Error ? error.name : "network_error", nextDelayMs: RETRY_DELAYS_MS[attempt - 1] })
    } finally {
      clearTimeout(timer)
    }
    await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 0)
  }
  throw lastError ?? new Error(`MiMo Token Plan ${endpoint} request exhausted`)
}

async function readEnvelope<T>(response: Response): Promise<Envelope<T> | undefined> {
  try {
    return await response.json() as Envelope<T>
  } catch {
    return undefined
  }
}

export function mapMiMoUsage(usage: UsageData, detail: DetailData, configured: MetricConfig[], now: string): NormalizedMetric[] {
  const items = Array.isArray(usage.usage?.items) ? usage.usage.items as UsageItem[] : []
  const plan = items.find((item) => item.name === "plan_total_token")
  const used = numberValue(plan?.used)
  const limit = numberValue(plan?.limit)
  if (used === undefined || limit === undefined) return []
  const wanted = new Set(configured.map((metric) => metric.providerMetricId ?? metric.id))
  if (!wanted.has("mimo:plan_credits")) return []
  const compensation = items.find((item) => item.name === "compensation_total_token")
  const compensationLimit = numberValue(compensation?.limit) ?? 0
  const planName = stringValue(detail.planName) ?? stringValue(detail.planCode) ?? "Token Plan"
  const notes = [
    planName,
    detail.enableAutoRenew === true ? "Auto-renew enabled" : "Auto-renew disabled",
    detail.clawEnabled === true ? "MiMo Claw enabled" : undefined,
    compensationLimit > 0 ? `Compensation ${formatInteger(compensationLimit)} credits` : undefined,
    detail.expired === true ? "Expired" : undefined,
  ].filter(Boolean).join(" · ")
  const metric: NormalizedMetric = {
    providerMetricId: "mimo:plan_credits",
    label: `${planName} credits`,
    unit: "credits",
    limit,
    used,
    remaining: Math.max(0, limit - used),
    authoritativeValue: used,
    sourceValueKind: "gauge-used",
    suggestedDisplayModule: "period-quota-card",
    sourceConfidence: "known",
    notes,
    updatedAt: now,
  }
  const window = planWindow(detail, now)
  if (window) metric.window = window
  return [metric]
}

function planWindow(detail: DetailData, now: string): LimitWindow | undefined {
  const resetAt = parseUtcDate(detail.currentPeriodEnd)
  if (!resetAt) return undefined
  const end = new Date(resetAt)
  const start = new Date(end)
  if (stringValue(detail.planCode)?.includes("year")) start.setUTCFullYear(start.getUTCFullYear() - 1)
  else start.setUTCMonth(start.getUTCMonth() - 1)
  if (start.getTime() >= end.getTime()) return { kind: "rolling", duration: "30d", resetAt }
  return { kind: "fixed", startsAt: start.toISOString(), resetAt }
}

function parseUtcDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined
  const normalized = value.includes("T") ? value : value.replace(" ", "T")
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}Z`
  const ms = Date.parse(withZone)
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function formatInteger(value: number): string {
  return Math.trunc(value).toLocaleString("en-US")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
