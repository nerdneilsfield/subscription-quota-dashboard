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

const PROVIDER_HOST_ALLOWLIST: Record<string, string[]> = {
  siliconflow: ["api.siliconflow.cn", "api.siliconflow.com"],
  zhipu: ["open.bigmodel.cn", "api.z.ai"],
  minimax: ["api.minimaxi.com", "api.minimax.io"],
}

// Providers that use apiKeyEnv/apiKey credential resolution.
// Named API_KEY rather than BEARER because Zhipu uses raw key (no Bearer prefix).
const API_KEY_PROVIDER_TYPES = new Set([
  "poe", "deepseek", "stepfun", "siliconflow", "openrouter", "novita",
  "kimi", "zhipu", "minimax", "zenmux",
])

function resolveBearerCredential(
  provider: { apiKeyEnv?: string | undefined; apiKey?: string | undefined },
): { apiKey?: string | undefined; reason?: string | undefined } {
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
  const result: { apiKey?: string; reason?: string } = {}
  if (apiKey !== undefined) result.apiKey = apiKey
  if (reason !== undefined) result.reason = reason
  return result
}

function resolveAkSkCredential(
  provider: { akEnv?: string | undefined; ak?: string | undefined; skEnv?: string | undefined; sk?: string | undefined },
): { ak?: string | undefined; sk?: string | undefined; reason?: string | undefined } {
  const ak = resolveBearerCredential({ apiKeyEnv: provider.akEnv, apiKey: provider.ak })
  const sk = resolveBearerCredential({ apiKeyEnv: provider.skEnv, apiKey: provider.sk })
  if (ak.apiKey !== undefined && sk.apiKey !== undefined) {
    return { ak: ak.apiKey, sk: sk.apiKey }
  }
  return { reason: ak.reason ?? sk.reason ?? "missing AK or SK" }
}

function isPrivateIPv4(a: number, b: number, c: number, d: number): boolean {
  if (a === 0) return true // 0.0.0.0/8 (unspecified + reserved)
  if (a === 127) return true // loopback
  if (a === 10) return true // private 10/8
  if (a === 172 && b >= 16 && b <= 31) return true // private 172.16/12
  if (a === 192 && b === 168) return true // private 192.168/16
  if (a === 169 && b === 254) return true // link-local 169.254/16
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  return false
}

function expandIPv6(h: string): number[] | undefined {
  if (h === "::") return [0, 0, 0, 0, 0, 0, 0, 0]
  if (!h.includes("::")) {
    const parts = h.split(":")
    if (parts.length !== 8) return undefined
    const nums = parts.map((p) => parseInt(p, 16))
    if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return undefined
    return nums
  }
  const [left = "", right = ""] = h.split("::", 2)
  const leftParts = left === "" ? [] : left.split(":")
  const rightParts = right === "" ? [] : right.split(":")
  const zeroCount = 8 - leftParts.length - rightParts.length
  if (zeroCount < 0) return undefined
  const allParts = [...leftParts, ...Array(zeroCount).fill("0"), ...rightParts]
  const nums = allParts.map((p) => parseInt(p, 16))
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return undefined
  return nums
}

function isLoopbackOrPrivateHost(hostname: string): boolean {
  // Bun/Node URL.hostname strips the port but may return IPv6 literals WITH brackets.
  const h = hostname.toLowerCase().replace(/^\[|]$/g, "")
  if (h === "localhost") return true

  // IPv4 literal (dotted quad)
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b, c, d] = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if ([a, b, c, d].some((n) => n > 255)) return false
    return isPrivateIPv4(a, b, c, d)
  }

  if (!h.includes(":")) return false

  const groups = expandIPv6(h)
  if (groups === undefined) return false

  // Unspecified ::
  if (groups.every((n) => n === 0)) return true
  // ::1 loopback
  if (groups[0] === 0 && groups.slice(1, 7).every((n) => n === 0) && groups[7] === 1) return true

  // IPv4-mapped (::ffff/96) or IPv4-compatible (::/96) addresses carry an IPv4
  // address in the low 32 bits. The URL parser normalizes these to hex form,
  // so prefix matching alone is not enough.
  const isMapped = groups.slice(0, 5).every((n) => n === 0) && groups[5] === 0xffff
  const isCompatible = groups.slice(0, 6).every((n) => n === 0)
  if (isMapped || isCompatible) {
    const ipv4 = ((groups[6]! << 16) | groups[7]!) >>> 0
    const a = (ipv4 >>> 24) & 0xff
    const b = (ipv4 >>> 16) & 0xff
    const c = (ipv4 >>> 8) & 0xff
    const d = ipv4 & 0xff
    return isPrivateIPv4(a, b, c, d)
  }

  const g0 = groups[0]!
  // ULA fc00::/7
  if ((g0 & 0xfe00) === 0xfc00) return true
  // Link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfe80) return true
  // Multicast ff00::/8
  if ((g0 & 0xff00) === 0xff00) return true

  return false
}

