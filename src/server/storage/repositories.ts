import type { DynamicSubscription, SourceValueKind } from "../../shared/domain"
import type { DashboardDatabase } from "./database"

export type ProviderCacheRecord = {
  providerAccountId: string
  fetchedAt: string
  staleAfter: string
  status: "ok" | "stale" | "unavailable"
  normalized: { metrics: Array<Record<string, unknown>> }
  errors: Array<{ message: string; retryable: boolean }>
  dynamicSubscriptions?: DynamicSubscription[]
}

export type SnapshotInsert = {
  providerAccountId: string
  subscriptionId: string
  metricId: string
  metricKey: string
  timestamp: string
  source: "provider" | "manual"
  sourceValueKind: SourceValueKind
  authoritativeValue?: number
  used?: number
  remaining?: number
  limit?: number
}

// Read projection of a quota_snapshots row: carries exactly the fields
// computeSnapshotConsumption (src/server/dashboard/project.ts) consumes.
export type SnapshotReadRow = {
  metricKey: string
  timestamp: string
  source: "provider" | "manual"
  sourceValueKind: SourceValueKind
  authoritativeValue?: number
  used?: number
  remaining?: number
  limit?: number
}

export type ImportStateRecord = {
  providerAccountId: string
  maxCreationTime?: number
  importedQueryIdsAtMaxCreationTime: string[]
  updatedAt: string
}

export type ProjectedHistoryEvent = {
  providerAccountId: string
  metricKey: string
  providerMetricId: string
  normalizedUsageFilter: string
  providerEventId?: string
  sourceTimestamp: string
  value: number
  valueKind: "used" | "remaining" | "consumption" | "percentUsed"
  pageCursor: string
  rowIndex: number
  raw?: unknown
}

export type DashboardStorage = {
  providerCache: {
    get(providerAccountId: string): ProviderCacheRecord | undefined
    upsert(record: ProviderCacheRecord): void
  }
  snapshots: {
    insertMany(rows: SnapshotInsert[]): void
    listForMetric(metricKey: string, rangeStart: string, rangeEnd: string): SnapshotReadRow[]
  }
  historyEvents: {
    insertMany(rows: ProjectedHistoryEvent[]): void
    listForMetric(metricKey: string, rangeStart: string, rangeEnd: string): ProjectedHistoryEvent[]
  }
  importState: {
    get(providerAccountId: string): ImportStateRecord | undefined
    upsert(record: ImportStateRecord): void
  }
  refreshRuns: {
    insertStarted(input: { startedAt: string; providerAccountIds: string[] }): number
    finish(input: { id: number; finishedAt: string; status: "ok" | "error"; errors: Array<{ message: string }> }): void
  }
  healthCheck(): boolean
  transaction<T>(fn: () => T): T
}

type ProviderCacheRow = {
  provider_account_id: string
  fetched_at: string
  stale_after: string
  status: string
  normalized_json: string
  error_json: string | null
  dynamic_subscriptions_json: string | null
}

type SnapshotRow = {
  metric_key: string
  timestamp: string
  source: string
  source_value_kind: string
  authoritative_value: number | null
  used: number | null
  remaining: number | null
  limit_value: number | null
}

type HistoryEventRow = {
  provider_account_id: string
  metric_key: string
  provider_metric_id: string
  normalized_usage_filter: string
  provider_event_id: string
  source_timestamp: string
  value: number
  value_kind: string
  raw_json: string | null
}

type ImportStateRow = {
  provider_account_id: string
  max_creation_time: number | null
  imported_query_ids_at_max_json: string
  updated_at: string
}

function fallbackEventId(event: ProjectedHistoryEvent): string {
  return `fallback:${event.providerAccountId}:${event.metricKey}:${event.sourceTimestamp}:${event.pageCursor}:${event.rowIndex}`
}

function decodeProviderCache(row: ProviderCacheRow): ProviderCacheRecord {
  const record: ProviderCacheRecord = {
    providerAccountId: row.provider_account_id,
    fetchedAt: row.fetched_at,
    staleAfter: row.stale_after,
    status: row.status as ProviderCacheRecord["status"],
    normalized: JSON.parse(row.normalized_json) as ProviderCacheRecord["normalized"],
    errors: row.error_json ? (JSON.parse(row.error_json) as ProviderCacheRecord["errors"]) : [],
  }
  if (row.dynamic_subscriptions_json !== null) {
    record.dynamicSubscriptions = JSON.parse(row.dynamic_subscriptions_json) as DynamicSubscription[]
  }
  return record
}

