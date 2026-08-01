import { currentLogger } from "./context"
import type { Logger } from "./logger"

function describeTarget(input: string | URL | Request): { targetOrigin: string; targetPath: string; queryKeys: string[] } {
  const url = new URL(input instanceof Request ? input.url : input)
  return {
    targetOrigin: url.origin,
    targetPath: url.pathname,
    queryKeys: [...url.searchParams.keys()],
  }
}

export function createLoggedFetch(baseLogger: Logger, fetchImpl: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const logger = currentLogger() ?? baseLogger
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const target = describeTarget(input)
    const startedAt = performance.now()
    logger.debug("upstream.request.started", { method, ...target })
    try {
      const response = await fetchImpl(input, init)
      const fields = {
        method,
        ...target,
        status: response.status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      }
      if (response.ok) logger.debug("upstream.request.completed", fields)
      else logger.warn("upstream.request.completed", fields)
      return response
    } catch (error) {
      logger.warn("upstream.request.failed", {
        method,
        ...target,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        error,
      })
      throw error
    }
  }) as typeof fetch
}
