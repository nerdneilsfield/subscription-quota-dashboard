import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// StepFun balance adapter.
// GET https://api.stepfun.com/v1/accounts
// Auth: Bearer <key>
// Response: { balance: number } (top-level)
// Source: cc-switch balance.rs:152-204

const STEPFUN_URL = "https://api.stepfun.com/v1/accounts"
const BALANCE_METRIC_ID = "balance"

export function createStepfunProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "stepfun",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "StepFun provider unavailable: API key not configured", retryable: false }] }
      }

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: { balance?: unknown }
      try {
        const res = await fetchImpl(STEPFUN_URL, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("StepFun authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `StepFun balance request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "StepFun balance request network error", retryable: true }] }
      }

      const metric = mapBalance(body, input.metrics)
      return { ...base, metrics: metric ? [metric] : [] }
    },
  }
}

function mapBalance(body: { balance?: unknown }, metrics: MetricConfig[]): NormalizedMetric | undefined {
  const remaining = parseNumber(body.balance)
  if (remaining === undefined) return undefined
  const cfg = metrics.find((m) => m.providerMetricId === BALANCE_METRIC_ID) ?? metrics[0]
  return {
    providerMetricId: BALANCE_METRIC_ID,
    label: cfg?.label ?? "Balance",
    unit: cfg?.unit ?? "CNY",
    remaining,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
  }
}
