import type { DynamicSubscription } from "../../shared/domain"
import type {
  NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult,
} from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"

// CLIProxyAPI adapter.
// GET /v0/management/auth-files -> discover accounts
// POST /v0/management/api-call -> query upstream quota with $TOKEN$ substitution
// Sources: cc-switch subscription.rs (Codex/Claude), CPAMP xai_probe.go (Grok)

const DEFAULT_QUERY_PROVIDERS = ["codex", "claude", "xai"]
const API_CALL_CONCURRENCY = 6
const PER_CALL_TIMEOUT_MS = 70_000
const OVERALL_DEADLINE_MS = 120_000

type CliproxyProvider = {
  id: string; type: "cliproxy"; baseUrl: string
  apiKeyEnv?: string | undefined; apiKey?: string | undefined; queryProviders?: string[] | undefined
}

type AuthFileEntry = {
  auth_index?: string
  provider?: string
  label?: string
  disabled?: boolean
  unavailable?: boolean
  status?: string
  id_token?: { chatgpt_account_id?: string; plan_type?: string }
}

type FilteredAccount = {
  provider: string
  authIndex: string
  label?: string
  idToken?: { chatgpt_account_id?: string; plan_type?: string }
}

export function createCliproxyProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "cliproxy",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 5 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        return { ...base, errors: [{ message: "CLIProxyAPI provider unavailable: management key not configured", retryable: false }] }
      }

      const providerConfig = input.provider as CliproxyProvider
      const baseUrl = providerConfig.baseUrl.replace(/\/$/, "")
      const queryProviders = providerConfig.queryProviders ?? DEFAULT_QUERY_PROVIDERS
      const deadline = Date.now() + OVERALL_DEADLINE_MS
      const deadlineController = new AbortController()
      const deadlineTimer = setTimeout(() => deadlineController.abort(), OVERALL_DEADLINE_MS)

      // 1) Discover accounts
      let authFiles: AuthFileEntry[]
      const mgmtHeaders = new Headers()
      mgmtHeaders.set("Authorization", `Bearer ${apiKey}`)
      mgmtHeaders.set("Accept", "application/json")

      try {
        const res = await fetchImpl(`${baseUrl}/v0/management/auth-files`, {
          method: "GET", headers: mgmtHeaders, signal: deadlineController.signal,
        })
        if (res.status === 404) {
          clearTimeout(deadlineTimer)
          return { ...base, errors: [{ message: "CLIProxyAPI management API not enabled. Set MANAGEMENT_PASSWORD or remote-management.secret-key.", retryable: false }] }
        }
        if (res.status === 401 || res.status === 403) {
          clearTimeout(deadlineTimer)
          return { ...base, errors: [authError("CLIProxyAPI authentication failed")] }
        }
        if (!res.ok) {
          clearTimeout(deadlineTimer)
          return { ...base, errors: [{ message: `CLIProxyAPI auth-files request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        const body = (await res.json()) as { files?: AuthFileEntry[] }
        authFiles = Array.isArray(body.files) ? body.files : []
      } catch {
        clearTimeout(deadlineTimer)
        return { ...base, errors: [{ message: "CLIProxyAPI auth-files network error", retryable: true }] }
      }

      // Filter accounts
      const accounts: FilteredAccount[] = authFiles.flatMap((a): FilteredAccount[] => {
        if (!a.provider || !queryProviders.includes(a.provider)) return []
        if (a.disabled === true) return []
        if (a.status !== undefined && a.status !== "active") return []
        if (!a.auth_index || a.auth_index === "") return []
        // Do NOT skip unavailable (quota exceeded = most important to show)
        return [{
          provider: a.provider,
          authIndex: a.auth_index,
          ...(a.label !== undefined ? { label: a.label } : {}),
          ...(a.id_token !== undefined ? { idToken: a.id_token } : {}),
        }]
      })

      // 2) Fan out api-call per account (concurrency-capped, with deadline + fast-fail)
      const metrics: NormalizedMetric[] = []
      const dynamicSubscriptions: DynamicSubscription[] = []
      const adapterErrors: Array<{ message: string; retryable: boolean }> = []

      for (let i = 0; i < accounts.length; i += API_CALL_CONCURRENCY) {
        if (Date.now() >= deadline) break
        const batch = accounts.slice(i, i + API_CALL_CONCURRENCY)
        const results = await Promise.allSettled(
          batch.map((acct) => queryAccountWithTimeout(fetchImpl, baseUrl, apiKey, acct, deadlineController.signal)),
        )

        // Fast-fail: if entire batch returned auth errors, abort remaining
        const batchResults = results.map(r => r.status === "fulfilled" ? r.value : { metrics: [] as NormalizedMetric[], error: "request failed" })
        const allAuthFailed = batchResults.every(r =>
          r.error !== undefined && (r.error.includes("auth") || r.error.includes("authentication"))
        )
        if (allAuthFailed && i + API_CALL_CONCURRENCY < accounts.length) {
          adapterErrors.push({ message: "All api-call requests in batch failed authentication; aborting remaining", retryable: false })
          break
        }

        for (let j = 0; j < batchResults.length; j++) {
          const acct = batch[j]!
          const r = batchResults[j]!
          const accountMetrics: NormalizedMetric[] = []
          accountMetrics.push(...r.metrics)
          if (r.error) {
            const errorMetric = makeErrorMetric(acct.provider, acct.authIndex, r.error)
            accountMetrics.push(errorMetric)
            // Push to adapter errors for subscription badge escalation
            adapterErrors.push({ message: `${acct.provider}:${acct.authIndex}: ${r.error}`, retryable: !r.error.includes("auth") })
          }
          metrics.push(...accountMetrics)
          dynamicSubscriptions.push({
            id: `cliproxy:${acct.provider}:${acct.authIndex}`,
            name: acct.label ? `CLIProxy - ${acct.label}` : `CLIProxy - ${acct.provider} #${acct.authIndex.slice(0, 8)}`,
            providerMetricIds: accountMetrics.map(m => m.providerMetricId),
            ui: { group: "CLIProxy" },
          })
        }
      }

      clearTimeout(deadlineTimer)
      return { ...base, metrics, dynamicSubscriptions, ...(adapterErrors.length > 0 ? { errors: adapterErrors } : {}) }
    },
  }
}

