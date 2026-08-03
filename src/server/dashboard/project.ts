// Dashboard projection: combines normalized config, provider output, and
// storage rows into the UI-ready DashboardPayload. Implements the projection
// rules from docs/superpowers/specs/2026-06-25-subscription-quota-dashboard-design.md
// (Poe Provider -> Metric projection rules, Dashboard Payload -> Payload mapping
// rules, and Status calculation).

import type {
  DisplayModule,
  DynamicSubscription,
  LimitWindow,
  MetricConfig,
  MetricStatus,
  NormalizedConfig,
  RangeKey,
  SourceValueKind,
  SubscriptionIdentity,
} from "../../shared/domain"
import type {
  DashboardMetric,
  DashboardMetricDisplay,
  DashboardPayload,
  DashboardRangeStats,
  DashboardSubscription,
  DashboardWindow,
  SummaryGroup,
} from "../../shared/dashboard-payload"
import type { NormalizedMetric, ProviderHistoryEvent } from "../providers/types"
import { normalizeManualMetric } from "../providers/manual-normalize"
import { buildMetricKey } from "../../shared/metric-key"
import { computeNextResetAt, labelWindow } from "../../shared/window"
import { buildSummaryGroups } from "../stats/summary"

const ALL_RANGES: RangeKey[] = ["1h", "24h", "7d", "30d"]
const DEFAULT_RANGE: RangeKey = "24h"

const RANGE_MS: Record<RangeKey, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
}

const STATUS_PRECEDENCE: MetricStatus[] = ["ok", "stale", "warn", "critical", "unavailable", "expired"]

export type UsageFilter = { usageTypes?: string[]; apiKeyName?: string; botName?: string }

export type ProviderCacheSummary = {
  fetchedAt: string
  staleAfter: string
  status: "ok" | "stale" | "unavailable"
  errors: Array<{ message: string; retryable: boolean }>
}

export type ProjectedHistoryPoint = {
  sourceTimestamp: string
  value: number
  valueKind: "used" | "remaining" | "consumption" | "percentUsed"
}

export type SnapshotPoint = {
  timestamp: string
  authoritativeValue?: number
  used?: number
  remaining?: number
  limit?: number
  sourceValueKind: SourceValueKind
}

export type ProviderAccountProjection = {
  providerAccountId: string
  metrics: NormalizedMetric[]
  historyEvents?: ProviderHistoryEvent[]
  cache?: ProviderCacheSummary
}

// A ProjectedMetric is the per-metric joined view consumed by both the
// dashboard payload builder and the summary aggregator. It carries the
// configured metric, the matched provider metric (if any), the resolved usage
// filter, and the per-metric history/snapshot slices already filtered to the
// metric's policy.
export type ProjectedMetric = {
  subscriptionId: string
  subscriptionName: string
  subscriptionIdentity?: SubscriptionIdentity
  subscriptionUi?: { color?: string; group?: string; sort?: number }
  metricId: string
  metricKey: string
  providerAccountId: string
  providerType: string
  providerMetricId: string
  config: MetricConfig
  providerMetric: NormalizedMetric | undefined
  cache: ProviderCacheSummary | undefined
  resolvedUsageFilter: UsageFilter
  normalizedUsageFilter: string
  projectedHistory: ProjectedHistoryPoint[]
  snapshots: SnapshotPoint[]
  dynamic?: boolean
}

export type DashboardProjectionInput = {
  config: NormalizedConfig
  profileId: string
  generatedAt: string
  selectedRange?: RangeKey
  providers: Array<ProviderAccountProjection>
  snapshots?: Map<string, SnapshotPoint[]>
  storedHistory?: Map<string, ProjectedHistoryPoint[]>
  dynamicSubscriptions?: Map<string, DynamicSubscription[]>
}

export type ProjectProviderMetricsInput = {
  config: NormalizedConfig
  subscriptionIds: string[]
  dynamicProviderIds?: string[]
  providers: Array<ProviderAccountProjection>
  snapshots?: Map<string, SnapshotPoint[]>
  storedHistory?: Map<string, ProjectedHistoryPoint[]>
  dynamicSubscriptions?: Map<string, DynamicSubscription[]>
  now: string
}

// --- usage filter normalization ---

