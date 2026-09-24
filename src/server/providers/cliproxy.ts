import type { DynamicSubscription } from "../../shared/domain"
import type {
  NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult,
} from "./types"
import { authError, isRetryableStatus, parseNumber } from "./shared"
import { silentLogger, type Logger } from "../logging/logger"

// CLIProxyAPI adapter.
// GET /v0/management/auth-files -> discover accounts
// POST /v0/management/api-call -> query upstream quota with $TOKEN$ substitution
// Sources: cc-switch subscription.rs (Codex/Claude), CPAMP xai_probe.go (Grok)

const DEFAULT_QUERY_PROVIDERS = ["codex", "claude", "xai", "antigravity"]
const API_CALL_CONCURRENCY = 6
const PER_CALL_TIMEOUT_MS = 70_000
const OVERALL_DEADLINE_MS = 120_000

type CliproxyProvider = {
  id: string; type: "cliproxy"; baseUrl: string
  apiKeyEnv?: string | undefined; apiKey?: string | undefined; queryProviders?: string[] | undefined
}

type AuthFileEntry = {
  name?: string
  project_id?: string
  projectId?: string
  metadata?: Record<string, unknown>
  attributes?: Record<string, unknown>
  auth_index?: string
  provider?: string
  label?: string
  disabled?: boolean
  unavailable?: boolean
  status?: string
  id_token?: { chatgpt_account_id?: string; plan_type?: string }
}

type FilteredAccount = {
  authFile?: AuthFileEntry
  provider: string
  authIndex: string
  label?: string
  idToken?: { chatgpt_account_id?: string; plan_type?: string }
}

// Structured error kind from apiCall, used for fast-fail + retryable classification
type ErrorKind = "mgmt-auth" | "mgmt-not-found" | "transport" | "upstream-auth" | "upstream-rate-limit" | "upstream-error" | "parse-error" | "no-data" | "unknown"

type AccountQueryResult = { metrics: NormalizedMetric[]; error?: string; errorKind?: ErrorKind; retryable?: boolean }

