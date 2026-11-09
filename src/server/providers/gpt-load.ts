import type { DynamicSubscription } from "../../shared/domain"
import type {
  NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult,
} from "./types"
import { isRetryableStatus, parseNumber, parseResetTime } from "./shared"
import { silentLogger, type Logger } from "../logging/logger"

// gpt-load adapter. gpt-load is a multi-account LLM gateway (Go) with a
// cliproxy-like management surface:
// GET  /api/groups                          -> discover groups (one per upstream channel)
// GET  /api/groups/{id}/credentials?page=N  -> credentials with per-account quota
// Auth: Authorization: Bearer <admin token> (the web-UI management password;
// access keys are restricted to an allowlist that excludes groups/credentials).
// Quota lives in item.observation.snapshot.quota_windows; observations are only
// populated for connection_type "subscription" groups, so api-key groups are
// skipped entirely (no quota to report).

// Both endpoints accept page_size up to 100 (credentials restricts to
// 20/50/100, so 100 must stay one of those values).
const PAGE_SIZE = 100
const GROUP_CONCURRENCY = 4
const PER_CALL_TIMEOUT_MS = 70_000
const OVERALL_DEADLINE_MS = 120_000

type GptLoadProvider = {
  id: string; type: "gpt-load"; baseUrl: string
  apiKeyEnv?: string | undefined; apiKey?: string | undefined
}

type Envelope<T> = { code?: number; message?: string; data?: T }

type GroupItem = {
  id?: number; name?: string; channel_id?: string
  connection_type?: string; status?: string
}

type GroupCollection = {
  items?: GroupItem[]
  pagination?: { page?: number; total_pages?: number; total_items?: number }
}

type QuotaWindow = {
  id?: string; label?: string; scope?: string; unit?: string
  used?: number | null; limit?: number | null; remaining?: number | null; utilization?: number | null
  reset_at_ms?: number | null; window_seconds?: number | null
  state?: string; is_primary?: boolean
}

type CredentialItem = {
  credential_id?: number; name?: string; mask?: string
  connection_type?: string; configured_status?: string; effective_status?: string
  auth_state?: string; auth_error_code?: string
  account?: { email?: string; plan_type?: string }
  observation?: {
    state?: string; observed_at_ms?: number | null
    snapshot?: {
      plan_summary?: { name?: string; level?: string }
      quota_windows?: QuotaWindow[]
    } | null
  } | null
}

type CredentialCollection = {
  items?: CredentialItem[]
  pagination?: { page?: number; total_pages?: number; total_items?: number }
}

type ListFailure =
  | { ok: true }
  | { ok: false; error: string; retryable: boolean; auth: boolean }

