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
  // A class - account balance (Bearer auth)
  | { id: string; type: "deepseek"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "stepfun"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "siliconflow"; baseUrl?: string | undefined; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "openrouter"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "novita"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  // B class - coding plan (Bearer auth, except Zhipu raw-key and Volcengine AK/SK)
  | { id: string; type: "kimi"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "zhipu"; baseUrl?: string | undefined; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "minimax"; baseUrl?: string | undefined; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "zenmux"; baseUrl: string; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "volcengine"; region?: string | undefined; akEnv?: string | undefined; ak?: string | undefined; skEnv?: string | undefined; sk?: string | undefined }
  | { id: string; type: "cliproxy"; baseUrl: string; apiKeyEnv?: string | undefined; apiKey?: string | undefined; queryProviders?: string[] | undefined }

export type SubscriptionConfig = {
  id: string
  name: string
  providerId: string
  metrics: MetricConfig[]
  ui?: { color?: string; group?: string; sort?: number }
}

export type ProfileConfig = { id: string; name: string; viewKey: string | undefined; subscriptionIds: string[]; dynamicProviderIds?: string[] }
export type DashboardConfigInput = { providers: ProviderAccountConfig[]; subscriptions: SubscriptionConfig[]; profiles: ProfileConfig[] }
export type ProviderRuntimeState = {
  available: boolean
  apiKey?: string
  ak?: string
  sk?: string
  reason?: string
}
export type DynamicSubscription = {
  id: string
  name: string
  providerMetricIds: string[]
  identity?: SubscriptionIdentity
  ui?: { color?: string; group?: string; sort?: number }
}
export type SubscriptionIdentity = {
  provider: string
  providerLabel: string
  account?: string
  plan?: string
  transport?: string
}
export type NormalizedConfig = { providers: Map<string, ProviderAccountConfig>; providerRuntime: Map<string, ProviderRuntimeState>; subscriptions: Map<string, SubscriptionConfig>; profiles: Map<string, ProfileConfig> }
