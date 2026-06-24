import type { MetricConfig } from "../../shared/domain"
import type {
  NormalizedMetric,
  ProviderAdapter,
  ProviderHistoryEvent,
  ProviderRefreshInput,
  ProviderRefreshResult,
} from "./types"

// Poe provider adapter.
//
// Endpoints:
//   GET https://api.poe.com/usage/current_balance
//   GET https://api.poe.com/usage/points_history?limit=100[&starting_after=<query_id>]
// Auth: `Authorization: Bearer <POE_API_KEY>`.
//
// creation_time semantics: Poe returns history row `creation_time` as an integer
// number of MICROSECONDS since the Unix epoch. We preserve microseconds as the
// canonical unit for the import watermark (`importState.maxCreationTime`) so the
// comparison is performed in the same units the upstream returns, avoiding any
// lossy conversion. `ProviderHistoryEvent.sourceTimestamp` is converted to an
// ISO string for downstream storage.
//
// Usage-type filtering (default `usage_type == "API"`) is intentionally NOT
// applied here; it belongs to dashboard projection (Task 7). Raw `usage_type`,
// `api_key_name`, and `bot_name` are preserved on each history event.
//
// Pagination: history is consumed newest-first (descending creation_time). We
// follow `has_more` using the last RAW response row's `query_id` as the
// `starting_after` cursor. Pagination stops as soon as a row is strictly older
// than the watermark or is an already-imported id at the watermark timestamp,
// which lets incremental refreshes avoid walking the entire history.

const POE_BASE = "https://api.poe.com/usage"
const POINTS_METRIC_ID = "points"
const PAGE_LIMIT = 100

type PoeRow = {
  query_id: string
  creation_time: number
  cost_points: number
  usage_type?: string
  api_key_name?: string
  bot_name?: string
  [k: string]: unknown
}

type ImportState = { maxCreationTime?: number; importedQueryIdsAtMaxCreationTime: string[] }

export function createPoeProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "poe",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
        historyEvents: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return {
          ...base,
          errors: [{ message: "Poe provider unavailable: API key not configured", retryable: false }],
        }
      }

      const headers = new Headers()
      headers.set("Authorization", `Bearer ${apiKey}`)
      headers.set("Accept", "application/json")

      // --- balance ---
      let balanceMetric: NormalizedMetric | undefined
      try {
        const balRes = await fetchImpl(`${POE_BASE}/current_balance`, { method: "GET", headers })
        if (balRes.status === 401) {
          return { ...base, errors: [{ message: "Poe authentication failed", retryable: false }] }
        }
        if (!balRes.ok) {
          return {
            ...base,
            errors: [
              {
                message: `Poe balance request failed (${balRes.status})`,
                retryable: balRes.status >= 500 || balRes.status === 429,
              },
            ],
          }
        }
        const balBody = (await balRes.json()) as { current_point_balance?: number }
        balanceMetric = mapBalance(balBody, input.metrics)
      } catch {
        return { ...base, errors: [{ message: "Poe balance request network error", retryable: true }] }
      }

      // --- history (paginated) ---
      const watermark = input.importState
      const events: ProviderHistoryEvent[] = []
      const importedRows: PoeRow[] = []
      let cursor: string | undefined
      let stop = false

      while (!stop) {
        const url = new URL(`${POE_BASE}/points_history`)
        url.searchParams.set("limit", String(PAGE_LIMIT))
        if (cursor !== undefined) url.searchParams.set("starting_after", cursor)

        let page: { data?: PoeRow[]; has_more?: boolean }
        try {
          const res = await fetchImpl(url.toString(), { method: "GET", headers })
          if (res.status === 401) {
            return {
              ...base,
              metrics: balanceMetric ? [balanceMetric] : [],
              errors: [{ message: "Poe authentication failed", retryable: false }],
            }
          }
          if (!res.ok) {
            return {
              ...base,
              metrics: balanceMetric ? [balanceMetric] : [],
              errors: [
                {
                  message: `Poe history request failed (${res.status})`,
                  retryable: res.status >= 500 || res.status === 429,
                },
              ],
            }
          }
          page = (await res.json()) as { data?: PoeRow[]; has_more?: boolean }
        } catch {
          return {
            ...base,
            metrics: balanceMetric ? [balanceMetric] : [],
            errors: [{ message: "Poe history request network error", retryable: true }],
          }
        }

        const rows = Array.isArray(page.data) ? page.data : []
        for (const r of rows) {
          if (isTerminal(r, watermark)) {
            stop = true
            continue
          }
          events.push(mapEvent(r))
          importedRows.push(r)
        }

        if (!page.has_more) break
        if (stop) break
        if (rows.length === 0) break
        // Cursor is always the last RAW row's query_id, even if some rows were
        // filtered by the watermark — never the last kept row.
        cursor = rows[rows.length - 1]!.query_id
      }

      const nextImportState = computeNextImportState(importedRows, watermark)
      return {
        ...base,
        metrics: balanceMetric ? [balanceMetric] : [],
        historyEvents: events,
        nextImportState: nextImportState,
      }
    },
  }
}

