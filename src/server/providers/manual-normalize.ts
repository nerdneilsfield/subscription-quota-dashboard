// Shared manual-metric normalization. Imported by BOTH the manual provider
// (src/server/providers/manual.ts) and the dashboard projection synthesis
// (src/server/dashboard/project.ts) so config-as-source metrics are normalized
// identically in the live refresh path and the projection-only path.
//
// In particular `sourceConfidence` is rolling-freshness-aware here, so a stale
// rolling manual metric yields "unknown" in both paths (previously the
// projection synthesis hardcoded "known", silently diverging from the provider).

import type { MetricConfig, SourceValueKind } from "../../shared/domain"
import { isValidDuration } from "../../shared/window"
import type { NormalizedMetric } from "./types"

export function normalizeManualMetric(metric: MetricConfig, now: string): NormalizedMetric {
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

export function inferSourceValueKind(metric: MetricConfig): SourceValueKind {
  if (metric.sourceValueKind) return metric.sourceValueKind
  if (metric.used !== undefined) return "gauge-used"
  if (metric.remaining !== undefined) return "gauge-remaining"
  return "status"
}

export function inferSourceConfidence(metric: MetricConfig, now: string): "known" | "unknown" {
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
