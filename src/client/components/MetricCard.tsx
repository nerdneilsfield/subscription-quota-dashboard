import type { DashboardMetric } from "../../shared/dashboard-payload"
import type { DisplayModule, MetricStatus } from "../../shared/domain"
import { formatNumber, formatBurnRate, formatPercentUsed } from "../format"
import { Sparkline } from "./Sparkline"
import { TimeDisplay } from "./TimeDisplay"

export const STATUS_LABEL: Record<MetricStatus, string> = {
  ok: "OK",
  warn: "Warning",
  critical: "Critical",
  stale: "Stale",
  unavailable: "Unavailable",
  expired: "Expired",
}

const STATUS_ICON: Record<MetricStatus, string> = {
  ok: "●",
  warn: "▲",
  critical: "✕",
  stale: "○",
  unavailable: "—",
  expired: "⌛",
}

interface MetricCardProps {
  metric: DashboardMetric
  now: Date
}

export function MetricCard({ metric, now }: MetricCardProps) {
  const status = metric.status
  const unknownRange = metric.rangeStats?.source === "unknown"
  const hasQuota = metric.display.module === "balance-card" || metric.display.module === "period-quota-card"
  const hasTrend = (metric.rangeStats?.series?.length ?? 0) >= 2
  return (
    <article className={`metric-card${hasQuota ? " metric-card--quota" : ""}${hasTrend ? "" : " metric-card--no-trend"}`} data-metric={metric.id} data-status={status}>
      <header className="metric-card__header">
        <h4 className="metric-card__label">{metric.label}</h4>
        <span className={`status-badge status-${status}`} data-status={status}>
          <span className="status-badge__icon" aria-hidden="true">{STATUS_ICON[status]}</span>
          <span className="status-badge__text">{STATUS_LABEL[status]}</span>
        </span>
        {metric.window?.label && <div className="metric-card__window">{metric.window.label}</div>}
      </header>
      {unknownRange && <div className="metric-card__unknown">insufficient data</div>}
      {!unknownRange && <ModuleBody metric={metric} now={now} />}
      {hasTrend && metric.rangeStats && metric.rangeStats.source !== "unknown" && (
        <div className="metric-card__sparkline">
          <Sparkline series={metric.rangeStats.series} status={status} />
        </div>
      )}
    </article>
  )
}

function ModuleBody({ metric, now }: { metric: DashboardMetric; now: Date }) {
  const module: DisplayModule = metric.display.module
  if (module === "balance-card") {
    return <BalanceBody metric={metric} />
  }
  if (module === "rolling-window-card") {
    return <RollingBody metric={metric} />
  }
  if (module === "period-quota-card") {
    return <PeriodBody metric={metric} />
  }
  return <ManualBody metric={metric} now={now} />
}

function BalanceBody({ metric }: { metric: DashboardMetric }) {
  const burn = metric.rangeStats?.burnRate
  const remainingPercent = metric.limit && metric.limit > 0 && metric.remaining !== undefined
    ? Math.min(100, Math.max(0, (metric.remaining / metric.limit) * 100))
    : undefined
  return (
    <div className="metric-card__body metric-card__body--quota">
      <div className="metric-card__primary">
        <div className="metric-stat metric-stat--primary">
          <span className="metric-stat__value">{metric.remaining != null ? formatNumber(metric.remaining) : "—"}</span>
          <span className="metric-stat__unit">{metric.unit}</span>
          <span className="metric-stat__caption">remaining</span>
        </div>
        {remainingPercent !== undefined && <strong className="metric-card__percent metric-card__percent--primary">{Math.round(remainingPercent)}%</strong>}
      </div>
      {remainingPercent !== undefined && (
        <div
          className="progress metric-card__balance-progress"
          role="progressbar"
          aria-label={`${metric.label} remaining`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(remainingPercent)}
          data-status={metric.status}
        >
          <div className="progress__fill" style={{ width: `${remainingPercent}%` }} />
        </div>
      )}
      <div className="metric-card__quota-meta">
        <span>{remainingPercent !== undefined ? `${Math.round(remainingPercent)}% remaining` : "Limit not reported"}</span>
        {burn && <span>Burn <strong>{formatBurnRate(burn.value)}</strong></span>}
      </div>
    </div>
  )
}

function RollingBody({ metric }: { metric: DashboardMetric }) {
  const usage = metric.used ?? metric.remaining
  return (
    <div className="metric-card__body">
      {metric.window?.duration && <div className="metric-card__duration">Window {metric.window.duration}</div>}
      <div className="metric-stat metric-stat--inline">
        <span className="metric-stat__label">Current</span>
        <span className="metric-stat__value">{usage != null ? formatNumber(usage) : "-"}</span>
        <span className="metric-stat__unit">{metric.unit}</span>
      </div>
    </div>
  )
}

function PeriodBody({ metric }: { metric: DashboardMetric }) {
  const limit = metric.limit
  const used = metric.used ?? 0
  const percent = metric.percentUsed ?? (limit ? Math.min(100, (used / limit) * 100) : 0)
  const overflow = (metric.percentUsed ?? 0) > 100
  const barWidth = Math.min(100, Math.max(0, percent))
  const hasBar = limit != null
  return (
    <div className="metric-card__body metric-card__body--quota">
      <div className="metric-card__primary">
        <div className="metric-card__quota">
          <span>{formatNumber(used)}</span>
          <span className="metric-card__quota-sep">/</span>
          <span>{limit != null ? formatNumber(limit) : "-"}</span>
          <span className="metric-stat__unit">{metric.unit}</span>
        </div>
        {hasBar && <strong className="metric-card__percent metric-card__percent--primary">{formatPercentUsed(percent, overflow)}</strong>}
      </div>
      {hasBar && (
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.max(0, Math.round(percent)))}
          data-status={metric.status}
        >
          <div className="progress__fill" style={{ width: `${barWidth}%` }} />
        </div>
      )}
      <div className="metric-card__quota-meta">
        <span>Used {formatPercentUsed(percent, overflow)}</span>
        <span>Remaining <strong>{metric.remaining != null ? formatNumber(metric.remaining) : "-"}</strong></span>
      </div>
    </div>
  )
}

function ManualBody({ metric, now }: { metric: DashboardMetric; now: Date }) {
  const notes = metric.display.notes
  const updatedAt = metric.display.updatedAt
  return (
    <div className="metric-card__body metric-card__body--manual">
      {notes && <p className="metric-card__notes">{notes}</p>}
      {updatedAt && (
        <div className="metric-card__updated">
          Updated <TimeDisplay iso={updatedAt} now={now} />
        </div>
      )}
    </div>
  )
}
