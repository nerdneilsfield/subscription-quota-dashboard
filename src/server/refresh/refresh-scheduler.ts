import type { NormalizedConfig, ProviderAccountConfig } from "../../shared/domain"
import { silentLogger, type Logger } from "../logging/logger"
import type { RefreshService } from "./refresh-service"

export type ProviderRefreshSchedule = {
  upstreamKey: string
  providerType: ProviderAccountConfig["type"]
  upstreamUrl: string
  providerAccountIds: string[]
  intervalSeconds: number
  subscriptionIds: string[]
}

export type RefreshScheduler = {
  schedules: ProviderRefreshSchedule[]
  start(): void
  stop(): void
}

type TimerHandle = unknown

type AccountSchedule = {
  providerAccountId: string
  intervalSeconds: number
  subscriptionIds: string[]
}

export type RefreshSchedulerDeps = {
  config: NormalizedConfig
  refreshService: Pick<RefreshService, "refreshProviderAccounts">
  logger?: Logger
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimeoutFn?: (handle: TimerHandle) => void
}

function providerUpstream(provider: ProviderAccountConfig): {
  upstreamKey: string
  upstreamUrl: string
} {
  const configuredUrl = "baseUrl" in provider ? provider.baseUrl : undefined
  const upstreamUrl = configuredUrl
    ? new URL(configuredUrl).href.replace(/\/$/, "")
    : "default"
  return {
    upstreamKey: `${provider.type}:${upstreamUrl}`,
    upstreamUrl,
  }
}

export function resolveProviderRefreshSchedules(config: NormalizedConfig): ProviderRefreshSchedule[] {
  const globalInterval = config.refresh?.intervalSeconds
  const byProvider = new Map<string, AccountSchedule>()

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

  const byUpstream = new Map<string, ProviderRefreshSchedule>()
  for (const account of byProvider.values()) {
    const provider = config.providers.get(account.providerAccountId)
    if (provider === undefined) continue
    const { upstreamKey, upstreamUrl } = providerUpstream(provider)
    const current = byUpstream.get(upstreamKey)
    if (current === undefined) {
      byUpstream.set(upstreamKey, {
        upstreamKey,
        providerType: provider.type,
        upstreamUrl,
        providerAccountIds: [account.providerAccountId],
        intervalSeconds: account.intervalSeconds,
        subscriptionIds: [...account.subscriptionIds],
      })
      continue
    }
    current.intervalSeconds = Math.min(current.intervalSeconds, account.intervalSeconds)
    current.providerAccountIds.push(account.providerAccountId)
    current.subscriptionIds.push(...account.subscriptionIds)
  }

  return [...byUpstream.values()]
    .map((schedule) => ({
      ...schedule,
      providerAccountIds: schedule.providerAccountIds.sort(),
      subscriptionIds: schedule.subscriptionIds.sort(),
    }))
    .sort((a, b) => a.upstreamKey.localeCompare(b.upstreamKey))
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
      timers.delete(schedule.upstreamKey)
      void run(schedule)
    }, schedule.intervalSeconds * 1000)
    if (typeof handle === "object" && handle !== null && "unref" in handle) {
      ;(handle as { unref(): void }).unref()
    }
    timers.set(schedule.upstreamKey, handle)
  }

  async function run(schedule: ProviderRefreshSchedule): Promise<void> {
    if (!started) return
    logger.info("refresh.scheduler.tick", {
      upstreamKey: schedule.upstreamKey,
      providerAccountIds: schedule.providerAccountIds,
      intervalSeconds: schedule.intervalSeconds,
      subscriptionIds: schedule.subscriptionIds,
    })
    try {
      await deps.refreshService.refreshProviderAccounts(
        schedule.providerAccountIds,
        "scheduler",
      )
    } catch (error) {
      logger.error("refresh.scheduler.failed", {
        upstreamKey: schedule.upstreamKey,
        providerAccountIds: schedule.providerAccountIds,
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
