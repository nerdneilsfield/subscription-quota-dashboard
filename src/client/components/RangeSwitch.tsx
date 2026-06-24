import type { RangeKey } from "../../shared/domain"

interface RangeSwitchProps {
  ranges: RangeKey[]
  selected: RangeKey
  onSelect: (range: RangeKey) => void
  loading?: boolean
}

export function RangeSwitch({ ranges, selected, onSelect, loading }: RangeSwitchProps) {
  return (
    <div className="range-switch" role="group" aria-label="Select time range">
      {ranges.map((r) => (
        <button
          key={r}
          type="button"
          className={`range-switch__btn${r === selected ? " is-active" : ""}`}
          aria-pressed={r === selected}
          onClick={() => onSelect(r)}
        >
          {r}
        </button>
      ))}
      {loading && (
        <span className="range-switch__skeleton" data-range-skeleton aria-hidden="true" />
      )}
    </div>
  )
}