export function createCliproxyProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "cliproxy",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const logger = (input.logger ?? silentLogger).child({ component: "provider.cliproxy" })
      const refreshStartedAt = performance.now()
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 5 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        logger.error("cliproxy.configuration.invalid", { reason: "management_key_missing" })
        return { ...base, errors: [{ message: "CLIProxyAPI provider unavailable: management key not configured", retryable: false }] }
      }

      const providerConfig = input.provider as CliproxyProvider
      const baseUrl = providerConfig.baseUrl.replace(/\/$/, "")
      const queryProviders = providerConfig.queryProviders ?? DEFAULT_QUERY_PROVIDERS
      const deadline = Date.now() + OVERALL_DEADLINE_MS
      const deadlineController = new AbortController()
      const deadlineTimer = setTimeout(() => deadlineController.abort(), OVERALL_DEADLINE_MS)
      logger.info("cliproxy.refresh.started", {
        baseUrl,
        queryProviders,
        apiCallConcurrency: API_CALL_CONCURRENCY,
        perCallTimeoutMs: PER_CALL_TIMEOUT_MS,
        overallDeadlineMs: OVERALL_DEADLINE_MS,
      })

      // 1) Discover accounts
      let authFiles: AuthFileEntry[]
      const mgmtHeaders = new Headers()
      mgmtHeaders.set("Authorization", `Bearer ${apiKey}`)
      mgmtHeaders.set("Accept", "application/json")

      try {
        const discoveryStartedAt = performance.now()
        logger.debug("cliproxy.discovery.requested", { endpoint: "/v0/management/auth-files" })
        const res = await fetchImpl(`${baseUrl}/v0/management/auth-files`, {
          method: "GET", headers: mgmtHeaders, signal: deadlineController.signal,
        })
        logger.debug("cliproxy.discovery.responded", {
          status: res.status,
          durationMs: Math.round((performance.now() - discoveryStartedAt) * 100) / 100,
        })
        if (res.status === 404) {
          clearTimeout(deadlineTimer)
          logger.error("cliproxy.discovery.failed", { status: res.status, reason: "management_api_not_enabled" })
          return { ...base, errors: [{ message: "CLIProxyAPI management API not enabled. Set MANAGEMENT_PASSWORD or remote-management.secret-key.", retryable: false }] }
        }
        if (res.status === 401 || res.status === 403) {
          clearTimeout(deadlineTimer)
          logger.error("cliproxy.discovery.failed", { status: res.status, reason: "management_authentication_failed" })
          return { ...base, errors: [authError("CLIProxyAPI authentication failed")] }
        }
        if (!res.ok) {
          clearTimeout(deadlineTimer)
          logger.error("cliproxy.discovery.failed", { status: res.status, reason: "unexpected_status" })
          return { ...base, errors: [{ message: `CLIProxyAPI auth-files request failed (${res.status})`, retryable: isRetryableStatus(res.status) }] }
        }
        const body = (await res.json()) as { files?: AuthFileEntry[] }
        authFiles = Array.isArray(body.files) ? body.files : []
      } catch (error) {
        clearTimeout(deadlineTimer)
        logger.error("cliproxy.discovery.failed", { reason: "network_error", error })
        return { ...base, errors: [{ message: "CLIProxyAPI auth-files network error", retryable: true }] }
      }

      // Filter accounts
      const accounts: FilteredAccount[] = authFiles.flatMap((a): FilteredAccount[] => {
        if (!a.provider || !queryProviders.includes(a.provider)) return []
        if (a.disabled === true) return []
        // Do NOT filter on status: CLIProxy marks quota-exhausted / cooldown
        // accounts with status:"error" or unavailable:true. These are the most
        // important to surface. Only `disabled:true` is a hard skip.
        if (!a.auth_index || a.auth_index === "") return []
        return [{
          ...(a.provider === "antigravity" ? { authFile: a } : {}),
          provider: a.provider,
          authIndex: a.auth_index,
          ...(a.label !== undefined ? { label: a.label } : {}),
          ...(a.id_token !== undefined ? { idToken: a.id_token } : {}),
        }]
      })
      logger.info("cliproxy.discovery.completed", {
        discoveredCount: authFiles.length,
        selectedCount: accounts.length,
        skippedCount: authFiles.length - accounts.length,
        selectedByProvider: Object.fromEntries(queryProviders.map((provider) => [provider, accounts.filter((account) => account.provider === provider).length])),
        accounts: accounts.map((account) => ({ provider: account.provider, authIndex: account.authIndex, label: account.label })),
      })

      // 2) Fan out api-call per account (concurrency-capped, with deadline + fast-fail)
      const metrics: NormalizedMetric[] = []
      const dynamicSubscriptions: DynamicSubscription[] = []
      const adapterErrors: Array<{ message: string; retryable: boolean }> = []
      // Track which metric ID prefixes had errors this cycle so the refresh
      // service knows to preserve old metrics with those prefixes.
      const failedMetricPrefixes: string[] = []
      const preservedMetricIds: string[] = []
      let aborted = false // tracks whether fast-fail or deadline caused early exit

      for (let i = 0; i < accounts.length; i += API_CALL_CONCURRENCY) {
        if (Date.now() >= deadline) {
          // Deadline hit: process remaining accounts as error metrics so they
          // stay visible (not silently dropped). Mark as aborted so we don't
          // return dynamicSubscriptions (coalesce will preserve last-good).
          aborted = true
          logger.error("cliproxy.deadline.exceeded", { processedCount: i, remainingCount: accounts.length - i })
          for (const acct of accounts.slice(i)) {
            const errorMetric = makeErrorMetric(acct.provider, acct.authIndex, "refresh deadline exceeded")
            metrics.push(errorMetric)
            dynamicSubscriptions.push(makeDynSub(acct, [errorMetric.providerMetricId]))
            adapterErrors.push({ message: `${acct.provider}:${acct.authIndex}: refresh deadline exceeded`, retryable: true })
          }
          break
        }

        const batch = accounts.slice(i, i + API_CALL_CONCURRENCY)
        logger.debug("cliproxy.batch.started", { offset: i, batchSize: batch.length, remainingCount: accounts.length - i })
        const results = await Promise.allSettled(
          batch.map((acct) => queryAccountWithTimeout(fetchImpl, baseUrl, apiKey, acct, deadlineController.signal, logger)),
        )

        // Process batch results FIRST (before any fast-fail decision)
        const batchResults: AccountQueryResult[] = results.map(r =>
          r.status === "fulfilled" ? r.value : { metrics: [], error: "request failed", errorKind: "transport", retryable: true }
        )

        for (let j = 0; j < batchResults.length; j++) {
          const acct = batch[j]!
          const r = batchResults[j]!
          const accountMetrics: NormalizedMetric[] = [...r.metrics]
          const hasError = !!r.error
          if (hasError) {
            const errorMetric = makeErrorMetric(acct.provider, acct.authIndex, r.error!)
            accountMetrics.push(errorMetric)
            // Use structured retryable from apiCall (not string guessing)
            const isRetryable = r.retryable ?? !isAuthErrorKind(r.errorKind)
            adapterErrors.push({ message: `${acct.provider}:${acct.authIndex}: ${r.error}`, retryable: isRetryable })
            logger.warn("cliproxy.account.failed", {
              provider: acct.provider,
              authIndex: acct.authIndex,
              label: acct.label,
              error: r.error,
              errorKind: r.errorKind,
              retryable: isRetryable,
              metricCount: r.metrics.length,
            })
          } else {
            logger.info("cliproxy.account.completed", {
              provider: acct.provider,
              authIndex: acct.authIndex,
              label: acct.label,
              metricCount: r.metrics.length,
              metricIds: r.metrics.map((metric) => metric.providerMetricId),
            })
          }
          metrics.push(...accountMetrics)
          dynamicSubscriptions.push(makeDynSub(acct, accountMetrics.map(m => m.providerMetricId)))
          // If this account had an error, preserve the real metric IDs (not
          // the error metric) from the previous cache. We know the metric
          // ID prefix pattern: provider:authIndex:metricName.
          if (hasError) {
            const prefix = `${acct.provider}:${acct.authIndex}:`
            for (const m of r.metrics) {
              // These are the real metrics returned this cycle - preserve
              // any old ones with the same prefix that aren't in this set.
              preservedMetricIds.push(m.providerMetricId)
            }
            // Mark prefix for refresh-service to find all old metrics with
            // this prefix not present in this cycle's returned metrics.
            // We push the prefix as a marker (refresh-service will match).
            failedMetricPrefixes.push(prefix)
          }
        }

        // Fast-fail: only abort remaining accounts when the management API
        // itself rejects authentication (401/403). A 400 (stale auth_index,
        // per-account) is NOT a global failure - healthy accounts in later
        // batches should still be queried.
        const allMgmtAuthFailed = batchResults.every(r => r.errorKind === "mgmt-auth")
        if (allMgmtAuthFailed && i + API_CALL_CONCURRENCY < accounts.length) {
          aborted = true
          logger.error("cliproxy.batch.aborted", { reason: "management_authentication_failed", offset: i, remainingCount: accounts.length - i - batch.length })
          adapterErrors.push({ message: "All api-call requests in batch failed management authentication; aborting remaining", retryable: false })
          // Process remaining accounts as error metrics so they stay visible
          for (const acct of accounts.slice(i + API_CALL_CONCURRENCY)) {
            const errorMetric = makeErrorMetric(acct.provider, acct.authIndex, "skipped: batch auth failure")
            metrics.push(errorMetric)
            dynamicSubscriptions.push(makeDynSub(acct, [errorMetric.providerMetricId]))
            adapterErrors.push({ message: `${acct.provider}:${acct.authIndex}: skipped (batch auth failure)`, retryable: false })
            failedMetricPrefixes.push(`${acct.provider}:${acct.authIndex}:`)
          }
          break
        }
      }

      clearTimeout(deadlineTimer)

      // If aborted (fast-fail or deadline), do NOT return dynamicSubscriptions
      // so coalesce preserves the last-known-good list in storage.
      // The error metrics + subscriptions are still in metrics[] for this refresh
      // cycle (visible immediately), but storage won't overwrite the good list.
      if (aborted) {
        logger.warn("cliproxy.refresh.completed", {
          status: "aborted",
          durationMs: Math.round((performance.now() - refreshStartedAt) * 100) / 100,
          metricCount: metrics.length,
          errorCount: adapterErrors.length,
          errors: adapterErrors,
        })
        return { ...base, metrics, ...(adapterErrors.length > 0 ? { errors: adapterErrors } : {}) }
      }

      // Collect preserveMetricIds: for failed accounts/endpoints, signal the
      // refresh service to preserve old metrics with matching prefixes from
      // the previous cache (per-endpoint granularity, not per-subscription).
      const preserveMetricIds = failedMetricPrefixes.length > 0 ? failedMetricPrefixes : undefined
      const completionFields = {
        status: adapterErrors.length > 0 ? "degraded" : "ok",
        durationMs: Math.round((performance.now() - refreshStartedAt) * 100) / 100,
        discoveredAccountCount: authFiles.length,
        queriedAccountCount: accounts.length,
        metricCount: metrics.length,
        dynamicSubscriptionCount: dynamicSubscriptions.length,
        errorCount: adapterErrors.length,
        errors: adapterErrors,
      }
      if (adapterErrors.length > 0) logger.warn("cliproxy.refresh.completed", completionFields)
      else logger.info("cliproxy.refresh.completed", completionFields)
      return { ...base, metrics, dynamicSubscriptions, ...(adapterErrors.length > 0 ? { errors: adapterErrors } : {}),
        ...(preserveMetricIds !== undefined ? { preserveMetricIds } : {}) }
    },
  }
}

