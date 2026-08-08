import type { RangeKey, SourceValueKind } from "./domain"

export type SubscriptionHistoryPoint = {
  timestamp: string
  sourceValueKind: SourceValueKind
  authoritativeValue?: number
  used?: number
  remaining?: number
  limit?: number
  percentUsed?: number
}

export type SubscriptionHistoryMetric = {
  id: string
  label: string
  unit: string
  points: SubscriptionHistoryPoint[]
}

export type SubscriptionHistoryPayload = {
  subscription: { id: string; name: string }
  range: RangeKey
  generatedAt: string
  metrics: SubscriptionHistoryMetric[]
}
