/* Hallmark · component: subscription-history-dialog · genre: technical-console · theme: existing Operations Matrix
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (46–50)
 */
import { useEffect, useRef, useState } from "react"
import type { DashboardSubscription } from "../../shared/dashboard-payload"
import type { RangeKey } from "../../shared/domain"
import type { SubscriptionHistoryPayload } from "../../shared/subscription-history"
import { getSubscriptionHistory } from "../api"
import { getApiErrorMessage, useI18n } from "../i18n"
import { ProviderLogo } from "./ProviderLogo"
import { UsageHistoryChart } from "./UsageHistoryChart"

const HISTORY_RANGES: RangeKey[] = ["24h", "7d", "30d"]

export function SubscriptionHistoryDialog({
  profileId,
  subscription,
  onClose,
  onSessionExpired,
}: {
  profileId: string
  subscription: DashboardSubscription
  onClose: () => void
  onSessionExpired?: () => void
}) {
  const { t } = useI18n()
  const [range, setRange] = useState<RangeKey>("24h")
  const [payload, setPayload] = useState<SubscriptionHistoryPayload>()
  const [state, setState] = useState<"loading" | "success" | "error">("loading")
  const [error, setError] = useState("")
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose()
        return
      }
      if (event.key !== "Tab") return
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])") ?? [])]
      if (controls.length === 0) return
      const first = controls[0]!
      const last = controls.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener("keydown", onKeyDown)
      previousFocus?.focus()
    }
  }, [onClose])

  useEffect(() => {
    const ctrl = new AbortController()
    setState("loading")
    setError("")
    void getSubscriptionHistory(profileId, subscription.id, range, ctrl.signal).then((result) => {
      if (ctrl.signal.aborted) return
      if (result.ok) {
        setPayload(result.value)
        setState("success")
      } else if (result.code === "unauthorized") {
        onSessionExpired?.()
      } else {
        setError(getApiErrorMessage(result.code, t))
        setState("error")
      }
    })
    return () => ctrl.abort()
  }, [profileId, subscription.id, range, onSessionExpired, t])

  const chartMetrics = payload?.metrics.filter((metric) => metric.points.length >= 2) ?? []
  return (
    <div className="history-dialog__backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-dialog-title" data-state={state}>
        <header className="history-dialog__header">
          <div className="history-dialog__identity">
            <ProviderLogo {...(subscription.identity?.provider ? { provider: subscription.identity.provider } : {})} label={subscription.identity?.providerLabel ?? subscription.name} />
            <div><span>{t("subscriptionHistory")}</span><h2 id="history-dialog-title">{subscription.name}</h2></div>
          </div>
          <button ref={closeRef} type="button" className="history-dialog__close" onClick={onClose} aria-label={t("close")}>×</button>
        </header>
        <div className="history-dialog__toolbar" role="group" aria-label={t("selectTimeRange")}>
          {HISTORY_RANGES.map((item) => <button key={item} type="button" className="history-dialog__range" data-active={range === item} aria-pressed={range === item} disabled={state === "loading"} onClick={() => setRange(item)}>{item}</button>)}
          <span>{t("scheduledSamples")}</span>
        </div>
        <div className="history-dialog__body">
          {state === "loading" && <div className="history-dialog__message" role="status">{t("loadingHistory")}</div>}
          {state === "error" && <div className="history-dialog__message history-dialog__message--error" role="alert">{error}</div>}
          {state === "success" && chartMetrics.length === 0 && <div className="history-dialog__message">{t("historyNotEnoughData")}</div>}
          {state === "success" && chartMetrics.map((metric) => <UsageHistoryChart key={metric.id} metric={metric} />)}
        </div>
      </section>
    </div>
  )
}