function decodeSnapshot(row: SnapshotRow): SnapshotReadRow {
  const out: SnapshotReadRow = {
    metricKey: row.metric_key,
    timestamp: row.timestamp,
    source: row.source as SnapshotReadRow["source"],
    sourceValueKind: row.source_value_kind as SourceValueKind,
  }
  if (row.authoritative_value !== null) out.authoritativeValue = row.authoritative_value
  if (row.used !== null) out.used = row.used
  if (row.remaining !== null) out.remaining = row.remaining
  if (row.limit_value !== null) out.limit = row.limit_value
  return out
}

function decodeHistoryEvent(row: HistoryEventRow): ProjectedHistoryEvent {
  const event: ProjectedHistoryEvent = {
    providerAccountId: row.provider_account_id,
    metricKey: row.metric_key,
    providerMetricId: row.provider_metric_id,
    normalizedUsageFilter: row.normalized_usage_filter,
    providerEventId: row.provider_event_id,
    sourceTimestamp: row.source_timestamp,
    value: row.value,
    valueKind: row.value_kind as ProjectedHistoryEvent["valueKind"],
    pageCursor: "",
    rowIndex: 0,
  }
  if (row.raw_json !== null) {
    event.raw = JSON.parse(row.raw_json) as unknown
  }
  return event
}

function decodeImportState(row: ImportStateRow): ImportStateRecord {
  const record: ImportStateRecord = {
    providerAccountId: row.provider_account_id,
    importedQueryIdsAtMaxCreationTime: JSON.parse(row.imported_query_ids_at_max_json) as string[],
    updatedAt: row.updated_at,
  }
  if (row.max_creation_time !== null) {
    record.maxCreationTime = row.max_creation_time
  }
  return record
}

