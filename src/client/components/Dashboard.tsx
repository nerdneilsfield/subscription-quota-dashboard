import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
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
import { LanguageSwitch } from "./LanguageSwitch"
import { getApiErrorMessage, useI18n } from "../i18n"

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
  onChangeViewKey?: () => Promise<void>
}

export function Dashboard({ profileId, range, initialPayload, onSessionExpired, onRangeChange, onChangeViewKey }: DashboardProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  // Validate initialPayload identity BEFORE useState init to prevent
  // a one-frame flash of stale range/profile data.
  const validInitialPayload = initialPayload
    && initialPayload.profile?.id === profileId
    && initialPayload.selectedRange === range
    ? initialPayload
    : undefined
  const [payload, setPayload] = useState<DashboardPayload | undefined>(validInitialPayload)
  const [phase, setPhase] = useState<Phase>(validInitialPayload ? "ready" : "loading")
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
  const [now, setNow] = useState(() => validInitialPayload ? new Date(validInitialPayload.generatedAt) : new Date())
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
    if (isFirst && validInitialPayload) {
      // Already initialized via useState with validated payload.
      return
    }
    void fetchRange(range, isFirst ? "initial" : "range")
    return () => {
      abortRef.current?.abort()
    }
  }, [range, validInitialPayload, fetchRange, profileId])

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
    document.title = `${unavailable ? "! " : ""}${payload.profile.name} · ${t("quotaDashboard")}`
  }, [payload, t])

  const retry = useCallback(() => {
    void fetchRange(range, "initial")
  }, [fetchRange, range])

  if (phase === "loading") return <LoadingState />
  if (phase === "error" || !payload) {
    return <NetworkError message={error ? getApiErrorMessage(error.code, t) : t("couldNotLoadDashboard")} onRetry={retry} />
  }

  const unavailable = payload.subscriptions.length > 0 && payload.subscriptions.every((s) => s.status === "unavailable")
  const anyStale = payload.subscriptions.some((s) => s.status === "stale" || s.errors?.some((e) => e.stale) === true)
  const upstreamSubscriptions = payload.subscriptions.filter((s) => s.identity !== undefined)
  const directSubscriptions = payload.subscriptions.filter((s) => s.identity === undefined)
  const healthyCount = payload.subscriptions.filter((s) => s.status === "ok").length
  const attentionCount = payload.subscriptions.length - healthyCount
  const metricCount = payload.subscriptions.reduce((sum, subscription) => sum + subscription.metrics.length, 0)

  return (
    <div className="dashboard" data-system-status={attentionCount > 0 ? "attention" : "nominal"}>
      <header className="dashboard__header">
        <div className="dashboard__identity">
          <span className="dashboard__wordmark">{payload.branding?.slogan ?? t("wordmark")}</span>
          <div className="dashboard__title">
            <h1>{payload.profile.name}</h1>
            <span className={`system-state${attentionCount > 0 ? " system-state--attention" : ""}`}>
              <span aria-hidden="true">●</span>
              {attentionCount > 0 ? t("attention") : t("nominal")}
            </span>
          </div>
        </div>
        <div className="dashboard__controls">
          <label className="profile-switch">
            <span>{t("profile")}</span>
            <select
              aria-label={t("switchProfile")}
              value={profileId}
              onChange={(event) => navigate(`/d/${encodeURIComponent(event.target.value)}?range=${range}`)}
            >
              {(payload.profiles ?? [payload.profile]).map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
          </label>
          {onChangeViewKey && (
            <button type="button" className="btn-session" onClick={() => void onChangeViewKey()}>
              {t("changeViewKey")}
            </button>
          )}
          <LanguageSwitch />
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
        <dl className="dashboard__telemetry">
          <div><dt>{t("accounts")}</dt><dd>{payload.subscriptions.length}</dd></div>
          <div><dt>{t("upstreams")}</dt><dd>{upstreamSubscriptions.length}</dd></div>
          <div><dt>{t("metrics")}</dt><dd>{metricCount}</dd></div>
          <div><dt>{t("healthy")}</dt><dd>{healthyCount}</dd></div>
          <div><dt>{t("attention")}</dt><dd data-attention={attentionCount > 0}>{attentionCount}</dd></div>
        </dl>
      </header>

      <div className="dashboard__range-rail">
        <RangeSwitch
          ranges={payload.ranges}
          selected={range}
          onSelect={onRangeChange ?? (() => {})}
          loading={rangeLoading}
        />
        <p className="dashboard__meta">
          {anyStale && <span className="header-warn" aria-label={t("staleData")} title={t("staleData")}>{t("staleSource")}</span>}
          <span>{t("snapshot")} </span>
          <TimeDisplay iso={payload.generatedAt} now={now} />
        </p>
      </div>

      {unavailable && (
        <div className="dashboard-banner dashboard-banner--unavailable" role="alert">
          {t("allProvidersUnavailable")}
        </div>
      )}

      {payload.subscriptions.length === 0 ? (
        <EmptyState />
      ) : (
        <main className="dashboard__body">
          {payload.summaryGroups.length > 0 && (
            <section className="dashboard__summary" aria-label={t("quotaSummary")}>
              <div className="section-heading">
                <div><span className="section-heading__index">01</span><h2>{t("resourceTelemetry")}</h2></div>
                <p>{t("consumptionWindow", { range })}</p>
              </div>
              <SummaryRow groups={payload.summaryGroups} now={now} />
            </section>
          )}
          {upstreamSubscriptions.length > 0 && <section className="dashboard__subscriptions" aria-labelledby="upstream-heading">
            <div className="section-heading">
              <div><span className="section-heading__index">02</span><h2 id="upstream-heading">{t("upstreamAccounts")}</h2></div>
              <p>{t("discoveredViaProxy", { count: upstreamSubscriptions.length })}</p>
            </div>
            <div className="subscriptions-grid subscriptions-grid--upstream">
              {upstreamSubscriptions.map((s) => (
                <SubscriptionCard key={s.id} subscription={s} now={now} />
              ))}
            </div>
          </section>}
          {directSubscriptions.length > 0 && <section className="dashboard__subscriptions" aria-labelledby="direct-heading">
            <div className="section-heading">
              <div><span className="section-heading__index">03</span><h2 id="direct-heading">{t("directManual")}</h2></div>
              <p>{t("configuredSources", { count: directSubscriptions.length })}</p>
            </div>
            <div className="subscriptions-grid subscriptions-grid--direct">
              {directSubscriptions.map((s) => (
                <SubscriptionCard key={s.id} subscription={s} now={now} />
              ))}
            </div>
          </section>}
        </main>
      )}

      <footer className="dashboard__footer">
        <p>
          <span>SQD / {payload.profile.id}</span>
          <span>{t("rangeLabel", { range })}</span>
          <span>{t("generated")} <TimeDisplay iso={payload.generatedAt} now={now} /></span>
        </p>
      </footer>
    </div>
  )
}

function RefreshLabel({ state }: { state: RefreshState }) {
  const { t } = useI18n()
  if (state.state === "refreshing") return <span>{t("refreshing")}</span>
  if (state.state === "updated") return <span>{t("refreshed")}</span>
  if (state.state === "failed") return <span>{t("refreshFailed")}</span>
  if (state.state === "rate-limited") return <span>{t("retryIn", { seconds: state.retryAfter })}</span>
  return <span>{t("refresh")}</span>
}
