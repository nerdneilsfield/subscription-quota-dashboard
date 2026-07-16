import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber, parseResetTime } from "./shared"

// Kimi coding-plan adapter.
// GET https://api.kimi.com/coding/v1/usages
// Auth: Bearer <key>
// Response: { limits: [{ detail: { limit, remaining, resetTime } }], usage: { limit, remaining, resetTime } }
// limits[].detail -> five_hour; usage -> weekly_limit
// Source: cc-switch coding_plan.rs:100-206

const KIMI_URL = "https://api.kimi.com/coding/v1/usages"

export function createKimiProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "kimi",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "Kimi provider unavailable: API key not configured", retryable: false }] }
      }

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: {
        limits?: Array<{ detail?: { limit?: unknown; remaining?: unknown; resetTime?: unknown } }>
        usage?: { limit?: unknown; remaining?: unknown; resetTime?: unknown }
      }
      try {
        const res = await fetchImpl(KIMI_URL, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("Kimi authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `Kimi usage request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "Kimi usage request network error", retryable: true }] }
      }

      const metrics: NormalizedMetric[] = []
      // five_hour from limits[].detail (first entry)
      const firstLimit = body.limits?.[0]?.detail
      if (firstLimit) {
        const m = mapTier("five_hour", firstLimit, input.metrics)
        if (m) metrics.push(m)
      }
      // weekly_limit from top-level usage
      if (body.usage) {
        const m = mapTier("weekly_limit", body.usage, input.metrics)
        if (m) metrics.push(m)
      }
      return { ...base, metrics }
    },
  }
}

function mapTier(
  providerMetricId: string,
  detail: { limit?: unknown; remaining?: unknown; resetTime?: unknown },
  metrics: MetricConfig[],
): NormalizedMetric | undefined {
  const limit = parseNumber(detail.limit)
  const remaining = parseNumber(detail.remaining)
  if (limit === undefined || remaining === undefined) return undefined
  const used = Math.max(0, limit - remaining)
  const resetAt = parseResetTime(detail.resetTime)
  const cfg = metrics.find((m) => m.providerMetricId === providerMetricId)
  const metric: NormalizedMetric = {
    providerMetricId,
    label: cfg?.label ?? providerMetricId,
    unit: cfg?.unit ?? "tokens",
    limit,
    remaining,
    used,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
    ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration: providerMetricId === "five_hour" ? "5h" : "7d", resetAt } } : {}),
  }
  return metric
}
