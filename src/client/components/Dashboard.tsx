import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import type { DashboardPayload } from "../../shared/dashboard-payload"
import type { RangeKey } from "../../shared/domain"
import { getDashboard, refreshDashboard } from "../api"
import type { ApiResult } from "../api"

type ApiFailure = Extract<ApiResult<unknown>, { ok: false }>
import { LoadingState } from "./LoadingState"
import { EmptyState } from "./EmptyState"
import { NetworkError } from "./NetworkError"
import { SummaryRow } from "./SummaryRow"
import { SubscriptionCard } from "./SubscriptionCard"
import { RangeSwitch } from "./RangeSwitch"
import { TimeDisplay } from "./TimeDisplay"

const VISIBILITY_REFETCH_MS = 5 * 60 * 1000

type Phase = "loading" | "ready" | "error"
type RefreshState =
  | { state: "idle" }
  | { state: "refreshing" }
  | { state: "updated" }
  | { state: "failed" }
  | { state: "rate-limited"; retryAfter: number }

interface DashboardProps {
  profileId: string
  range: RangeKey
  initialPayload?: DashboardPayload
  onSessionExpired?: () => void
  onRangeChange?: (range: RangeKey) => void
}

export function Dashboard({ profileId, range, initialPayload, onSessionExpired, onRangeChange }: DashboardProps) {
  const [payload, setPayload] = useState<DashboardPayload | undefined>(initialPayload)
  const [phase, setPhase] = useState<Phase>(initialPayload ? "ready" : "loading")
  const [error, setError] = useState<ApiFailure | undefined>()
  const [rangeLoading, setRangeLoading] = useState(false)
  const [refresh, setRefresh] = useState<RefreshState>({ state: "idle" })
  const abortRef = useRef<AbortController | null>(null)
  const refreshAbortRef = useRef<AbortController | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hiddenSinceRef = useRef<number | null>(null)

  const now = useMemo(() => (payload ? new Date(payload.generatedAt) : new Date()), [payload])

  const handleResult = useCallback(
    (range: RangeKey, res: ApiResult<DashboardPayload>, ctrl: AbortController, silent: boolean) => {
      if (ctrl.signal.aborted) return
      if (res.ok) {
        setPayload(res.value)
        setPhase("ready")
        setError(undefined)
        return
      }
      if (res.code === "unauthorized") {
        onSessionExpired?.()
        return
      }
      if (!silent) {
        setError(res)
        setPhase("error")
      }
    },
    [onSessionExpired],
  )

  const fetchRange = useCallback(
    async (nextRange: RangeKey, mode: "initial" | "range" | "silent") => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      if (mode === "initial") setPhase("loading")
      else if (mode === "range") setRangeLoading(true)
      const res = await getDashboard(profileId, nextRange, ctrl.signal)
      handleResult(nextRange, res, ctrl, mode === "silent")
      if (mode === "range") setRangeLoading(false)
    },
    [profileId, handleResult],
  )

  const initRef = useRef(false)
  useEffect(() => {
    const isFirst = !initRef.current
    initRef.current = true
    if (isFirst && initialPayload) {
      setPayload(initialPayload)
      setPhase("ready")
      return
    }
    void fetchRange(range, isFirst ? "initial" : "range")
    return () => {
      abortRef.current?.abort()
    }
  }, [range, initialPayload, fetchRange])

  // visibility refetch (no auto-poll)
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        hiddenSinceRef.current = Date.now()
      } else {
        const since = hiddenSinceRef.current
        hiddenSinceRef.current = null
        if (since != null && Date.now() - since >= VISIBILITY_REFETCH_MS) {
          void fetchRange(range, "silent")
        }
      }
    }
    document.addEventListener("visibilitychange", onVis)
    return () => document.removeEventListener("visibilitychange", onVis)
  }, [range, fetchRange])

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshAbortRef.current?.abort()
      abortRef.current?.abort()
    }
  }, [])

  const doRefresh = useCallback(async () => {
    refreshAbortRef.current?.abort()
    const ctrl = new AbortController()
    refreshAbortRef.current = ctrl
    setRefresh({ state: "refreshing" })
    const res = await refreshDashboard(profileId, range, ctrl.signal)
    if (ctrl.signal.aborted) return
    if (res.ok) {
      setPayload(res.value)
      const hasStale = res.value.subscriptions.some(
        (s) => s.status === "stale" || s.errors?.some((e) => e.stale) === true,
      )
      if (hasStale) {
        setRefresh({ state: "idle" })
      } else {
        setRefresh({ state: "updated" })
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = setTimeout(() => setRefresh({ state: "idle" }), 2000)
      }
      return
    }
    if (res.code === "unauthorized") {
      onSessionExpired?.()
      return
    }
    if (res.code === "rate-limited") {
      setRefresh({ state: "rate-limited", retryAfter: res.retryAfterSeconds ?? 30 })
      return
    }
    setRefresh({ state: "failed" })
  }, [profileId, range, onSessionExpired])

  // document.title
  useEffect(() => {
    if (!payload) return
    const unavailable =
      payload.subscriptions.length > 0 && payload.subscriptions.every((s) => s.status === "unavailable")
    document.title = `${unavailable ? "! " : ""}${payload.profile.name} · Quota Dashboard`
  }, [payload])

  const retry = useCallback(() => {
    void fetchRange(range, "initial")
  }, [fetchRange, range])

  if (phase === "loading") return <LoadingState />
  if (phase === "error" || !payload) {
    return <NetworkError message={error?.message ?? "Could not load dashboard."} onRetry={retry} />
  }

  const unavailable = payload.subscriptions.length > 0 && payload.subscriptions.every((s) => s.status === "unavailable")
  const anyStale = payload.subscriptions.some((s) => s.status === "stale" || s.errors?.some((e) => e.stale) === true)

  return (
    <div className="dashboard">
      <header className="dashboard__header">
        <div className="dashboard__title">
          <h1>{payload.profile.name}</h1>
          <p className="dashboard__meta">
            {anyStale && <span className="header-warn" aria-label="stale data" title="Some data is stale">▲</span>}
            <span>Updated </span>
            <TimeDisplay iso={payload.generatedAt} now={now} />
          </p>
        </div>
        <div className="dashboard__controls">
          <button
            type="button"
            className="btn-refresh"
            onClick={doRefresh}
            aria-busy={refresh.state === "refreshing"}
            disabled={refresh.state === "refreshing"}
          >
            <RefreshLabel state={refresh} />
          </button>
        </div>
      </header>

      <RangeSwitch
        ranges={payload.ranges}
        selected={range}
        onSelect={onRangeChange ?? (() => {})}
        loading={rangeLoading}
      />

      {unavailable && (
        <div className="dashboard-banner dashboard-banner--unavailable" role="alert">
          All providers are currently unavailable.
        </div>
      )}

      {payload.subscriptions.length === 0 ? (
        <EmptyState />
      ) : (
        <main className="dashboard__body">
          {payload.summaryGroups.length > 0 && <SummaryRow groups={payload.summaryGroups} now={now} />}
          <div className="subscriptions-grid">
            {payload.subscriptions.map((s) => (
              <SubscriptionCard key={s.id} subscription={s} now={now} />
            ))}
          </div>
        </main>
      )}
    </div>
  )
}

function RefreshLabel({ state }: { state: RefreshState }) {
  if (state.state === "refreshing") return <span>Refreshing…</span>
  if (state.state === "updated") return <span>Updated</span>
  if (state.state === "failed") return <span>Refresh failed</span>
  if (state.state === "rate-limited") return <span>Retry in {state.retryAfter}s</span>
  return <span>Refresh</span>
}