export function createGptLoadProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "gpt-load",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const logger = (input.logger ?? silentLogger).child({ component: "provider.gpt-load" })
      const refreshStartedAt = performance.now()
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 5 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const apiKey = input.runtime.apiKey
      if (!apiKey) {
        logger.error("gptload.configuration.invalid", { reason: "admin_token_missing" })
        return { ...base, errors: [{ message: "gpt-load provider unavailable: admin token not configured", retryable: false }] }
      }

      const providerConfig = input.provider as GptLoadProvider
      const baseUrl = providerConfig.baseUrl.replace(/\/$/, "")
      const deadline = Date.now() + OVERALL_DEADLINE_MS
      const deadlineController = new AbortController()
      const deadlineTimer = setTimeout(() => deadlineController.abort(), OVERALL_DEADLINE_MS)
      logger.info("gptload.refresh.started", {
        baseUrl,
        groupConcurrency: GROUP_CONCURRENCY,
        perCallTimeoutMs: PER_CALL_TIMEOUT_MS,
        overallDeadlineMs: OVERALL_DEADLINE_MS,
      })

      // 1) Discover all groups (paginated)
      const groupsResult = await listAllPages(
        fetchImpl, baseUrl, apiKey, "/api/groups", deadlineController.signal, logger,
        (data: GroupCollection | undefined) => ({ items: data?.items, totalPages: data?.pagination?.total_pages }),
      )
      if (!groupsResult.ok) {
        clearTimeout(deadlineTimer)
        logger.error("gptload.discovery.failed", { error: groupsResult.error, retryable: groupsResult.retryable })
        return { ...base, errors: [{ message: `gpt-load groups request failed: ${groupsResult.error}`, retryable: groupsResult.retryable }] }
      }
      const groups = groupsResult.items
      logger.info("gptload.discovery.completed", {
        groupCount: groups.length,
        channels: [...new Set(groups.map((g) => g.channel_id).filter((c): c is string => !!c))],
      })

      // 2) Fan out per group (concurrency-capped) to collect credentials
      const metrics: NormalizedMetric[] = []
      const dynamicSubscriptions: DynamicSubscription[] = []
      const adapterErrors: Array<{ message: string; retryable: boolean }> = []
      const failedMetricPrefixes: string[] = []
      let aborted = false
      let groupsAuthFailed = 0
      let groupsProcessed = 0

      for (let i = 0; i < groups.length; i += GROUP_CONCURRENCY) {
        if (Date.now() >= deadline) {
          aborted = true
          logger.error("gptload.deadline.exceeded", { processedCount: i, remainingCount: groups.length - i })
          adapterErrors.push({ message: `gpt-load refresh deadline exceeded (${groups.length - i} groups unprocessed)`, retryable: true })
          break
        }
        const batch = groups.slice(i, i + GROUP_CONCURRENCY)
        const results = await Promise.allSettled(
          batch.map((group) => collectGroup(fetchImpl, baseUrl, apiKey, group, deadlineController.signal, logger)),
        )
        for (let j = 0; j < results.length; j++) {
          const group = batch[j]!
          const settled = results[j]!
          const outcome: GroupOutcome = settled.status === "fulfilled"
            ? settled.value
            : { metrics: [], dynamicSubscriptions: [], failedPrefixes: [], credentialErrors: [], error: "request failed", retryable: true, auth: false }
          metrics.push(...outcome.metrics)
          dynamicSubscriptions.push(...outcome.dynamicSubscriptions)
          failedMetricPrefixes.push(...outcome.failedPrefixes)
          for (const credentialError of outcome.credentialErrors) {
            adapterErrors.push({ message: `gpt-load group ${group.id ?? "?"} (${group.channel_id ?? "?"}): ${credentialError}`, retryable: false })
          }
          groupsProcessed++
          if (outcome.auth) groupsAuthFailed++
          if (outcome.error !== undefined) {
            adapterErrors.push({ message: `gpt-load group ${group.id ?? "?"} (${group.channel_id ?? "?"}): ${outcome.error}`, retryable: outcome.retryable })
            logger.warn("gptload.group.failed", {
              groupId: group.id, channel: group.channel_id, error: outcome.error, retryable: outcome.retryable,
            })
          } else {
            logger.info("gptload.group.completed", {
              groupId: group.id, channel: group.channel_id,
              credentialCount: outcome.dynamicSubscriptions.length,
              metricCount: outcome.metrics.length,
            })
          }
        }
      }

      clearTimeout(deadlineTimer)

      // Global auth failure: every reachable group rejected the token. Omit
      // dynamicSubscriptions so coalesce preserves the last-known-good list.
      const allAuthFailed = groups.length > 0 && groupsAuthFailed === groupsProcessed
      if (allAuthFailed && adapterErrors.length > 0) aborted = true

      if (aborted) {
        logger.warn("gptload.refresh.completed", {
          status: "aborted",
          durationMs: Math.round((performance.now() - refreshStartedAt) * 100) / 100,
          metricCount: metrics.length,
          errorCount: adapterErrors.length,
        })
        return { ...base, metrics, ...(adapterErrors.length > 0 ? { errors: adapterErrors } : {}) }
      }

      const preserveMetricIds = failedMetricPrefixes.length > 0 ? failedMetricPrefixes : undefined
      const completionFields = {
        status: adapterErrors.length > 0 ? "degraded" : "ok",
        durationMs: Math.round((performance.now() - refreshStartedAt) * 100) / 100,
        groupCount: groups.length,
        credentialCount: dynamicSubscriptions.length,
        metricCount: metrics.length,
        errorCount: adapterErrors.length,
      }
      if (adapterErrors.length > 0) logger.warn("gptload.refresh.completed", completionFields)
      else logger.info("gptload.refresh.completed", completionFields)
      return { ...base, metrics, dynamicSubscriptions, ...(adapterErrors.length > 0 ? { errors: adapterErrors } : {}),
        ...(preserveMetricIds !== undefined ? { preserveMetricIds } : {}) }
    },
  }
}