function makeDynSub(acct: FilteredAccount, providerMetricIds: string[]): DynamicSubscription {
  const providerLabel = UPSTREAM_LABELS[acct.provider] ?? titleCase(acct.provider)
  return {
    id: `cliproxy:${acct.provider}:${acct.authIndex}`,
    name: providerLabel,
    providerMetricIds,
    identity: {
      provider: acct.provider,
      providerLabel,
      ...(acct.label ? { account: acct.label } : {}),
      ...(acct.provider === "xai"
        ? { plan: "SuperGrok" }
        : acct.idToken?.plan_type ? { plan: formatPlan(acct.idToken.plan_type) } : {}),
      transport: "CLIProxy",
    },
    ui: { group: providerLabel },
  }
}

const UPSTREAM_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  xai: "Grok",
  antigravity: "Antigravity",
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatPlan(value: string): string {
  const normalized = value.toLowerCase().replace(/[_-]+/g, "")
  if (normalized === "prolite") return "Pro Lite"
  return titleCase(value)
}

function isAuthErrorKind(kind: ErrorKind | undefined): boolean {
  return kind === "mgmt-auth" || kind === "mgmt-not-found" || kind === "upstream-auth"
}

async function queryAccountWithTimeout(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, acct: FilteredAccount, parentSignal: AbortSignal,
  logger: Logger,
): Promise<AccountQueryResult> {
  const accountLogger = logger.child({ provider: acct.provider, authIndex: acct.authIndex, label: acct.label })
  const startedAt = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS)
  parentSignal.addEventListener("abort", () => controller.abort(), { once: true })
  try {
    accountLogger.debug("cliproxy.account.started", {})
    const result = await queryAccount(fetchImpl, baseUrl, mgmtKey, acct, controller.signal, accountLogger)
    accountLogger.debug("cliproxy.account.finished", {
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      metricCount: result.metrics.length,
      error: result.error,
      errorKind: result.errorKind,
    })
    return result
  } catch (error) {
    accountLogger.error("cliproxy.account.exception", {
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      error,
    })
    return { metrics: [], error: "request timeout or abort", errorKind: "transport", retryable: true }
  } finally {
    clearTimeout(timer)
  }
}

