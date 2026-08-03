import type { DashboardSubscription, DashboardSubscriptionError } from "../../shared/dashboard-payload"
import { MetricCard } from "./MetricCard"
import { UpstreamAccountCard } from "./UpstreamAccountCard"
import { ProviderLogo } from "./ProviderLogo"
import { getStatusLabel } from "./MetricCard"
import { useI18n } from "../i18n"

interface SubscriptionCardProps {
  subscription: DashboardSubscription
  now: Date
}

export function SubscriptionCard({ subscription, now }: SubscriptionCardProps) {
  const { t } = useI18n()
  const unavailable = subscription.status === "unavailable"
  const stale = subscription.status === "stale"
  const hasMetrics = subscription.metrics.length > 0
  const isUpstreamAccount = subscription.identity !== undefined
  return (
    <section
      className={`subscription-card${unavailable ? " subscription-card--unavailable" : ""}`}
      data-subscription={subscription.id}
      data-status={subscription.status}
    >
      {isUpstreamAccount ? <UpstreamAccountCard subscription={subscription} now={now} /> : <><header className="subscription-card__header">
        <div className="subscription-card__identity">
          <ProviderLogo label={subscription.name} />
          <h3>{subscription.name}</h3>
        </div>
        <span className={`status-badge status-${subscription.status}`} data-status={subscription.status}>
          <span className="status-badge__icon" aria-hidden="true">{ICON[subscription.status]}</span>
          <span className="status-badge__text">{getStatusLabel(subscription.status, t)}</span>
        </span>
      </header>
      {subscription.errors?.map((err, i) => <ErrorBanner key={i} error={err} stale={stale} />)}
      {hasMetrics && (
        <div className={`subscription-card__metrics${unavailable ? " subscription-card__metrics--stale" : ""}`}>
          {subscription.metrics.map((m) => (
            <MetricCard key={m.id} metric={m} now={now} />
          ))}
        </div>
      )}
      {!hasMetrics && unavailable && (
        <div className="subscription-card__unavailable">
          {subscription.errors?.[0]?.message ?? t("subscriptionUnavailable")}
        </div>
      )}</>}
      {isUpstreamAccount && subscription.errors?.map((err, i) => <ErrorBanner key={i} error={err} stale={stale} />)}
    </section>
  )
}

function ErrorBanner({ error, stale }: { error: DashboardSubscriptionError; stale: boolean }) {
  const tone = error.stale ? "warning" : "critical"
  return (
    <div className={`banner banner--${tone}`} role="alert" data-stale={error.stale ? "true" : "false"}>
      <span className="banner__icon" aria-hidden="true">{stale ? "▲" : "✕"}</span>
      <span className="banner__text">{error.message}</span>
    </div>
  )
}

const ICON: Record<string, string> = {
  ok: "●",
  warn: "▲",
  critical: "✕",
  stale: "○",
  unavailable: "—",
  expired: "⌛",
}
