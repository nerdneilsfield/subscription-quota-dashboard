import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// SiliconFlow balance adapter (CN + EN share one adapter, baseUrl selects host).
// GET <baseUrl>/v1/user/info  (default https://api.siliconflow.cn)
// Auth: Bearer <key>
// Response: { data: { totalBalance: number } }
// Source: cc-switch balance.rs:210-281

const DEFAULT_BASE_URL = "https://api.siliconflow.cn"
const BALANCE_METRIC_ID = "balance"

type SiliconflowProvider = { id: string; type: "siliconflow"; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }

export function createSiliconflowProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "siliconflow",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "SiliconFlow provider unavailable: API key not configured", retryable: false }] }
      }

      const providerConfig = input.provider as SiliconflowProvider
      const baseUrl = providerConfig.baseUrl ?? DEFAULT_BASE_URL
      const url = `${baseUrl}/v1/user/info`

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: { data?: { totalBalance?: unknown } }
      try {
        const res = await fetchImpl(url, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("SiliconFlow authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `SiliconFlow balance request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "SiliconFlow balance request network error", retryable: true }] }
      }

      if (!body.data) {
        return { ...base, errors: [{ message: "SiliconFlow response missing 'data' field", retryable: false }] }
      }
      const metric = mapBalance(body.data, baseUrl, input.metrics)
      return { ...base, metrics: metric ? [metric] : [] }
    },
  }
}

function mapBalance(data: { totalBalance?: unknown }, baseUrl: string, metrics: MetricConfig[]): NormalizedMetric | undefined {
  const remaining = parseNumber(data.totalBalance)
  if (remaining === undefined) return undefined
  const cfg = metrics.find((m) => m.providerMetricId === BALANCE_METRIC_ID) ?? metrics[0]
  // Auto-derive unit from host: .cn -> CNY, .com -> USD (matches cc-switch balance.rs:260)
  let defaultUnit = "USD"
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    defaultUnit = host === "api.siliconflow.cn" ? "CNY" : "USD"
  } catch {
    // Fall through with USD default
  }
  return {
    providerMetricId: BALANCE_METRIC_ID,
    label: cfg?.label ?? "Balance",
    unit: cfg?.unit ?? defaultUnit,
    remaining,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
  }
}
