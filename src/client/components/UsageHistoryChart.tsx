/* Hallmark · component: usage-history-chart · genre: technical-console · theme: existing Operations Matrix
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (46–50)
 */
import { useMemo, useState } from "react"
import type { SubscriptionHistoryMetric, SubscriptionHistoryPoint } from "../../shared/subscription-history"
import { formatNumber } from "../format"
import { useI18n } from "../i18n"

type PlottedPoint = SubscriptionHistoryPoint & { value: number; x: number; y: number }

export function UsageHistoryChart({ metric }: { metric: SubscriptionHistoryMetric }) {
  const { locale, t } = useI18n()
  const [hovered, setHovered] = useState<number | null>(null)
  const width = 800
  const height = 260
  const pad = { top: 18, right: 18, bottom: 34, left: 54 }
  const percentMode = metric.points.some((point) => point.percentUsed !== undefined)
  const raw = useMemo(() => metric.points.flatMap((point) => {
    const value = percentMode
      ? point.percentUsed
      : point.used ?? point.authoritativeValue ?? point.remaining
    return value === undefined || !Number.isFinite(value) ? [] : [{ ...point, value }]
  }), [metric.points, percentMode])

  if (raw.length < 2) {
    return <div className="history-chart history-chart--empty">{t("historyNotEnoughData")}</div>
  }

  const times = raw.map((point) => Date.parse(point.timestamp))
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const values = raw.map((point) => point.value)
  const minValue = percentMode ? 0 : Math.min(...values)
  const maxValue = percentMode ? Math.max(100, ...values) : Math.max(...values)
  const spread = Math.max(1, maxValue - minValue)
  const yMin = percentMode ? 0 : Math.max(0, minValue - spread * 0.12)
  const yMax = percentMode ? maxValue : maxValue + spread * 0.12
  const xSpan = Math.max(1, maxTime - minTime)
  const ySpan = Math.max(1, yMax - yMin)
  const plotted: PlottedPoint[] = raw.map((point) => ({
    ...point,
    x: pad.left + ((Date.parse(point.timestamp) - minTime) / xSpan) * (width - pad.left - pad.right),
    y: pad.top + (1 - (point.value - yMin) / ySpan) * (height - pad.top - pad.bottom),
  }))

  const gaps = times.slice(1).map((time, index) => time - times[index]!).filter((gap) => gap > 0).sort((a, b) => a - b)
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : Number.POSITIVE_INFINITY
  const segments: PlottedPoint[][] = []
  for (const point of plotted) {
    const previous = segments.at(-1)?.at(-1)
    if (!previous || Date.parse(point.timestamp) - Date.parse(previous.timestamp) > medianGap * 3.5) segments.push([point])
    else segments.at(-1)!.push(point)
  }
  const resetThreshold = Math.max(1, spread * 0.08)
  const resets = plotted.filter((point, index) => index > 0 && plotted[index - 1]!.value - point.value > resetThreshold)
  const active = hovered === null ? plotted.at(-1)! : plotted[hovered]!
  const formatMetricValue = (value: number) => metric.unit === "$"
    ? `$${formatNumber(value, locale)}`
    : `${formatNumber(value, locale)}${metric.unit}`
  const formatValue = (value: number) => percentMode ? `${value.toFixed(value < 10 ? 1 : 0)}%` : formatMetricValue(value)
  const dateFormat = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })

  return (
    <article className="history-chart" data-state="success">
      <header className="history-chart__header">
        <div><h3>{metric.label}</h3><span>{percentMode ? t("percentUsedHistory") : t("usageHistory")}</span></div>
        <strong>{formatValue(active.value)}</strong>
      </header>
      <div className="history-chart__plot">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t("historyChartAria", { label: metric.label })}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * width
            let nearest = 0
            for (let index = 1; index < plotted.length; index += 1) {
              if (Math.abs(plotted[index]!.x - x) < Math.abs(plotted[nearest]!.x - x)) nearest = index
            }
            setHovered(nearest)
          }}
          onPointerLeave={() => setHovered(null)}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = pad.top + ratio * (height - pad.top - pad.bottom)
            const value = yMax - ratio * ySpan
            return <g key={ratio}><line className="history-chart__grid" x1={pad.left} x2={width - pad.right} y1={y} y2={y} /><text className="history-chart__axis" x={pad.left - 8} y={y + 4} textAnchor="end">{formatValue(value)}</text></g>
          })}
          {segments.map((segment, index) => segment.length > 1 && (
            <polyline key={index} className="history-chart__line" points={segment.map((point) => `${point.x},${point.y}`).join(" ")} />
          ))}
          {resets.map((point) => <line key={point.timestamp} className="history-chart__reset" x1={point.x} x2={point.x} y1={pad.top} y2={height - pad.bottom} />)}
          <line className="history-chart__cursor" x1={active.x} x2={active.x} y1={pad.top} y2={height - pad.bottom} />
          <circle className="history-chart__point" cx={active.x} cy={active.y} r="5" />
          <text className="history-chart__axis" x={pad.left} y={height - 8}>{dateFormat.format(new Date(minTime))}</text>
          <text className="history-chart__axis" x={width - pad.right} y={height - 8} textAnchor="end">{dateFormat.format(new Date(maxTime))}</text>
        </svg>
      </div>
      <dl className="history-chart__tooltip" aria-live="polite">
        <div><dt>{t("snapshot")}</dt><dd>{dateFormat.format(new Date(active.timestamp))}</dd></div>
        <div><dt>{t("used")}</dt><dd>{active.used !== undefined ? formatMetricValue(active.used) : "—"}</dd></div>
        <div><dt>{t("remaining")}</dt><dd>{active.remaining !== undefined ? formatMetricValue(active.remaining) : "—"}</dd></div>
        <div><dt>{t("limit")}</dt><dd>{active.limit !== undefined ? formatMetricValue(active.limit) : "—"}</dd></div>
      </dl>
    </article>
  )
}