type GroupOutcome = {
  metrics: NormalizedMetric[]
  dynamicSubscriptions: DynamicSubscription[]
  failedPrefixes: string[]
  credentialErrors: string[]
  error?: string
  retryable: boolean
  auth: boolean
}

async function collectGroup(
  fetchImpl: typeof fetch, baseUrl: string, apiKey: string, group: GroupItem,
  parentSignal: AbortSignal, logger: Logger,
): Promise<GroupOutcome> {
  const groupLogger = logger.child({ groupId: group.id, channel: group.channel_id })
  const empty: GroupOutcome = { metrics: [], dynamicSubscriptions: [], failedPrefixes: [], credentialErrors: [], retryable: false, auth: false }
  if (group.id === undefined) {
    return { ...empty, error: "group missing id", retryable: false }
  }
  const channel = (group.channel_id ?? "unknown").trim().toLowerCase() || "unknown"

  // Observations are only populated for subscription-type groups; api-key
  // groups have no quota to report, so skip them entirely rather than
  // emitting an error card per credential.
  if (group.connection_type !== undefined && group.connection_type !== "subscription") {
    groupLogger.debug("gptload.group.skipped", { connectionType: group.connection_type })
    return empty
  }

  const fetchCredentials = () => listAllPages(
    fetchImpl, baseUrl, apiKey, `/api/groups/${group.id}/credentials`, parentSignal, groupLogger,
    (data: CredentialCollection | undefined) => ({ items: data?.items, totalPages: data?.pagination?.total_pages }),
  )
  let credentialsResult = await fetchCredentials()
  if (!credentialsResult.ok && credentialsResult.retryable) {
    groupLogger.warn("gptload.group.retry", { error: credentialsResult.error })
    credentialsResult = await fetchCredentials()
  }
  if (!credentialsResult.ok) {
    // Placeholder card keeps the failure visible; per-credential cards cannot
    // be synthesized because the credential IDs are unknown this cycle, so
    // they reappear on the next successful refresh.
    const metric: NormalizedMetric = {
      providerMetricId: `${channel}:${group.id}:unavailable`,
      label: "Status",
      unit: "",
      sourceValueKind: "status",
      sourceConfidence: "unknown",
      notes: `failed to fetch credentials: ${credentialsResult.error}`,
    }
    const providerLabel = CHANNEL_LABELS[channel] ?? titleCase(channel)
    return {
      metrics: [metric],
      dynamicSubscriptions: [{
        id: `gpt-load:${group.id}:unavailable`,
        name: group.name?.trim() || providerLabel,
        providerMetricIds: [metric.providerMetricId],
        identity: { provider: channel, providerLabel, transport: "GPT Load" },
        ui: { group: providerLabel },
      }],
      failedPrefixes: [],
      credentialErrors: [],
      error: credentialsResult.error,
      retryable: credentialsResult.retryable,
      auth: credentialsResult.auth,
    }
  }

  const metrics: NormalizedMetric[] = []
  const dynamicSubscriptions: DynamicSubscription[] = []
  const failedPrefixes: string[] = []
  const credentialErrors: string[] = []
  for (const credential of credentialsResult.items) {
    if (credential.configured_status === "disabled") continue
    if (credential.credential_id === undefined) continue
    const credentialKey = `${group.id}:${credential.credential_id}`
    const prefix = `${channel}:${credentialKey}:`
    const account = credential.account?.email?.trim() || credential.name?.trim() || undefined

    // gpt-load keeps the last snapshot when refresh fails, so trust windows
    // only as fresh as the observation says they are.
    const observation = credential.observation
    const obsState = observation?.state?.trim()
    const observedAtMs = parseNumber(observation?.observed_at_ms)
    const freshness: Freshness = {
      confidence: obsState === undefined || obsState === "fresh" ? "known" : "estimated",
      updatedAt: observedAtMs !== undefined ? new Date(observedAtMs).toISOString() : undefined,
      note: obsState !== undefined && obsState !== "fresh" ? `observation state: ${obsState}` : undefined,
    }

    const windows = observation?.snapshot?.quota_windows
    const credentialMetrics: NormalizedMetric[] = []
    if (windows && windows.length > 0) {
      for (const [index, window] of windows.entries()) {
        const metric = mapQuotaWindow(prefix, index, window, freshness)
        if (metric) credentialMetrics.push(metric)
      }
    }
    if (credentialMetrics.length === 0) {
      if (credential.auth_state !== undefined && credential.auth_state !== "ready") {
        const errorMetric = makeErrorMetric(prefix, credential)
        credentialMetrics.push(errorMetric)
        failedPrefixes.push(prefix)
        credentialErrors.push(`${credentialKey}: ${errorMetric.notes ?? "no quota data"}`)
        groupLogger.warn("gptload.credential.auth_failed", {
          credentialId: credential.credential_id, account, authState: credential.auth_state,
        })
      } else {
        credentialMetrics.push({
          providerMetricId: `${prefix}status`,
          label: "Status",
          unit: "",
          sourceValueKind: "status",
          sourceConfidence: "unknown",
          notes: "awaiting first observation",
          ...(freshness.updatedAt !== undefined ? { updatedAt: freshness.updatedAt } : {}),
        })
        groupLogger.info("gptload.credential.awaiting_observation", {
          credentialId: credential.credential_id, account,
        })
      }
    }
    metrics.push(...credentialMetrics)
    dynamicSubscriptions.push(makeDynSub(channel, credentialKey, credential, credentialMetrics.map((m) => m.providerMetricId)))
  }

  return { metrics, dynamicSubscriptions, failedPrefixes, credentialErrors, retryable: false, auth: false }
}

