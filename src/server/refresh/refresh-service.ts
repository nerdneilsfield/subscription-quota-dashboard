// Refresh service: per-provider-account singleflight with global concurrency
// cap (default 2). Orchestrates provider adapter calls, projects results into
// storage rows inside a single transaction, and returns a fresh dashboard
// payload (or stale payload + safe error on provider failure when cache exists).
//
// Key design points (see task-9-brief Step 3):
// - Singleflight is keyed by providerAccountId: concurrent refreshes for the
//   same account share one provider adapter call.
// - Cross-profile watermark: when refreshing a provider account, ALL configured
//   metrics across the FULL config for that account are passed to the adapter,
//   so history for hidden profiles is not skipped.
// - All storage writes (cache, snapshots, history, importState, refreshRun) are
//   wrapped in storage.transaction().
// - Rate limiting: a "new" refresh (no in-flight singleflight) for a provider
//   account consumes a rate-limit token keyed `ip:profileId:providerAccountId`;
//   a joined singleflight does NOT consume a token.

import type { NormalizedConfig, MetricConfig, DynamicSubscription } from "../../shared/domain"
import type { RangeKey } from "../../shared/domain"
import type { DashboardPayload } from "../../shared/dashboard-payload"
import type { DashboardStorage, ProjectedHistoryEvent, ProviderCacheRecord, SnapshotInsert } from "../storage/repositories"
import type { NormalizedMetric, ProviderAdapter, ProviderHistoryEvent, ProviderRefreshInput, ProviderRefreshResult } from "../providers/types"
import type { RateLimiter } from "../auth/rate-limit"
import {
  buildDashboardPayload,
  matchesUsageFilter,
  normalizeUsageFilter,
  resolveUsageFilter,
  type ProviderAccountProjection,
  type ProviderCacheSummary,
  type ProjectedHistoryPoint,
  type SnapshotPoint,
  type UsageFilter,
} from "../dashboard/project"
import { buildMetricKey } from "../../shared/metric-key"

const RANGE_MS: Record<RangeKey, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
}

export type RefreshRequest = { profileId: string; ip: string; range?: RangeKey }

export type RefreshOutcome =
  | { status: "ok"; payload: DashboardPayload }
  | { status: "degraded"; payload: DashboardPayload; error: string }
  | { status: "rate_limited"; providerAccountId: string }
  | { status: "fatal"; error: string }

export type RefreshService = {
  refreshProfile(req: RefreshRequest): Promise<RefreshOutcome>
  getPayload(profileId: string, range: RangeKey): DashboardPayload
  isInFlight(providerAccountId: string): boolean
}

export type RefreshServiceDeps = {
  config: NormalizedConfig
  storage: DashboardStorage
  providers: Map<string, ProviderAdapter>
  now: () => Date
  rateLimiter?: RateLimiter
  concurrencyLimit?: number
}

type SubscriptionMetric = { subscriptionId: string; metric: MetricConfig }

function buildImportStateInput(rec: { maxCreationTime?: number; importedQueryIdsAtMaxCreationTime: string[] }): { maxCreationTime?: number; importedQueryIdsAtMaxCreationTime: string[] } {
  const out: { maxCreationTime?: number; importedQueryIdsAtMaxCreationTime: string[] } = {
    importedQueryIdsAtMaxCreationTime: rec.importedQueryIdsAtMaxCreationTime,
  }
  if (rec.maxCreationTime !== undefined) out.maxCreationTime = rec.maxCreationTime
  return out
}