export function createRepositories(db: DashboardDatabase): DashboardStorage {
  const providerCache: DashboardStorage["providerCache"] = {
    get(providerAccountId) {
      const row = db
        .query<ProviderCacheRow, [string]>("select * from provider_cache where provider_account_id = ?")
        .get(providerAccountId)
      return row ? decodeProviderCache(row) : undefined
    },
    upsert(record) {
      const sql = [
        "insert into provider_cache(",
        "  provider_account_id, fetched_at, stale_after, status, normalized_json, error_json, dynamic_subscriptions_json",
        ") values (?, ?, ?, ?, ?, ?, ?)",
        "on conflict(provider_account_id) do update set",
        "  fetched_at = excluded.fetched_at,",
        "  stale_after = excluded.stale_after,",
        "  status = excluded.status,",
        "  normalized_json = excluded.normalized_json,",
        "  error_json = excluded.error_json,",
        "  dynamic_subscriptions_json = coalesce(excluded.dynamic_subscriptions_json, provider_cache.dynamic_subscriptions_json)",
      ].join("\n")
      db.query(sql).run(
        record.providerAccountId,
        record.fetchedAt,
        record.staleAfter,
        record.status,
        JSON.stringify(record.normalized),
        record.errors.length > 0 ? JSON.stringify(record.errors) : null,
        record.dynamicSubscriptions !== undefined ? JSON.stringify(record.dynamicSubscriptions) : null,
      )
    },
  }

  const snapshots: DashboardStorage["snapshots"] = {
    insertMany(rows) {
      if (rows.length === 0) return
      const sql = [
        "insert into quota_snapshots(",
        "  provider_account_id, subscription_id, metric_id, metric_key, timestamp,",
        "  source, source_value_kind, authoritative_value, used, remaining, limit_value",
        ") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ].join("\n")
      const insert = db.query(sql)
      for (const r of rows) {
        insert.run(
          r.providerAccountId,
          r.subscriptionId,
          r.metricId,
          r.metricKey,
          r.timestamp,
          r.source,
          r.sourceValueKind,
          r.authoritativeValue ?? null,
          r.used ?? null,
          r.remaining ?? null,
          r.limit ?? null,
        )
      }
    },
    listForMetric(metricKey, rangeStart, rangeEnd) {
      const rows = db
        .query<SnapshotRow, [string, string, string]>(
          [
            "select metric_key, timestamp, source, source_value_kind,",
            "       authoritative_value, used, remaining, limit_value",
            "from quota_snapshots",
            "where metric_key = ? and timestamp >= ? and timestamp <= ?",
            "order by timestamp asc",
          ].join("\n"),
        )
        .all(metricKey, rangeStart, rangeEnd)
      return rows.map(decodeSnapshot)
    },
  }

  const historyEvents: DashboardStorage["historyEvents"] = {
    insertMany(rows) {
      if (rows.length === 0) return
      const sql = [
        "insert into provider_history_events(",
        "  provider_account_id, metric_key, provider_metric_id, normalized_usage_filter,",
        "  provider_event_id, source_timestamp, value, value_kind, raw_json",
        ") values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "on conflict(provider_account_id, metric_key, provider_event_id) do update set",
        "  provider_metric_id = excluded.provider_metric_id,",
        "  normalized_usage_filter = excluded.normalized_usage_filter,",
        "  source_timestamp = excluded.source_timestamp,",
        "  value = excluded.value,",
        "  value_kind = excluded.value_kind,",
        "  raw_json = excluded.raw_json",
      ].join("\n")
      const insert = db.query(sql)
      for (const r of rows) {
        const eventId = r.providerEventId ?? fallbackEventId(r)
        insert.run(
          r.providerAccountId,
          r.metricKey,
          r.providerMetricId,
          r.normalizedUsageFilter,
          eventId,
          r.sourceTimestamp,
          r.value,
          r.valueKind,
          r.raw !== undefined ? JSON.stringify(r.raw) : null,
        )
      }
    },
    listForMetric(metricKey, rangeStart, rangeEnd) {
      const rows = db
        .query<HistoryEventRow, [string, string, string]>(
          [
            "select provider_account_id, metric_key, provider_metric_id, normalized_usage_filter,",
            "       provider_event_id, source_timestamp, value, value_kind, raw_json",
            "from provider_history_events",
            "where metric_key = ? and source_timestamp >= ? and source_timestamp <= ?",
            "order by source_timestamp asc",
          ].join("\n"),
        )
        .all(metricKey, rangeStart, rangeEnd)
      return rows.map(decodeHistoryEvent)
    },
  }

  const importState: DashboardStorage["importState"] = {
    get(providerAccountId) {
      const row = db
        .query<ImportStateRow, [string]>("select * from provider_import_state where provider_account_id = ?")
        .get(providerAccountId)
      return row ? decodeImportState(row) : undefined
    },
    upsert(record) {
      const sql = [
        "insert into provider_import_state(",
        "  provider_account_id, max_creation_time, imported_query_ids_at_max_json, updated_at",
        ") values (?, ?, ?, ?)",
        "on conflict(provider_account_id) do update set",
        "  max_creation_time = excluded.max_creation_time,",
        "  imported_query_ids_at_max_json = excluded.imported_query_ids_at_max_json,",
        "  updated_at = excluded.updated_at",
      ].join("\n")
      db.query(sql).run(
        record.providerAccountId,
        record.maxCreationTime ?? null,
        JSON.stringify(record.importedQueryIdsAtMaxCreationTime),
        record.updatedAt,
      )
    },
  }

  const refreshRuns: DashboardStorage["refreshRuns"] = {
    insertStarted(input) {
      db.query(
        [
          "insert into refresh_runs(started_at, finished_at, status, provider_account_ids_json, error_json)",
          "values (?, null, 'running', ?, null)",
        ].join("\n"),
      ).run(input.startedAt, JSON.stringify(input.providerAccountIds))
      const row = db.query<{ id: number }, []>("select last_insert_rowid() as id").get()
      return row?.id ?? 0
    },
    finish(input) {
      db.query(
        "update refresh_runs set finished_at = ?, status = ?, error_json = ? where id = ?",
      ).run(
        input.finishedAt,
        input.status,
        input.errors.length > 0 ? JSON.stringify(input.errors) : null,
        input.id,
      )
    },
  }

  return {
    providerCache,
    snapshots,
    historyEvents,
    importState,
    refreshRuns,
    healthCheck() {
      try {
        const row = db.query<{ ok: number }, []>("select 1 as ok").get()
        return row?.ok === 1
      } catch {
        return false
      }
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)()
    },
  }
}
