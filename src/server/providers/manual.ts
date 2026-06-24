import type { MetricConfig, SourceValueKind } from "../../shared/domain"
import { isValidDuration } from "../../shared/window"
import type {
  NormalizedMetric,
  ProviderAdapter,
  ProviderRefreshInput,
  ProviderRefreshResult,
} from "./types"

export function createManualProvider(): ProviderAdapter {
  return {
    type: "manual",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const metrics = input.metrics.map((metric) => normalizeManualMetric(metric, input.now))
      return {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: input.now,
        metrics,
      }
    },
  }
}

function normalizeManualMetric(metric: MetricConfig, now: string): NormalizedMetric {
  const providerMetricId = metric.providerMetricId ?? metric.id
  const sourceValueKind = inferSourceValueKind(metric)
  const sourceConfidence = inferSourceConfidence(metric, now)
  const base: NormalizedMetric = {
    providerMetricId,
    label: metric.label,
    unit: metric.unit,
    sourceValueKind,
    sourceConfidence,
  }
  if (metric.limit !== undefined) base.limit = metric.limit
  if (metric.used !== undefined) base.used = metric.used
  if (metric.remaining !== undefined) base.remaining = metric.remaining
  if (metric.window !== undefined) base.window = metric.window
  if (metric.display.module !== undefined) base.suggestedDisplayModule = metric.display.module
  if (metric.notes !== undefined) base.notes = metric.notes
  if (metric.updatedAt !== undefined) base.updatedAt = metric.updatedAt
  return base
}

function inferSourceValueKind(metric: MetricConfig): SourceValueKind {
  if (metric.sourceValueKind) return metric.sourceValueKind
  if (metric.used !== undefined) return "gauge-used"
  if (metric.remaining !== undefined) return "gauge-remaining"
  return "status"
}

function inferSourceConfidence(metric: MetricConfig, now: string): "known" | "unknown" {
  if (metric.window?.kind !== "rolling") return "known"
  if (!metric.updatedAt) return "known"
  const durationMs = parseDurationToMs(metric.window.duration)
  if (durationMs === undefined) return "known"
  const updatedAtMs = Date.parse(metric.updatedAt)
  if (Number.isNaN(updatedAtMs)) return "known"
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) return "known"
  return nowMs <= updatedAtMs + durationMs ? "known" : "unknown"
}

function parseDurationToMs(duration: string): number | undefined {
  if (!isValidDuration(duration)) return undefined
  const match = /^(\d+)(m|h|d)$/.exec(duration)
  if (!match) return undefined
  const value = Number(match[1])
  const unit = match[2]
  if (unit === "m") return value * 60_000
  if (unit === "h") return value * 3_600_000
  return value * 86_400_000
}
