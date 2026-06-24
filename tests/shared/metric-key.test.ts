import { expect, test } from "bun:test"
import { buildMetricKey, parseMetricKey } from "../../src/shared/metric-key"

test("metric key URL-encodes each segment", () => {
  const key = buildMetricKey("poe/main", "self dashboard", "points")
  expect(key).toBe("poe%2Fmain/self%20dashboard/points")
  expect(parseMetricKey(key)).toEqual({ providerAccountId: "poe/main", subscriptionId: "self dashboard", metricId: "points" })

  const literalEncoded = buildMetricKey("poe%2Fmain", "self", "points")
  expect(literalEncoded).toBe("poe%252Fmain/self/points")
  expect(parseMetricKey(literalEncoded).providerAccountId).toBe("poe%2Fmain")
})
