import type { NormalizedMetric, ProviderAdapter, ProviderRefreshResult } from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

const CREDITS_URL = "https://api.commandcode.ai/internal/billing/credits"

type CreditsResponse = {
  credits?: { monthlyCredits?: unknown; monthlyCreditsGranted?: unknown; purchasedCredits?: unknown }
  windowLimits?: {
    limited?: boolean
    fiveHour?: { used?: unknown; cap?: unknown; resetAt?: unknown }
    weekly?: { used?: unknown; cap?: unknown; resetAt?: unknown }
  }
}

export function createCommandCodeProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "command-code",
    async refresh(input): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId, fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(), metrics: [],
      }
      const cookie = input.runtime.authCookie
      if (!cookie || /[\r\n]/.test(cookie)) {
        return { ...base, errors: [authError("Command Code session cookie missing or invalid")] }
      }
      let body: CreditsResponse
      try {
        const response = await fetchImpl(CREDITS_URL, {
          method: "GET", headers: { Cookie: cookie, Accept: "application/json" }, redirect: "error",
        })
        if (response.status === 401 || response.status === 403) {
          return { ...base, errors: [authError("Command Code authentication failed; renew the session cookie")] }
        }
        if (!response.ok) return { ...base, errors: [{
          message: `Command Code credits request failed (${response.status})`, retryable: isRetryableStatus(response.status),
        }] }
        try { body = await response.json() as CreditsResponse } catch {
          return { ...base, errors: [{ message: "Command Code returned invalid JSON", retryable: false }] }
        }
      } catch {
        return { ...base, errors: [{ message: "Command Code credits request network error", retryable: true }] }
      }
      const monthly = parseNumber(body?.credits?.monthlyCredits)
      const granted = parseNumber(body?.credits?.monthlyCreditsGranted)
      const purchased = parseNumber(body?.credits?.purchasedCredits)
      if (monthly === undefined || granted === undefined || purchased === undefined) {
        return { ...base, errors: [{ message: "Command Code returned invalid credits data", retryable: false }] }
      }
      const metrics: NormalizedMetric[] = [
        { providerMetricId: "monthly_credits", label: "Monthly credits", unit: "credits",
          remaining: monthly, limit: granted, used: Math.max(0, granted - monthly),
          sourceValueKind: "gauge-remaining", sourceConfidence: "known" },
        { providerMetricId: "purchased_credits", label: "Purchased credits", unit: "credits",
          remaining: purchased, sourceValueKind: "gauge-remaining", sourceConfidence: "known" },
      ]
      const errors: NonNullable<ProviderRefreshResult["errors"]> = []
      if (body.windowLimits?.limited === true) {
        for (const [key, id, label, duration] of [
          ["fiveHour", "five_hour", "5h quota", "5h"], ["weekly", "weekly", "Weekly quota", "7d"],
        ] as const) {
          const quota = body.windowLimits[key]
          const used = parseNumber(quota?.used)
          const limit = parseNumber(quota?.cap)
          const resetMs = parseNumber(quota?.resetAt)
          const reset = resetMs !== undefined ? new Date(resetMs) : undefined
          if (used === undefined || limit === undefined || !reset || !Number.isFinite(reset.getTime())) {
            errors.push({ message: `Command Code returned invalid ${key} quota`, retryable: false })
            continue
          }
          metrics.push({ providerMetricId: id, label, unit: "credits", used, limit,
            remaining: Math.max(0, limit - used), sourceValueKind: "gauge-used", sourceConfidence: "known",
            window: { kind: "rolling", duration, resetAt: reset.toISOString() } })
        }
      }
      for (const metric of metrics) {
        const config = input.metrics.find((entry) => entry.providerMetricId === metric.providerMetricId)
        metric.label = config?.label ?? metric.label
        metric.unit = config?.unit ?? metric.unit
      }
      return { ...base, metrics, ...(errors.length ? { errors } : {}) }
    },
  }
}
