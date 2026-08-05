import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import type { ApiErrorCode } from "./api"

export type Locale = "en" | "zh-CN"

const STORAGE_KEY = "sqd.locale"

const MESSAGES = {
  en: {
    language: "Language",
    english: "English",
    chinese: "中文",
    notFoundTitle: "Not found",
    notFoundDescription: "The page you requested does not exist.",
    signIn: "Sign in",
    accessControl: "SQD / ACCESS CONTROL",
    signingIn: "Signing in…",
    viewKey: "View key",
    profile: "Profile",
    switchProfile: "Switch profile",
    changeViewKey: "Change key",
    logout: "Log out",
    sessionExpired: "Session expired. Enter your view key again.",
    invalidViewKey: "Invalid view key.",
    tooManyAttempts: "Too many attempts. Try again later.",
    dashboardLoadAfterLoginFailed: "Failed to load dashboard after login. Please try again.",
    somethingWentWrong: "Something went wrong.",
    couldNotLoadDashboard: "Could not load dashboard.",
    quotaDashboard: "Quota Dashboard",
    networkError: "Network error.",
    serverError: "Server error.",
    requestFailed: "Request failed.",
    unauthorized: "Unauthorized.",
    loadingDashboard: "Loading dashboard",
    retry: "Retry",
    statusWarning: "Warning",
    statusCritical: "Critical",
    statusStale: "Stale",
    statusUnavailable: "Unavailable",
    statusExpired: "Expired",
    insufficientData: "insufficient data",
    remaining: "remaining",
    percentRemaining: "{percent}% remaining",
    burn: "Burn",
    exhaustion: "Exhaustion",
    limitNotReported: "Limit not reported",
    window: "Window",
    current: "Current",
    updated: "Updated",
    account: "Account {id}",
    via: "via {transport}",
    balance: "Balance",
    used: "Used",
    reset: "Reset",
    resetAt: "Cutoff",
    timeRemaining: "Time remaining",
    resetNotReported: "Cutoff not reported",
    notReported: "Not reported",
    status: "Status",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    refreshed: "Updated",
    refreshFailed: "Refresh failed",
    retryIn: "Retry in {seconds}s",
    attention: "ATTENTION",
    nominal: "NOMINAL",
    wordmark: "SQD / QUOTA OPERATIONS",
    accounts: "Accounts",
    upstreams: "Upstreams",
    metrics: "Metrics",
    healthy: "Healthy",
    staleSource: "▲ STALE SOURCE",
    staleData: "Some data is stale",
    snapshot: "SNAPSHOT",
    generated: "GENERATED",
    allProvidersUnavailable: "All providers are currently unavailable.",
    subscriptionUnavailable: "This subscription is currently unavailable.",
    quotaSummary: "Quota summary",
    resourceTelemetry: "Resource telemetry",
    consumptionWindow: "{range} consumption window",
    upstreamAccounts: "Upstream accounts",
    discoveredViaProxy: "{count} discovered via proxy",
    directManual: "Direct & manual",
    configuredSources: "{count} configured sources",
    rangeLabel: "{range} RANGE",
    noSubscriptions: "No subscriptions configured for this profile.",
    selectTimeRange: "Select time range",
    metricRemainingAria: "{label} remaining",
    formatOverdue: "overdue",
    justNow: "just now",
    inSeconds: "in {count}s",
    secondsAgo: "{count}s ago",
    inMinutes: "in {count}m",
    minutesAgo: "{count}m ago",
    inHours: "in {count}h",
    hoursAgo: "{count}h ago",
    inDays: "in {count}d",
    daysAgo: "{count}d ago",
    apiNotFound: "Not found.",
  },
  "zh-CN": {
    language: "语言",
    english: "English",
    chinese: "中文",
    notFoundTitle: "页面不存在",
    notFoundDescription: "你请求的页面不存在。",
    signIn: "登录",
    accessControl: "SQD / 访问控制",
    signingIn: "登录中…",
    viewKey: "访问密钥",
    profile: "视图",
    switchProfile: "切换视图",
    changeViewKey: "更换密钥",
    logout: "退出登录",
    sessionExpired: "会话已过期，请重新输入访问密钥。",
    invalidViewKey: "访问密钥无效。",
    tooManyAttempts: "尝试次数过多，请稍后再试。",
    dashboardLoadAfterLoginFailed: "登录后加载仪表盘失败，请重试。",
    somethingWentWrong: "发生错误。",
    couldNotLoadDashboard: "无法加载仪表盘。",
    quotaDashboard: "配额仪表盘",
    networkError: "网络错误。",
    serverError: "服务器错误。",
    requestFailed: "请求失败。",
    unauthorized: "未授权。",
    loadingDashboard: "正在加载仪表盘",
    retry: "重试",
    statusWarning: "警告",
    statusCritical: "严重",
    statusStale: "过期",
    statusUnavailable: "不可用",
    statusExpired: "已过期",
    insufficientData: "数据不足",
    remaining: "剩余",
    percentRemaining: "剩余 {percent}%",
    burn: "消耗速率",
    exhaustion: "预计耗尽",
    limitNotReported: "未提供上限",
    window: "窗口",
    current: "当前",
    updated: "已更新",
    account: "账户 {id}",
    via: "通过 {transport}",
    balance: "余额",
    used: "已用",
    reset: "重置",
    resetAt: "截止",
    timeRemaining: "剩余时间",
    resetNotReported: "未提供截止时间",
    notReported: "未提供",
    status: "状态",
    refresh: "刷新",
    refreshing: "刷新中…",
    refreshed: "已更新",
    refreshFailed: "刷新失败",
    retryIn: "{seconds} 秒后重试",
    attention: "需关注",
    nominal: "正常",
    wordmark: "SQD / 配额运营",
    accounts: "账户",
    upstreams: "上游账户",
    metrics: "指标",
    healthy: "健康",
    staleSource: "▲ 数据已过期",
    staleData: "部分数据已过期",
    snapshot: "快照",
    generated: "生成于",
    allProvidersUnavailable: "所有提供商当前均不可用。",
    subscriptionUnavailable: "此订阅当前不可用。",
    quotaSummary: "配额概览",
    resourceTelemetry: "资源监测",
    consumptionWindow: "{range} 消耗窗口",
    upstreamAccounts: "上游账户",
    discoveredViaProxy: "通过代理发现 {count} 个",
    directManual: "直连与手动配置",
    configuredSources: "已配置 {count} 个来源",
    rangeLabel: "{range} 范围",
    noSubscriptions: "此配置档未配置订阅。",
    selectTimeRange: "选择时间范围",
    metricRemainingAria: "{label} 剩余",
    formatOverdue: "已超期",
    justNow: "刚刚",
    inSeconds: "{count} 秒后",
    secondsAgo: "{count} 秒前",
    inMinutes: "{count} 分钟后",
    minutesAgo: "{count} 分钟前",
    inHours: "{count} 小时后",
    hoursAgo: "{count} 小时前",
    inDays: "{count} 天后",
    daysAgo: "{count} 天前",
    apiNotFound: "页面不存在。",
  },
} as const