export function createRefreshService(deps: RefreshServiceDeps): RefreshService {
  const { config, storage, providers, now } = deps
  const concurrencyLimit = deps.concurrencyLimit ?? 8
  const rateLimiter = deps.rateLimiter

  // Singleflight: in-flight provider-account refresh promises.
  const inFlight = new Map<string, Promise<AccountRefreshOutcome>>()
  // Concurrency semaphore.
  let active = 0
  const waitQueue: Array<() => void> = []

  async function acquireSlot(): Promise<void> {
    if (active < concurrencyLimit) {
      active++
      return
    }
    await new Promise<void>((resolve) => waitQueue.push(resolve))
    active++
  }

  function releaseSlot(): void {
    active--
    const next = waitQueue.shift()
    if (next !== undefined) next()
  }

  function collectSubscriptionMetricsForAccount(paId: string): SubscriptionMetric[] {
    const out: SubscriptionMetric[] = []
    for (const sub of config.subscriptions.values()) {
      if (sub.providerId !== paId) continue
      for (const metric of sub.metrics) {
        out.push({ subscriptionId: sub.id, metric })
      }
    }
    return out
  }

  function collectVisibleProviderAccounts(profileId: string): string[] {
    const profile = config.profiles.get(profileId)
    if (!profile) return []
    const seen = new Set<string>()
    for (const subId of profile.subscriptionIds) {
      const sub = config.subscriptions.get(subId)
      if (sub) seen.add(sub.providerId)
    }
    for (const dynProviderId of profile.dynamicProviderIds ?? []) {
      seen.add(dynProviderId)
    }
    return Array.from(seen)
  }

  type AccountRefreshOutcome =
    | { ok: true; result: ProviderRefreshResult; fresh: boolean; hadErrors: boolean }
    | { ok: false; error: string }

  // Refresh ONE provider account (singleflight + concurrency cap + adapter call).
  // No rate-limiting here: the caller decides token consumption.
  function refreshProviderAccount(paId: string, staleCache: ProviderCacheRecord | undefined): Promise<AccountRefreshOutcome> {
    const existing = inFlight.get(paId)
    if (existing !== undefined) {
      return existing.then((o) => o.ok ? { ok: true, result: o.result, fresh: false, hadErrors: o.hadErrors } : { ok: false, error: o.error })
    }

    const providerAccount = config.providers.get(paId)
    const adapter = providerAccount ? providers.get(providerAccount.type) : undefined
    const allMetrics = collectSubscriptionMetricsForAccount(paId)

    const promise = (async (): Promise<AccountRefreshOutcome> => {
      if (!providerAccount || !adapter) {
        return { ok: false, error: `no adapter configured for provider account ${paId}` }
      }
      await acquireSlot()
      try {
        const runtime = config.providerRuntime.get(paId) ?? { available: false }
        const prevImport = storage.importState.get(paId)
        const input: ProviderRefreshInput = {
          providerAccountId: paId,
          provider: providerAccount,
          runtime,
          now: now().toISOString(),
          metrics: allMetrics.map((m) => m.metric),
          ...(prevImport !== undefined
            ? { importState: buildImportStateInput(prevImport) }
            : {}),
        }
        const result = await adapter.refresh(input)
        const hadErrors = (result.errors ?? []).length > 0
        return { ok: true, result, fresh: true, hadErrors }
      } catch (e) {
        const message = e instanceof Error ? e.message : "provider refresh failed"
        return { ok: false, error: message }
      } finally {
        releaseSlot()
      }
    })()

    // Store the in-flight promise carrying the raw result + write outcome.
    const tracked = promise.then(async (outcome): Promise<AccountRefreshOutcome & { result?: ProviderRefreshResult; error?: string }> => {
      if (outcome.ok && outcome.fresh) {
        // Persist the fresh result inside a transaction.
        try {
          writeProviderResult(paId, outcome.result, allMetrics)
        } catch (writeErr) {
          // Storage write failure must not crash the refresh scheduler.
          const msg = writeErr instanceof Error ? writeErr.message : "storage write failed"
          console.error(`writeProviderResult failed for ${paId}: ${msg}`)
          return { ok: false, error: msg }
        }
      }
      return outcome
    })

    inFlight.set(paId, tracked as Promise<AccountRefreshOutcome>)
    // Clean up after settlement so a later refresh starts a new singleflight.
    tracked.finally(() => {
      if (inFlight.get(paId) === tracked) inFlight.delete(paId)
    })

    return tracked
  }

  // Persist a provider refresh result (cache + snapshots + history + importState)
  // inside storage.transaction.
  function writeProviderResult(
    paId: string,
    result: ProviderRefreshResult,
    subMetrics: SubscriptionMetric[],
  ): void {
    const providerAccount = config.providers.get(paId)
    const providerType = providerAccount?.type ?? "manual"
    const tsIso = result.fetchedAt

    const snapshotRows: SnapshotInsert[] = []
    const historyRows: ProjectedHistoryEvent[] = []

    for (const { subscriptionId, metric } of subMetrics) {
      const providerMetricId = metric.providerMetricId ?? metric.id
      const matched = result.metrics.find((m) => m.providerMetricId === providerMetricId)
      const metricKey = buildMetricKey(paId, subscriptionId, metric.id)
      const filter = resolveUsageFilter(providerType, metric.usageFilter)
      const normalizedFilter = normalizeUsageFilter(filter)

      // Snapshot: only for declared metrics that the provider returned.
      if (matched) {
        const snap: SnapshotInsert = {
          providerAccountId: paId,
          subscriptionId,
          metricId: metric.id,
          metricKey,
          timestamp: tsIso,
          source: providerType === "manual" ? "manual" : "provider",
          sourceValueKind: matched.sourceValueKind ?? metric.sourceValueKind ?? "status",
        }
        if (matched.authoritativeValue !== undefined) snap.authoritativeValue = matched.authoritativeValue
        if (matched.used !== undefined) snap.used = matched.used
        if (matched.remaining !== undefined) snap.remaining = matched.remaining
        if (matched.limit !== undefined) snap.limit = matched.limit
        snapshotRows.push(snap)
      }

      // History: project raw provider history to this metric's key + filter.
      for (const ev of result.historyEvents ?? []) {
        if (ev.providerMetricId !== providerMetricId) continue
        if (!matchesUsageFilter(ev, filter)) continue
        const row: ProjectedHistoryEvent = {
          providerAccountId: paId,
          metricKey,
          providerMetricId,
          normalizedUsageFilter: normalizedFilter,
          sourceTimestamp: ev.sourceTimestamp,
          value: ev.value,
          valueKind: ev.valueKind,
          pageCursor: ev.pageCursor ?? "",
          rowIndex: ev.rowIndex ?? 0,
        }
        if (ev.providerEventId !== undefined) row.providerEventId = ev.providerEventId
        if (ev.raw !== undefined) row.raw = ev.raw
        historyRows.push(row)
      }
    }

    // Dynamic subscription snapshots: write a snapshot row for each metric
    // declared under a DynamicSubscription returned by the adapter. Skip
    // status/error metrics (no numeric value -> dead NULL row). History is
    // not tracked for dynamic subscriptions (adapters produce none).
    if (result.dynamicSubscriptions) {
      for (const dynSub of result.dynamicSubscriptions) {
        for (const providerMetricId of dynSub.providerMetricIds) {
          const matched = result.metrics.find((m) => m.providerMetricId === providerMetricId)
          if (!matched) continue
          // Skip status/error metrics: they have no numeric value to snapshot
          if (matched.sourceValueKind === "status") continue
          if (matched.used === undefined && matched.remaining === undefined && matched.authoritativeValue === undefined) continue
          const metricKey = buildMetricKey(paId, dynSub.id, providerMetricId)
          const snap: SnapshotInsert = {
            providerAccountId: paId,
            subscriptionId: dynSub.id,
            metricId: providerMetricId,
            metricKey,
            timestamp: tsIso,
            source: "provider",
            sourceValueKind: matched.sourceValueKind,
          }
          if (matched.authoritativeValue !== undefined) snap.authoritativeValue = matched.authoritativeValue
          if (matched.used !== undefined) snap.used = matched.used
          if (matched.remaining !== undefined) snap.remaining = matched.remaining
          if (matched.limit !== undefined) snap.limit = matched.limit
          snapshotRows.push(snap)
        }
      }
    }

    const cacheStatus: ProviderCacheRecord["status"] = (() => {
      const hasErrors = (result.errors ?? []).length > 0
      const hasMetrics = result.metrics.length > 0
      if (hasErrors && !hasMetrics) return "unavailable"
      if (hasErrors && hasMetrics) return "stale"
      return "ok"
    })()

    // C3 fix: When the adapter returned zero metrics AND has errors (failure path),
    // preserve the last-known-good normalized metrics so dynamic subscription
    // cards don't disappear. The coalesce on dynamic_subscriptions_json already
    // preserves the subscription list; this extends the same semantics to metrics.
    // Additionally, preserve the old fetchedAt/staleAfter so the cache doesn't
    // pretend to be fresh when the refresh actually failed.
    //
    // P1.6: When the adapter returned SOME metrics AND has errors (partial
    // failure), merge by providerMetricId: update metrics that were returned,
    // preserve old ones for metrics the adapter couldn't produce this cycle.
    // This prevents cards from disappearing on partial outages (e.g. xAI weekly
    // endpoint fails but monthly succeeds -> weekly card stays from last-good).
    let normalizedForCache = result.metrics as Array<Record<string, unknown>>
    let dynamicSubsForCache = result.dynamicSubscriptions
    let cacheFetchedAt = result.fetchedAt
    let cacheStaleAfter = result.staleAfter
    if (result.metrics.length === 0 && (result.errors ?? []).length > 0) {
      // Total failure: preserve old metrics + old dynamicSubscriptions + old timestamps
      const existing = storage.providerCache.get(paId)
      if (existing) {
        normalizedForCache = existing.normalized.metrics
        cacheFetchedAt = existing.fetchedAt
        cacheStaleAfter = existing.staleAfter
        if (dynamicSubsForCache === undefined && existing.dynamicSubscriptions !== undefined) {
          dynamicSubsForCache = existing.dynamicSubscriptions
        }
      }
    } else if ((result.errors ?? []).length > 0 && result.metrics.length > 0) {
      // Partial failure: merge returned metrics into last-known-good.
      // Use the adapter's explicit preserveSubscriptionIds (subscription IDs
      // whose old metrics should be preserved) if available. Otherwise fall
      // back to inference: preserve old metrics for subscriptions not returned.
      const existing = storage.providerCache.get(paId)
      if (existing) {
        const returnedIds = new Set(result.metrics.map((m) => (m as NormalizedMetric).providerMetricId))

        const failedSubIds = result.preserveSubscriptionIds
          ? new Set(result.preserveSubscriptionIds)
          : null

        // Map: subscription ID -> set of old providerMetricIds to preserve
        const preserveBySubId = new Map<string, Set<string>>()
        const oldIdsToPreserve = new Set<string>()
        if (existing.dynamicSubscriptions) {
          for (const oldDs of existing.dynamicSubscriptions) {
            let shouldPreserve: boolean
            if (failedSubIds !== null) {
              shouldPreserve = failedSubIds.has(oldDs.id)
            } else {
              shouldPreserve = !result.dynamicSubscriptions?.some((nds) => nds.id === oldDs.id)
            }
            if (shouldPreserve) {
              const idSet = new Set<string>()
              for (const id of oldDs.providerMetricIds) {
                oldIdsToPreserve.add(id)
                idSet.add(id)
              }
              preserveBySubId.set(oldDs.id, idSet)
            }
          }
        }

        const merged = existing.normalized.metrics.filter((oldMetric) => {
          const old = oldMetric as NormalizedMetric
          return !returnedIds.has(old.providerMetricId) && oldIdsToPreserve.has(old.providerMetricId)
        })
        merged.push(...(result.metrics as Array<Record<string, unknown>>))
        normalizedForCache = merged

        // dynamicSubscriptions: discovery succeeded -> current subs are
        // authoritative. But for failed subs, union the preserved old metric
        // IDs back into their providerMetricIds so the projection layer
        // can still find the preserved metrics.
        if (result.dynamicSubscriptions) {
          dynamicSubsForCache = result.dynamicSubscriptions.map((ds) => {
            const preserved = preserveBySubId.get(ds.id)
            if (preserved === undefined) return ds
            // Union: new IDs + preserved old IDs not in new set
            const newIds = new Set(ds.providerMetricIds)
            const preservedOnly = [...preserved].filter((id) => !newIds.has(id))
            return { ...ds, providerMetricIds: [...ds.providerMetricIds, ...preservedOnly] }
          })
        }
      }
    }

    const cacheRecord: ProviderCacheRecord = {
      providerAccountId: paId,
      fetchedAt: cacheFetchedAt,
      staleAfter: cacheStaleAfter,
      status: cacheStatus,
      normalized: { metrics: normalizedForCache },
      errors: result.errors ?? [],
      ...(dynamicSubsForCache !== undefined ? { dynamicSubscriptions: dynamicSubsForCache } : {}),
    }

    storage.transaction(() => {
      storage.providerCache.upsert(cacheRecord)
      storage.snapshots.insertMany(snapshotRows)
      storage.historyEvents.insertMany(historyRows)
      if (result.nextImportState !== undefined) {
        storage.importState.upsert({
          providerAccountId: paId,
          importedQueryIdsAtMaxCreationTime: result.nextImportState.importedQueryIdsAtMaxCreationTime,
          updatedAt: tsIso,
          ...(result.nextImportState.maxCreationTime !== undefined ? { maxCreationTime: result.nextImportState.maxCreationTime } : {}),
        })
      }
    })
  }

  async function refreshProfile(req: RefreshRequest): Promise<RefreshOutcome> {
    const profile = config.profiles.get(req.profileId)
    if (!profile) return { status: "fatal", error: "unknown profile" }

    const range: RangeKey = req.range ?? "24h"
    const paIds = collectVisibleProviderAccounts(req.profileId)
    if (paIds.length === 0) {
      // No provider accounts to refresh: return current payload.
      const payload = buildPayloadFromStorage(req.profileId, now().toISOString(), range)
      return { status: "ok", payload }
    }

    // Rate-limit check for NEW (not in-flight) provider accounts. A joined
    // singleflight does not consume a token.
    for (const paId of paIds) {
      if (!isInFlight(paId)) {
        if (rateLimiter) {
          const key = `${req.ip}:${req.profileId}:${paId}`
          if (!rateLimiter.check(key)) {
            return { status: "rate_limited", providerAccountId: paId }
          }
        }
      }
    }

    // Read existing cache BEFORE provider calls (stale fallback).
    const staleCaches = new Map<string, ProviderCacheRecord>()
    for (const paId of paIds) {
      const c = storage.providerCache.get(paId)
      if (c) staleCaches.set(paId, c)
    }

    const startedAt = now().toISOString()
    const runId = storage.refreshRuns.insertStarted({ startedAt, providerAccountIds: paIds })

    const outcomes = await Promise.all(
      paIds.map((paId) => refreshProviderAccount(paId, staleCaches.get(paId))),
    )

    const errors: Array<{ message: string }> = []
    const warnings: string[] = []
    let anyOk = false
    for (const o of outcomes) {
      if (o.ok) {
        if (o.hadErrors) {
          // Adapter resolved but returned errors alongside metrics (partial success)
          warnings.push(`${paIds[outcomes.indexOf(o)]}: adapter reported errors`)
        } else {
          anyOk = true
        }
      } else {
        errors.push({ message: o.error })
      }
    }

    storage.refreshRuns.finish({
      id: runId,
      finishedAt: now().toISOString(),
      status: errors.length === 0 && warnings.length === 0 ? "ok" : "error",
      errors,
    })

    const payload = buildPayloadFromStorage(req.profileId, now().toISOString(), range)

    if (!anyOk && errors.length > 0) {
      // If a stale cache exists for at least one account, serve degraded.
      if (paIds.some((paId) => staleCaches.has(paId))) {
        const safeError = errors.map((e) => e.message).join("; ")
        return { status: "degraded", payload, error: safeError }
      }
      return { status: "fatal", error: errors.map((e) => e.message).join("; ") }
    }
    if (errors.length > 0) {
      const safeError = errors.map((e) => e.message).join("; ")
      return { status: "degraded", payload, error: safeError }
    }
    if (warnings.length > 0) {
      const safeWarning = warnings.join("; ")
      return { status: "degraded", payload, error: safeWarning }
    }

    return { status: "ok", payload }
  }

  // Build a dashboard payload by reading storage (provider_cache + manual config
  // synthesis + stored history). Never calls provider adapters.
  function buildPayloadFromStorage(profileId: string, generatedAt: string, range: RangeKey): DashboardPayload {
    const profile = config.profiles.get(profileId)!
    const paIds = collectVisibleProviderAccounts(profileId)

    const providerProjections: ProviderAccountProjection[] = []
    for (const paId of paIds) {
      const cache = storage.providerCache.get(paId)
      const cacheSummary: ProviderCacheSummary | undefined = cache
        ? { fetchedAt: cache.fetchedAt, staleAfter: cache.staleAfter, status: cache.status, errors: cache.errors }
        : undefined
      const metrics: NormalizedMetric[] = cache
        ? (cache.normalized.metrics as unknown as NormalizedMetric[])
        : []
      providerProjections.push({
        providerAccountId: paId,
        metrics,
        ...(cacheSummary !== undefined ? { cache: cacheSummary } : {}),
      })
    }

    // Stored history + snapshots per metric key. Snapshots feed the
    // snapshot-delta rangeStats path for metrics that have no provider-history
    // consumption events (e.g. gauge-remaining balances, manual gauges).
    const storedHistory = new Map<string, ProjectedHistoryPoint[]>()
    const snapshots = new Map<string, SnapshotPoint[]>()
    const rangeMs = RANGE_MS[range] ?? RANGE_MS["24h"]!
    const rangeStart = new Date(Date.parse(generatedAt) - rangeMs).toISOString()
    const rangeEnd = generatedAt
    for (const subId of profile.subscriptionIds) {
      const sub = config.subscriptions.get(subId)
      if (!sub) continue
      for (const metric of sub.metrics) {
        const metricKey = buildMetricKey(sub.providerId, subId, metric.id)
        const rows = storage.historyEvents.listForMetric(metricKey, rangeStart, rangeEnd)
        if (rows.length > 0) {
          storedHistory.set(metricKey, rows.map((r) => ({ sourceTimestamp: r.sourceTimestamp, value: r.value, valueKind: r.valueKind })))
        }
        const snapRows = storage.snapshots.listForMetric(metricKey, rangeStart, rangeEnd)
        if (snapRows.length > 0) {
          snapshots.set(
            metricKey,
            snapRows.map((s) => {
              const p: SnapshotPoint = { timestamp: s.timestamp, sourceValueKind: s.sourceValueKind }
              if (s.authoritativeValue !== undefined) p.authoritativeValue = s.authoritativeValue
              if (s.used !== undefined) p.used = s.used
              if (s.remaining !== undefined) p.remaining = s.remaining
              if (s.limit !== undefined) p.limit = s.limit
              return p
            }),
          )
        }
      }
    }

    // Dynamic subscriptions: load from cache (persisted by writeProviderResult)
    // and read their snapshots. History is not tracked for dynamic subs --
    // adapters produce none. This feeds projectProviderMetrics' dynamic branch
    // (see src/server/dashboard/project.ts).
    const dynamicSubscriptions = new Map<string, DynamicSubscription[]>()
    for (const dynProviderId of profile.dynamicProviderIds ?? []) {
      const cache = storage.providerCache.get(dynProviderId)
      const dynSubs = cache?.dynamicSubscriptions ?? []
      if (dynSubs.length > 0) {
        dynamicSubscriptions.set(dynProviderId, dynSubs)
      }
      for (const dynSub of dynSubs) {
        for (const providerMetricId of dynSub.providerMetricIds) {
          const metricKey = buildMetricKey(dynProviderId, dynSub.id, providerMetricId)
          const snapRows = storage.snapshots.listForMetric(metricKey, rangeStart, rangeEnd)
          if (snapRows.length > 0) {
            snapshots.set(
              metricKey,
              snapRows.map((s) => {
                const p: SnapshotPoint = { timestamp: s.timestamp, sourceValueKind: s.sourceValueKind }
                if (s.authoritativeValue !== undefined) p.authoritativeValue = s.authoritativeValue
                if (s.used !== undefined) p.used = s.used
                if (s.remaining !== undefined) p.remaining = s.remaining
                if (s.limit !== undefined) p.limit = s.limit
                return p
              }),
            )
          }
        }
      }
    }

    return buildDashboardPayload({
      config,
      profileId,
      generatedAt,
      selectedRange: range,
      providers: providerProjections,
      ...(storedHistory.size > 0 ? { storedHistory } : {}),
      ...(snapshots.size > 0 ? { snapshots } : {}),
      ...(dynamicSubscriptions.size > 0 ? { dynamicSubscriptions } : {}),
    })
  }

  function isInFlight(providerAccountId: string): boolean {
    return inFlight.has(providerAccountId)
  }

  function getPayload(profileId: string, range: RangeKey): DashboardPayload {
    return buildPayloadFromStorage(profileId, now().toISOString(), range)
  }

  return { refreshProfile, getPayload, isInFlight }
}
