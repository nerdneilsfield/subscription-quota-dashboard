import { expect, test } from "bun:test"
import { computeSnapshotDelta } from "../../src/server/stats/delta"

test("gauge-remaining delta uses earlier minus later", () => {
  const result = computeSnapshotDelta({
    kind: "gauge-remaining",
    earlier: { timestamp: "2026-06-25T00:00:00Z", value: 100 },
    later: { timestamp: "2026-06-25T01:00:00Z", value: 70 },
    resetBoundaries: [],
  })
  expect(result).toEqual({ status: "known", consumption: 30, sourceConfidence: "known" })
})

test("reset crossing without boundary samples returns unknown", () => {
  const result = computeSnapshotDelta({
    kind: "gauge-used",
    earlier: { timestamp: "2026-06-30T23:00:00Z", value: 90 },
    later: { timestamp: "2026-07-01T01:00:00Z", value: 10 },
    resetBoundaries: ["2026-07-01T00:00:00Z"],
  })
  expect(result.status).toBe("unknown")
})

test("counter reset crossing with boundary samples returns estimated consumption", () => {
  const result = computeSnapshotDelta({
    kind: "counter",
    earlier: { timestamp: "2026-06-30T23:00:00Z", value: 1000 },
    later: { timestamp: "2026-07-01T01:00:00Z", value: 15 },
    resetBoundaries: ["2026-07-01T00:00:00Z"],
    preBoundary: { timestamp: "2026-06-30T23:58:00Z", value: 1030 },
    postBoundary: { timestamp: "2026-07-01T00:02:00Z", value: 4 },
  })
  expect(result).toEqual({ status: "known", consumption: 41, sourceConfidence: "estimated" })
})

test("gauge-remaining refill without reset boundary returns unknown", () => {
  const result = computeSnapshotDelta({
    kind: "gauge-remaining",
    earlier: { timestamp: "2026-06-25T00:00:00Z", value: 20 },
    later: { timestamp: "2026-06-25T01:00:00Z", value: 100 },
    resetBoundaries: [],
  })
  expect(result.status).toBe("unknown")
})