type AccountQueryResult = { metrics: NormalizedMetric[]; error?: string }

async function queryAccountWithTimeout(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, acct: FilteredAccount, parentSignal: AbortSignal,
): Promise<AccountQueryResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS)
  // Link to parent deadline
  parentSignal.addEventListener("abort", () => controller.abort(), { once: true })
  try {
    return await queryAccount(fetchImpl, baseUrl, mgmtKey, acct, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function queryAccount(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, acct: FilteredAccount, signal: AbortSignal,
): Promise<AccountQueryResult> {
  if (acct.provider === "codex") {
    return queryCodex(fetchImpl, baseUrl, mgmtKey, acct.authIndex, acct.idToken?.chatgpt_account_id, signal)
  } else if (acct.provider === "claude") {
    return queryClaude(fetchImpl, baseUrl, mgmtKey, acct.authIndex, signal)
  } else if (acct.provider === "xai") {
    return queryXai(fetchImpl, baseUrl, mgmtKey, acct.authIndex, signal)
  }
  return { metrics: [], error: `unknown provider: ${acct.provider}` }
}

async function apiCall(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string,
  authIndex: string, method: string, url: string, headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ ok: true; statusCode: number; body: string } | { ok: false; error: string; retryable: boolean }> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/v0/management/api-call`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${mgmtKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ auth_index: authIndex, method, url, header: headers }),
      signal,
    })
  } catch {
    return { ok: false, error: "network error", retryable: true }
  }
  // Management API HTTP status determines error type
  if (res.status === 502) {
    return { ok: false, error: "api-call transport failure", retryable: true }
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    const raw = body.error ?? "api-call bad request"
    // A 400 'auth token not found' means the CLIProxyAPI server no longer has
    // a valid token for this auth_index (user logged out or token expired).
    // Surface this as a stale-auth_index hint so the UI can badge it.
    const hint = raw.toLowerCase().includes("auth token") ? " (stale auth_index)" : ""
    return { ok: false, error: `${raw}${hint}`, retryable: false }
  }
  if (!res.ok) {
    return { ok: false, error: `api-call failed (${res.status})`, retryable: isRetryableStatus(res.status) }
  }
  const body = await res.json() as { status_code?: number; body?: string; error?: string }
  if (body.error !== undefined) {
    return { ok: false, error: body.error, retryable: false }
  }
  return { ok: true, statusCode: body.status_code ?? 0, body: body.body ?? "" }
}

async function queryCodex(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, authIndex: string, accountId: string | undefined, signal: AbortSignal,
): Promise<AccountQueryResult> {
  const headers: Record<string, string> = {
    "Authorization": "Bearer $TOKEN$",
    "User-Agent": "codex-cli",
    "Accept": "application/json",
  }
  if (accountId !== undefined) headers["ChatGPT-Account-Id"] = accountId

  const result = await apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
    "https://chatgpt.com/backend-api/wham/usage", headers, signal)
  if (!result.ok) return { metrics: [], error: result.error }

  if (result.statusCode === 401 || result.statusCode === 403) {
    return { metrics: [], error: "upstream auth failed (possible stale auth_index)" }
  }
  if (result.statusCode === 429) {
    return { metrics: [], error: "upstream rate limited (429)" }
  }
  if (result.statusCode >= 500) {
    return { metrics: [], error: `upstream error (${result.statusCode})` }
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return { metrics: [], error: `upstream error (${result.statusCode})` }
  }

  try {
    const parsed = JSON.parse(result.body) as {
      rate_limit?: Record<string, { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown } | undefined>
    }
    const metrics: NormalizedMetric[] = []
    const rl = parsed.rate_limit ?? {}
    for (const window of Object.values(rl)) {
      if (!window) continue
      const used = parseNumber(window.used_percent)
      const limitWindowSeconds = parseNumber(window.limit_window_seconds)
      if (used === undefined || limitWindowSeconds === undefined) continue

      // Classify by limit_window_seconds (NOT hardcoded primary/secondary)
      let name: string
      let duration: string
      if (limitWindowSeconds === 18000) { name = "five_hour"; duration = "5h" }
      else if (limitWindowSeconds === 604800) { name = "weekly"; duration = "7d" }
      else if (limitWindowSeconds === 2592000) { name = "monthly"; duration = "30d" }
      else continue // unknown window size -> skip

      // reset_at is Unix epoch seconds (NOT ISO string)
      const resetAt = typeof window.reset_at === "number"
        ? new Date(window.reset_at * 1000).toISOString()
        : undefined

      metrics.push({
        providerMetricId: `codex:${authIndex}:${name}`,
        label: name === "five_hour" ? "5h" : name === "weekly" ? "Weekly" : "Monthly",
        unit: "%",
        used,
        limit: 100,
        sourceValueKind: "gauge-used",
        sourceConfidence: "known",
        ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration, resetAt } } : {}),
      })
    }
    return { metrics }
  } catch {
    return { metrics: [], error: "parse error" }
  }
}

async function queryClaude(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, authIndex: string, signal: AbortSignal,
): Promise<AccountQueryResult> {
  const headers: Record<string, string> = {
    "Authorization": "Bearer $TOKEN$",
    "anthropic-beta": "oauth-2025-04-20",
    "Accept": "application/json",
  }

  const result = await apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
    "https://api.anthropic.com/api/oauth/usage", headers, signal)
  if (!result.ok) return { metrics: [], error: result.error }

  if (result.statusCode === 401 || result.statusCode === 403) {
    return { metrics: [], error: "upstream auth failed (possible stale auth_index)" }
  }
  if (result.statusCode === 429) {
    return { metrics: [], error: "upstream rate limited (429)" }
  }
  if (result.statusCode >= 500) {
    return { metrics: [], error: `upstream error (${result.statusCode})` }
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return { metrics: [], error: `upstream error (${result.statusCode})` }
  }

  try {
    const parsed = JSON.parse(result.body) as Record<string, unknown>
    const metrics: NormalizedMetric[] = []
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "extra_usage") continue
      if (typeof value !== "object" || value === null) continue
      const win = value as { utilization?: unknown; resets_at?: unknown }
      const used = parseNumber(win.utilization)
      if (used === undefined) continue
      // utilization is 0-100, used directly (do NOT multiply by 100)
      const resetAt = typeof win.resets_at === "string" ? win.resets_at : undefined
      const duration = key.startsWith("five_hour") ? "5h" : "7d"
      metrics.push({
        providerMetricId: `claude:${authIndex}:${key}`,
        label: key.replace(/_/g, " "),
        unit: "%",
        used,
        limit: 100,
        sourceValueKind: "gauge-used",
        sourceConfidence: "known",
        ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration, resetAt } } : {}),
      })
    }
    return { metrics }
  } catch {
    return { metrics: [], error: "parse error" }
  }
}

async function queryXai(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, authIndex: string, signal: AbortSignal,
): Promise<AccountQueryResult> {
  const headers: Record<string, string> = {
    "Authorization": "Bearer $TOKEN$",
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": "0.2.101",
    "User-Agent": "grok-pager/0.2.101 grok-shell/0.2.101 (macos; aarch64)",
    "Accept": "*/*",
  }

  // Query both weekly and monthly endpoints, merge results
  const [weeklyResult, monthlyResult] = await Promise.all([
    apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits", headers, signal),
    apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
      "https://cli-chat-proxy.grok.com/v1/billing", headers, signal),
  ])

  const metrics: NormalizedMetric[] = []
  let weeklyConfig: Record<string, unknown> | undefined
  let monthlyConfig: Record<string, unknown> | undefined

  if (weeklyResult.ok && weeklyResult.statusCode >= 200 && weeklyResult.statusCode < 300) {
    try {
      const parsed = JSON.parse(weeklyResult.body) as { config?: Record<string, unknown> }
      weeklyConfig = parsed.config
    } catch { /* handled below */ }
  }
  if (monthlyResult.ok && monthlyResult.statusCode >= 200 && monthlyResult.statusCode < 300) {
    try {
      const parsed = JSON.parse(monthlyResult.body) as { config?: Record<string, unknown> }
      monthlyConfig = parsed.config
    } catch { /* handled below */ }
  }

  // Weekly data from weekly endpoint
  const config = weeklyConfig ?? monthlyConfig
  if (!config) {
    const err = !weeklyResult.ok ? weeklyResult.error
      : !monthlyResult.ok ? monthlyResult.error
      : "no billing data"
    return { metrics: [], error: err }
  }

  // Weekly: credit_usage_percent
  const weeklyUsed = parseNumber(config["credit_usage_percent"])
  if (weeklyUsed !== undefined) {
    const period = config["current_period"] as Record<string, unknown> | undefined
    const periodEnd = typeof period?.["end"] === "string" ? period["end"] as string : undefined
    metrics.push({
      providerMetricId: `xai:${authIndex}:weekly`,
      label: "Weekly",
      unit: "%",
      used: weeklyUsed,
      limit: 100,
      sourceValueKind: "gauge-used",
      sourceConfidence: "known",
      ...(periodEnd !== undefined ? { window: { kind: "rolling" as const, duration: "7d", resetAt: periodEnd } } : {}),
    })
  }

  // Monthly: merge from monthlyConfig if available, fallback to weekly config
  const monthlyCfg = monthlyConfig ?? config
  const monthlyLimit = readXaiCents(monthlyCfg, "monthly_limit", "monthlyLimit")
  const used = readXaiCents(monthlyCfg, "used")
  const onDemandCap = readXaiCents(monthlyCfg, "on_demand_cap", "onDemandCap")
  const onDemandUsed = readXaiCents(monthlyCfg, "on_demand_used", "onDemandUsed")
  const billingPeriodEnd = typeof monthlyCfg["billing_period_end"] === "string" ? monthlyCfg["billing_period_end"] as string : undefined

  if (monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined) {
    // NO Math.min cap -- overage >100% is meaningful
    const monthlyUsedPercent = (used / monthlyLimit) * 100
    metrics.push({
      providerMetricId: `xai:${authIndex}:monthly`,
      label: "Monthly",
      unit: "%",
      used: monthlyUsedPercent,
      limit: 100,
      sourceValueKind: "gauge-used",
      sourceConfidence: "known",
      ...(billingPeriodEnd !== undefined ? { window: { kind: "rolling" as const, duration: "30d", resetAt: billingPeriodEnd } } : {}),
    })
  }

  if (onDemandCap !== undefined && onDemandCap > 0 && onDemandUsed !== undefined) {
    const onDemandPercent = (onDemandUsed / onDemandCap) * 100
    metrics.push({
      providerMetricId: `xai:${authIndex}:on_demand`,
      label: "On-demand",
      unit: "%",
      used: onDemandPercent,
      limit: 100,
      sourceValueKind: "gauge-used",
      sourceConfidence: "known",
    })
  }

  if (metrics.length === 0) {
    return { metrics: [], error: "no billing data parsed" }
  }
  return { metrics }
}

function readXaiCents(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const val = obj[key]
    if (val === undefined) continue
    if (typeof val === "number") return val
    if (typeof val === "object" && val !== null) {
      const v = (val as Record<string, unknown>)["val"]
      if (typeof v === "number") return v
    }
  }
  return undefined
}

function makeErrorMetric(provider: string, authIndex: string, error: string): NormalizedMetric {
  return {
    providerMetricId: `${provider}:${authIndex}:error`,
    label: `${provider} status`,
    unit: "",
    sourceValueKind: "status",
    sourceConfidence: "unknown",
    notes: error,
  }
}
