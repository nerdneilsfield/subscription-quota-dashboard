import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// ZenMux coding-plan adapter.
// GET <baseUrl>  (required, user-supplied)
// Auth: Bearer <key>
// Response: { success: boolean, message?: string, data: { quota_5_hour: { usage_percentage (0-1), resets_at, used_value_usd, max_value_usd }, quota_7_day: {...}, plan: { tier }, account_status } }
// usage_percentage is a 0-1 fraction; adapter sets limit/used/remaining as USD absolute values.
// Source: cc-switch coding_plan.rs:493-629

type ZenmuxProvider = { id: string; type: "zenmux"; baseUrl: string; apiKeyEnv?: string; apiKey?: string }

type QuotaWindow = {
  usage_percentage?: unknown
  resets_at?: string
  used_value_usd?: unknown
  max_value_usd?: unknown
}

export function createZenmuxProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "zenmux",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "ZenMux provider unavailable: API key not configured", retryable: false }] }
      }

      const providerConfig = input.provider as ZenmuxProvider
      const url = providerConfig.baseUrl

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      let body: { success?: boolean; message?: string; data?: { quota_5_hour?: QuotaWindow; quota_7_day?: QuotaWindow; plan?: { tier?: string }; account_status?: string } }
      try {
        const res = await fetchImpl(url, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("ZenMux authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `ZenMux usage request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "ZenMux usage request network error", retryable: true }] }
      }

      // Business error envelope
      if (body.success !== true) {
        const msg = body.message ?? "Unknown error"
        return { ...base, errors: [{ message: `ZenMux API error: ${msg}`, retryable: false }] }
      }

      if (!body.data) {
        return { ...base, errors: [{ message: "ZenMux response missing 'data' field", retryable: false }] }
      }

      const metrics: NormalizedMetric[] = []
      const data = body.data
      const tier = data.plan?.tier
      const accountStatus = data.account_status
      let planNote: string | undefined
      if (tier || accountStatus) {
        const parts: string[] = []
        if (tier) parts.push(`Plan: ${tier}`)
        if (accountStatus) parts.push(accountStatus)
        planNote = parts.join(" ")
      }

      if (data.quota_5_hour) {
        const m = mapWindow("five_hour", "5h", data.quota_5_hour, input.metrics, planNote)
        if (m) metrics.push(m)
      }
      if (data.quota_7_day) {
        const m = mapWindow("weekly_limit", "7d", data.quota_7_day, input.metrics, planNote)
        if (m) metrics.push(m)
      }
      return { ...base, metrics }
    },
  }
}

function mapWindow(
  providerMetricId: string,
  duration: string,
  win: QuotaWindow,
  configs: MetricConfig[],
  planNote: string | undefined,
): NormalizedMetric | undefined {
  const maxUsd = parseNumber(win.max_value_usd)
  const usedUsd = parseNumber(win.used_value_usd)
  if (maxUsd === undefined || usedUsd === undefined) return undefined
  const remaining = maxUsd - usedUsd
  // usage_percentage is 0-1; multiply by 100 for percentUsed (but projection computes
  // percentUsed from used/limit, so we just set used/limit and let it derive)
  const cfg = configs.find((m) => m.providerMetricId === providerMetricId)
  const metric: NormalizedMetric = {
    providerMetricId,
    label: cfg?.label ?? providerMetricId,
    unit: cfg?.unit ?? "USD",
    limit: maxUsd,
    used: usedUsd,
    remaining,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
    ...(win.resets_at !== undefined ? { window: { kind: "rolling" as const, duration, resetAt: win.resets_at } } : {}),
  }
  if (planNote) metric.notes = planNote
  return metric
}
