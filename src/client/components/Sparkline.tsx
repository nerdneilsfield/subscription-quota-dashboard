import type { DashboardRangeStats } from "../../shared/dashboard-payload"
import type { MetricStatus } from "../../shared/domain"

interface SparklineProps {
  series?: DashboardRangeStats["series"]
  status?: MetricStatus
}

const STATUS_COLOR: Record<MetricStatus, string> = {
  ok: "var(--status-ok)",
  warn: "var(--status-warn)",
  critical: "var(--status-critical)",
  stale: "var(--status-stale)",
  unavailable: "var(--status-unavailable)",
  expired: "var(--status-expired)",
}

export function Sparkline({ series, status = "ok" }: SparklineProps) {
  if (!series || series.length < 2) return null
  const values = series.map((s) => s.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const width = 100
  const height = 24
  const points = series
    .map((s, i) => {
      const x = (i / (series.length - 1)) * width
      const y = height - ((s.value - min) / span) * height
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(" ")
  return (
    <svg
      className="sparkline"
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="transparent"
        stroke={STATUS_COLOR[status]}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
