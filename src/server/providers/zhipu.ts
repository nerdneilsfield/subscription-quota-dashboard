import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber, parseResetTime } from "./shared"

// Zhipu (personal) coding-plan adapter.
// GET <baseUrl>/api/monitor/usage/quota/limit  (default https://open.bigmodel.cn, EN: https://api.z.ai)
// Auth: Authorization: <key>  (NO Bearer prefix - Zhipu-specific)
// Response: { success: boolean, msg?: string, data: { level?: string, limits: [{ type, unit, percentage, nextResetTime }] } }
// Window classification by `unit`: 3 -> five_hour, 6 -> weekly_limit
// Source: cc-switch coding_plan.rs:208-406

const DEFAULT_BASE_URL = "https://open.bigmodel.cn"
const ZHIPU_PATH = "/api/monitor/usage/quota/limit"

type ZhipuProvider = { id: string; type: "zhipu"; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }

type ZhipuLimitItem = {
  type?: string
  unit?: number
  percentage?: unknown
  nextResetTime?: unknown
}

export function createZhipuProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "zhipu",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "Zhipu provider unavailable: API key not configured", retryable: false }] }
      }

      const providerConfig = input.provider as ZhipuProvider
      const baseUrl = providerConfig.baseUrl ?? DEFAULT_BASE_URL
      const url = `${baseUrl}${ZHIPU_PATH}`

      // Zhipu: NO Bearer prefix
      const headers = new Headers()
      headers.set("Authorization", apiKey)
      headers.set("Content-Type", "application/json")
      headers.set("Accept", "application/json")

      let body: { success?: boolean; msg?: string; data?: { level?: string; limits?: ZhipuLimitItem[] } }
      try {
        const res = await fetchImpl(url, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("Zhipu authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `Zhipu usage request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "Zhipu usage request network error", retryable: true }] }
      }

      // Business error envelope
      if (body.success === false) {
        const msg = body.msg ?? "Unknown error"
        return { ...base, errors: [{ message: `Zhipu API error: ${msg}`, retryable: false }] }
      }

      if (!body.data) {
        return { ...base, errors: [{ message: "Zhipu response missing 'data' field", retryable: false }] }
      }

      const metrics = parseTiers(body.data, input.metrics)
      return { ...base, metrics }
    },
  }
}

function classifyWindow(unit: number | undefined): "five_hour" | "weekly_limit" | undefined {
  if (unit === 3) return "five_hour"
  if (unit === 6) return "weekly_limit"
  return undefined
}

function parseTiers(
  data: { level?: string; limits?: ZhipuLimitItem[] },
  configs: MetricConfig[],
): NormalizedMetric[] {
  const limits = data.limits ?? []
  let fiveHour: { percentage: number; resetAt: string | undefined } | undefined
  let weekly: { percentage: number; resetAt: string | undefined } | undefined
  const unclassified: Array<{ percentage: number; resetAt: string | undefined; resetMs: number | undefined }> = []

  for (const item of limits) {
    const type = item.type ?? ""
    // NOTE: plan used `equalsIgnoreCase` (not a JS method); replaced with
    // toUpperCase() per the plan's own note.
    if (type.toUpperCase() !== "TOKENS_LIMIT") continue
    // Clamp percentage to 0-100 range (API may return 0-1 fraction in some edge cases)
    const rawPercentage = parseNumber(item.percentage) ?? 0
    const percentage = rawPercentage <= 1 ? rawPercentage * 100 : rawPercentage
    const resetAt = parseResetTime(item.nextResetTime)
    // Compute resetMs for fallback sorting from the parsed resetAt so numeric
    // seconds are normalized consistently with parseResetTime.
    const resetMs = resetAt !== undefined ? Date.parse(resetAt) : undefined
    const window = classifyWindow(item.unit)
    if (window === "five_hour" && !fiveHour) {
      fiveHour = { percentage, resetAt }
    } else if (window === "weekly_limit" && !weekly) {
      weekly = { percentage, resetAt }
    } else {
      unclassified.push({ percentage, resetAt, resetMs })
    }
  }

  // Fallback heuristic: no-resetTime -> five_hour first; rest by reset ascending
  unclassified.sort((a, b) => {
    const aHas = a.resetMs !== undefined ? 1 : 0
    const bHas = b.resetMs !== undefined ? 1 : 0
    if (aHas !== bHas) return aHas - bHas
    return (a.resetMs ?? 0) - (b.resetMs ?? 0)
  })
  for (const u of unclassified) {
    if (!fiveHour) fiveHour = { percentage: u.percentage, resetAt: u.resetAt }
    else if (!weekly) weekly = { percentage: u.percentage, resetAt: u.resetAt }
  }

  const metrics: NormalizedMetric[] = []
  const level = data.level
  if (fiveHour) metrics.push(makeMetric("five_hour", fiveHour.percentage, fiveHour.resetAt, configs, level))
  if (weekly) metrics.push(makeMetric("weekly_limit", weekly.percentage, weekly.resetAt, configs, level))
  return metrics
}

function makeMetric(
  providerMetricId: string,
  percentage: number,
  resetAt: string | undefined,
  configs: MetricConfig[],
  level: string | undefined,
): NormalizedMetric {
  const cfg = configs.find((m) => m.providerMetricId === providerMetricId)
  const metric: NormalizedMetric = {
    providerMetricId,
    label: cfg?.label ?? providerMetricId,
    unit: cfg?.unit ?? "%",
    limit: 100,
    used: percentage,
    remaining: 100 - percentage,
    sourceValueKind: "gauge-used",
    sourceConfidence: "known",
    ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration: providerMetricId === "five_hour" ? "5h" : "7d", resetAt } } : {}),
  }
  if (level) metric.notes = `Plan: ${level}`
  return metric
}