// Poe history filters default to `usage_type == "API"` unless config sets
// `usageTypes`. `apiKeyName` / `botName` narrow further when configured.
export function resolveUsageFilter(providerType: string, configFilter: UsageFilter | undefined): UsageFilter {
  const result: UsageFilter = {}
  if (configFilter?.usageTypes !== undefined) {
    result.usageTypes = [...configFilter.usageTypes].sort()
  } else if (providerType === "poe") {
    result.usageTypes = ["API"]
  }
  if (configFilter?.apiKeyName !== undefined) result.apiKeyName = configFilter.apiKeyName
  if (configFilter?.botName !== undefined) result.botName = configFilter.botName
  return result
}

export function normalizeUsageFilter(filter: UsageFilter): string {
  const parts: string[] = []
  if (filter.usageTypes !== undefined && filter.usageTypes.length > 0) {
    // usageTypes is already canonically sorted by resolveUsageFilter; sort once.
    parts.push(`usageTypes=${filter.usageTypes.join(",")}`)
  }
  if (filter.apiKeyName !== undefined) parts.push(`apiKeyName=${filter.apiKeyName}`)
  if (filter.botName !== undefined) parts.push(`botName=${filter.botName}`)
  return parts.join("|")
}

export function matchesUsageFilter(ev: ProviderHistoryEvent, filter: UsageFilter): boolean {
  if (filter.usageTypes !== undefined) {
    if (ev.usageType === undefined || !filter.usageTypes.includes(ev.usageType)) return false
  }
  if (filter.apiKeyName !== undefined && ev.apiKeyName !== filter.apiKeyName) return false
  if (filter.botName !== undefined && ev.botName !== filter.botName) return false
  return true
}

// --- projection ---

export function projectProviderMetrics(input: ProjectProviderMetricsInput): ProjectedMetric[] {
  const result: ProjectedMetric[] = []
  for (const subscriptionId of input.subscriptionIds) {
    const subscription = input.config.subscriptions.get(subscriptionId)
    if (!subscription) continue
    const providerAccount = input.config.providers.get(subscription.providerId)
    if (!providerAccount) continue
    const providerType = providerAccount.type
    const providerProjection = input.providers.find((p) => p.providerAccountId === subscription.providerId)
    for (const metric of subscription.metrics) {
      const providerMetricId = metric.providerMetricId ?? metric.id
      const metricKey = buildMetricKey(subscription.providerId, subscriptionId, metric.id)
      const matchedProviderMetric = providerProjection?.metrics.find(
        (m) => m.providerMetricId === providerMetricId,
      )
      // Manual providers are config-as-source: if no provider metric was
      // supplied (caller skipped manual.refresh), synthesize one from config
      // via the SAME normalization as the manual provider so sourceConfidence
      // (rolling-freshness-aware) is computed identically in both paths.
      const providerMetric =
        matchedProviderMetric ?? (providerType === "manual" ? normalizeManualMetric(metric, input.now) : undefined)
      const resolvedUsageFilter = resolveUsageFilter(providerType, metric.usageFilter)
      const normalizedUsageFilter = normalizeUsageFilter(resolvedUsageFilter)
      const rawHistory = providerProjection?.historyEvents ?? []
      const liveProjected = rawHistory
        .filter((ev) => ev.providerMetricId === providerMetricId)
        .filter((ev) => matchesUsageFilter(ev, resolvedUsageFilter))
        .map<ProjectedHistoryPoint>((ev) => ({
          sourceTimestamp: ev.sourceTimestamp,
          value: ev.value,
          valueKind: ev.valueKind,
        }))
      const stored = input.storedHistory?.get(metricKey) ?? []
      const projectedHistory = mergeHistoryPoints(liveProjected, stored)
      result.push({
        subscriptionId,
        subscriptionName: subscription.name,
        ...(subscription.ui ? { subscriptionUi: subscription.ui } : {}),
        metricId: metric.id,
        metricKey,
        providerAccountId: subscription.providerId,
        providerType,
        providerMetricId,
        config: metric,
        providerMetric,
        cache: providerProjection?.cache,
        resolvedUsageFilter,
        normalizedUsageFilter,
        projectedHistory,
        snapshots: input.snapshots?.get(metricKey) ?? [],
      })
    }
  }
  // --- dynamic subscriptions ---
  for (const providerId of input.dynamicProviderIds ?? []) {
    const providerAccount = input.config.providers.get(providerId)
    if (!providerAccount) continue
    const providerType = providerAccount.type
    const providerProjection = input.providers.find((p) => p.providerAccountId === providerId)
    const dynamicSubs = input.dynamicSubscriptions?.get(providerId) ?? []

    for (const dynSub of dynamicSubs) {
      for (const providerMetricId of dynSub.providerMetricIds) {
        const matchedMetric = providerProjection?.metrics.find(
          (m) => m.providerMetricId === providerMetricId,
        )
        if (!matchedMetric) continue

        const metricKey = buildMetricKey(providerId, dynSub.id, providerMetricId)
        const syntheticConfig = synthesizeMetricConfig(matchedMetric, providerMetricId)
        result.push({
          subscriptionId: dynSub.id,
          subscriptionName: dynSub.name,
          ...(dynSub.identity ? { subscriptionIdentity: dynSub.identity } : {}),
          ...(dynSub.ui ? { subscriptionUi: dynSub.ui } : {}),
          metricId: providerMetricId,
          metricKey,
          providerAccountId: providerId,
          providerType,
          providerMetricId,
          config: syntheticConfig,
          providerMetric: matchedMetric,
          cache: providerProjection?.cache,
          resolvedUsageFilter: {},
          normalizedUsageFilter: "",
          projectedHistory: [],
          snapshots: input.snapshots?.get(metricKey) ?? [],
          dynamic: true,
        })
      }
    }
  }
  return result
}

