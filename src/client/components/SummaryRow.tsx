import type { SummaryGroup } from "../../shared/dashboard-payload"
import { formatNumber, formatBurnRate } from "../format"
import { TimeDisplay } from "./TimeDisplay"
import { useI18n } from "../i18n"

const PROVIDER_LABELS: Record<string, string> = {
  poe: "Poe",
  zhipu: "Zhipu",
  kimi: "Kimi",
  "opencode-go": "OpenCode Go",
  volcengine: "Doubao",
  "mimo-token-plan": "Xiaomi MiMo",
  deepseek: "DeepSeek",
  stepfun: "StepFun",
  siliconflow: "SiliconFlow",
  minimax: "MiniMax",
  openrouter: "OpenRouter",
  novita: "Novita",
  zenmux: "ZenMux",
  manual: "Manual",
}

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
  const { locale, t } = useI18n()
  const burn = group.burnRate
  const conservative = group.estimatedExhaustionConfidence === "conservative"
  const providerLabel = group.providerType
    ? PROVIDER_LABELS[group.providerType] ?? group.providerType
    : undefined
  return (
    <article className="summary-card" data-summary={group.id}>
      <div className="summary-card__heading">
        {providerLabel && <span className="summary-card__provider">{providerLabel}</span>}
        <h3 className="summary-card__label">{group.label}</h3>
      </div>
      <div className="summary-card__remaining">
        <span>{t("remaining")}</span>
        <strong>{group.remaining != null ? formatNumber(group.remaining, locale) : "-"}</strong>
      </div>
      <dl className="summary-card__stats">
        <div className="summary-stat">
          <dt>{t("used")}</dt>
          <dd>{group.consumption != null ? formatNumber(group.consumption, locale) : "-"}</dd>
        </div>
        <div className="summary-stat">
          <dt>{t("burn")}</dt>
          <dd>{burn ? formatBurnRate(burn.value) : "-"}</dd>
        </div>
        <div className="summary-stat">
          <dt>{t("exhaustion")}</dt>
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
