import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// OpenRouter balance adapter.
// GET https://openrouter.ai/api/v1/credits
// Auth: Bearer <key>
// Response: { data: { total_credits: number, total_usage: number } }
// remaining = total_credits - total_usage; limit = total_credits; used = total_usage
// Source: cc-switch balance.rs:287-346

const OPENROUTER_URL = "https://openrouter.ai/api/v1/credits"
const BALANCE_METRIC_ID = "balance"

export function createOpenrouterProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "openrouter",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "OpenRouter provider unavailable: API key not configured", retryable: false }] }
      }

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: { data?: { total_credits?: unknown; total_usage?: unknown } }
      try {
        const res = await fetchImpl(OPENROUTER_URL, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("OpenRouter authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `OpenRouter balance request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "OpenRouter balance request network error", retryable: true }] }
      }

      const data = body.data ?? {}
      const totalCredits = parseNumber(data.total_credits) ?? 0
      const totalUsage = parseNumber(data.total_usage) ?? 0
      const metric = mapBalance(totalCredits, totalUsage, input.metrics)
      return { ...base, metrics: metric ? [metric] : [] }
    },
  }
}

function mapBalance(totalCredits: number, totalUsage: number, metrics: MetricConfig[]): NormalizedMetric | undefined {
  const remaining = totalCredits - totalUsage
  const cfg = metrics.find((m) => m.providerMetricId === BALANCE_METRIC_ID) ?? metrics[0]
  const metric: NormalizedMetric = {
    providerMetricId: BALANCE_METRIC_ID,
    label: cfg?.label ?? "Credits",
    unit: cfg?.unit ?? "USD",
    remaining,
    limit: totalCredits,
    used: totalUsage,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
  }
  if (remaining <= 0) {
    metric.notes = "No credits remaining"
  }
  return metric
}