function synthesizeMetricConfig(m: NormalizedMetric, providerMetricId: string): MetricConfig {
  const config: MetricConfig = {
    id: providerMetricId,
    providerMetricId,
    label: m.label,
    unit: m.unit,
    sourceValueKind: m.sourceValueKind,
    display: { module: inferDisplayModule(m) },
  }
  if (m.notes !== undefined) config.notes = m.notes
  if (m.window !== undefined) config.window = m.window
  return config
}

function inferDisplayModule(m: NormalizedMetric): DisplayModule {
  if (m.suggestedDisplayModule !== undefined) return m.suggestedDisplayModule
  if (m.sourceValueKind === "status") return "manual-status-card"
  if ((m.sourceValueKind === "gauge-used" || m.sourceValueKind === "gauge-remaining") && m.limit !== undefined) {
    return "period-quota-card"
  }
  if (m.window?.kind === "rolling") return "rolling-window-card"
  if (m.window?.kind === "calendar" || m.window?.kind === "fixed") return "period-quota-card"
  return "balance-card"
}

function mergeHistoryPoints(a: ProjectedHistoryPoint[], b: ProjectedHistoryPoint[]): ProjectedHistoryPoint[] {
  if (b.length === 0) return a
  if (a.length === 0) return b
  const byTs = new Map<string, ProjectedHistoryPoint>()
  for (const p of a) byTs.set(p.sourceTimestamp, p)
  for (const p of b) byTs.set(p.sourceTimestamp, p)
  return Array.from(byTs.values()).sort((x, y) => x.sourceTimestamp.localeCompare(y.sourceTimestamp))
}

// --- payload builder ---

export function buildDashboardPayload(input: DashboardProjectionInput): DashboardPayload {
  const profile = input.config.profiles.get(input.profileId)
  if (!profile) throw new Error(`buildDashboardPayload: unknown profileId ${input.profileId}`)
  const selectedRange = input.selectedRange ?? DEFAULT_RANGE

  const projected = projectProviderMetrics({
    config: input.config,
    subscriptionIds: profile.subscriptionIds,
    ...(profile.dynamicProviderIds ? { dynamicProviderIds: profile.dynamicProviderIds } : {}),
    providers: input.providers,
    now: input.generatedAt,
    ...(input.snapshots !== undefined ? { snapshots: input.snapshots } : {}),
    ...(input.storedHistory !== undefined ? { storedHistory: input.storedHistory } : {}),
    ...(input.dynamicSubscriptions !== undefined ? { dynamicSubscriptions: input.dynamicSubscriptions } : {}),
  })

  const subscriptions = buildSubscriptions(projected, input.generatedAt, selectedRange)
  const summaryGroups = buildSummaryGroups(
    projected.filter((p) => !p.dynamic),
    selectedRange,
    input.generatedAt,
  )

  return {
    profile: { id: profile.id, name: profile.name },
    generatedAt: input.generatedAt,
    ranges: ALL_RANGES,
    selectedRange,
    summaryGroups,
    subscriptions,
  }
}

