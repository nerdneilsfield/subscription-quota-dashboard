// Browser API client. Maps network/HTTP outcomes into `ApiResult` so React
// render paths never see thrown errors. Range changes and refresh actions pass
// an AbortSignal; aborted requests resolve to a network error result that
// callers ignore (they check `signal.aborted`).
//
// viewKey is ONLY transmitted via the session JSON body + Authorization header
// (cookie auth), never as a query parameter.

import type { DashboardPayload } from "../shared/dashboard-payload"
import type { RangeKey } from "../shared/domain"

export type ApiErrorCode = "unauthorized" | "rate-limited" | "not-found" | "network" | "server"
export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ApiErrorCode; status?: number; message: string; retryAfterSeconds?: number }

const JSON_HEADERS = { "Content-Type": "application/json" }

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("Retry-After")
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds)
  const date = Date.parse(raw)
  if (!Number.isNaN(date)) return Math.max(0, Math.round((date - Date.now()) / 1000))
  return undefined
}

async function request(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  range?: RangeKey,
): Promise<Response> {
  const finalUrl = range ? `${url}${url.includes("?") ? "&" : "?"}range=${range}` : url
  return globalThis.fetch(finalUrl, { ...init, credentials: "include" })
}

async function mapResponse<T>(res: Response): Promise<ApiResult<T>> {
  if (res.status === 401) return { ok: false, code: "unauthorized", status: 401, message: "Unauthorized." }
  if (res.status === 404) return { ok: false, code: "not-found", status: 404, message: "Not found." }
  if (res.status === 429) {
    const ra = parseRetryAfter(res.headers)
    const base = { ok: false as const, code: "rate-limited" as const, status: 429, message: "Too many requests." }
    return ra !== undefined ? { ...base, retryAfterSeconds: ra } : base
  }
  if (res.status >= 500) {
    return { ok: false, code: "server", status: res.status, message: "Server error." }
  }
  if (res.status >= 400) {
    return { ok: false, code: "server", status: res.status, message: "Request failed." }
  }
  try {
    const value = (await res.json()) as T
    return { ok: true, value }
  } catch {
    return { ok: false, code: "server", status: res.status, message: "Invalid response body." }
  }
}

function mapError(err: unknown, signal?: AbortSignal): ApiResult<never> {
  if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
    return { ok: false, code: "network", message: "Request aborted." }
  }
  if (err instanceof TypeError) {
    return { ok: false, code: "network", message: "Network error." }
  }
  return { ok: false, code: "server", message: "Unexpected error." }
}

export async function createSession(
  profileId: string,
  viewKey: string,
  signal?: AbortSignal,
): Promise<ApiResult<{ profile: { id: string; name: string } }>> {
  try {
    const res = await request(
      `/api/session/${encodeURIComponent(profileId)}`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ viewKey }),
        ...(signal !== undefined ? { signal } : {}),
      },
    )
    return await mapResponse<{ profile: { id: string; name: string } }>(res)
  } catch (err) {
    return mapError(err, signal)
  }
}

export async function clearSession(
  profileId: string,
  signal?: AbortSignal,
): Promise<ApiResult<{ ok: true }>> {
  try {
    const res = await request(
      `/api/session/${encodeURIComponent(profileId)}/logout`,
      { method: "POST", headers: JSON_HEADERS, ...(signal !== undefined ? { signal } : {}) },
    )
    return await mapResponse<{ ok: true }>(res)
  } catch (err) {
    return mapError(err, signal)
  }
}

export async function getDashboard(
  profileId: string,
  range: RangeKey,
  signal?: AbortSignal,
): Promise<ApiResult<DashboardPayload>> {
  try {
    const res = await request(
      `/api/dashboard/${encodeURIComponent(profileId)}`,
      { ...(signal !== undefined ? { signal } : {}) },
      range,
    )
    return await mapResponse<DashboardPayload>(res)
  } catch (err) {
    return mapError(err, signal)
  }
}

export async function refreshDashboard(
  profileId: string,
  range: RangeKey,
  signal?: AbortSignal,
): Promise<ApiResult<DashboardPayload>> {
  try {
    const res = await request(
      `/api/dashboard/${encodeURIComponent(profileId)}/refresh`,
      { method: "POST", headers: JSON_HEADERS, ...(signal !== undefined ? { signal } : {}) },
      range,
    )
    return await mapResponse<DashboardPayload>(res)
  } catch (err) {
    return mapError(err, signal)
  }
}
