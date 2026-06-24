export type DeltaInput = {
  kind: "counter" | "gauge-remaining" | "gauge-used"
  earlier: { timestamp: string; value: number }
  later: { timestamp: string; value: number }
  resetBoundaries: string[]
  preBoundary?: { timestamp: string; value: number }
  postBoundary?: { timestamp: string; value: number }
}

export type DeltaResult =
  | { status: "known"; consumption: number; sourceConfidence: "known" | "estimated" }
  | { status: "unknown"; reason: string }

function segmentConsumption(
  kind: DeltaInput["kind"],
  a: { value: number },
  b: { value: number },
): number {
  if (kind === "gauge-remaining") return a.value - b.value
  return b.value - a.value
}

export function computeSnapshotDelta(input: DeltaInput): DeltaResult {
  const earlierMs = Date.parse(input.earlier.timestamp)
  const laterMs = Date.parse(input.later.timestamp)

  const crossings = input.resetBoundaries
    .map((iso) => Date.parse(iso))
    .filter((ms) => !Number.isNaN(ms) && ms > earlierMs && ms < laterMs)

  if (crossings.length === 0) {
    if (input.kind === "gauge-remaining" && input.later.value > input.earlier.value) {
      return { status: "unknown", reason: "gauge-remaining increased without a reset boundary (refill unexplained)" }
    }
    if ((input.kind === "gauge-used" || input.kind === "counter") && input.later.value < input.earlier.value) {
      return { status: "unknown", reason: `${input.kind} decreased without a reset boundary` }
    }
    return {
      status: "known",
      consumption: segmentConsumption(input.kind, input.earlier, input.later),
      sourceConfidence: "known",
    }
  }

  if (input.preBoundary !== undefined && input.postBoundary !== undefined) {
    const before = segmentConsumption(input.kind, input.earlier, input.preBoundary)
    const after = segmentConsumption(input.kind, input.postBoundary, input.later)
    return {
      status: "known",
      consumption: before + after,
      sourceConfidence: "estimated",
    }
  }

  return { status: "unknown", reason: "reset crossing occurred without preBoundary and postBoundary samples" }
}
