import { useEffect, useRef, useState } from "react"
import type { DashboardPayload } from "../../shared/dashboard-payload"
import type { RangeKey } from "../../shared/domain"
import { createSession, getDashboard } from "../api"
import { Dashboard } from "./Dashboard"
import { LoadingState } from "./LoadingState"
import { NetworkError } from "./NetworkError"

type AuthState = "checking-session" | "unauthenticated" | "submitting" | "authenticated" | "expired"

interface AuthGateProps {
  profileId: string
  range: RangeKey
  onRangeChange?: (range: RangeKey) => void
}

export function AuthGate({ profileId, range, onRangeChange }: AuthGateProps) {
  const [auth, setAuth] = useState<AuthState>("checking-session")
  const [initialPayload, setInitialPayload] = useState<DashboardPayload | undefined>()
  const [formError, setFormError] = useState<string | undefined>()
  const [sessionError, setSessionError] = useState<string | undefined>()
  const [viewKey, setViewKey] = useState("")
  // Bumped on each retry to force the session-check effect to re-run even
  // when auth is already "checking-session" (retry sets the same value).
  const [retryNonce, setRetryNonce] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const sessionCtrlRef = useRef<AbortController | null>(null)

  // checking-session: one getDashboard with existing cookies.
  // Component remounts on profileId change (via key={profileId} in App.tsx).
  // Range is in deps so that switching range during the auth probe re-fetches
  // with the correct range (the old response is aborted via cleanup).
  // retryNonce forces re-run when retrySession sets auth to the same value.
  useEffect(() => {
    // Only run the session check when in checking-session state.
    if (auth !== "checking-session") return
    const ctrl = new AbortController()
    sessionCtrlRef.current = ctrl
    let cancelled = false
    void (async () => {
      const res = await getDashboard(profileId, range, ctrl.signal)
      if (cancelled || ctrl.signal.aborted) return
      if (res.ok) {
        setInitialPayload(res.value)
        setAuth("authenticated")
      } else if (res.code === "unauthorized") {
        setAuth("unauthenticated")
      } else {
        setSessionError(res.message)
      }
    })()
    return () => {
      cancelled = true
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, auth, range, retryNonce])

  const retrySession = () => {
    setSessionError(undefined)
    setAuth("checking-session")
    setRetryNonce((n) => n + 1)
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (auth === "submitting") return
    setFormError(undefined)
    setAuth("submitting")
    const ctrl = new AbortController()
    sessionCtrlRef.current = ctrl
    const res = await createSession(profileId, viewKey, ctrl.signal)
    if (ctrl.signal.aborted) return
    if (res.ok) {
      // fetch the dashboard payload so Dashboard can skip its own initial fetch
      const dash = await getDashboard(profileId, range, ctrl.signal)
      if (ctrl.signal.aborted) return
      if (dash.ok) {
        setInitialPayload(dash.value)
        setAuth("authenticated")
      } else if (dash.code === "unauthorized") {
        setAuth("expired")
        setFormError("Session expired. Enter your view key again.")
      } else {
        // Dashboard GET failed (network/server error): show the error on the
        // form so the user can retry, instead of silently going to unauthenticated.
        setAuth("unauthenticated")
        setFormError(dash.message || "Failed to load dashboard after login. Please try again.")
      }
      return
    }
    if (res.code === "unauthorized") {
      setAuth("unauthenticated")
      setFormError("Invalid view key.")
      setViewKey("")
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    if (res.code === "rate-limited") {
      setAuth("unauthenticated")
      setFormError("Too many attempts. Try again later.")
      return
    }
    setAuth("unauthenticated")
    setFormError(res.message)
  }

  // Unmount cleanup: abort any in-flight session/login request.
  // This covers the key={profileId} remount case: when profileId changes,
  // the old AuthGate unmounts and all in-flight requests are aborted.
  useEffect(() => {
    return () => {
      sessionCtrlRef.current?.abort()
    }
  }, [])

  if (auth === "checking-session") {
    if (sessionError) return <NetworkError message={sessionError} onRetry={retrySession} />
    return <LoadingState />
  }

  if (auth === "authenticated") {
    return (
      <Dashboard
        profileId={profileId}
        range={range}
        {...(initialPayload ? { initialPayload } : {})}
        onSessionExpired={() => {
          setAuth("expired")
          setFormError("Session expired. Enter your view key again.")
        }}
        {...(onRangeChange ? { onRangeChange } : {})}
      />
    )
  }

  const isExpired = auth === "expired"
  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <h1>Sign in</h1>
      {isExpired && (
        <div className="auth-form__expired" role="alert">
          {formError}
        </div>
      )}
      {!isExpired && formError && (
        <div className="auth-form__error" role="alert">
          {formError}
        </div>
      )}
      <label className="auth-form__label" htmlFor="view-key-input">
        View key
      </label>
      <input
        id="view-key-input"
        ref={inputRef}
        type="password"
        className="auth-form__input"
        value={viewKey}
        onChange={(e) => setViewKey(e.target.value)}
        autoComplete="current-password"
      />
      <button type="submit" className="btn-primary" disabled={auth === "submitting"}>
        {auth === "submitting" ? "Signing in…" : "Sign in"}
      </button>
    </form>
  )
}