type Freshness = {
  confidence: "known" | "estimated"
  updatedAt?: string | undefined
  note?: string | undefined
}

function mapQuotaWindow(prefix: string, index: number, window: QuotaWindow, freshness: Freshness): NormalizedMetric | undefined {
  const windowId = window.id ?? `window_${index + 1}`
  const label = window.label?.trim() || windowId
  const unit = UNIT_LABELS[window.unit ?? ""] ?? (window.unit?.trim() || "")

  const used = parseNumber(window.used)
  const remaining = parseNumber(window.remaining)
  const limit = parseNumber(window.limit)
  const utilization = parseNumber(window.utilization)

  let sourceValueKind: NormalizedMetric["sourceValueKind"]
  let usedValue: number | undefined
  let remainingValue: number | undefined
  let limitValue: number | undefined
  if (used !== undefined) {
    sourceValueKind = "gauge-used"
    usedValue = used
    remainingValue = remaining
    limitValue = limit
  } else if (remaining !== undefined) {
    sourceValueKind = "gauge-remaining"
    remainingValue = remaining
    limitValue = limit
  } else if (utilization !== undefined) {
    sourceValueKind = "gauge-used"
    usedValue = utilization
    limitValue = limit ?? 100
  } else {
    return undefined
  }

  const windowSeconds = parseNumber(window.window_seconds)
  const resetAt = parseResetTime(window.reset_at_ms)
  return {
    providerMetricId: `${prefix}${encodeURIComponent(windowId)}`,
    label,
    unit,
    ...(usedValue !== undefined ? { used: usedValue } : {}),
    ...(remainingValue !== undefined ? { remaining: remainingValue } : {}),
    ...(limitValue !== undefined ? { limit: limitValue } : {}),
    sourceValueKind,
    sourceConfidence: freshness.confidence,
    ...(freshness.note !== undefined ? { notes: freshness.note } : {}),
    ...(freshness.updatedAt !== undefined ? { updatedAt: freshness.updatedAt } : {}),
    ...(windowSeconds !== undefined
      ? { window: { kind: "rolling" as const, duration: durationFromSeconds(windowSeconds), ...(resetAt !== undefined ? { resetAt } : {}) } }
      : {}),
  }
}

const UNIT_LABELS: Record<string, string> = {
  percent: "%",
  usd: "$",
}

function durationFromSeconds(seconds: number): string {
  if (seconds === 18000) return "5h"
  if (seconds === 604800) return "7d"
  if (seconds === 2592000) return "30d"
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  return `${minutes}m`
}

function makeErrorMetric(prefix: string, credential: CredentialItem): NormalizedMetric {
  const notes = `auth_state: ${credential.auth_state}${credential.auth_error_code ? ` (${credential.auth_error_code})` : ""}`
  return {
    providerMetricId: `${prefix}error`,
    label: "Status",
    unit: "",
    sourceValueKind: "status",
    sourceConfidence: "unknown",
    notes,
  }
}

