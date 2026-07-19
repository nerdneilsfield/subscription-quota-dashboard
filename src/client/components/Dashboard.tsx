import { useCallback, useEffect, useRef, useState } from "react"
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
  // Ref mirror of rangeLoading so doRefresh can read it without depending on it.
  const rangeLoadingRef = useRef(rangeLoading)
  rangeLoadingRef.current = rangeLoading
  const [refresh, setRefresh] = useState<RefreshState>({ state: "idle" })
  // Ref mirror of refresh.state so fetchRange can read it without depending
  // on it (which would cause the range effect to re-run on every refresh state change).
  const refreshStateRef = useRef(refresh.state)
  refreshStateRef.current = refresh.state
  // A single shared abort controller for both range fetches and manual
  // refreshes. Switching range aborts an in-flight refresh, and vice versa,
  // so a stale slow response can never overwrite a newer one.
  const abortRef = useRef<AbortController | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hiddenSinceRef = useRef<number | null>(null)
  // Generation token: bumped on every range switch or refresh. A response
  // from an older generation is discarded before calling setPayload.
  const genRef = useRef(0)

  // "now" snaps to the server's generatedAt when a payload arrives, then
  // ticks every 30s via wall-clock so relative times advance.
  const [now, setNow] = useState(() => payload ? new Date(payload.generatedAt) : new Date())
  useEffect(() => {
    if (payload) setNow(new Date(payload.generatedAt))
  }, [payload])
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])

  const handleResult = useCallback(
    (range: RangeKey, res: ApiResult<DashboardPayload>, ctrl: AbortController, gen: number, silent: boolean) => {
      if (ctrl.signal.aborted || gen !== genRef.current) return
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
      // Clear any pending "Updated" timer so it can't clobber the new state.
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
      // Abort any in-flight operation (range or refresh).
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      const gen = ++genRef.current
      // Reset refresh state if a refresh was in-flight.
      const curRefreshState = refreshStateRef.current
      if (curRefreshState === "refreshing" || curRefreshState === "updated" || curRefreshState === "rate-limited") {
        setRefresh({ state: "idle" })
      }
      // Clear rangeLoading from a previous operation (prevents stuck skeleton
      // when a silent fetch takes over a pending range fetch).
      if (rangeLoadingRef.current) setRangeLoading(false)
      if (mode === "initial") setPhase("loading")
      else if (mode === "range") setRangeLoading(true)
      const res = await getDashboard(profileId, nextRange, ctrl.signal)
      handleResult(nextRange, res, ctrl, gen, mode === "silent")
      // Only clear loading if this operation still owns the gen token.
      if (mode === "range" && gen === genRef.current) setRangeLoading(false)
    },
    [profileId, handleResult],
  )

  const initRef = useRef(false)
  useEffect(() => {
    const isFirst = !initRef.current
    initRef.current = true
    if (isFirst && initialPayload) {
      // Validate that the initialPayload matches the current profile and range.
      // If it doesn't (e.g. AuthGate captured an old range before auth), fetch fresh.
      const profileMatch = initialPayload.profile?.id === profileId
      const rangeMatch = initialPayload.selectedRange === range
      if (profileMatch && rangeMatch) {
        setPayload(initialPayload)
        setPhase("ready")
        return
      }
      // Mismatch: fall through to fetch
    }
    void fetchRange(range, isFirst ? "initial" : "range")
    return () => {
      abortRef.current?.abort()
    }
  }, [range, initialPayload, fetchRange, profileId])

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
      abortRef.current?.abort()
    }
  }, [])

  const doRefresh = useCallback(async () => {
    // Clear any pending "Updated" timer so it can't clobber the new refresh.
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
    // Abort any in-flight operation (range fetch or prior refresh).
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const gen = ++genRef.current
    // Clear range loading if a range fetch was in-flight.
    if (rangeLoadingRef.current) setRangeLoading(false)
    setRefresh({ state: "refreshing" })
    const res = await refreshDashboard(profileId, range, ctrl.signal)
    if (ctrl.signal.aborted || gen !== genRef.current) {
      // Aborted by a range switch or newer refresh: reset to idle so the
      // button doesn't stay stuck in "refreshing" forever.
      setRefresh({ state: "idle" })
      return
    }
    if (res.ok) {
      setPayload(res.value)
      const hasStale = res.value.subscriptions.some(
        (s) => s.status === "stale" || s.errors?.some((e) => e.stale) === true,
      )
      if (hasStale) {
        setRefresh({ state: "idle" })
      } else {
        setRefresh({ state: "updated" })
        // Only set the timer if this refresh still owns the gen token.
        if (gen === genRef.current) {
          refreshTimerRef.current = setTimeout(() => setRefresh({ state: "idle" }), 2000)
        }
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
        <div className="dashboard__identity">
          <span className="dashboard__wordmark">Quota dashboard</span>
          <div className="dashboard__title">
            <h1>{payload.profile.name}</h1>
            <p className="dashboard__meta">
              {anyStale && <span className="header-warn" aria-label="stale data" title="Some data is stale">▲</span>}
              <span>Updated </span>
              <TimeDisplay iso={payload.generatedAt} now={now} />
            </p>
          </div>
        </div>
        <div className="dashboard__controls">
          <button
            type="button"
            className="btn-refresh"
            data-state={refresh.state}
            onClick={doRefresh}
            aria-busy={refresh.state === "refreshing"}
            disabled={refresh.state === "refreshing"}
          >
            <span aria-live="polite"><RefreshLabel state={refresh} /></span>
          </button>
        </div>
      </header>

      <div className="dashboard__range-rail">
        <RangeSwitch
          ranges={payload.ranges}
          selected={range}
          onSelect={onRangeChange ?? (() => {})}
          loading={rangeLoading}
        />
      </div>

      {unavailable && (
        <div className="dashboard-banner dashboard-banner--unavailable" role="alert">
          All providers are currently unavailable.
        </div>
      )}

      {payload.subscriptions.length === 0 ? (
        <EmptyState />
      ) : (
        <main className="dashboard__body">
          {payload.summaryGroups.length > 0 && (
            <section className="dashboard__summary" aria-label="Quota summary">
              <SummaryRow groups={payload.summaryGroups} now={now} />
            </section>
          )}
          <section className="dashboard__subscriptions" aria-labelledby="subscriptions-heading">
            <div className="section-heading">
              <h2 id="subscriptions-heading">Subscriptions</h2>
              <p>{payload.subscriptions.length} configured</p>
            </div>
            <div className="subscriptions-grid">
              {payload.subscriptions.map((s) => (
                <SubscriptionCard key={s.id} subscription={s} now={now} />
              ))}
            </div>
          </section>
        </main>
      )}

      <footer className="dashboard__footer">
        <p>
          <span>{range} range</span>
          <span>Generated <TimeDisplay iso={payload.generatedAt} now={now} /></span>
        </p>
      </footer>
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