function buildSubscriptions(
  projected: ProjectedMetric[],
  generatedAt: string,
  selectedRange: RangeKey,
): DashboardSubscription[] {
  const bySub = new Map<string, ProjectedMetric[]>()
  for (const p of projected) {
    const arr = bySub.get(p.subscriptionId) ?? []
    arr.push(p)
    bySub.set(p.subscriptionId, arr)
  }
  const subs: DashboardSubscription[] = []
  for (const [subId, metrics] of bySub) {
    const first = metrics[0]!
    const dashboardMetrics = metrics.map((m) => buildDashboardMetric(m, generatedAt, selectedRange))
    const subscriptionStatuses: MetricStatus[] = dashboardMetrics.map((m) => m.status)
    // Spec ~918: subscription status escalates from metric statuses AND
    // subscription-level cache status/errors (e.g. an `unavailable` cache or a
    // degraded refresh carrying provider errors must raise the subscription
    // badge even when individual metrics compute `ok`).
    if (first.cache) {
      subscriptionStatuses.push(first.cache.status)
      if (first.cache.errors.length > 0) subscriptionStatuses.push("warn")
    }
    const subscriptionStatus = highestStatus(subscriptionStatuses)
    const sub: DashboardSubscription = {
      id: subId,
      name: first.subscriptionName,
      status: subscriptionStatus,
      metrics: dashboardMetrics,
    }
    if (first.subscriptionIdentity) sub.identity = first.subscriptionIdentity
    if (first.subscriptionUi) sub.ui = first.subscriptionUi
    if (first.cache) sub.lastRefreshAt = first.cache.fetchedAt
    const errors = collectSubscriptionErrors(first.cache)
    if (errors.length > 0) sub.errors = errors
    subs.push(sub)
  }
  return subs
}

function collectSubscriptionErrors(
  cache: ProviderCacheSummary | undefined,
): Array<{ message: string; stale: boolean }> {
  if (!cache || cache.errors.length === 0) return []
  const stale = cache.status === "stale"
  return cache.errors.map((e) => ({ message: e.message, stale }))
}

