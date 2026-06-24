import type {
  DisplayModule,
  LimitWindow,
  MetricConfig,
  ProviderAccountConfig,
  ProviderRuntimeState,
  SourceValueKind,
} from "../../shared/domain"

export type ProviderRefreshInput = {
  providerAccountId: string
  provider: ProviderAccountConfig
  runtime: ProviderRuntimeState
  now: string
  metrics: MetricConfig[]
  importState?: { maxCreationTime?: number; importedQueryIdsAtMaxCreationTime: string[] }
}

export type NormalizedMetric = {
  providerMetricId: string
  label: string
  unit: string
  limit?: number
  used?: number
  remaining?: number
  authoritativeValue?: number
  sourceValueKind: SourceValueKind
  window?: LimitWindow
  suggestedDisplayModule?: DisplayModule
  sourceConfidence: "known" | "estimated" | "unknown"
  notes?: string
  updatedAt?: string
}

export type ProviderHistoryEvent = {
  providerMetricId: string
  providerEventId?: string
  sourceTimestamp: string
  value: number
  valueKind: "used" | "remaining" | "consumption" | "percentUsed"
  usageType?: string
  apiKeyName?: string
  botName?: string
  pageCursor?: string
  rowIndex?: number
  raw?: unknown
}

export type ProviderRefreshResult = {
  providerAccountId: string
  fetchedAt: string
  staleAfter: string
  metrics: NormalizedMetric[]
  historyEvents?: ProviderHistoryEvent[]
  nextImportState?: { maxCreationTime?: number; importedQueryIdsAtMaxCreationTime: string[] }
  errors?: Array<{ message: string; retryable: boolean }>
}

export type ProviderAdapter = {
  type: string
  refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult>
}