function validateBaseUrl(baseUrl: string | undefined, providerType: string, path: string): void {
  if (baseUrl === undefined) return
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    fail(path, `baseUrl "${baseUrl}" is not a valid URL`)
  }
  const host = parsed.hostname.toLowerCase()
  if (isLoopbackOrPrivateHost(host)) {
    fail(path, `baseUrl host "${host}" is loopback or private (SSRF defense)`)
  }
  const allowlist = PROVIDER_HOST_ALLOWLIST[providerType]
  if (allowlist !== undefined && !allowlist.includes(host)) {
    fail(path, `baseUrl host "${host}" not in allowlist for ${providerType}: ${allowlist.join(", ")}`)
  }
  // zenmux has no hostname allowlist (user-supplied private deployments).
  // SSRF defense relies on isLoopbackOrPrivateHost string check at config-load
  // time. DNS rebinding (TOCTOU between config-load and request) is an
  // accepted risk documented in the spec: zenmux baseUrl is user-controlled
  // and pinned at deploy time.
}

// cliproxy allows loopback baseUrls (CLIProxyAPI runs on the same host as
// the dashboard). Private non-loopback addresses are still rejected to
// prevent SSRF via internal services.
function isLoopbackOnly(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|]$/g, "")
  if (h === "localhost") return true
  if (/^127\./.test(h)) return true
  if (h === "::1") return true
  // NOT :: (unspecified address -- should not be exempted)
  return false
}

function validateBaseUrlSkipLoopback(baseUrl: string, path: string): void {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    fail(path, `baseUrl "${baseUrl}" is not a valid URL`)
  }
  const host = parsed.hostname.toLowerCase()
  if (isLoopbackOrPrivateHost(host) && !isLoopbackOnly(host)) {
    fail(path, `baseUrl host "${host}" is private (non-loopback)`)
  }
}

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
    const providerPath = `providers[${provider.id}]`

    if (provider.type === "volcengine") {
      const region = provider.region ?? "cn-beijing"
      const { ak, sk, reason } = resolveAkSkCredential(provider)
      const state: ProviderRuntimeState =
        ak !== undefined && sk !== undefined
          ? { available: true, ak, sk }
          : { available: false, reason: reason ?? "missing AK or SK" }
      providers.set(provider.id, { ...provider, region })
      providerRuntime.set(provider.id, state)
    } else if (provider.type === "cliproxy") {
      if (!provider.baseUrl) {
        fail(`${providerPath}.baseUrl`, "cliproxy requires baseUrl")
      }
      validateBaseUrlSkipLoopback(provider.baseUrl, `${providerPath}.baseUrl`)
      if (provider.queryProviders !== undefined) {
        const knownProviders = new Set(["codex", "claude", "xai"])
        for (const qp of provider.queryProviders) {
          if (!knownProviders.has(qp)) {
            fail(`${providerPath}.queryProviders`, `unknown provider "${qp}"`)
          }
        }
      }
      const { apiKey, reason } = resolveBearerCredential(provider as { apiKeyEnv?: string | undefined; apiKey?: string | undefined })
      const state: ProviderRuntimeState = { available: apiKey !== undefined }
      if (apiKey !== undefined) state.apiKey = apiKey
      if (reason !== undefined) state.reason = reason
      providers.set(provider.id, provider)
      providerRuntime.set(provider.id, state)
    } else if (API_KEY_PROVIDER_TYPES.has(provider.type)) {
      // Validate baseUrl for providers that accept it
      if ("baseUrl" in provider && provider.baseUrl !== undefined) {
        validateBaseUrl(provider.baseUrl, provider.type, `${providerPath}.baseUrl`)
      }
      // zenmux requires baseUrl
      if (provider.type === "zenmux" && provider.baseUrl === undefined) {
        fail(`${providerPath}.baseUrl`, "zenmux requires baseUrl")
      }
      const { apiKey, reason } = resolveBearerCredential(
        provider as { apiKeyEnv?: string | undefined; apiKey?: string | undefined },
      )
      const state: ProviderRuntimeState = { available: apiKey !== undefined }
      if (apiKey !== undefined) state.apiKey = apiKey
      if (reason !== undefined) state.reason = reason
      providers.set(provider.id, provider)
      providerRuntime.set(provider.id, state)
    } else {
      // manual
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
    const seenDynIds = new Set<string>()
    for (const dynProviderId of profile.dynamicProviderIds ?? []) {
      if (!providers.has(dynProviderId)) {
        fail(
          `profiles[${profile.id}].dynamicProviderIds`,
          `references unknown provider "${dynProviderId}"`,
        )
      }
      if (seenDynIds.has(dynProviderId)) {
        fail(
          `profiles[${profile.id}].dynamicProviderIds`,
          `duplicate dynamicProviderId "${dynProviderId}"`,
        )
      }
      seenDynIds.add(dynProviderId)
      const referenced = providers.get(dynProviderId)
      if (referenced !== undefined && referenced.type !== "cliproxy") {
        fail(
          `profiles[${profile.id}].dynamicProviderIds`,
          `provider "${dynProviderId}" is not a cliproxy provider (only cliproxy supports dynamic discovery)`,
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