function buildDashboardMetric(
  p: ProjectedMetric,
  generatedAt: string,
  selectedRange: RangeKey,
): DashboardMetric {
  const config = p.config
  const pm = p.providerMetric
  const providerType = p.providerType

  const limit = config.limit ?? pm?.limit
  const providerRemaining = config.remaining ?? pm?.remaining
  const providerUsed = config.used ?? pm?.used

  // Over-limit: ONLY applies to gauge-remaining where remaining > limit
  // (the Poe-style quirk where purchased credits exceed plan limit).
  // Do NOT extend to gauge-used or percent-based: those have legitimate
  // used>=limit states that should show critical via threshold logic.
  // When triggered: used is zeroed (display hack) but remaining is preserved
  // so the UI shows remaining > limit with used=0. percentUsed is omitted.
  const isOverLimit =
    pm?.sourceValueKind === "gauge-remaining" &&
    limit !== undefined &&
    providerRemaining !== undefined &&
    providerRemaining > limit

  let used: number | undefined = providerUsed
  let remaining: number | undefined = providerRemaining
  // Note: remaining is intentionally left as-is when isOverLimit (shows the
  // actual balance); only used is zeroed so percentUsed is not computed.
  if (isOverLimit) {
    used = 0
  } else if (used === undefined && limit !== undefined && remaining !== undefined) {
    used = Math.max(0, limit - remaining)
  }

  let percentUsed: number | undefined
  if (!isOverLimit && limit !== undefined && limit > 0 && used !== undefined) {
    percentUsed = (used / limit) * 100
  }

  const window = buildDashboardWindow(config, pm, generatedAt, p.projectedHistory)
  const sourceConfidence = pm?.sourceConfidence ?? "unknown"
  const rangeStats = buildRangeStats(p, selectedRange, generatedAt)

  const status = computeMetricStatus({
    providerType,
    cache: p.cache,
    providerMetric: pm,
    limit,
    used,
    percentUsed,
    isOverLimit,
    window,
    generatedAt,
    thresholds: config.display.thresholds,
  })

  const display = buildDisplay(config, pm, window, sourceConfidence, p.resolvedUsageFilter)

  const metric: DashboardMetric = {
    id: config.id,
    providerMetricId: p.providerMetricId,
    metricKey: p.metricKey,
    label: config.label,
    unit: config.unit,
    status,
    ...(limit !== undefined ? { limit } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(window ? { window } : {}),
    display,
    ...(percentUsed !== undefined ? { percentUsed } : {}),
    rangeStats,
  }
  return metric
}

function buildDisplay(
  config: MetricConfig,
  providerMetric: NormalizedMetric | undefined,
  window: DashboardWindow | undefined,
  sourceConfidence: "known" | "estimated" | "unknown",
  resolvedUsageFilter: UsageFilter,
): DashboardMetricDisplay {
  const subtitle = window
    ? labelWindow(toLimitWindowForLabel(window), window.resetAt)
    : undefined
  const notes = config.notes ?? providerMetric?.notes
  const updatedAt = config.updatedAt ?? providerMetric?.updatedAt
  const display: DashboardMetricDisplay = {
    module: config.display.module,
    title: config.label,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    sourceConfidence,
    ...(hasUsageFilter(resolvedUsageFilter) ? { usageFilter: resolvedUsageFilter } : {}),
    ...(config.display.thresholds ? { thresholds: config.display.thresholds } : {}),
  }
  return display
}

function hasUsageFilter(filter: UsageFilter): boolean {
  return (
    (filter.usageTypes !== undefined && filter.usageTypes.length > 0) ||
    filter.apiKeyName !== undefined ||
    filter.botName !== undefined
  )
}

// Reconstruct a LimitWindow view for labelWindow(). labelWindow only consumes
// `kind`, `period`, `duration`, so we can synthesize the minimal shape.
function toLimitWindowForLabel(window: DashboardWindow): LimitWindow {
  if (window.kind === "calendar") {
    return {
      kind: "calendar",
      period: inferPeriodFromLabel(window.label),
      timezone: window.timezone ?? "UTC",
    }
  }
  if (window.kind === "rolling") {
    return { kind: "rolling", duration: window.duration ?? "0h" }
  }
  return { kind: "fixed", startsAt: "", resetAt: "" }
}

function inferPeriodFromLabel(label: string): "day" | "week" | "month" | "year" {
  const lower = label.toLowerCase()
  if (lower.startsWith("year")) return "year"
  if (lower.startsWith("month")) return "month"
  if (lower.startsWith("week")) return "week"
  return "day"
}

// --- window composition ---

function buildDashboardWindow(
  config: MetricConfig,
  pm: NormalizedMetric | undefined,
  generatedAt: string,
  history: ProjectedHistoryPoint[],
): DashboardWindow | undefined {
  const configWindow = config.window
  const providerWindow = pm?.window
  if (!configWindow && !providerWindow) return undefined

  if (configWindow) {
    return composeFromConfigWindow(configWindow, providerWindow, generatedAt, history)
  }
  // No config window; use provider window directly.
  return composeFromProviderOnlyWindow(providerWindow!, generatedAt)
}

function composeFromConfigWindow(
  configWindow: LimitWindow,
  providerWindow: LimitWindow | undefined,
  generatedAt: string,
  history: ProjectedHistoryPoint[],
): DashboardWindow {
  if (configWindow.kind === "calendar") {
    // Config anchor wins. Compute next resetAt from the anchor.
    let resetAt: string | undefined
    if (configWindow.anchor) {
      resetAt = computeNextResetAt(configWindow, new Date(generatedAt))
    } else if (configWindow.resetAt) {
      resetAt =
        Date.parse(configWindow.resetAt) > Date.parse(generatedAt) ? configWindow.resetAt : undefined
    }
    // Provider resetAt fills only when config did not produce one AND the
    // provider window has no anchor (i.e., provider is reporting the same
    // one-cycle policy). If config has anchor, provider resetAt must never
    // override — fall back to leaving resetAt undefined.
    if (!resetAt && providerWindow?.kind === "calendar" && !configWindow.anchor && providerWindow.resetAt) {
      resetAt = providerWindow.resetAt
    }
    const label = labelWindow(configWindow, resetAt)
    const w: DashboardWindow = {
      kind: "calendar",
      label,
      timezone: configWindow.timezone,
      ...(resetAt ? { resetAt } : {}),
      ...(configWindow.anchor ? { anchor: configWindow.anchor } : {}),
    }
    return w
  }
  if (configWindow.kind === "rolling") {
    const durationMs = parseDurationToMs(configWindow.duration)
    let windowStartAt: string | undefined
    if (durationMs !== undefined && history.length > 0) {
      const nowMs = Date.parse(generatedAt)
      const earliestMs = Math.min(...history.map((h) => Date.parse(h.sourceTimestamp)))
      if (!Number.isNaN(earliestMs) && nowMs - earliestMs >= durationMs) {
        windowStartAt = new Date(nowMs - durationMs).toISOString()
      }
    }
    // Provider runtime resetAt for a rolling window may fill when present
    // (represents the same rolling policy the config declares).
    let resetAt: string | undefined
    if (providerWindow?.kind === "rolling" && providerWindow.resetAt) {
      resetAt = providerWindow.resetAt
    }
    const label = labelWindow(configWindow, resetAt)
    const w: DashboardWindow = {
      kind: "rolling",
      label,
      duration: configWindow.duration,
      ...(resetAt ? { resetAt } : {}),
      ...(windowStartAt ? { windowStartAt } : {}),
    }
    return w
  }
  // fixed — keep resetAt even when past so status logic can detect expiry.
  const resetAt = configWindow.resetAt
  const label = labelWindow(configWindow, resetAt)
  const w: DashboardWindow = {
    kind: "fixed",
    label,
    resetAt,
  }
  return w
}

function composeFromProviderOnlyWindow(
  providerWindow: LimitWindow,
  generatedAt: string,
): DashboardWindow {
  if (providerWindow.kind === "calendar") {
    const resetAt =
      providerWindow.resetAt && Date.parse(providerWindow.resetAt) > Date.parse(generatedAt)
        ? providerWindow.resetAt
        : undefined
    return {
      kind: "calendar",
      label: labelWindow(providerWindow, resetAt),
      timezone: providerWindow.timezone,
      ...(resetAt ? { resetAt } : {}),
      ...(providerWindow.anchor ? { anchor: providerWindow.anchor } : {}),
    }
  }
  if (providerWindow.kind === "rolling") {
    const resetAt =
      providerWindow.resetAt && Date.parse(providerWindow.resetAt) > Date.parse(generatedAt)
        ? providerWindow.resetAt
        : undefined
    return {
      kind: "rolling",
      label: labelWindow(providerWindow, resetAt),
      duration: providerWindow.duration,
      ...(resetAt ? { resetAt } : {}),
    }
  }
  const resetAt =
    Date.parse(providerWindow.resetAt) > Date.parse(generatedAt) ? providerWindow.resetAt : undefined
  return {
    kind: "fixed",
    label: labelWindow(providerWindow, resetAt),
    ...(resetAt ? { resetAt } : {}),
  }
}

// --- range stats ---

function buildRangeStats(
  p: ProjectedMetric,
  selectedRange: RangeKey,
  generatedAt: string,
): DashboardRangeStats {
  const rangeMs = RANGE_MS[selectedRange]
  const nowMs = Date.parse(generatedAt)
  const rangeStartIso = new Date(nowMs - rangeMs).toISOString()

  const consumptionEvents = p.projectedHistory.filter(
    (h) => h.valueKind === "consumption" && Date.parse(h.sourceTimestamp) >= Date.parse(rangeStartIso),
  )
  if (consumptionEvents.length > 0) {
    const consumption = consumptionEvents.reduce((s, e) => s + e.value, 0)
    const rangeHours = rangeMs / 3_600_000
    return {
      range: selectedRange,
      source: "provider-history",
      consumption,
      burnRate: { value: consumption / rangeHours, per: "hour" },
    }
  }

  // No provider history. Try snapshot delta.
  const snap = computeSnapshotConsumption(p, selectedRange, nowMs)
  if (snap !== undefined) {
    const rangeHours = rangeMs / 3_600_000
    return {
      range: selectedRange,
      source: "snapshot-delta",
      consumption: snap,
      burnRate: { value: snap / rangeHours, per: "hour" },
    }
  }

  if (p.providerType === "manual") {
    return { range: selectedRange, source: "manual" }
  }
  return { range: selectedRange, source: "unknown" }
}

function computeSnapshotConsumption(
  p: ProjectedMetric,
  selectedRange: RangeKey,
  nowMs: number,
): number | undefined {
  if (p.snapshots.length < 2) return undefined
  const rangeMs = RANGE_MS[selectedRange]
  const rangeStartMs = nowMs - rangeMs
  const inRange = p.snapshots
    .filter((s) => {
      const ts = Date.parse(s.timestamp)
      return ts >= rangeStartMs && ts <= nowMs
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  if (inRange.length < 2) return undefined
  const earlier = inRange[0]!
  const later = inRange[inRange.length - 1]!
  const ea = earlier.authoritativeValue ?? earlier.used ?? earlier.remaining
  const la = later.authoritativeValue ?? later.used ?? later.remaining
  if (ea === undefined || la === undefined) return undefined
  const kind = earlier.sourceValueKind
  if (kind === "gauge-remaining") return Math.max(0, ea - la)
  if (kind === "counter" || kind === "gauge-used") return Math.max(0, la - ea)
  return undefined
}

// --- status ---

function statusRank(s: MetricStatus): number {
  return STATUS_PRECEDENCE.indexOf(s)
}

function highestStatus(statuses: MetricStatus[]): MetricStatus {
  return statuses.reduce(
    (acc, s) => (statusRank(s) > statusRank(acc) ? s : acc),
    "ok" as MetricStatus,
  )
}

function computeMetricStatus(input: {
  providerType: string
  cache: ProviderCacheSummary | undefined
  providerMetric: NormalizedMetric | undefined
  limit: number | undefined
  used: number | undefined
  percentUsed: number | undefined
  isOverLimit: boolean
  window: DashboardWindow | undefined
  generatedAt: string
  thresholds: MetricConfig["display"]["thresholds"] | undefined
}): MetricStatus {
  const { cache, providerMetric, limit, used, percentUsed, isOverLimit, window, generatedAt, thresholds } = input

  // Fixed window past resetAt -> expired.
  if (window?.kind === "fixed" && window.resetAt && Date.parse(window.resetAt) <= Date.parse(generatedAt)) {
    return "expired"
  }
  // Provider metric missing -> unavailable (config-declared but provider returned nothing).
  if (!providerMetric) return "unavailable"
  if (cache?.status === "unavailable") return "unavailable"

  if (isOverLimit) {
    // Over-limit: status ok unless stale forces a higher-precedence mark.
    if (cache?.staleAfter && Date.parse(cache.staleAfter) < Date.parse(generatedAt)) {
      return "stale"
    }
    return "ok"
  }

  const statuses: MetricStatus[] = ["ok"]
  if (percentUsed !== undefined) {
    const warnT = thresholds?.warnPercentUsed ?? 80
    const critT = thresholds?.criticalPercentUsed ?? 95
    if (percentUsed >= critT) statuses.push("critical")
    else if (percentUsed >= warnT) statuses.push("warn")
  }
  if (limit !== undefined && used !== undefined && used > limit) {
    statuses.push("critical")
  }
  if (window?.kind === "rolling" && limit !== undefined && used !== undefined && used >= limit) {
    statuses.push("critical")
  }
  if (cache?.staleAfter && Date.parse(cache.staleAfter) < Date.parse(generatedAt)) {
    statuses.push("stale")
  }
  return highestStatus(statuses)
}

// --- duration parsing ---

function parseDurationToMs(duration: string): number | undefined {
  const match = /^(\d+)(m|h|d)$/.exec(duration)
  if (!match) return undefined
  const value = Number(match[1])
  const unit = match[2]
  if (unit === "m") return value * 60_000
  if (unit === "h") return value * 3_600_000
  return value * 86_400_000
}

export type { SummaryGroup }