function isTerminal(r: PoeRow, wm: ImportState | undefined): boolean {
  if (wm === undefined || wm.maxCreationTime === undefined) return false
  if (r.creation_time < wm.maxCreationTime) return true
  if (r.creation_time === wm.maxCreationTime && wm.importedQueryIdsAtMaxCreationTime.includes(r.query_id)) {
    return true
  }
  return false
}

function mapEvent(r: PoeRow): ProviderHistoryEvent {
  const ev: ProviderHistoryEvent = {
    providerMetricId: POINTS_METRIC_ID,
    providerEventId: r.query_id,
    sourceTimestamp: microsToIso(r.creation_time),
    value: r.cost_points,
    valueKind: "consumption",
    raw: r,
  }
  if (r.usage_type !== undefined) ev.usageType = r.usage_type
  if (r.api_key_name !== undefined) ev.apiKeyName = r.api_key_name
  if (r.bot_name !== undefined) ev.botName = r.bot_name
  return ev
}

function mapBalance(body: { current_point_balance?: number }, metrics: MetricConfig[]): NormalizedMetric | undefined {
  if (body.current_point_balance === undefined) return undefined
  const cfg = metrics.find((m) => m.providerMetricId === POINTS_METRIC_ID) ?? metrics[0]
  const metric: NormalizedMetric = {
    providerMetricId: POINTS_METRIC_ID,
    label: cfg?.label ?? "Points",
    unit: cfg?.unit ?? "points",
    remaining: body.current_point_balance,
    sourceValueKind: "gauge-remaining",
    sourceConfidence: "known",
  }
  return metric
}

function microsToIso(us: number): string {
  return new Date(us / 1000).toISOString()
}

function computeNextImportState(imported: PoeRow[], prev: ImportState | undefined): ImportState {
  if (imported.length === 0) {
    return prev ?? { importedQueryIdsAtMaxCreationTime: [] }
  }
  let maxCt = imported[0]!.creation_time
  for (const r of imported) {
    if (r.creation_time > maxCt) maxCt = r.creation_time
  }
  let idsAtMax = imported.filter((r) => r.creation_time === maxCt).map((r) => r.query_id)
  // If the high-water mark did not advance, accumulate the already-known ids at
  // that timestamp so the next refresh keeps deduping all of them.
  if (prev !== undefined && prev.maxCreationTime === maxCt) {
    idsAtMax = Array.from(new Set([...prev.importedQueryIdsAtMaxCreationTime, ...idsAtMax]))
  }
  idsAtMax.sort()
  return { maxCreationTime: maxCt, importedQueryIdsAtMaxCreationTime: idsAtMax }
}
