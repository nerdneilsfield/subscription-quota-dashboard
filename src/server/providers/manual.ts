import { normalizeManualMetric } from "./manual-normalize"
import type {
  ProviderAdapter,
  ProviderRefreshInput,
  ProviderRefreshResult,
} from "./types"

export function createManualProvider(): ProviderAdapter {
  return {
    type: "manual",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const metrics = input.metrics.map((metric) => normalizeManualMetric(metric, input.now))
      return {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: input.now,
        metrics,
      }
    },
  }
}
