import type { MetricConfig } from "../../shared/domain"
import type { NormalizedMetric, ProviderAdapter, ProviderRefreshInput, ProviderRefreshResult } from "./types"
import { isRetryableStatus, parseNumber, parseResetTime } from "./shared"
import { signVolcengineRequest } from "./volcengine-sig"

// Volcengine coding-plan adapter (Agent Plan via GetAFPUsage, fallback to Coding Plan via GetCodingPlanUsage).
// Control-plane POST https://open.volcengineapi.com with AK/SK SigV4 signing.
// Source: cc-switch coding_plan.rs:1097-1153, 977-1069

type VolcengineProvider = { id: string; type: "volcengine"; region?: string | undefined; akEnv?: string | undefined; ak?: string | undefined; skEnv?: string | undefined; sk?: string | undefined }

const DEFAULT_REGION = "cn-beijing"

// Auth-error code keywords (lowercased contains match). Per cc-switch coding_plan.rs:749-759.
// Matches cc-switch exactly, including "denied". Rate-limit "RequestDenied" errors are rare
// in Volcengine OpenAPI; auth errors are far more common and the false-positive risk is low.
const AUTH_ERROR_KEYWORDS = ["auth", "signature", "accessdenied", "denied", "unauthorized", "forbidden", "credential", "token"]

export function createVolcengineProvider(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "volcengine",
    async refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult> {
      const base: ProviderRefreshResult = {
        providerAccountId: input.providerAccountId,
        fetchedAt: input.now,
        staleAfter: new Date(Date.parse(input.now) + 15 * 60 * 1000).toISOString(),
        metrics: [],
      }

      const ak = input.runtime.ak
      const sk = input.runtime.sk
      if (!ak || !sk) {
        return { ...base, errors: [{ message: "Volcengine provider unavailable: AK/SK not configured", retryable: false }] }
      }

      const providerConfig = input.provider as VolcengineProvider
      const region = providerConfig.region ?? DEFAULT_REGION
      const now = new Date(input.now)
      const wantsAgentPlan = input.metrics.some((metric) => metric.providerMetricId?.startsWith("afp:"))
      const wantsCodingPlan = input.metrics.some((metric) => metric.providerMetricId?.startsWith("cp:"))

      // 1) GetAFPUsage
      const afpResult = await callOpenApi(fetchImpl, ak, sk, region, "GetAFPUsage", now)
      let afpTiers: NormalizedMetric[] = []
      if ("body" in afpResult) {
        afpTiers = parseAfpTiers(afpResult.body, input.metrics)
        if (afpTiers.length > 0) {
          const planType = extractPlanType(afpResult.body)
          const notes = planType ? `Agent Plan ${planType}` : undefined
          if (notes) for (const m of afpTiers) m.notes = notes
        }
      }
      const afpError = "error" in afpResult ? afpResult.error : undefined
      // Auth failures are fatal; don't waste a CodingPlan call with bad credentials.
      if (afpError && !afpError.retryable) return { ...base, errors: [afpError] }

      // 2) Coding Plan is an independent product. Query it whenever cp:* is
      // configured, even if Agent Plan exists. Keep the legacy fallback when
      // AFP is empty so older single-plan configurations still work.
      let cpTiers: NormalizedMetric[] = []
      let cpError: { message: string; retryable: boolean } | undefined
      if (wantsCodingPlan || afpTiers.length === 0) {
        const cpResult = await callOpenApi(fetchImpl, ak, sk, region, "GetCodingPlanUsage", now)
        if ("body" in cpResult) cpTiers = parseCodingPlanTiers(cpResult.body, input.metrics)
        else cpError = cpResult.error
        if (cpTiers.length > 0) {
          for (const m of cpTiers) m.notes = "Coding Plan"
        }
      }

      // When both namespaces are configured, preserve both. If only cp:* is
      // configured and Coding Plan returns nothing, AFP aliases remain a
      // backward-compatible fallback for accounts served through AFP.
      const metrics = [
        ...(wantsAgentPlan || cpTiers.length === 0 ? afpTiers : []),
        ...cpTiers,
      ]
      if (metrics.length > 0) {
        const partialErrors = [
          ...(wantsAgentPlan && afpError ? [afpError] : []),
          ...(wantsCodingPlan && cpError ? [cpError] : []),
        ]
        return { ...base, metrics, ...(partialErrors.length > 0 ? { errors: partialErrors } : {}) }
      }

      if (afpError) return { ...base, errors: [afpError] }
      if (cpError) return { ...base, errors: [cpError] }
      return { ...base, errors: [{ message: "Volcengine: no active Agent Plan or Coding Plan subscription found", retryable: false }] }
    },
  }
}

