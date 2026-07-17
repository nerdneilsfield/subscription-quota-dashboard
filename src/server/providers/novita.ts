import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// Novita AI balance adapter.
// GET https://api.novita.ai/v3/user/balance
// Auth: Bearer <key>
// Response: { availableBalance: number }  (raw unit = 0.0001 USD, divide by 10000)
// Source: cc-switch balance.rs:353-410

const NOVITA_URL = "https://api.novita.ai/v3/user/balance"
const BALANCE_METRIC_ID = "balance"
const NOVITA_UNIT_DIVISOR = 10000

export function createNovitaProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "novita",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "Novita provider unavailable: API key not configured", retryable: false }] }
      }

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: { availableBalance?: unknown }
      try {
        const res = await fetchImpl(NOVITA_URL, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("Novita authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `Novita balance request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "Novita balance request network error", retryable: true }] }
      }

      const raw = parseNumber(body.availableBalance)
      if (raw === undefined) {
        return { ...base, errors: [{ message: "Novita response missing 'availableBalance' field", retryable: false }] }
      }
      const remaining = raw / NOVITA_UNIT_DIVISOR
      const metric = mapBalance(remaining, input.metrics)
      return { ...base, metrics: metric ? [metric] : [] }
    },
  }
}

function mapBalance(remaining: number, metrics: MetricConfig[]): NormalizedMetric {
  const cfg = metrics.find((m) => m.providerMetricId === BALANCE_METRIC_ID) ?? metrics[0]
  const metric: NormalizedMetric = {
    providerMetricId: BALANCE_METRIC_ID,
    label: cfg?.label ?? "Balance",
    unit: cfg?.unit ?? "USD",
    remaining,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
  }
  if (remaining <= 0) {
    metric.notes = "No balance remaining"
  }
  return metric
}
