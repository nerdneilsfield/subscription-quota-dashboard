import type { NormalizedConfig } from "../../shared/domain"
import { silentLogger, type Logger } from "../logging/logger"
import type { RefreshService } from "./refresh-service"

export type ProviderRefreshSchedule = {
  providerAccountId: string
  intervalSeconds: number
  subscriptionIds: string[]
}

export type RefreshScheduler = {
  schedules: ProviderRefreshSchedule[]
  start(): void
  stop(): void
}

type TimerHandle = unknown

export type RefreshSchedulerDeps = {
  config: NormalizedConfig
  refreshService: Pick<RefreshService, "refreshProviderAccounts">
  logger?: Logger
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimeoutFn?: (handle: TimerHandle) => void
}

export function resolveProviderRefreshSchedules(config: NormalizedConfig): ProviderRefreshSchedule[] {
  const globalInterval = config.refresh?.intervalSeconds
  const byProvider = new Map<string, ProviderRefreshSchedule>()

  for (const subscription of config.subscriptions.values()) {
    const intervalSeconds = subscription.refresh?.intervalSeconds ?? globalInterval
    if (intervalSeconds === undefined || intervalSeconds === 0) continue

    const current = byProvider.get(subscription.providerId)
    if (current === undefined) {
      byProvider.set(subscription.providerId, {
        providerAccountId: subscription.providerId,
        intervalSeconds,
        subscriptionIds: [subscription.id],
      })
      continue
    }

    current.intervalSeconds = Math.min(current.intervalSeconds, intervalSeconds)
    current.subscriptionIds.push(subscription.id)
  }

  // Dynamic providers have no configured subscription. They inherit only the
  // global interval when referenced by at least one profile.
  if (globalInterval !== undefined && globalInterval > 0) {
    const configuredProviderIds = new Set(
      [...config.subscriptions.values()].map((subscription) => subscription.providerId),
    )
    for (const profile of config.profiles.values()) {
      for (const providerAccountId of profile.dynamicProviderIds ?? []) {
        if (!configuredProviderIds.has(providerAccountId) && !byProvider.has(providerAccountId)) {
          byProvider.set(providerAccountId, {
            providerAccountId,
            intervalSeconds: globalInterval,
            subscriptionIds: [],
          })
        }
      }
    }
  }

  return [...byProvider.values()].sort((a, b) =>
    a.providerAccountId.localeCompare(b.providerAccountId),
  )
}

export function createRefreshScheduler(deps: RefreshSchedulerDeps): RefreshScheduler {
  const schedules = resolveProviderRefreshSchedules(deps.config)
  const logger = (deps.logger ?? silentLogger).child({ component: "refresh-scheduler" })
  const setTimer: (callback: () => void, delayMs: number) => TimerHandle =
    deps.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer: (handle: TimerHandle) => void =
    deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const timers = new Map<string, TimerHandle>()
  let started = false

  function arm(schedule: ProviderRefreshSchedule): void {
    if (!started) return
    const handle = setTimer(() => {
      timers.delete(schedule.providerAccountId)
      void run(schedule)
    }, schedule.intervalSeconds * 1000)
    if (typeof handle === "object" && handle !== null && "unref" in handle) {
      ;(handle as { unref(): void }).unref()
    }
    timers.set(schedule.providerAccountId, handle)
  }

  async function run(schedule: ProviderRefreshSchedule): Promise<void> {
    if (!started) return
    logger.info("refresh.scheduler.tick", {
      providerAccountId: schedule.providerAccountId,
      intervalSeconds: schedule.intervalSeconds,
      subscriptionIds: schedule.subscriptionIds,
    })
    try {
      await deps.refreshService.refreshProviderAccounts(
        [schedule.providerAccountId],
        "scheduler",
      )
    } catch (error) {
      logger.error("refresh.scheduler.failed", {
        providerAccountId: schedule.providerAccountId,
        error,
      })
    } finally {
      arm(schedule)
    }
  }

  function start(): void {
    if (started) return
    started = true
    logger.info("refresh.scheduler.started", {
      providerAccountCount: schedules.length,
      schedules,
    })
    for (const schedule of schedules) void run(schedule)
  }

  function stop(): void {
    if (!started) return
    started = false
    for (const handle of timers.values()) clearTimer(handle)
    timers.clear()
    logger.info("refresh.scheduler.stopped")
  }

  return { schedules, start, stop }
}