async function queryAccount(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, acct: FilteredAccount, signal: AbortSignal,
  logger: Logger,
): Promise<AccountQueryResult> {
  if (acct.provider === "codex") {
    return queryCodex(fetchImpl, baseUrl, mgmtKey, acct.authIndex, acct.idToken?.chatgpt_account_id, signal, logger)
  } else if (acct.provider === "claude") {
    return queryClaude(fetchImpl, baseUrl, mgmtKey, acct.authIndex, signal, logger)
  } else if (acct.provider === "xai") {
    return queryXai(fetchImpl, baseUrl, mgmtKey, acct.authIndex, signal, logger)
  } else if (acct.provider === "antigravity") {
    return queryAntigravity(fetchImpl, baseUrl, mgmtKey, acct, signal, logger)
  }
  return { metrics: [], error: `unknown provider: ${acct.provider}`, errorKind: "unknown", retryable: false }
}

type ApiCallResult =
  | { ok: true; statusCode: number; body: string }
  | { ok: false; error: string; errorKind: ErrorKind; retryable: boolean }

async function apiCall(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string,
  authIndex: string, method: string, url: string, headers: Record<string, string>,
  signal: AbortSignal, logger: Logger,
  data?: string,
): Promise<ApiCallResult> {
  const target = new URL(url)
  const startedAt = performance.now()
  logger.debug("cliproxy.api_call.requested", { method, targetOrigin: target.origin, targetPath: target.pathname })
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/v0/management/api-call`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${mgmtKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ auth_index: authIndex, method, url, header: headers, ...(data !== undefined ? { data } : {}) }),
      signal,
    })
  } catch (error) {
    logger.warn("cliproxy.api_call.failed", {
      method,
      targetOrigin: target.origin,
      targetPath: target.pathname,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      reason: "network_error",
      error,
    })
    return { ok: false, error: "network error", errorKind: "transport", retryable: true }
  }
  logger.debug("cliproxy.api_call.responded", {
    method,
    targetOrigin: target.origin,
    targetPath: target.pathname,
    managementStatus: res.status,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  })
  // Management API HTTP status determines error type
  if (res.status === 502) {
    return { ok: false, error: "api-call transport failure", errorKind: "transport", retryable: true }
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    const raw = body.error ?? "api-call bad request"
    const hint = raw.toLowerCase().includes("auth token") ? " (stale auth_index)" : ""
    return { ok: false, error: `${raw}${hint}`, errorKind: "upstream-error", retryable: false }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "management API authentication failed", errorKind: "mgmt-auth", retryable: false }
  }
  if (!res.ok) {
    return { ok: false, error: `api-call failed (${res.status})`, errorKind: "unknown", retryable: isRetryableStatus(res.status) }
  }
  let body: { status_code?: number; body?: string; error?: string }
  try {
    body = await res.json() as { status_code?: number; body?: string; error?: string }
  } catch {
    return { ok: false, error: "management API returned non-JSON", errorKind: "parse-error", retryable: false }
  }
  if (body.error !== undefined) {
    return { ok: false, error: body.error, errorKind: "unknown", retryable: false }
  }
  return { ok: true, statusCode: body.status_code ?? 0, body: body.body ?? "" }
}

async function queryCodex(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, authIndex: string, accountId: string | undefined, signal: AbortSignal,
  logger: Logger,
): Promise<AccountQueryResult> {
  const headers: Record<string, string> = {
    "Authorization": "Bearer $TOKEN$",
    "User-Agent": "codex-cli",
    "Accept": "application/json",
  }
  if (accountId !== undefined) headers["ChatGPT-Account-Id"] = accountId

  const result = await apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
    "https://chatgpt.com/backend-api/wham/usage", headers, signal, logger)
  if (!result.ok) return { metrics: [], error: result.error, errorKind: result.errorKind, retryable: result.retryable }

  const upstreamErr = classifyUpstreamStatus(result.statusCode)
  if (upstreamErr) return upstreamErr

  try {
    if (result.body === "" || result.body === "{}") {
      return { metrics: [], error: "no quota data (empty body)", errorKind: "no-data", retryable: false }
    }
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

      let name: string
      let duration: string
      if (limitWindowSeconds === 18000) { name = "five_hour"; duration = "5h" }
      else if (limitWindowSeconds === 604800) { name = "weekly"; duration = "7d" }
      else if (limitWindowSeconds === 2592000) { name = "monthly"; duration = "30d" }
      else {
        // Unknown window: produce a generic metric so the data isn't silently
        // dropped. Use exact units when divisible by m/h/d; otherwise use
        // minutes (rounded up to avoid 0) to stay within the duration domain
        // (shared validators accept m/h/d only).
        name = `window_${limitWindowSeconds}`
        if (limitWindowSeconds >= 86400 && limitWindowSeconds % 86400 === 0) {
          duration = `${limitWindowSeconds / 86400}d`
        } else if (limitWindowSeconds >= 3600 && limitWindowSeconds % 3600 === 0) {
          duration = `${limitWindowSeconds / 3600}h`
        } else {
          const minutes = Math.max(1, Math.ceil(limitWindowSeconds / 60))
          duration = `${minutes}m`
        }
      }

      const resetAt = typeof window.reset_at === "number" && window.reset_at > 0
        ? new Date(window.reset_at * 1000).toISOString()
        : undefined

      metrics.push({
        providerMetricId: `codex:${authIndex}:${name}`,
        label: name === "five_hour" ? "5h" : name === "weekly" ? "Weekly" : name === "monthly" ? "Monthly" : name.replace(/_/g, " "),
        unit: "%",
        used,
        limit: 100,
        sourceValueKind: "gauge-used",
        sourceConfidence: "known",
        ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration, resetAt } } : {}),
      })
    }
    if (metrics.length === 0) return { metrics: [], error: "no quota windows parsed", errorKind: "no-data", retryable: false }
    return { metrics }
  } catch {
    return { metrics: [], error: "parse error", errorKind: "parse-error", retryable: false }
  }
}

function antigravityProject(file: Record<string, unknown>): string | undefined {
  for (const source of [file, file.metadata, file.attributes, file.installed, file.web]) {
    if (!source || typeof source !== "object") continue
    const record = source as Record<string, unknown>
    for (const key of ["project_id", "projectId", "gemini_virtual_project"]) {
      const value = record[key]
      if (typeof value === "string" && value.trim()) return value.trim()
    }
  }
  return undefined
}

async function queryAntigravity(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, acct: FilteredAccount,
  signal: AbortSignal, logger: Logger,
): Promise<AccountQueryResult> {
  const file = acct.authFile ?? {}
  let project = antigravityProject(file)
  if (!project && file.name) {
    const response = await fetchImpl(`${baseUrl}/v0/management/auth-files/download?name=${encodeURIComponent(file.name)}`, {
      headers: { Authorization: `Bearer ${mgmtKey}` }, signal,
    })
    if (!response.ok) {
      return { metrics: [], error: `auth-file download failed (${response.status})`,
        errorKind: response.status === 401 || response.status === 403 ? "mgmt-auth" : "upstream-error",
        retryable: isRetryableStatus(response.status) }
    }
    try {
      const downloaded = await response.json()
      if (downloaded && typeof downloaded === "object") project = antigravityProject(downloaded)
    } catch {
      return { metrics: [], error: "invalid auth-file JSON", errorKind: "parse-error", retryable: false }
    }
  }
  if (!project) return { metrics: [], error: "Antigravity project_id missing", errorKind: "no-data", retryable: false }

  const result = await apiCall(fetchImpl, baseUrl, mgmtKey, acct.authIndex, "POST",
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
      Authorization: "Bearer $TOKEN$", "Content-Type": "application/json",
      "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
    }, signal, logger, JSON.stringify({ project }))
  if (!result.ok) return { metrics: [], error: result.error, errorKind: result.errorKind, retryable: result.retryable }
  const upstreamErr = classifyUpstreamStatus(result.statusCode)
  if (upstreamErr) return upstreamErr
  try {
    const parsed = JSON.parse(result.body)
    const metrics: NormalizedMetric[] = []
    for (const [groupIndex, group] of (Array.isArray(parsed?.groups) ? parsed.groups : []).entries()) {
      if (!group || typeof group !== "object") continue
      const groupLabel = String(group.displayName ?? group.display_name ?? `Quota Group ${groupIndex + 1}`)
      for (const [bucketIndex, bucket] of (Array.isArray(group.buckets) ? group.buckets : []).entries()) {
        if (!bucket || typeof bucket !== "object") continue
        const fraction = parseNumber(bucket.remainingFraction ?? bucket.remaining_fraction)
        if (fraction === undefined || fraction < 0 || fraction > 1) continue
        const id = String(bucket.bucketId ?? bucket.bucket_id ?? bucket.window ?? bucketIndex)
        const remaining = fraction * 100
        const resetAt = bucket.resetTime ?? bucket.reset_time
        const window = String(bucket.window ?? "").toLowerCase()
        const duration = ["5h", "five-hour", "five_hour"].includes(window) ? "5h"
          : ["weekly", "week"].includes(window) ? "7d" : undefined
        metrics.push({
          providerMetricId: `antigravity:${acct.authIndex}:${encodeURIComponent(groupLabel)}:${encodeURIComponent(id)}`,
          label: `${groupLabel} · ${bucket.displayName ?? bucket.display_name ?? id}`,
          unit: "%", remaining, used: 100 - remaining, limit: 100,
          sourceValueKind: "gauge-remaining", sourceConfidence: "known",
          ...(duration ? { window: { kind: "rolling" as const, duration,
            ...(typeof resetAt === "string" && Number.isFinite(Date.parse(resetAt)) ? { resetAt } : {}) } } : {}),
        })
      }
    }
    return metrics.length ? { metrics } : { metrics: [], error: "no quota buckets parsed", errorKind: "no-data", retryable: false }
  } catch {
    return { metrics: [], error: "parse error", errorKind: "parse-error", retryable: false }
  }
}

async function queryClaude(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, authIndex: string, signal: AbortSignal,
  logger: Logger,
): Promise<AccountQueryResult> {
  const headers: Record<string, string> = {
    "Authorization": "Bearer $TOKEN$",
    "anthropic-beta": "oauth-2025-04-20",
    "Accept": "application/json",
  }

  const result = await apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
    "https://api.anthropic.com/api/oauth/usage", headers, signal, logger)
  if (!result.ok) return { metrics: [], error: result.error, errorKind: result.errorKind, retryable: result.retryable }

  const upstreamErr = classifyUpstreamStatus(result.statusCode)
  if (upstreamErr) return upstreamErr

  try {
    if (result.body === "" || result.body === "{}") {
      return { metrics: [], error: "no quota data (empty body)", errorKind: "no-data", retryable: false }
    }
    const parsed = JSON.parse(result.body) as Record<string, unknown>
    const metrics: NormalizedMetric[] = []
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "extra_usage") continue
      if (typeof value !== "object" || value === null) continue
      const win = value as { utilization?: unknown; resets_at?: unknown }
      const used = parseNumber(win.utilization)
      if (used === undefined) continue
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
    if (metrics.length === 0) return { metrics: [], error: "no quota windows parsed", errorKind: "no-data", retryable: false }
    return { metrics }
  } catch {
    return { metrics: [], error: "parse error", errorKind: "parse-error", retryable: false }
  }
}

async function queryXai(
  fetchImpl: typeof fetch, baseUrl: string, mgmtKey: string, authIndex: string, signal: AbortSignal,
  logger: Logger,
): Promise<AccountQueryResult> {
  const headers: Record<string, string> = {
    "Authorization": "Bearer $TOKEN$",
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": "0.2.101",
    "User-Agent": "grok-pager/0.2.101 grok-shell/0.2.101 (macos; aarch64)",
    "Accept": "*/*",
  }

  const [weeklyResult, monthlyResult] = await Promise.all([
    apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits", headers, signal, logger),
    apiCall(fetchImpl, baseUrl, mgmtKey, authIndex, "GET",
      "https://cli-chat-proxy.grok.com/v1/billing", headers, signal, logger),
  ])

  // Check for upstream auth errors (I2 fix: xai now classifies 401/403)
  if (!weeklyResult.ok && weeklyResult.errorKind === "mgmt-auth") {
    return { metrics: [], error: weeklyResult.error, errorKind: weeklyResult.errorKind, retryable: weeklyResult.retryable }
  }
  if (!monthlyResult.ok && monthlyResult.errorKind === "mgmt-auth") {
    return { metrics: [], error: monthlyResult.error, errorKind: monthlyResult.errorKind, retryable: monthlyResult.retryable }
  }

  // Check upstream status codes for auth errors (both endpoints must fail auth
  // to return here; if only one fails, treat as partial below).
  if (weeklyResult.ok && (weeklyResult.statusCode === 401 || weeklyResult.statusCode === 403)
      && monthlyResult.ok && (monthlyResult.statusCode === 401 || monthlyResult.statusCode === 403)) {
    return { metrics: [], error: "upstream auth failed (possible stale auth_index)", errorKind: "upstream-auth", retryable: false }
  }

  const metrics: NormalizedMetric[] = []
  let weeklyConfig: Record<string, unknown> | undefined
  let monthlyConfig: Record<string, unknown> | undefined

  // Track per-endpoint failure state for partial detection.
  // An endpoint "fails" if: apiCall returned !ok, OR the upstream status_code
  // is non-2xx (the management API wraps upstream status in status_code),
  // OR the body can't be parsed / has no config.
  // Each failure carries its own errorKind/retryable so parse/no-data failures
  // are NOT incorrectly marked retryable.
  let weeklyFailed = false
  let weeklyErr = ""
  let weeklyErrKind: ErrorKind = "unknown"
  let weeklyRetryable = false
  let monthlyFailed = false
  let monthlyErr = ""
  let monthlyErrKind: ErrorKind = "unknown"
  let monthlyRetryable = false

  if (!weeklyResult.ok) {
    weeklyFailed = true
    weeklyErr = weeklyResult.error
    weeklyErrKind = weeklyResult.errorKind
    weeklyRetryable = weeklyResult.retryable
  } else if (weeklyResult.statusCode < 200 || weeklyResult.statusCode >= 300) {
    const cls = classifyUpstreamStatus(weeklyResult.statusCode)
    if (cls) {
      weeklyFailed = true
      weeklyErr = cls.error ?? `upstream status ${weeklyResult.statusCode}`
      weeklyErrKind = cls.errorKind ?? "upstream-error"
      weeklyRetryable = cls.retryable ?? true
    }
  }

  if (!monthlyResult.ok) {
    monthlyFailed = true
    monthlyErr = monthlyResult.error
    monthlyErrKind = monthlyResult.errorKind
    monthlyRetryable = monthlyResult.retryable
  } else if (monthlyResult.statusCode < 200 || monthlyResult.statusCode >= 300) {
    const cls = classifyUpstreamStatus(monthlyResult.statusCode)
    if (cls) {
      monthlyFailed = true
      monthlyErr = cls.error ?? `upstream status ${monthlyResult.statusCode}`
      monthlyErrKind = cls.errorKind ?? "upstream-error"
      monthlyRetryable = cls.retryable ?? true
    }
  }

  if (weeklyResult.ok && weeklyResult.statusCode >= 200 && weeklyResult.statusCode < 300) {
    try {
      const parsed = JSON.parse(weeklyResult.body) as { config?: Record<string, unknown> }
      weeklyConfig = parsed.config
      if (!weeklyConfig) {
        weeklyFailed = true
        weeklyErr = "no config in weekly response"
        weeklyErrKind = "no-data"
        weeklyRetryable = false
      }
    } catch {
      weeklyFailed = true
      weeklyErr = "weekly response parse error"
      weeklyErrKind = "parse-error"
      weeklyRetryable = false
    }
  }
  if (monthlyResult.ok && monthlyResult.statusCode >= 200 && monthlyResult.statusCode < 300) {
    try {
      const parsed = JSON.parse(monthlyResult.body) as { config?: Record<string, unknown> }
      monthlyConfig = parsed.config
      if (!monthlyConfig) {
        monthlyFailed = true
        monthlyErr = "no config in monthly response"
        monthlyErrKind = "no-data"
        monthlyRetryable = false
      }
    } catch {
      monthlyFailed = true
      monthlyErr = "monthly response parse error"
      monthlyErrKind = "parse-error"
      monthlyRetryable = false
    }
  }

  const config = weeklyConfig ?? monthlyConfig

  // Track partial failures: if one endpoint failed but the other succeeded,
  // surface a warning instead of silently swallowing it.
  const partialWarnings: string[] = []
  if (weeklyFailed && monthlyConfig !== undefined) {
    partialWarnings.push(`weekly endpoint failed: ${weeklyErr}`)
  }
  if (monthlyFailed && weeklyConfig !== undefined) {
    partialWarnings.push(`monthly endpoint failed: ${monthlyErr}`)
  }

  if (!config) {
    const err = weeklyFailed ? weeklyErr
      : monthlyFailed ? monthlyErr
      : "no billing data"
    // Use the per-endpoint failure state which carries the correct errorKind
    // and retryable for parse/no-data failures (not just status code based).
    const kind = (weeklyFailed ? weeklyErrKind
      : monthlyFailed ? monthlyErrKind
      : "no-data") as ErrorKind
    const retryable = (weeklyFailed ? weeklyRetryable : false)
      || (monthlyFailed ? monthlyRetryable : false)
    return { metrics: [], error: err, errorKind: kind, retryable }
  }

  const weeklyUsedReported = parseNumber(config["credit_usage_percent"] ?? config["creditUsagePercent"])
  const period = readXaiRecord(weeklyConfig ?? config, "current_period", "currentPeriod")
  const periodEnd = readXaiString(period, "end")
  // New unified-billing responses omit creditUsagePercent when no weekly
  // credits have been consumed, but still return the authoritative weekly
  // currentPeriod. Surface that window instead of silently dropping it.
  if (weeklyUsedReported !== undefined || periodEnd !== undefined) {
    const weeklyUsed = weeklyUsedReported ?? 0
    metrics.push({
      providerMetricId: `xai:${authIndex}:weekly`,
      label: "Weekly quota",
      unit: "%",
      used: weeklyUsed,
      limit: 100,
      sourceValueKind: "gauge-used",
      sourceConfidence: weeklyUsedReported !== undefined ? "known" : "estimated",
      ...(periodEnd !== undefined ? { window: { kind: "rolling" as const, duration: "7d", resetAt: periodEnd } } : {}),
    })
  }

  const monthlyCfg = monthlyConfig ?? config
  const monthlyLimit = readXaiCents(monthlyCfg, "monthly_limit", "monthlyLimit")
  const used = readXaiCents(monthlyCfg, "used")
  const onDemandCap = readXaiCents(monthlyCfg, "on_demand_cap", "onDemandCap")
  let onDemandUsed = readXaiCents(monthlyCfg, "on_demand_used", "onDemandUsed")
  // On-demand usage not reported but overage exists: derive from used - monthly_limit
  if (onDemandUsed === undefined && used !== undefined && monthlyLimit !== undefined && used > monthlyLimit) {
    onDemandUsed = used - monthlyLimit
  }
  const billingPeriodEnd = readXaiString(monthlyCfg, "billing_period_end", "billingPeriodEnd")

  if (monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined) {
    metrics.push({
      providerMetricId: `xai:${authIndex}:monthly`,
      label: "Monthly credits",
      unit: "$",
      used: used / 100,
      limit: monthlyLimit / 100,
      sourceValueKind: "gauge-used",
      sourceConfidence: "known",
      ...(billingPeriodEnd !== undefined ? { window: { kind: "rolling" as const, duration: "30d", resetAt: billingPeriodEnd } } : {}),
    })
  }

  if (onDemandCap !== undefined) {
    const enabled = onDemandCap > 0
    metrics.push({
      providerMetricId: `xai:${authIndex}:on_demand`,
      label: "Pay as you go",
      unit: "status",
      sourceValueKind: "status",
      sourceConfidence: "known",
      suggestedDisplayModule: "manual-status-card",
      notes: enabled
        ? `Enabled · $${(onDemandCap / 100).toFixed(2)} cap · $${((onDemandUsed ?? 0) / 100).toFixed(2)} used`
        : "Disabled",
    })
  }

  if (metrics.length === 0) {
    return { metrics: [], error: "no billing data parsed", errorKind: "no-data", retryable: false }
  }
  if (partialWarnings.length > 0) {
    // Propagate the actual failure's errorKind/retryable from whichever
    // endpoint failed. Parse-error/no-data should be retryable:false, while
    // upstream-error/transport should be retryable:true.
    const failedKind = weeklyFailed ? weeklyErrKind
      : monthlyFailed ? monthlyErrKind
      : "unknown"
    const failedRetryable = weeklyFailed ? weeklyRetryable
      : monthlyFailed ? monthlyRetryable
      : true
    return { metrics, error: partialWarnings.join("; "), errorKind: failedKind, retryable: failedRetryable }
  }
  return { metrics }
}

// Shared upstream status classifier for Codex, Claude, and xAI.
function classifyUpstreamStatus(statusCode: number): AccountQueryResult | null {
  if (statusCode === 401 || statusCode === 403) {
    return { metrics: [], error: "upstream auth failed (possible stale auth_index)", errorKind: "upstream-auth", retryable: false }
  }
  if (statusCode === 429) {
    return { metrics: [], error: "upstream rate limited (429)", errorKind: "upstream-rate-limit", retryable: true }
  }
  if (statusCode >= 500) {
    return { metrics: [], error: `upstream error (${statusCode})`, errorKind: "upstream-error", retryable: true }
  }
  if (statusCode < 200 || statusCode >= 300) {
    return { metrics: [], error: `upstream error (${statusCode})`, errorKind: "upstream-error", retryable: false }
  }
  return null
}

function readXaiCents(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const val = obj[key]
    if (val === undefined) continue
    if (typeof val === "number") return val
    if (typeof val === "string") {
      const n = Number(val)
      if (Number.isFinite(n)) return n
    }
    if (typeof val === "object" && val !== null) {
      const obj2 = val as Record<string, unknown>
      const v = obj2["val"]
      if (typeof v === "number") return v
      if (typeof v === "string") {
        const n = Number(v)
        if (Number.isFinite(n)) return n
      }
      // Also try {value: N} form
      const v2 = obj2["value"]
      if (typeof v2 === "number") return v2
      if (typeof v2 === "string") {
        const n = Number(v2)
        if (Number.isFinite(n)) return n
      }
    }
  }
  return undefined
}

function readXaiRecord(obj: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  }
  return undefined
}

function readXaiString(obj: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!obj) return undefined
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === "string" && value !== "") return value
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