type OpenApiResult =
  | { body: Record<string, unknown> }
  | { error: { message: string; retryable: boolean } }

async function callOpenApi(
  fetchImpl: typeof fetch,
  ak: string,
  sk: string,
  region: string,
  action: string,
  now: Date,
): Promise<OpenApiResult> {
  const { url, headers } = signVolcengineRequest({ ak, sk, region, action, now })

  let res: Response
  try {
    res = await fetchImpl(url, { method: "POST", headers, body: "" })
  } catch {
    return { error: { message: `Volcengine ${action} network error`, retryable: true } }
  }

  if (res.status === 401 || res.status === 403) {
    return { error: { message: `Volcengine ${action} authentication failed`, retryable: false } }
  }
  if (!res.ok) {
    // Parse body for error envelope (Volcengine returns 4xx with ResponseMetadata.Error)
    let body: unknown
    try { body = await res.json() } catch { body = {} }
    const errInfo = extractError(body)
    if (errInfo && isAuthErrorCode(errInfo.code)) {
      return { error: { message: `Volcengine ${action} auth/signature error (${errInfo.code}): ${errInfo.message}`, retryable: false } }
    }
    return { error: { message: `Volcengine ${action} request failed (${res.status})`, retryable: isRetryableStatus(res.status) } }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { error: { message: `Volcengine ${action} response parse error`, retryable: false } }
  }

  // 200 + ResponseMetadata.Error (business error)
  const errInfo = extractError(body)
  if (errInfo) {
    if (isAuthErrorCode(errInfo.code)) {
      return { error: { message: `Volcengine ${action} auth/signature error (${errInfo.code}): ${errInfo.message}`, retryable: false } }
    }
    return { error: { message: `Volcengine ${action} API error (${errInfo.code}): ${errInfo.message}`, retryable: false } }
  }

  return { body: body as Record<string, unknown> }
}

function extractError(body: unknown): { code: string; message: string } | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const meta = (body as Record<string, unknown>)["ResponseMetadata"] as Record<string, unknown> | undefined
  const err = (meta?.["Error"] ?? (body as Record<string, unknown>)["Error"]) as Record<string, unknown> | undefined
  if (!err) return undefined
  const code = typeof err["Code"] === "string" ? err["Code"] : ""
  const message = typeof err["Message"] === "string" ? err["Message"] : ""
  if (!code && !message) return undefined
  return { code, message }
}

function isAuthErrorCode(code: string): boolean {
  const lower = code.toLowerCase()
  return AUTH_ERROR_KEYWORDS.some((kw) => lower.includes(kw))
}

function extractPlanType(body: Record<string, unknown>): string | undefined {
  const result = (body["Result"] ?? body) as Record<string, unknown>
  const planType = result["PlanType"]
  if (typeof planType === "string" && planType.trim() !== "") return planType.trim()
  return undefined
}

function parseAfpTiers(body: Record<string, unknown>, configs: MetricConfig[]): NormalizedMetric[] {
  const result = (body["Result"] ?? body) as Record<string, unknown>
  const windows: Array<{ key: string; metricId: string; label: string }> = [
    { key: "AFPFiveHour", metricId: "afp:five_hour", label: "five_hour" },
    { key: "AFPWeekly", metricId: "afp:weekly_limit", label: "weekly_limit" },
    { key: "AFPMonthly", metricId: "afp:monthly", label: "monthly" },
  ]
  const metrics: NormalizedMetric[] = []
  for (const w of windows) {
    const win = result[w.key] as Record<string, unknown> | undefined
    if (!win) continue
    const quota = parseNumber(win["Quota"]) ?? 0
    if (quota <= 0) continue // Skip unbound windows
    const used = parseNumber(win["Used"]) ?? 0
    const resetAt = parseResetTime(win["ResetTime"])
    metrics.push(makeAfpMetric(w.metricId, w.label, quota, used, resetAt, configs))
  }
  return metrics
}

