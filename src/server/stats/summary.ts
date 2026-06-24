// Summary aggregation. Builds SummaryGroup[] from ProjectedMetric[].
//
// Rules from docs/superpowers/specs/2026-06-25-subscription-quota-dashboard-design.md
// (Dashboard Payload -> Payload mapping rules):
// - Aggregate only metrics with the same unit, sourceValueKind, compatible
//   window semantics, and providerType.
// - Dedupe account-scoped provider metrics by providerAccountId +
//   providerMetricId so the same provider balance is not counted twice when
//   multiple subscriptions display it.
// - Consumption/burn-rate aggregation dedupes by providerAccountId +
//   providerMetricId + normalizedUsageFilter so filtered metrics do not
//   collapse into unfiltered totals.
// - burnRate is normalized to units per hour.
// - estimatedExhaustionAt is emitted only when remaining and burnRate are
//   both available; mixed reset windows use estimatedExhaustionConfidence
//   "conservative".

import type { SourceValueKind, RangeKey, LimitWindow } from "../../shared/domain"
import type { SummaryGroup } from "../../shared/dashboard-payload"
import type { ProjectedMetric } from "../dashboard/project"

type WindowGroupKind = "same-reset" | "mixed-reset" | "rolling" | "none"

const RANGE_MS: Record<RangeKey, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
}

type GroupAccumulator = {
  unit: string
  sourceValueKind: SourceValueKind
  providerType: string
  normalizedUsageFilter: string
  members: ProjectedMetric[]
  dedupeSeen: Set<string>
}

export function buildSummaryGroups(
  metrics: ProjectedMetric[],
  selectedRange: RangeKey,
  generatedAt: string,
): SummaryGroup[] {
  // Sort metrics by metricKey for deterministic group order.
  const sorted = [...metrics].sort((a, b) => a.metricKey.localeCompare(b.metricKey))

  const groups: GroupAccumulator[] = []
  for (const m of sorted) {
    const sourceValueKind = resolveSourceValueKind(m)
    const providerType = m.providerType
    const group = groups.find(
      (g) =>
        g.unit === m.config.unit &&
        g.sourceValueKind === sourceValueKind &&
        g.providerType === providerType &&
        g.normalizedUsageFilter === m.normalizedUsageFilter,
    )
    if (group) {
      // Dedupe account-scoped provider metrics by providerAccountId+providerMetricId.
      const dedupeKey = `${m.providerAccountId}/${m.providerMetricId}`
      if (!group.dedupeSeen.has(dedupeKey)) {
        group.members.push(m)
        group.dedupeSeen.add(dedupeKey)
      }
    } else {
      groups.push({
        unit: m.config.unit,
        sourceValueKind,
        providerType,
        normalizedUsageFilter: m.normalizedUsageFilter,
        members: [m],
        dedupeSeen: new Set<string>([`${m.providerAccountId}/${m.providerMetricId}`]),
      })
    }
  }

  return groups.map((g) => buildGroup(g, selectedRange, generatedAt))
}

function resolveSourceValueKind(m: ProjectedMetric): SourceValueKind {
  return m.config.sourceValueKind ?? m.providerMetric?.sourceValueKind ?? "status"
}

function classifyWindowGroup(members: ProjectedMetric[]): WindowGroupKind {
  if (members.length === 0) return "none"
  const kinds = new Set<string>()
  let hasRolling = false
  let hasAny = false
  for (const mem of members) {
    const w = mem.config.window ?? mem.providerMetric?.window
    if (!w) continue
    hasAny = true
    if (w.kind === "rolling") {
      hasRolling = true
      continue
    }
    kinds.add(windowSignature(w))
  }
  if (hasRolling && kinds.size === 0 && !hasAny) return "rolling"
  if (hasRolling && kinds.size > 0) return "mixed-reset"
  if (hasRolling) return "rolling"
  if (!hasAny) return "none"
  return kinds.size <= 1 ? "same-reset" : "mixed-reset"
}

function windowSignature(w: LimitWindow): string {
  if (w.kind === "calendar") return `calendar:${w.period}:${w.timezone}:${w.anchor ? JSON.stringify(w.anchor) : w.resetAt ?? ""}`
  if (w.kind === "rolling") return `rolling:${w.duration}`
  return `fixed:${w.startsAt}:${w.resetAt}`
}

function buildGroup(
  g: GroupAccumulator,
  selectedRange: RangeKey,
  generatedAt: string,
): SummaryGroup {
  const members = g.members
  const label = pickLabel(members)
  const windowGroup = classifyWindowGroup(members)

  // remaining: sum across members (already deduped by providerAccountId+providerMetricId).
  let remainingTotal: number | undefined
  for (const m of members) {
    const r = m.config.remaining ?? m.providerMetric?.remaining
    if (r !== undefined) {
      remainingTotal = (remainingTotal ?? 0) + r
    }
  }

  // consumption: sum of provider history consumption events within range.
  const rangeMs = RANGE_MS[selectedRange]
  const rangeStartMs = Date.parse(generatedAt) - rangeMs
  let consumptionTotal = 0
  let hasConsumption = false
  for (const m of members) {
    for (const ev of m.projectedHistory) {
      if (ev.valueKind !== "consumption") continue
      const ts = Date.parse(ev.sourceTimestamp)
      if (ts < rangeStartMs) continue
      consumptionTotal += ev.value
      hasConsumption = true
    }
  }

  const consumption = hasConsumption ? consumptionTotal : undefined
  const rangeHours = rangeMs / 3_600_000
  const burnRate = hasConsumption
    ? { value: consumptionTotal / rangeHours, per: "hour" as const }
    : undefined

  // estimated exhaustion: only when remaining and burnRate both known and > 0.
  let estimatedExhaustionAt: string | undefined
  let estimatedExhaustionConfidence: "known" | "conservative" | undefined
  if (remainingTotal !== undefined && burnRate !== undefined && burnRate.value > 0) {
    const hoursRemaining = remainingTotal / burnRate.value
    estimatedExhaustionAt = new Date(Date.parse(generatedAt) + hoursRemaining * 3_600_000).toISOString()
    estimatedExhaustionConfidence = members.length > 1 && windowGroup === "mixed-reset" ? "conservative" : "known"
  }

  const id = buildGroupId(g.unit, g.sourceValueKind, g.providerType, windowGroup, g.normalizedUsageFilter)

  const group: SummaryGroup = {
    id,
    label,
    unit: g.unit,
    ...(g.providerType ? { providerType: g.providerType } : {}),
    sourceValueKind: g.sourceValueKind,
    windowGroup,
    ...(g.normalizedUsageFilter ? { normalizedUsageFilter: g.normalizedUsageFilter } : {}),
    ...(remainingTotal !== undefined ? { remaining: remainingTotal } : {}),
    ...(consumption !== undefined ? { consumption } : {}),
    ...(burnRate ? { burnRate } : {}),
    ...(estimatedExhaustionAt ? { estimatedExhaustionAt } : {}),
    ...(estimatedExhaustionConfidence ? { estimatedExhaustionConfidence } : {}),
  }
  return group
}

function pickLabel(members: ProjectedMetric[]): string {
  // Prefer the first member's label deterministically.
  return members[0]?.config.label ?? members[0]?.providerMetric?.label ?? ""
}

function buildGroupId(
  unit: string,
  sourceValueKind: SourceValueKind,
  providerType: string,
  windowGroup: WindowGroupKind,
  normalizedUsageFilter: string,
): string {
  const filterPart = normalizedUsageFilter ? normalizedUsageFilter : "none"
  return `${unit}|${sourceValueKind}|${providerType}|${windowGroup}|${filterPart}`
}
