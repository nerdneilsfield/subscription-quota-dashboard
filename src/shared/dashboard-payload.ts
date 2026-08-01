// Dashboard payload shape — the UI-ready contract produced by the server
// projection layer. Source of truth:
// docs/superpowers/specs/2026-06-25-subscription-quota-dashboard-design.md
// (Dashboard Payload section). Field names mirror the spec verbatim so the
// frontend can consume the payload without translation.

import type {
  CalendarAnchor,
  DisplayModule,
  MetricStatus,
  MetricThresholds,
  RangeKey,
  SourceValueKind,
  SubscriptionIdentity,
} from "./domain"

export type DashboardUsageFilter = {
  usageTypes?: string[]
  apiKeyName?: string
  botName?: string
}

export type DashboardBurnRate = { value: number; per: "hour" }

export type DashboardRangeStats = {
  range: RangeKey
  source: "provider-history" | "snapshot-delta" | "manual" | "unknown"
  consumption?: number
  burnRate?: DashboardBurnRate
  estimatedExhaustionAt?: string
  series?: Array<{
    timestamp: string
    value: number
    valueKind: "used" | "remaining" | "consumption" | "percentUsed"
  }>
}

export type DashboardWindow = {
  kind: "calendar" | "rolling" | "fixed"
  label: string
  resetAt?: string
  timezone?: string
  duration?: string
  windowStartAt?: string
  anchor?: CalendarAnchor
}

export type DashboardMetricDisplay = {
  module: DisplayModule
  title?: string
  subtitle?: string
  notes?: string
  updatedAt?: string
  sourceConfidence?: "known" | "estimated" | "unknown"
  usageFilter?: DashboardUsageFilter
  thresholds?: MetricThresholds
}

export type DashboardMetric = {
  id: string
  providerMetricId?: string
  metricKey: string
  label: string
  unit: string
  status: MetricStatus
  limit?: number
  used?: number
  remaining?: number
  window?: DashboardWindow
  display: DashboardMetricDisplay
  percentUsed?: number
  rangeStats?: DashboardRangeStats
}

export type DashboardSubscriptionError = { message: string; stale: boolean }

export type DashboardSubscription = {
  id: string
  name: string
  identity?: SubscriptionIdentity
  ui?: { color?: string; group?: string; sort?: number }
  status: MetricStatus
  lastRefreshAt?: string
  metrics: DashboardMetric[]
  errors?: DashboardSubscriptionError[]
}

export type SummaryGroup = {
  id: string
  label: string
  unit: string
  providerType?: string
  sourceValueKind: SourceValueKind
  windowGroup: "same-reset" | "mixed-reset" | "rolling" | "none"
  normalizedUsageFilter?: string
  remaining?: number
  consumption?: number
  burnRate?: DashboardBurnRate
  estimatedExhaustionAt?: string
  estimatedExhaustionConfidence?: "known" | "conservative"
}

export type DashboardPayload = {
  profile: { id: string; name: string }
  generatedAt: string
  ranges: RangeKey[]
  selectedRange: RangeKey
  summaryGroups: SummaryGroup[]
  subscriptions: DashboardSubscription[]
}
