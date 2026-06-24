import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type {
  DashboardConfigInput,
  LimitWindow,
  MetricConfig,
  NormalizedConfig,
  ProfileConfig,
  ProviderAccountConfig,
  ProviderRuntimeState,
  SourceValueKind,
  SubscriptionConfig,
} from "../../shared/domain"

const ROLLING_DURATION_RE = /^\d+(m|h|d)$/
const VALID_DISPLAY_MODULES = new Set<string>([
  "balance-card",
  "rolling-window-card",
  "period-quota-card",
  "manual-status-card",
])

function fail(path: string, message: string): never {
  throw new Error(`Invalid dashboard config: ${path}: ${message}`)
}

function validateWindow(window: LimitWindow, path: string): void {
  if (window.kind === "calendar") {
    if (window.timezone === undefined || window.timezone === "") {
      fail(path, "calendar window requires timezone")
    }
    const hasResetAt = window.resetAt !== undefined
    const anchor = window.anchor
    if (hasResetAt && anchor !== undefined) {
      fail(path, "calendar window must specify exactly one of resetAt or anchor")
    }
    if (!hasResetAt && anchor === undefined) {
      fail(path, "calendar window must specify exactly one of resetAt or anchor")
    }
    if (anchor !== undefined) {
      switch (window.period) {
        case "day":
          if (anchor.timeOfDay === undefined) fail(path, "calendar day anchor requires timeOfDay")
          break
        case "week":
          if (anchor.dayOfWeek === undefined) fail(path, "calendar week anchor requires dayOfWeek")
          if (anchor.timeOfDay === undefined) fail(path, "calendar week anchor requires timeOfDay")
          break
        case "month":
          if (anchor.dayOfMonth === undefined) fail(path, "calendar month anchor requires dayOfMonth")
          if (anchor.timeOfDay === undefined) fail(path, "calendar month anchor requires timeOfDay")
          break
        case "year":
          if (anchor.monthOfYear === undefined) fail(path, "calendar year anchor requires monthOfYear")
          if (anchor.dayOfMonth === undefined) fail(path, "calendar year anchor requires dayOfMonth")
          if (anchor.timeOfDay === undefined) fail(path, "calendar year anchor requires timeOfDay")
          break
      }
    }
  } else if (window.kind === "rolling") {
    if (!ROLLING_DURATION_RE.test(window.duration)) {
      fail(path, `rolling window duration must match ${ROLLING_DURATION_RE.source}`)
    }
  } else {
    if (window.startsAt === undefined || window.resetAt === undefined) {
      fail(path, "fixed window requires startsAt and resetAt")
    } else if (Number.isNaN(Date.parse(window.startsAt)) || Number.isNaN(Date.parse(window.resetAt))) {
      fail(path, "fixed window startsAt and resetAt must be valid timestamps")
    } else if (Date.parse(window.startsAt) >= Date.parse(window.resetAt)) {
      fail(path, "fixed window requires startsAt < resetAt")
    }
  }
}

function inferSourceValueKind(metric: MetricConfig): SourceValueKind {
  const hasUsed = metric.used !== undefined
  const hasRemaining = metric.remaining !== undefined
  if (hasUsed) return "gauge-used"
  if (hasRemaining) return "gauge-remaining"
  return "status"
}

export function loadDashboardConfig(input: DashboardConfigInput): NormalizedConfig {
  const providers = new Map<string, ProviderAccountConfig>()
  const providerRuntime = new Map<string, ProviderRuntimeState>()

  for (const provider of input.providers) {
    if (providers.has(provider.id)) {
      fail(`providers[${provider.id}]`, "duplicate provider id")
    }
    if (provider.type === "poe") {
      const envName = provider.apiKeyEnv
      let apiKey: string | undefined
      let reason: string | undefined
      if (envName !== undefined) {
        const fromEnv = process.env[envName]
        if (fromEnv !== undefined && fromEnv !== "") {
          apiKey = fromEnv
        } else if (provider.apiKey !== undefined) {
          apiKey = provider.apiKey
        } else {
          reason = `environment variable ${envName} is not set and no apiKey fallback was provided`
        }
      } else if (provider.apiKey !== undefined) {
        apiKey = provider.apiKey
      } else {
        reason = "no apiKeyEnv or apiKey configured"
      }
      const state: ProviderRuntimeState = { available: apiKey !== undefined }
      if (apiKey !== undefined) state.apiKey = apiKey
      if (reason !== undefined) state.reason = reason
      providers.set(provider.id, provider)
      providerRuntime.set(provider.id, state)
    } else {
      providers.set(provider.id, provider)
      providerRuntime.set(provider.id, { available: true })
    }
  }

  const subscriptions = new Map<string, SubscriptionConfig>()
  for (const subscription of input.subscriptions) {
    if (subscriptions.has(subscription.id)) {
      fail(`subscriptions[${subscription.id}]`, "duplicate subscription id")
    }
    const provider = providers.get(subscription.providerId)
    if (provider === undefined) {
      fail(
        `subscriptions[${subscription.id}].providerId`,
        `references unknown provider "${subscription.providerId}"`,
      )
    }
    const metricIds = new Set<string>()
    const normalizedMetrics: MetricConfig[] = []
    for (const rawMetric of subscription.metrics) {
      const metricPath = `subscriptions[${subscription.id}].metrics[${rawMetric.id}]`
      if (metricIds.has(rawMetric.id)) {
        fail(metricPath, "duplicate metric id within subscription")
      }
      metricIds.add(rawMetric.id)
      const metric: MetricConfig = { ...rawMetric }
      if (metric.providerMetricId === undefined) {
        metric.providerMetricId = metric.id
      }
      if (!VALID_DISPLAY_MODULES.has(metric.display.module)) {
        fail(
          `${metricPath}.display.module`,
          `unknown display module "${metric.display.module}"`,
        )
      }
      if (metric.window !== undefined) {
        validateWindow(metric.window, `${metricPath}.window`)
      }
      if (
        provider?.type === "manual" &&
        metric.window?.kind === "rolling" &&
        metric.updatedAt === undefined
      ) {
        fail(
          `${metricPath}.updatedAt`,
          "manual rolling metric requires updatedAt",
        )
      }
      if (provider?.type === "manual" && metric.sourceValueKind === undefined) {
        metric.sourceValueKind = inferSourceValueKind(metric)
      }
      normalizedMetrics.push(metric)
    }
    subscriptions.set(subscription.id, { ...subscription, metrics: normalizedMetrics })
  }

  const profiles = new Map<string, ProfileConfig>()
  for (const profile of input.profiles) {
    if (profiles.has(profile.id)) {
      fail(`profiles[${profile.id}]`, "duplicate profile id")
    }
    if (profile.viewKey === undefined || profile.viewKey === "") {
      fail(`profiles[${profile.id}].viewKey`, "must be a non-empty string")
    }
    for (const subscriptionId of profile.subscriptionIds) {
      if (!subscriptions.has(subscriptionId)) {
        fail(
          `profiles[${profile.id}].subscriptionIds`,
          `references unknown subscription "${subscriptionId}"`,
        )
      }
    }
    profiles.set(profile.id, profile)
  }

  return { providers, providerRuntime, subscriptions, profiles }
}

export async function loadDashboardConfigFromFile(
  path: string = "config/dashboard.config.ts",
): Promise<NormalizedConfig> {
  const url = pathToFileURL(resolve(path)).href
  const imported = (await import(url)) as { default: DashboardConfigInput }
  return loadDashboardConfig(imported.default)
}