function makeAfpMetric(
  afpProviderMetricId: string,
  label: string,
  quota: number,
  used: number,
  resetAt: string | undefined,
  configs: MetricConfig[],
): NormalizedMetric {
  const providerMetricId = resolveVolcengineMetricId(afpProviderMetricId, configs)
  const cfg = configs.find((m) => m.providerMetricId === providerMetricId)
  const metric: NormalizedMetric = {
    providerMetricId,
    label: cfg?.label ?? label,
    unit: cfg?.unit ?? "tokens",
    limit: quota,
    used,
    remaining: Math.max(0, quota - used),
    sourceValueKind: "gauge-used",
    sourceConfidence: "known",
    ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration: durationForAfpWindow(providerMetricId), resetAt } } : {}),
  }
  return metric
}

/**
 * GetAFPUsage and GetCodingPlanUsage expose the same quota windows under
 * different metric namespaces. Prefer whichever namespace the subscription
 * configured so an account migrating between the two control-plane shapes
 * does not silently lose every metric during refresh filtering.
 */
function resolveVolcengineMetricId(afpProviderMetricId: string, configs: MetricConfig[]): string {
  if (configs.some((metric) => metric.providerMetricId === afpProviderMetricId)) return afpProviderMetricId
  const codingPlanAlias = AFP_TO_CODING_PLAN_METRIC[afpProviderMetricId]
  if (codingPlanAlias && configs.some((metric) => metric.providerMetricId === codingPlanAlias)) return codingPlanAlias
  return afpProviderMetricId
}

const AFP_TO_CODING_PLAN_METRIC: Record<string, string> = {
  "afp:five_hour": "cp:five_hour",
  "afp:weekly_limit": "cp:weekly_limit",
  "afp:monthly": "cp:monthly",
}

function durationForAfpWindow(providerMetricId: string): string {
  if (providerMetricId.includes("five_hour")) return "5h"
  if (providerMetricId.includes("weekly")) return "7d"
  return "30d"
}

function parseCodingPlanTiers(body: Record<string, unknown>, configs: MetricConfig[]): NormalizedMetric[] {
  const result = (body["Result"] ?? body) as Record<string, unknown>
  const arr = (result["QuotaUsage"] ?? result["Usages"] ?? result["Details"]) as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(arr)) return []

  const metrics: NormalizedMetric[] = []
  for (const item of arr) {
    const label = (item["Level"] ?? item["Type"] ?? item["Period"] ?? item["Label"] ?? item["Window"]) as string | undefined
    if (!label) continue
    const windowName = classifyCodingWindow(label)
    if (!windowName) continue
    const percent = parseNumber(item["Percent"] ?? item["UsedPercent"] ?? item["UsagePercent"]) ?? 0
    const resetAt = parseResetTime(item["ResetTime"] ?? item["ResetTimestamp"])
    metrics.push(makeCpMetric(windowName, percent, resetAt, configs))
  }
  return metrics
}

function classifyCodingWindow(label: string): "five_hour" | "weekly_limit" | "monthly" | undefined {
  const lower = label.toLowerCase()
  if (["session", "5h", "fivehour", "five_hour", "rolling_5h"].includes(lower)) return "five_hour"
  if (["weekly", "week", "7d"].includes(lower)) return "weekly_limit"
  if (["monthly", "month"].includes(lower)) return "monthly"
  return undefined
}

function makeCpMetric(
  windowName: "five_hour" | "weekly_limit" | "monthly",
  percent: number,
  resetAt: string | undefined,
  configs: MetricConfig[],
): NormalizedMetric {
  const providerMetricId = `cp:${windowName}`
  const cfg = configs.find((m) => m.providerMetricId === providerMetricId)
  const metric: NormalizedMetric = {
    providerMetricId,
    label: cfg?.label ?? windowName,
    unit: cfg?.unit ?? "%",
    limit: 100,
    used: percent,
    remaining: 100 - percent,
    sourceValueKind: "gauge-used",
    sourceConfidence: "known",
    ...(resetAt !== undefined ? { window: { kind: "rolling" as const, duration: windowName === "five_hour" ? "5h" : windowName === "weekly_limit" ? "7d" : "30d", resetAt } } : {}),
  }
  return metric
}
