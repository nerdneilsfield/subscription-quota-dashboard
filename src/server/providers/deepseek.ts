import type { MetricConfig } from "../../shared/domain"
import type {
  NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult,
} from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// DeepSeek balance adapter.
// GET https://api.deepseek.com/user/balance
// Auth: Bearer <key>
// Response: { is_available: boolean, balance_infos: [{ currency, total_balance }] }
// Source: cc-switch balance.rs:74-146

const DEEPSEEK_URL = "https://api.deepseek.com/user/balance"
const BALANCE_METRIC_ID = "balance"

export function createDeepseekProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "deepseek",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "DeepSeek provider unavailable: API key not configured", retryable: false }] }
      }

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: { is_available?: boolean; balance_infos?: Array<{ currency?: string; total_balance?: unknown }> }
      try {
        const res = await fetchImpl(DEEPSEEK_URL, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("DeepSeek authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `DeepSeek balance request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "DeepSeek balance request network error", retryable: true }] }
      }

      const metrics = mapBalance(body, input.metrics)
      return { ...base, metrics }
    },
  }
}

function mapBalance(
  body: { is_available?: boolean; balance_infos?: Array<{ currency?: string; total_balance?: unknown }> },
  metrics: MetricConfig[],
): NormalizedMetric[] {
  const infos = body.balance_infos ?? []
  const result: NormalizedMetric[] = []
  for (const info of infos) {
    const remaining = parseNumber(info.total_balance)
    if (remaining === undefined) continue
    const cfg = metrics.find((m) => m.providerMetricId === BALANCE_METRIC_ID) ?? metrics[0]
    const metric: NormalizedMetric = {
      providerMetricId: BALANCE_METRIC_ID,
      label: cfg?.label ?? "Balance",
      unit: cfg?.unit ?? "CNY",
      remaining,
      sourceValueKind: "gauge-remaining",
      sourceConfidence: "known",
    }
    if (body.is_available === false) {
      metric.notes = "Insufficient balance"
    }
    result.push(metric)
  }
  return result
}
