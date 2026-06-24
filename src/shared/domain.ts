export type DisplayModule = "balance-card" | "rolling-window-card" | "period-quota-card" | "manual-status-card"
export type SourceValueKind = "counter" | "gauge-remaining" | "gauge-used" | "status"
export type MetricStatus = "ok" | "warn" | "critical" | "stale" | "unavailable" | "expired"
export type RangeKey = "1h" | "24h" | "7d" | "30d"

export type LimitWindow =
  | { kind: "calendar"; period: "day" | "week" | "month" | "year"; timezone: string; resetAt?: string; anchor?: CalendarAnchor }
  | { kind: "rolling"; duration: string; resetAt?: string }
  | { kind: "fixed"; startsAt: string; resetAt: string }

export type CalendarAnchor = {
  dayOfWeek?: number
  dayOfMonth?: number
  monthOfYear?: number
  timeOfDay?: string
}

export type MetricConfig = {
  id: string
  providerMetricId?: string
  label: string
  unit: string
  limit?: number
  used?: number
  remaining?: number
  sourceValueKind?: SourceValueKind
  window?: LimitWindow
  display: { module: DisplayModule; thresholds?: MetricThresholds }
  updatedAt?: string
  notes?: string
  usageFilter?: { usageTypes?: string[]; apiKeyName?: string; botName?: string }
}

export type MetricThresholds = {
  warnPercentUsed?: number
  criticalPercentUsed?: number
  warnRemaining?: number
  criticalRemaining?: number
}

export type ProviderAccountConfig =
  | { id: string; type: "poe"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "manual" }

export type SubscriptionConfig = {
  id: string
  name: string
  providerId: string
  metrics: MetricConfig[]
  ui?: { color?: string; group?: string; sort?: number }
}

export type ProfileConfig = { id: string; name: string; viewKey: string | undefined; subscriptionIds: string[] }
export type DashboardConfigInput = { providers: ProviderAccountConfig[]; subscriptions: SubscriptionConfig[]; profiles: ProfileConfig[] }
export type ProviderRuntimeState = { available: boolean; apiKey?: string; reason?: string }
export type NormalizedConfig = { providers: Map<string, ProviderAccountConfig>; providerRuntime: Map<string, ProviderRuntimeState>; subscriptions: Map<string, SubscriptionConfig>; profiles: Map<string, ProfileConfig> }
