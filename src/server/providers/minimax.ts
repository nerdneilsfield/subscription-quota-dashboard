import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseResetTime } from "./shared"

// MiniMax coding-plan adapter.
// GET <baseUrl>/v1/api/openplatform/coding_plan/remains  (CN: api.minimaxi.com, EN: api.minimax.io)
// Auth: Bearer <key>
// Response: { base_resp: { status_code, status_msg }, model_remains: [{ model_name, current_interval_remaining_percent, end_time, current_weekly_status, current_weekly_remaining_percent, weekly_end_time }] }
// Only model_name=="general" is processed. Weekly tier only when current_weekly_status==1.
// Source: cc-switch coding_plan.rs:408-491, 631-695

const DEFAULT_BASE_URL = "https://api.minimaxi.com"
const MINIMAX_PATH = "/v1/api/openplatform/coding_plan/remains"

type MiniMaxProvider = { id: string; type: "minimax"; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }

type ModelRemain = {
  model_name?: string
  current_interval_remaining_percent?: number
  end_time?: unknown
  current_weekly_status?: number
  current_weekly_remaining_percent?: number
  weekly_end_time?: unknown
}

export function createMiniMaxProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "minimax",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "MiniMax provider unavailable: API key not configured", retryable: false }] }
      }

      const providerConfig = input.provider as MiniMaxProvider
      const baseUrl = providerConfig.baseUrl ?? DEFAULT_BASE_URL
      const url = `${baseUrl}${MINIMAX_PATH}`

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Content-Type", "application/json")
      headers.set("Accept", "application/json")

      let body: { base_resp?: { status_code?: number; status_msg?: string }; model_remains?: ModelRemain[] }
      try {
        const res = await fetchImpl(url, { method: "GET", headers })
        if (res.status === 401 || res.status === 403) {
          return { ...base, errors: [authError("MiniMax authentication failed")] }
        }
        if (!res.ok) {
          return { ...base, errors: [{ message: `MiniMax usage request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        body = (await res.json()) as typeof body
      } catch {
        return { ...base, errors: [{ message: "MiniMax usage request network error", retryable: true }] }
      }

      // Business error envelope
      const baseResp = body.base_resp
      if (!baseResp || baseResp.status_code === undefined) {
        return { ...base, errors: [{ message: "MiniMax response missing base_resp envelope", retryable: false }] }
      }
      if (baseResp.status_code !== 0) {
        const msg = baseResp.status_msg ?? "Unknown error"
        return { ...base, errors: [{ message: `MiniMax API error (code ${baseResp.status_code}): ${msg}`, retryable: false }] }
      }

      // Find general model
      const general = (body.model_remains ?? []).find((m) => m.model_name === "general")
      if (!general) return { ...base, metrics: [] }

      const metrics: NormalizedMetric[] = []
      // 5h tier (always present for general)
      if (general.current_interval_remaining_percent !== undefined) {
        const resetAt = parseResetTime(general.end_time)
        metrics.push(makeMetric("five_hour", general.current_interval_remaining_percent, resetAt, input.metrics, general.current_weekly_status))
      }
      // Weekly tier (only when status == 1)
      if (general.current_weekly_status === 1 && general.current_weekly_remaining_percent !== undefined) {
        const resetAt = parseResetTime(general.weekly_end_time)
        metrics.push(makeMetric("weekly_limit", general.current_weekly_remaining_percent, resetAt, input.metrics, general.current_weekly_status))
      }
      return { ...base, metrics }
    },
  }
}

function makeMetric(
  providerMetricId: string,
  remainingPercent: number,
  resetAt: string | undefined,
  configs: MetricConfig[],
  weeklyStatus: number | undefined,
): NormalizedMetric {
  const cfg = configs.find((m) => m.providerMetricId === providerMetricId)
  const metric: NormalizedMetric = {
    providerMetricId,
    label: cfg?.label ?? providerMetricId,
    unit: cfg?.unit ?? "%",
    limit: 100,
    remaining: remainingPercent,
    used: Math.max(0, 100 - remainingPercent),
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
    ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration: providerMetricId === "five_hour" ? "5h" : "7d", resetAt } } : {}),
  }
  if (providerMetricId === "weekly_limit" && weeklyStatus !== undefined) {
    metric.notes = `Weekly status: ${weeklyStatus}`
  }
  return metric
}
