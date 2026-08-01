import type { DashboardMetric, DashboardSubscription } from "../../shared/dashboard-payload"
import { formatNumber, formatPercentUsed } from "../format"
import { TimeDisplay } from "./TimeDisplay"
import { STATUS_LABEL } from "./MetricCard"
import { ProviderLogo } from "./ProviderLogo"

export function UpstreamAccountCard({ subscription, now }: { subscription: DashboardSubscription; now: Date }) {
  const identity = subscription.identity!
  const updatedAt = subscription.lastRefreshAt
  return (
    <>
      <header className="upstream-card__header">
        <div className="upstream-card__identity">
          <ProviderLogo provider={identity.provider} label={identity.providerLabel} />
          <div className="upstream-card__title">
            <div className="upstream-card__title-line">
              <h3>{identity.providerLabel}</h3>
              {identity.plan && <span className="upstream-card__plan">{identity.plan}</span>}
            </div>
            <div className="upstream-card__account">{identity.account ?? `Account ${subscription.id.split(":").at(-1)?.slice(0, 8)}`}</div>
          </div>
        </div>
        <div className="upstream-card__provenance">
          {identity.transport && <span className="upstream-card__transport">via {identity.transport}</span>}
          <span className={`status-badge status-${subscription.status}`} data-status={subscription.status}>
            <span className="status-badge__icon" aria-hidden="true">●</span>
            <span className="status-badge__text">{STATUS_LABEL[subscription.status]}</span>
          </span>
          {updatedAt && <span className="upstream-card__updated">Updated <TimeDisplay iso={updatedAt} now={now} /></span>}
        </div>
      </header>
      <div className="upstream-card__metrics">
        {subscription.metrics.map((metric) => <QuotaRow key={metric.id} metric={metric} now={now} />)}
      </div>
    </>
  )
}

function QuotaRow({ metric, now }: { metric: DashboardMetric; now: Date }) {
  if (metric.display.module === "manual-status-card") return <StatusRow metric={metric} />
  const used = metric.used
  const percent = metric.percentUsed ?? (metric.limit && used !== undefined ? (used / metric.limit) * 100 : undefined)
  const remaining = metric.remaining ?? (percent !== undefined ? Math.max(0, 100 - percent) : undefined)
  const remainingPercent = remaining !== undefined && metric.limit && metric.limit > 0
    ? (remaining / metric.limit) * 100
    : remaining !== undefined && metric.unit === "%" ? remaining : undefined
  const progress = Math.min(100, Math.max(0, remainingPercent ?? 0))
  const monetary = metric.unit === "$"
  return (
    <article className="quota-row" data-metric={metric.id} data-status={metric.status}>
      <div className="quota-row__heading">
        <div>
          <h4>{metric.label}</h4>
          <div className="quota-row__window">
            {metric.window?.duration && <span>Window {metric.window.duration}</span>}
            {metric.window?.label && !metric.window.duration && <span>{metric.window.label}</span>}
          </div>
        </div>
        <div className="quota-row__headline">
          <strong>{remainingPercent !== undefined ? formatPercentUsed(remainingPercent, false) : "—"}</strong>
          <span>remaining</span>
        </div>
      </div>
      {remainingPercent !== undefined && (
        <div className="progress quota-row__progress" role="progressbar" aria-label={`${metric.label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} data-status={metric.status}>
          <div className="progress__fill" style={{ width: `${progress}%` }} />
        </div>
      )}
      <dl className="quota-row__facts">
        <div><dt>{monetary ? "Balance" : "Remaining"}</dt><dd>{monetary && remaining !== undefined && metric.limit !== undefined ? `${formatMetricValue(remaining, metric.unit)} / ${formatMetricValue(metric.limit, metric.unit)}` : remaining !== undefined ? formatMetricValue(remaining, metric.unit) : "—"}</dd></div>
        <div><dt>Used</dt><dd>{used !== undefined ? formatMetricValue(used, metric.unit) : "—"}</dd></div>
        <div><dt>Reset</dt><dd>{metric.window?.resetAt ? <><span>{formatReset(metric.window.resetAt)}</span><TimeDisplay iso={metric.window.resetAt} now={now} /></> : "Not reported"}</dd></div>
        <div><dt>Status</dt><dd className={`status-${metric.status}`}>{STATUS_LABEL[metric.status]}</dd></div>
      </dl>
      {metric.display.notes && <p className="quota-row__notes">{metric.display.notes}</p>}
    </article>
  )
}

function StatusRow({ metric }: { metric: DashboardMetric }) {
  return (
    <article className="quota-row quota-row--status" data-metric={metric.id} data-status={metric.status}>
      <div className="quota-row__heading">
        <div><h4>{metric.label}</h4></div>
        <div className="quota-row__headline quota-row__headline--status">
          <strong>{metric.display.notes ?? STATUS_LABEL[metric.status]}</strong>
        </div>
      </div>
    </article>
  )
}

function formatMetricValue(value: number, unit: string): string {
  if (unit === "$") return `$${value.toFixed(2)}`
  return `${formatNumber(value)}${unit}`
}

function formatReset(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date)
}
