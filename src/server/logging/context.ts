import { AsyncLocalStorage } from "node:async_hooks"
import type { Logger } from "./logger"

const loggerContext = new AsyncLocalStorage<Logger>()

export function runWithLogger<T>(logger: Logger, fn: () => T): T {
  return loggerContext.run(logger, fn)
}

export function currentLogger(): Logger | undefined {
  return loggerContext.getStore()
}
