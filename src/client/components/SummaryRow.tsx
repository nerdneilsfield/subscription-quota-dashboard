import type { SummaryGroup } from "../../shared/dashboard-payload"
import { formatNumber, formatBurnRate } from "../format"
import { TimeDisplay } from "./TimeDisplay"

interface SummaryRowProps {
  groups: SummaryGroup[]
  now: Date
}

export function SummaryRow({ groups, now }: SummaryRowProps) {
  return (
    <div className="summary-grid" data-testid="summary">
      {groups.map((g) => (
        <SummaryCard key={g.id} group={g} now={now} />
      ))}
    </div>
  )
}

function SummaryCard({ group, now }: { group: SummaryGroup; now: Date }) {
  const burn = group.burnRate
  const conservative = group.estimatedExhaustionConfidence === "conservative"
  return (
    <article className="summary-card" data-summary={group.id}>
      <h3 className="summary-card__label">{group.label}</h3>
      <div className="summary-card__remaining">
        {group.remaining != null ? formatNumber(group.remaining) : "-"}
      </div>
      <dl className="summary-card__stats">
        <div className="summary-stat">
          <dt>Used</dt>
          <dd>{group.consumption != null ? formatNumber(group.consumption) : "-"}</dd>
        </div>
        <div className="summary-stat">
          <dt>Burn</dt>
          <dd>{burn ? formatBurnRate(burn.value) : "-"}</dd>
        </div>
        <div className="summary-stat">
          <dt>Exhaustion</dt>
          <dd>
            {group.estimatedExhaustionAt ? (
              <TimeDisplay
                iso={group.estimatedExhaustionAt}
                now={now}
                overdueIfPast
                {...(conservative ? { prefix: "≈" } : {})}
              />
            ) : (
              "-"
            )}
          </dd>
        </div>
      </dl>
    </article>
  )
}