export type TranslationKey = keyof typeof MESSAGES.en
export type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string

function interpolate(template: string, values?: Record<string, string | number>): string {
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`))
}

function createTranslator(locale: Locale): Translator {
  return (key, values) => interpolate(MESSAGES[locale][key] ?? MESSAGES.en[key], values)
}

export function getTranslator(locale: Locale): Translator {
  return createTranslator(locale)
}

function detectLocale(): Locale {
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      if (stored === "en" || stored === "zh-CN") return stored
    } catch {
      // Ignore unavailable storage, then fall back to browser language.
    }
    if (window.navigator.language.toLowerCase().startsWith("zh")) return "zh-CN"
  }
  return "en"
}

const DEFAULT_CONTEXT: I18nContextValue = {
  locale: "en",
  setLocale: () => undefined,
  t: createTranslator("en"),
}

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Translator
}

const I18nContext = createContext<I18nContextValue>(DEFAULT_CONTEXT)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(detectLocale)
  const t = useMemo(() => createTranslator(locale), [locale])

  useEffect(() => {
    document.documentElement.lang = locale
    try {
      window.localStorage.setItem(STORAGE_KEY, locale)
    } catch {
      // Ignore unavailable storage; language still works for this session.
    }
  }, [locale])

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}

export function getApiErrorMessage(code: ApiErrorCode, t: Translator): string {
  switch (code) {
    case "unauthorized": return t("unauthorized")
    case "not-found": return t("apiNotFound")
    case "network": return t("networkError")
    case "server": return t("serverError")
    case "rate-limited": return t("tooManyAttempts")
  }
}

export function formatRelativeTimeText(
  targetIso: string,
  now: Date,
  t: Translator,
): string {
  const target = new Date(targetIso).getTime()
  const diffMs = target - now.getTime()
  const abs = Math.abs(diffMs)
  const secs = abs / 1000
  const mins = secs / 60
  const hours = mins / 60
  const days = hours / 24
  const future = diffMs >= 0
  const count = (qty: number) => Math.max(1, Math.round(qty))
  if (secs < 60) {
    if (abs < 500) return t("justNow")
    return future ? t("inSeconds", { count: count(secs) }) : t("secondsAgo", { count: count(secs) })
  }
  if (mins < 60) return future ? t("inMinutes", { count: count(mins) }) : t("minutesAgo", { count: count(mins) })
  if (hours < 24) return future ? t("inHours", { count: count(hours) }) : t("hoursAgo", { count: count(hours) })
  return future ? t("inDays", { count: count(days) }) : t("daysAgo", { count: count(days) })
}