const CHANNEL_LABELS: Record<string, string> = {
  openai: "ChatGPT",
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
  azure_openai: "Azure OpenAI",
  openai_compatible: "OpenAI Compatible",
  deepseek: "DeepSeek",
  zhipuai: "Zhipu",
  xai: "Grok",
  grok: "Grok",
}

function makeDynSub(
  channel: string, credentialKey: string, credential: CredentialItem, providerMetricIds: string[],
): DynamicSubscription {
  const providerLabel = CHANNEL_LABELS[channel] ?? titleCase(channel)
  const planName = credential.observation?.snapshot?.plan_summary?.name?.trim()
  const planLevel = credential.observation?.snapshot?.plan_summary?.level?.trim()
  // Email first: it identifies the actual upstream account, so mirrored copies
  // of the same account across groups collapse into one card; display names
  // are only a fallback and can collide between distinct credentials.
  const account = credential.account?.email?.trim() || credential.name?.trim() || undefined
  return {
    id: `gpt-load:${credentialKey}`,
    name: providerLabel,
    providerMetricIds,
    identity: {
      // channel (codex/claude/xai/...) rather than "gpt-load": the projection
      // layer dedupes by account:<provider>:<account>, and sharing the
      // upstream vocabulary with cliproxy collapses the same account seen on
      // both platforms into one card.
      provider: channel,
      providerLabel,
      ...(account ? { account } : {}),
      ...(planName || planLevel ? { plan: [planName, planLevel].filter(Boolean).join(" ") } : {}),
      transport: "GPT Load",
    },
    ui: { group: providerLabel },
  }
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

// Fetches a paginated control endpoint, following pagination.total_pages.
// Returns the accumulated items or a classified failure.
async function listAllPages<Item, Collection>(
  fetchImpl: typeof fetch, baseUrl: string, apiKey: string, path: string,
  parentSignal: AbortSignal, logger: Logger,
  extract: (data: Collection | undefined) => { items?: Item[] | undefined; totalPages?: number | undefined },
): Promise<{ ok: true; items: Item[] } | { ok: false; error: string; retryable: boolean; auth: boolean }> {
  const items: Item[] = []
  let page = 1
  let totalPages = 1
  do {
    const outcome = await fetchPage<Collection>(fetchImpl, baseUrl, apiKey, path, page, parentSignal, logger)
    if (!outcome.ok) return { ok: false, error: outcome.error, retryable: outcome.retryable, auth: outcome.auth }
    const { items: pageItems, totalPages: reported } = extract(outcome.data)
    items.push(...(pageItems ?? []))
    totalPages = Math.max(1, parseNumber(reported) ?? (pageItems && pageItems.length > 0 ? page : 1))
    page++
  } while (page <= totalPages)
  return { ok: true, items }
}

type PageResult<Collection> =
  | { ok: true; data: Collection | undefined }
  | { ok: false; error: string; retryable: boolean; auth: boolean }

async function fetchPage<Collection>(
  fetchImpl: typeof fetch, baseUrl: string, apiKey: string, path: string,
  page: number, parentSignal: AbortSignal, logger: Logger,
): Promise<PageResult<Collection>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS)
  const onParentAbort = (): void => controller.abort()
  parentSignal.addEventListener("abort", onParentAbort, { once: true })
  const separator = path.includes("?") ? "&" : "?"
  const url = `${baseUrl}${path}${separator}page=${page}&page_size=${PAGE_SIZE}`
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    })
  } catch (error) {
    logger.warn("gptload.request.failed", { path, page, reason: "network_error", error })
    return { ok: false, error: "network error", retryable: true, auth: false }
  } finally {
    clearTimeout(timer)
    parentSignal.removeEventListener("abort", onParentAbort)
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "admin token rejected", retryable: false, auth: true }
  }
  if (!res.ok) {
    return { ok: false, error: `request failed (${res.status})`, retryable: isRetryableStatus(res.status), auth: false }
  }
  let body: Envelope<Collection>
  try {
    body = (await res.json()) as Envelope<Collection>
  } catch {
    return { ok: false, error: "non-JSON response", retryable: false, auth: false }
  }
  if (body.code !== 0) {
    return { ok: false, error: body.message ?? `control API error (code ${body.code})`, retryable: false, auth: false }
  }
  return { ok: true, data: body.data }
}
