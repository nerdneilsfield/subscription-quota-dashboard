# Subscription Quota Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Bun-managed TypeScript full-stack subscription quota dashboard with Poe API points, manual quotas, SQLite cache/snapshots, profile-based view access, and a dark React dashboard.

**Architecture:** A single Bun process runs a Hono API server, serves the Vite React build in production, reads typed config from `config/dashboard.config.ts`, and stores provider cache/history in SQLite. Providers normalize account-level data into configured subscription metrics; the dashboard API projects only profile-allowed subscriptions and returns a UI-ready payload.

**Tech Stack:** Bun, TypeScript, Hono, React, Vite, SQLite via `bun:sqlite`, `bun:test`, CSS modules through plain CSS files.

## Global Constraints

- `viewKey` must never appear in URLs; first validation uses `Authorization: Bearer <viewKey>` or JSON body, then a short-lived HttpOnly signed session cookie.
- Dashboard APIs must send `Cache-Control: no-store`; Vite static assets may use normal hashed-asset caching.
- Poe provider uses `GET https://api.poe.com/usage/current_balance` and `GET https://api.poe.com/usage/points_history` with `Authorization: Bearer <POE_API_KEY>`.
- Poe history filters default to `usage_type == "API"`.
- `metricKey` format is `providerAccountId/subscriptionId/metricId`, with each segment URL-encoded before joining.
- Window durations must match `/^\d+(m|h|d)$/`; calendar windows require `timezone` and either `anchor` or one-cycle `resetAt`.
- Status precedence is `expired > unavailable > critical > warn > stale > ok`.
- Summary aggregation must not add different units together and must dedupe account-scoped provider balances by `providerAccountId + providerMetricId`.
- SQLite uses migrations, WAL, busy timeout, serialized writes, and transaction-wrapped refresh writes.
- No admin UI, OAuth, cookie scraping, charting library, or public-internet hardening beyond the spec-defined protections.

---

## File Structure

- `package.json`: Bun scripts and dependency declarations.
- `tsconfig.json`: shared strict TypeScript config for server and client.
- `vite.config.ts`: Vite React build config with `src/client` entry.
- `index.html`: Vite HTML shell.
- `tests/setup-dom.ts`: happy-dom global setup and React Testing Library cleanup.
- `config/dashboard.config.ts`: local typed example config.
- `src/shared/domain.ts`: domain contracts shared by server and client.
- `src/shared/dashboard-payload.ts`: public dashboard API payload types.
- `src/shared/window.ts`: limit window validation, reset calculation, label generation.
- `src/shared/metric-key.ts`: canonical metric key builder and parser.
- `src/server/config/load-config.ts`: config import, env resolution, validation, normalized config output.
- `src/server/storage/schema.ts`: SQL migrations.
- `src/server/storage/database.ts`: SQLite open, WAL setup, migrations, write transaction helper.
- `src/server/storage/repositories.ts`: provider cache, snapshots, history events, import state, refresh run persistence.
- `src/server/stats/delta.ts`: reset-aware delta and burn-rate math.
- `src/server/stats/summary.ts`: per-range stats and summary group aggregation.
- `src/server/providers/types.ts`: provider adapter interfaces and normalized provider output.
- `src/server/providers/manual.ts`: manual provider adapter.
- `src/server/providers/poe.ts`: Poe Usage API adapter.
- `src/server/dashboard/project.ts`: provider/config metric projection and dashboard payload composition.
- `src/server/auth/session.ts`: viewKey verification, signed session cookies, constant-time comparison.
- `src/server/auth/rate-limit.ts`: in-memory rate limiters.
- `src/server/http/app.ts`: Hono app, API routes, security headers, static serving.
- `src/server/main.ts`: process entrypoint.
- `src/client/api.ts`: browser API client.
- `src/client/App.tsx`: route shell and state flow.
- `src/client/components/*.tsx`: dashboard UI components.
- `src/client/styles.css`: dark dense dashboard styles and CSS bars.
- `tests/**/*.test.ts`: Bun tests for each server/shared unit and minimal UI render tests.
- `README.md`: setup, env, config, run, security notes.

---

### Task 1: Project Scaffold And Tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/server/main.ts`
- Create: `src/server/http/app.ts`
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/styles.css`
- Test: `tests/scaffold.test.ts`

**Interfaces:**
- Consumes: Empty repository with existing `README.md`, `.gitignore`, and design spec.
- Produces: `createApp(): Hono` from `src/server/http/app.ts`; script commands `test`, `typecheck`, `dev`, `build`, `start`.

- [ ] **Step 1: Create package and TypeScript scaffold files**

Create `package.json` with these scripts and dependency groups:

```json
{
  "name": "subscription-quota-dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/server/main.ts",
    "client:dev": "vite --host 127.0.0.1",
    "build": "vite build && bun build src/server/main.ts --target=bun --outdir=dist/server",
    "start": "bun dist/server/main.js",
    "test": "bun test --preload ./tests/setup-dom.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@js-temporal/polyfill": "latest",
    "@hono/node-server": "latest",
    "@vitejs/plugin-react": "latest",
    "hono": "latest",
    "react": "latest",
    "react-dom": "latest",
    "react-router-dom": "latest",
    "vite": "latest"
  },
  "devDependencies": {
    "@testing-library/react": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "bun-types": "latest",
    "happy-dom": "latest",
    "typescript": "latest"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["bun-types"]
  },
  "include": ["src", "tests", "config", "vite.config.ts"]
}
```

Create `vite.config.ts`:

```ts
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
})
```

Create `tests/setup-dom.ts`:

```ts
import { afterEach } from "bun:test"
import { cleanup } from "@testing-library/react"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()
afterEach(() => cleanup())
```

- [ ] **Step 2: Install dependencies**

Run: `rtk bun install`

Expected: `bun.lock` is created and dependencies install without errors.

- [ ] **Step 3: Create minimal app entrypoints**

Create `src/server/http/app.ts`:

```ts
import { Hono } from "hono"

export function createApp() {
  const app = new Hono()
  app.get("/health", (c) => c.json({ ok: true }))
  return app
}
```

Create `src/server/main.ts`:

```ts
import { serve } from "@hono/node-server"
import { createApp } from "./http/app"

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: createApp().fetch, port })
console.log(`subscription-quota-dashboard listening on http://127.0.0.1:${port}`)
```

Create `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Subscription Quota Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/client/main.tsx"></script>
  </body>
</html>
```

Create `src/client/main.tsx`:

```tsx
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./styles.css"

createRoot(document.getElementById("root")!).render(<App />)
```

Create `src/client/App.tsx`:

```tsx
export function App() {
  return <h1>Subscription Quota Dashboard</h1>
}
```

Create `src/client/styles.css` with `body` dark background and a visible `Subscription Quota Dashboard` heading.

- [ ] **Step 4: Write scaffold smoke test**

Create `tests/scaffold.test.ts`:

```ts
import { expect, test } from "bun:test"
import { createApp } from "../src/server/http/app"

test("health endpoint reports alive", async () => {
  const res = await createApp().request("/health")
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
})
```

- [ ] **Step 5: Run verification**

Run: `rtk bun test tests/scaffold.test.ts`

Expected: test passes.

Run: `rtk bun run typecheck`

Expected: exits 0.

- [ ] **Step 6: Commit**

Run:

```bash
rtk git add package.json bun.lock tsconfig.json vite.config.ts index.html src tests
rtk git commit -m "chore: scaffold dashboard app"
```

---

### Task 2: Domain Contracts And Config Validation

**Files:**
- Create: `src/shared/domain.ts`
- Create: `src/shared/dashboard-payload.ts`
- Create: `src/server/config/load-config.ts`
- Create: `config/dashboard.config.ts`
- Test: `tests/config/load-config.test.ts`

**Interfaces:**
- Consumes: project scaffold from Task 1.
- Produces: `loadDashboardConfig(input: DashboardConfigInput): NormalizedConfig`; `loadDashboardConfigFromFile(path?: string): Promise<NormalizedConfig>`; domain types `LimitWindow`, `MetricConfig`, `ProviderAccountConfig`, `SubscriptionConfig`, `ProfileConfig`, `DashboardPayload`.

- [ ] **Step 1: Write failing config validation tests**

Create `tests/config/load-config.test.ts`:

```ts
import { expect, test } from "bun:test"
import { loadDashboardConfig } from "../../src/server/config/load-config"
import type { DashboardConfigInput } from "../../src/shared/domain"

const baseConfig: DashboardConfigInput = {
  providers: [{ id: "poe-main", type: "poe", apiKey: "poe_test_key" }],
  subscriptions: [
    {
      id: "poe-api",
      name: "Poe API",
      providerId: "poe-main",
      metrics: [
        {
          id: "points",
          providerMetricId: "points",
          label: "API points",
          unit: "points",
          limit: 1000,
          usageFilter: { usageTypes: ["API"] },
          sourceValueKind: "gauge-remaining",
          window: {
            kind: "calendar",
            period: "month",
            timezone: "Asia/Shanghai",
            anchor: { dayOfMonth: 1, timeOfDay: "00:00" },
          },
          display: { module: "balance-card" },
        },
      ],
    },
  ],
  profiles: [{ id: "self", name: "Personal", viewKey: "view_secret_128_bits", subscriptionIds: ["poe-api"] }],
}

test("normalizes a valid config", () => {
  const config = loadDashboardConfig(baseConfig)
  expect(config.profiles.get("self")?.subscriptionIds).toEqual(["poe-api"])
  expect(config.subscriptions.get("poe-api")?.metrics[0]?.providerMetricId).toBe("points")
})

test("rejects a missing viewKey with profile id", () => {
  const invalid: DashboardConfigInput = {
    ...baseConfig,
    profiles: [{ id: "self", name: "Personal", viewKey: undefined, subscriptionIds: ["poe-api"] }],
  }
  expect(() => loadDashboardConfig(invalid)).toThrow("profiles[self].viewKey")
})

test("rejects calendar resetAt and anchor together", () => {
  const invalid = structuredClone(baseConfig)
  const metric = invalid.subscriptions[0]!.metrics[0]!
  metric.window = {
    kind: "calendar",
    period: "month",
    timezone: "Asia/Shanghai",
    resetAt: "2026-07-01T00:00:00+08:00",
    anchor: { dayOfMonth: 1, timeOfDay: "00:00" },
  }
  expect(() => loadDashboardConfig(invalid)).toThrow("exactly one of resetAt or anchor")
})

test("marks unresolved Poe provider unavailable instead of throwing", () => {
  const config = loadDashboardConfig({
    ...baseConfig,
    providers: [{ id: "poe-main", type: "poe", apiKeyEnv: "MISSING_POE_KEY" }],
  })
  expect(config.providers.get("poe-main")?.type).toBe("poe")
  expect(config.providerRuntime.get("poe-main")?.available).toBe(false)
  expect(config.providerRuntime.get("poe-main")?.reason).toContain("MISSING_POE_KEY")
})

test("rejects stale manual rolling metric without updatedAt", () => {
  const invalid = structuredClone(baseConfig)
  invalid.providers.push({ id: "manual-main", type: "manual" })
  invalid.subscriptions.push({
    id: "manual-sub",
    name: "Manual Sub",
    providerId: "manual-main",
    metrics: [{ id: "rolling", label: "Rolling", unit: "messages", used: 1, window: { kind: "rolling", duration: "5h" }, display: { module: "rolling-window-card" } }],
  })
  expect(() => loadDashboardConfig(invalid)).toThrow("subscriptions[manual-sub].metrics[rolling].updatedAt")
})

test("rejects duplicate ids and broken references", () => {
  expect(() => loadDashboardConfig({ ...baseConfig, providers: [...baseConfig.providers, baseConfig.providers[0]!] })).toThrow("providers[poe-main]")
  expect(() => loadDashboardConfig({ ...baseConfig, subscriptions: [{ ...baseConfig.subscriptions[0]!, providerId: "missing" }] })).toThrow("subscriptions[poe-api].providerId")
  expect(() => loadDashboardConfig({ ...baseConfig, profiles: [{ ...baseConfig.profiles[0]!, subscriptionIds: ["missing"] }] })).toThrow("profiles[self].subscriptionIds")
})

test("rejects invalid window rules and display modules", () => {
  const invalidDuration = structuredClone(baseConfig)
  invalidDuration.subscriptions[0]!.metrics[0]!.window = { kind: "rolling", duration: "five-hours" }
  expect(() => loadDashboardConfig(invalidDuration)).toThrow("duration")

  const invalidDisplay = structuredClone(baseConfig) as DashboardConfigInput & { subscriptions: Array<{ metrics: Array<{ display: { module: string } }> }> }
  invalidDisplay.subscriptions[0]!.metrics[0]!.display.module = "chart-card"
  expect(() => loadDashboardConfig(invalidDisplay)).toThrow("display.module")
})

test("infers manual sourceValueKind", () => {
  const config = loadDashboardConfig({
    providers: [{ id: "manual-main", type: "manual" }],
    subscriptions: [{ id: "manual", name: "Manual", providerId: "manual-main", metrics: [
      { id: "used", label: "Used", unit: "requests", used: 4, display: { module: "period-quota-card" } },
      { id: "remaining", label: "Remaining", unit: "credits", remaining: 7, display: { module: "balance-card" } },
      { id: "status", label: "Status", unit: "state", display: { module: "manual-status-card" } },
    ] }],
    profiles: [{ id: "self", name: "Self", viewKey: "secret", subscriptionIds: ["manual"] }],
  })
  const metrics = config.subscriptions.get("manual")!.metrics
  expect(metrics.map((metric) => metric.sourceValueKind)).toEqual(["gauge-used", "gauge-remaining", "status"])
})
```

- [ ] **Step 2: Run failing tests**

Run: `rtk bun test tests/config/load-config.test.ts`

Expected: FAIL because `load-config.ts` and `domain.ts` do not exist.

- [ ] **Step 3: Add domain types**

Create `src/shared/domain.ts` with the spec-aligned unions and config types. Include these exact exported type names:

```ts
export type DisplayModule = "balance-card" | "rolling-window-card" | "period-quota-card" | "manual-status-card"
export type SourceValueKind = "counter" | "gauge-remaining" | "gauge-used" | "status"
export type MetricStatus = "ok" | "warn" | "critical" | "stale" | "unavailable" | "expired"
export type RangeKey = "1h" | "24h" | "7d" | "30d"

export type LimitWindow =
  | { kind: "calendar"; period: "day" | "week" | "month" | "year"; timezone: string; resetAt?: string; anchor?: CalendarAnchor }
  | { kind: "rolling"; duration: string; resetAt?: string }
  | { kind: "fixed"; startsAt: string; resetAt: string }

export type CalendarAnchor = {
  dayOfWeek?: number
  dayOfMonth?: number
  monthOfYear?: number
  timeOfDay?: string
}

export type MetricConfig = {
  id: string
  providerMetricId?: string
  label: string
  unit: string
  limit?: number
  used?: number
  remaining?: number
  sourceValueKind?: SourceValueKind
  window?: LimitWindow
  display: { module: DisplayModule; thresholds?: MetricThresholds }
  updatedAt?: string
  notes?: string
  usageFilter?: { usageTypes?: string[]; apiKeyName?: string; botName?: string }
}

export type MetricThresholds = {
  warnPercentUsed?: number
  criticalPercentUsed?: number
  warnRemaining?: number
  criticalRemaining?: number
}

export type ProviderAccountConfig =
  | { id: string; type: "poe"; apiKeyEnv?: string | undefined; apiKey?: string | undefined }
  | { id: string; type: "manual" }

export type SubscriptionConfig = {
  id: string
  name: string
  providerId: string
  metrics: MetricConfig[]
  ui?: { color?: string; group?: string; sort?: number }
}

export type ProfileConfig = { id: string; name: string; viewKey: string | undefined; subscriptionIds: string[] }
export type DashboardConfigInput = { providers: ProviderAccountConfig[]; subscriptions: SubscriptionConfig[]; profiles: ProfileConfig[] }
export type ProviderRuntimeState = { available: boolean; apiKey?: string; reason?: string }
export type NormalizedConfig = { providers: Map<string, ProviderAccountConfig>; providerRuntime: Map<string, ProviderRuntimeState>; subscriptions: Map<string, SubscriptionConfig>; profiles: Map<string, ProfileConfig> }
```

- [ ] **Step 4: Implement config validation**

Create `src/server/config/load-config.ts` with `loadDashboardConfig(input)` that:

- validates unique provider, subscription, profile IDs;
- validates all references;
- validates profile `viewKey` is non-empty;
- resolves Poe `apiKeyEnv`; falls back to direct `apiKey` when env is missing and direct key exists; marks provider unavailable when neither resolves;
- validates calendar, rolling, fixed window rules;
- rejects manual rolling metrics without `updatedAt`;
- validates metric IDs unique within subscription;
- infers `providerMetricId = id` when omitted;
- infers manual `sourceValueKind` from `used`/`remaining` as defined in the spec.

Also export `loadDashboardConfigFromFile(path = "config/dashboard.config.ts")` that dynamically imports the config file and calls `loadDashboardConfig(imported.default)`. `src/server/main.ts` must use `loadDashboardConfigFromFile()` during startup rather than constructing config inline.

Use this error style for path-specific failures:

```ts
throw new Error(`Invalid dashboard config: ${path}: ${message}`)
```

- [ ] **Step 5: Add example config**

Create `config/dashboard.config.ts` exporting `DashboardConfigInput` with one Poe subscription and one manual subscription matching the design spec examples.

- [ ] **Step 6: Run tests and typecheck**

Run: `rtk bun test tests/config/load-config.test.ts`

Expected: all tests pass.

Run: `rtk bun run typecheck`

Expected: exits 0.

- [ ] **Step 7: Commit**

Run:

```bash
rtk git add src/shared src/server/config config tests/config
rtk git commit -m "feat: add dashboard config validation"
```

---

### Task 3: Window, Metric Key, And Delta Utilities

**Files:**
- Create: `src/shared/window.ts`
- Create: `src/shared/metric-key.ts`
- Create: `src/server/stats/delta.ts`
- Test: `tests/shared/window.test.ts`
- Test: `tests/shared/metric-key.test.ts`
- Test: `tests/stats/delta.test.ts`

**Interfaces:**
- Consumes: domain types from Task 2.
- Produces: `buildMetricKey(providerAccountId, subscriptionId, metricId): string`; `labelWindow(window, resetAt?): string`; `computeNextResetAt(window, from): string | undefined`; `computeSnapshotDelta(input): DeltaResult`.

- [ ] **Step 1: Write failing utility tests**

Create `tests/shared/metric-key.test.ts`:

```ts
import { expect, test } from "bun:test"
import { buildMetricKey, parseMetricKey } from "../../src/shared/metric-key"

test("metric key URL-encodes each segment", () => {
  const key = buildMetricKey("poe/main", "self dashboard", "points")
  expect(key).toBe("poe%2Fmain/self%20dashboard/points")
  expect(parseMetricKey(key)).toEqual({ providerAccountId: "poe/main", subscriptionId: "self dashboard", metricId: "points" })

  const literalEncoded = buildMetricKey("poe%2Fmain", "self", "points")
  expect(literalEncoded).toBe("poe%252Fmain/self/points")
  expect(parseMetricKey(literalEncoded).providerAccountId).toBe("poe%2Fmain")
})
```

Create `tests/stats/delta.test.ts`:

```ts
import { expect, test } from "bun:test"
import { computeSnapshotDelta } from "../../src/server/stats/delta"

test("gauge-remaining delta uses earlier minus later", () => {
  const result = computeSnapshotDelta({
    kind: "gauge-remaining",
    earlier: { timestamp: "2026-06-25T00:00:00Z", value: 100 },
    later: { timestamp: "2026-06-25T01:00:00Z", value: 70 },
    resetBoundaries: [],
  })
  expect(result).toEqual({ status: "known", consumption: 30, sourceConfidence: "known" })
})

test("reset crossing without boundary samples returns unknown", () => {
  const result = computeSnapshotDelta({
    kind: "gauge-used",
    earlier: { timestamp: "2026-06-30T23:00:00Z", value: 90 },
    later: { timestamp: "2026-07-01T01:00:00Z", value: 10 },
    resetBoundaries: ["2026-07-01T00:00:00Z"],
  })
  expect(result.status).toBe("unknown")
})

test("counter reset crossing with boundary samples returns estimated consumption", () => {
  const result = computeSnapshotDelta({
    kind: "counter",
    earlier: { timestamp: "2026-06-30T23:00:00Z", value: 1000 },
    later: { timestamp: "2026-07-01T01:00:00Z", value: 15 },
    resetBoundaries: ["2026-07-01T00:00:00Z"],
    preBoundary: { timestamp: "2026-06-30T23:58:00Z", value: 1030 },
    postBoundary: { timestamp: "2026-07-01T00:02:00Z", value: 4 },
  })
  expect(result).toEqual({ status: "known", consumption: 41, sourceConfidence: "estimated" })
})

test("gauge-remaining refill without reset boundary returns unknown", () => {
  const result = computeSnapshotDelta({
    kind: "gauge-remaining",
    earlier: { timestamp: "2026-06-25T00:00:00Z", value: 20 },
    later: { timestamp: "2026-06-25T01:00:00Z", value: 100 },
    resetBoundaries: [],
  })
  expect(result.status).toBe("unknown")
})
```

- [ ] **Step 2: Run failing tests**

Run: `rtk bun test tests/shared/metric-key.test.ts tests/stats/delta.test.ts`

Expected: FAIL because utility modules do not exist.

- [ ] **Step 3: Implement metric key and delta utilities**

Create exact signatures:

```ts
export function buildMetricKey(providerAccountId: string, subscriptionId: string, metricId: string): string
export function parseMetricKey(metricKey: string): { providerAccountId: string; subscriptionId: string; metricId: string }
```

```ts
export type DeltaInput = {
  kind: "counter" | "gauge-remaining" | "gauge-used"
  earlier: { timestamp: string; value: number }
  later: { timestamp: string; value: number }
  resetBoundaries: string[]
  preBoundary?: { timestamp: string; value: number }
  postBoundary?: { timestamp: string; value: number }
}

export type DeltaResult =
  | { status: "known"; consumption: number; sourceConfidence: "known" | "estimated" }
  | { status: "unknown"; reason: string }

export function computeSnapshotDelta(input: DeltaInput): DeltaResult
```

- [ ] **Step 4: Implement window labels and validation helpers**

Create `src/shared/window.ts` with these exports:

```ts
import type { LimitWindow } from "./domain"

export function isValidDuration(value: string): boolean {
  return /^\d+(m|h|d)$/.test(value)
}

export function validateWindow(window: LimitWindow, path = "window"): void {
  if (window.kind === "calendar") {
    if (!window.timezone) throw new Error(`${path}.timezone is required`)
    if (Boolean(window.resetAt) === Boolean(window.anchor)) throw new Error(`${path} must set exactly one of resetAt or anchor`)
  }
  if (window.kind === "rolling" && !isValidDuration(window.duration)) throw new Error(`${path}.duration is invalid`)
  if (window.kind === "fixed" && Date.parse(window.startsAt) >= Date.parse(window.resetAt)) throw new Error(`${path}.startsAt must be before resetAt`)
}

export function validateNormalizedWindow(window: LimitWindow, path = "window"): void {
  if (window.kind === "calendar") {
    if (!window.timezone) throw new Error(`${path}.timezone is required`)
    if (!window.resetAt && !window.anchor) throw new Error(`${path} must set resetAt or anchor`)
  }
  if (window.kind === "rolling" && !isValidDuration(window.duration)) throw new Error(`${path}.duration is invalid`)
  if (window.kind === "fixed" && Date.parse(window.startsAt) >= Date.parse(window.resetAt)) throw new Error(`${path}.startsAt must be before resetAt`)
}

export function labelWindow(window: LimitWindow, resetAt?: string): string {
  const reset = resetAt ? `, resets ${new Date(resetAt).toISOString()}` : ""
  if (window.kind === "calendar") return `${window.period[0]!.toUpperCase()}${window.period.slice(1)}ly${reset}`
  if (window.kind === "rolling") return `Rolling ${window.duration}`
  return `Fixed window${reset}`
}

export function computeNextResetAt(window: Extract<LimitWindow, { kind: "calendar" }>, from: Date): string | undefined {
  validateNormalizedWindow(window)
  if (window.resetAt) return Date.parse(window.resetAt) > from.getTime() ? window.resetAt : undefined
  return computeCalendarAnchorReset(window, from)
}
```

Use `@js-temporal/polyfill` for timezone-aware calendar reset math. Add `computeCalendarAnchorReset` in the same file. Add tests for `5h`, `30m`, `7d`, invalid `five-hours`, config validation rejecting `resetAt + anchor`, normalized validation accepting `resetAt + anchor`, ISO `dayOfWeek`, month-end clamp behavior, DST nonexistent time using next valid local time, DST repeated time using first occurrence, and label text including reset text when known.

- [ ] **Step 5: Run tests and typecheck**

Run: `rtk bun test tests/shared tests/stats`

Expected: all tests pass.

Run: `rtk bun run typecheck`

Expected: exits 0.

- [ ] **Step 6: Commit**

Run:

```bash
rtk git add src/shared/window.ts src/shared/metric-key.ts src/server/stats tests/shared tests/stats
rtk git commit -m "feat: add quota window and stats utilities"
```

---

### Task 4: SQLite Storage And Migrations

**Files:**
- Create: `src/server/storage/schema.ts`
- Create: `src/server/storage/database.ts`
- Create: `src/server/storage/repositories.ts`
- Test: `tests/storage/database.test.ts`
- Test: `tests/storage/repositories.test.ts`

**Interfaces:**
- Consumes: metric key and domain types from Tasks 2 and 3.
- Produces: `openDashboardDatabase(path): DashboardDatabase`; `DashboardStorage`; `createRepositories(db)` with provider cache, snapshots, projected history events, import state, refresh run methods, `healthCheck`, and `transaction`.

- [ ] **Step 1: Write failing migration test**

Create `tests/storage/database.test.ts`:

```ts
import { expect, test } from "bun:test"
import { openDashboardDatabase } from "../../src/server/storage/database"

test("migrates in-memory database and enables WAL pragmas", () => {
  const db = openDashboardDatabase(":memory:")
  const tables = db.query<{ name: string }, []>("select name from sqlite_master where type = 'table' order by name").all()
  expect(tables.map((row) => row.name)).toContain("schema_migrations")
  expect(tables.map((row) => row.name)).toContain("provider_cache")
  expect(tables.map((row) => row.name)).toContain("provider_history_events")
  expect(tables.map((row) => row.name)).toContain("provider_import_state")
  db.close()
})
```

- [ ] **Step 2: Run failing test**

Run: `rtk bun test tests/storage/database.test.ts`

Expected: FAIL because storage modules do not exist.

- [ ] **Step 3: Implement schema migration**

Create `src/server/storage/schema.ts` exporting `MIGRATIONS` with SQL for business tables only. `schema_migrations` is bootstrapped by `openDashboardDatabase()` before migrations run.

- `provider_cache(provider_account_id text primary key, fetched_at text not null, stale_after text not null, status text not null, normalized_json text not null, error_json text)`;
- `quota_snapshots(id integer primary key, provider_account_id text not null, subscription_id text not null, metric_id text not null, metric_key text not null, timestamp text not null, source text not null, source_value_kind text not null, authoritative_value real, used real, remaining real, limit_value real)`;
- `provider_history_events(provider_account_id text not null, metric_key text not null, provider_metric_id text not null, normalized_usage_filter text not null, provider_event_id text not null, source_timestamp text not null, value real not null, value_kind text not null, raw_json text, primary key(provider_account_id, metric_key, provider_event_id))`;
- `provider_import_state(provider_account_id text primary key, max_creation_time integer, imported_query_ids_at_max_json text not null default '[]', updated_at text not null)`;
- `refresh_runs(id integer primary key, started_at text not null, finished_at text, status text not null, provider_account_ids_json text not null, error_json text)`.

- [ ] **Step 4: Implement database open helper**

Create `src/server/storage/database.ts` using `bun:sqlite`:

```ts
import { Database } from "bun:sqlite"
import { MIGRATIONS } from "./schema"

export type DashboardDatabase = Database

export function openDashboardDatabase(path: string): DashboardDatabase {
  const db = new Database(path, { create: true })
  db.exec("pragma journal_mode = WAL")
  db.exec("pragma busy_timeout = 5000")
  db.exec("pragma foreign_keys = ON")
  db.exec("create table if not exists schema_migrations(version integer primary key, applied_at text not null)")
  for (const migration of MIGRATIONS) {
    const exists = db.query("select 1 from schema_migrations where version = ?").get(migration.version)
    if (!exists) {
      db.transaction(() => {
        db.exec(migration.sql)
        db.query("insert into schema_migrations(version, applied_at) values (?, ?)").run(migration.version, new Date().toISOString())
      })()
    }
  }
  return db
}
```

- [ ] **Step 5: Add repository tests and implementation**

Create tests proving:

- provider cache upsert and read by account ID;
- history events are idempotent by `(provider_account_id, metric_key, provider_event_id)`;
- history event insertion generates `fallback:${providerAccountId}:${metricKey}:${sourceTimestamp}:${pageCursor}:${rowIndex}` when provider event ID is missing;
- projected history stores `provider_metric_id` and `normalized_usage_filter` and returns them from reads;
- import state persists max creation time and query IDs;
- snapshots persist `metric_key` with source value kind.

Implement `createRepositories(db)` returning `{ providerCache, snapshots, historyEvents, importState, refreshRuns }` with those methods.

Use these exact repository contracts:

```ts
export type ProviderCacheRecord = {
  providerAccountId: string
  fetchedAt: string
  staleAfter: string
  status: "ok" | "stale" | "unavailable"
  normalized: { metrics: Array<Record<string, unknown>> }
  errors: Array<{ message: string; retryable: boolean }>
}

export type SnapshotInsert = {
  providerAccountId: string
  subscriptionId: string
  metricId: string
  metricKey: string
  timestamp: string
  source: "provider" | "manual"
  sourceValueKind: SourceValueKind
  authoritativeValue?: number
  used?: number
  remaining?: number
  limit?: number
}

export type ImportStateRecord = {
  providerAccountId: string
  maxCreationTime?: number
  importedQueryIdsAtMaxCreationTime: string[]
  updatedAt: string
}

export type ProjectedHistoryEvent = {
  providerAccountId: string
  metricKey: string
  providerMetricId: string
  normalizedUsageFilter: string
  providerEventId?: string
  sourceTimestamp: string
  value: number
  valueKind: "used" | "remaining" | "consumption" | "percentUsed"
  pageCursor: string
  rowIndex: number
  raw?: unknown
}

export type DashboardStorage = {
  providerCache: {
    get(providerAccountId: string): ProviderCacheRecord | undefined
    upsert(record: ProviderCacheRecord): void
  }
  snapshots: {
    insertMany(rows: SnapshotInsert[]): void
  }
  historyEvents: {
    insertMany(rows: ProjectedHistoryEvent[]): void
    listForMetric(metricKey: string, rangeStart: string, rangeEnd: string): ProjectedHistoryEvent[]
  }
  importState: {
    get(providerAccountId: string): ImportStateRecord | undefined
    upsert(record: ImportStateRecord): void
  }
  refreshRuns: {
    insertStarted(input: { startedAt: string; providerAccountIds: string[] }): number
    finish(input: { id: number; finishedAt: string; status: "ok" | "error"; errors: Array<{ message: string }> }): void
  }
  healthCheck(): boolean
  transaction<T>(fn: () => T): T
}

export function createRepositories(db: DashboardDatabase): DashboardStorage
```

- [ ] **Step 6: Run verification**

Run: `rtk bun test tests/storage`

Expected: all storage tests pass.

Run: `rtk bun run typecheck`

Expected: exits 0.

- [ ] **Step 7: Commit**

Run:

```bash
rtk git add src/server/storage tests/storage
rtk git commit -m "feat: add sqlite storage layer"
```

---

### Task 5: Provider Interfaces And Manual Provider

**Files:**
- Create: `src/server/providers/types.ts`
- Create: `src/server/providers/manual.ts`
- Test: `tests/providers/manual.test.ts`

**Interfaces:**
- Consumes: domain types and config normalization.
- Produces: `ProviderAdapter`, `NormalizedMetric`, `ProviderHistoryEvent`, `createManualProvider()`.

- [ ] **Step 1: Write failing manual provider tests**

Create `tests/providers/manual.test.ts` asserting:

- manual metric with `used` becomes `sourceValueKind: "gauge-used"` when unspecified;
- rolling manual metric older than `updatedAt + duration` returns unknown confidence;
- fixed metric past `resetAt` keeps fixed window metadata; projection task computes the `expired` status.

- [ ] **Step 2: Run failing tests**

Run: `rtk bun test tests/providers/manual.test.ts`

Expected: FAIL because provider modules do not exist.

- [ ] **Step 3: Add provider contracts**

Create `src/server/providers/types.ts` with exact spec names:

```ts
export type ProviderRefreshInput = {
  providerAccountId: string
  provider: ProviderAccountConfig
  runtime: ProviderRuntimeState
  now: string
  metrics: MetricConfig[]
  importState?: { maxCreationTime?: number; importedQueryIdsAtMaxCreationTime: string[] }
}

export type NormalizedMetric = {
  providerMetricId: string
  label: string
  unit: string
  limit?: number
  used?: number
  remaining?: number
  authoritativeValue?: number
  sourceValueKind: SourceValueKind
  window?: LimitWindow
  suggestedDisplayModule?: DisplayModule
  sourceConfidence: "known" | "estimated" | "unknown"
  notes?: string
  updatedAt?: string
}

export type ProviderHistoryEvent = {
  providerMetricId: string
  providerEventId?: string
  sourceTimestamp: string
  value: number
  valueKind: "used" | "remaining" | "consumption" | "percentUsed"
  usageType?: string
  apiKeyName?: string
  botName?: string
  pageCursor?: string
  rowIndex?: number
  raw?: unknown
}

export type ProviderRefreshResult = {
  providerAccountId: string
  fetchedAt: string
  staleAfter: string
  metrics: NormalizedMetric[]
  historyEvents?: ProviderHistoryEvent[]
  nextImportState?: { maxCreationTime?: number; importedQueryIdsAtMaxCreationTime: string[] }
  errors?: Array<{ message: string; retryable: boolean }>
}

export type ProviderAdapter = {
  type: string
  refresh(input: ProviderRefreshInput): Promise<ProviderRefreshResult>
}
```

- [ ] **Step 4: Implement manual provider**

Create `createManualProvider()` that maps configured manual metrics into normalized metrics and uses spec inference rules.

- [ ] **Step 5: Run verification**

Run: `rtk bun test tests/providers/manual.test.ts`

Expected: all tests pass.

Run: `rtk bun run typecheck`

Expected: exits 0.

- [ ] **Step 6: Commit**

Run:

```bash
rtk git add src/server/providers tests/providers/manual.test.ts
rtk git commit -m "feat: add manual quota provider"
```

---

### Task 6: Poe Provider

**Files:**
- Create: `src/server/providers/poe.ts`
- Test: `tests/providers/poe.test.ts`

**Interfaces:**
- Consumes: provider contracts from Task 5, resolved Poe runtime credentials from Task 2, and import state from Task 4.
- Produces: `createPoeProvider(fetchImpl?: typeof fetch): ProviderAdapter` whose `refresh(input)` reads `input.runtime.apiKey` and `input.importState`.

- [ ] **Step 1: Write failing Poe provider tests**

Create tests with a fake `fetchImpl` proving:

- balance endpoint maps `{ current_point_balance: 1500 }` to `providerMetricId: "points"`, `remaining: 1500`, `sourceValueKind: "gauge-remaining"`;
- points history maps `query_id`, microsecond `creation_time`, and `cost_points` to `ProviderHistoryEvent` with `valueKind: "consumption"`;
- points history preserves raw `usageType`, `apiKeyName`, and `botName` fields without applying usage filters in the provider adapter;
- 401 returns `errors` and no secret-bearing output.
- missing `input.runtime.apiKey` returns unavailable error without calling fetch;
- pagination follows `has_more: true` with `starting_after` set to the last raw response row `query_id`, even when trailing rows are filtered out;
- second refresh with watermark `(maxCreationTime, importedQueryIdsAtMaxCreationTime)` stops once page entries are strictly older or already imported at same timestamp;
- same `creation_time` entries with a new `query_id` at the watermark are imported and included in `nextImportState.importedQueryIdsAtMaxCreationTime`;
- duplicate entries at the watermark are not returned again, so repository idempotent upsert sees no duplicate event work.

- [ ] **Step 2: Run failing tests**

Run: `rtk bun test tests/providers/poe.test.ts`

Expected: FAIL because `poe.ts` does not exist.

- [ ] **Step 3: Implement Poe provider**

Implement:

- `GET https://api.poe.com/usage/current_balance`;
- `GET https://api.poe.com/usage/points_history?limit=100` with pagination through `starting_after` using the last raw response row `query_id` as cursor;
- `creation_time` conversion from microseconds to ISO timestamp;
- `query_id` as `providerEventId`;
- Authorization header from `input.runtime.apiKey`;
- incremental pagination using `input.importState.maxCreationTime` and `input.importState.importedQueryIdsAtMaxCreationTime`;
- `nextImportState` computed from the highest imported `creation_time` plus all imported `query_id` values at that timestamp;
- raw event fields `usageType`, `apiKeyName`, and `botName` so refresh projection can apply default and configured filters per metric;
- `errors: [{ message: "Poe authentication failed", retryable: false }]` for 401.

- [ ] **Step 4: Run verification**

Run: `rtk bun test tests/providers/poe.test.ts`

Expected: all tests pass.

Run: `rtk bun run typecheck`

Expected: exits 0.

- [ ] **Step 5: Commit**

Run:

```bash
rtk git add src/server/providers/poe.ts tests/providers/poe.test.ts
rtk git commit -m "feat: add poe usage provider"
```

---

### Task 7: Dashboard Projection, Stats, And Summary

**Files:**
- Create: `src/server/dashboard/project.ts`
- Create: `src/server/stats/summary.ts`
- Test: `tests/dashboard/project.test.ts`
- Test: `tests/stats/summary.test.ts`

**Interfaces:**
- Consumes: config, providers, storage rows, stats utilities.
- Produces: `buildDashboardPayload(input): DashboardPayload`; `projectProviderMetrics(input): ProjectedMetric[]`; `buildSummaryGroups(metrics): SummaryGroup[]`.

- [ ] **Step 1: Write failing projection tests**

Create tests proving:

- only profile `subscriptionIds` appear in payload;
- provider metric `points` projects into configured metric `poe-api/points`;
- undeclared provider metrics are not rendered in the dashboard payload;
- duplicated account-scoped balance is deduped in summary;
- filtered consumption uses normalized filter in summary identity.
- raw Poe history projection applies default `usage_type == "API"`, so Chat rows are excluded unless a metric config overrides `usageFilter.usageTypes`;
- Poe balance with `current_point_balance > configuredLimit` displays `used: 0`, omits `percentUsed`, and keeps status `ok`;
- provider runtime `resetAt` does not replace configured recurring `anchor`, `timezone`, or `duration` unless it represents the same configured policy.
- rolling metrics include `windowStartAt` only when provider history covers the rolling duration;
- display title defaults to metric label and subtitle defaults to window label/reset text;
- `SummaryGroup` includes optional `providerType` plus stable `id` and `normalizedUsageFilter`.

- [ ] **Step 2: Run failing tests**

Run: `rtk bun test tests/dashboard tests/stats/summary.test.ts`

Expected: FAIL because dashboard projection does not exist.

- [ ] **Step 3: Implement dashboard payload types**

Create `src/shared/dashboard-payload.ts` matching the spec `DashboardPayload`, including metric-level `status`, `summaryGroups.id`, `providerType`, `normalizedUsageFilter`, range stats, display `title`/`subtitle`, `window.windowStartAt`, and `burnRate: { value, per: "hour" }`.

- [ ] **Step 4: Implement projection and summary**

Implement status precedence, stale handling, percentUsed rules, summary grouping, range stat source precedence, Poe over-limit balance behavior, config-vs-provider window precedence, `display.title`/`subtitle` generation, and rolling `windowStartAt` derivation from provider history.

- [ ] **Step 5: Run verification**

Run: `rtk bun test tests/dashboard tests/stats`

Expected: all tests pass.

Run: `rtk bun run typecheck`

Expected: exits 0.

- [ ] **Step 6: Commit**

Run:

```bash
rtk git add src/server/dashboard src/server/stats/summary.ts src/shared/dashboard-payload.ts tests/dashboard tests/stats
rtk git commit -m "feat: compose dashboard payload"
```

---

### Task 8: Auth, Sessions, Rate Limits, And Security Headers

**Files:**
- Create: `src/server/auth/session.ts`
- Create: `src/server/auth/rate-limit.ts`
- Create: `src/server/http/security.ts`
- Test: `tests/auth/session.test.ts`
- Test: `tests/auth/rate-limit.test.ts`

**Interfaces:**
- Consumes: normalized config profiles.
- Produces: `verifyViewKey(profile, candidate): boolean`; `createSessionCookie(profileId, viewKey, secret, now, maxAgeSeconds): string`; `verifySessionCookie(cookie, profile, secret, now): boolean`; `createRateLimiter(options)`.

- [ ] **Step 1: Write failing auth tests**

Create tests proving:

- viewKey comparison accepts exact key and rejects wrong key;
- session cookie verifies with same `SESSION_SECRET` and fails after viewKey rotation;
- session cookie name is `sqd_session_self` for profile `self`, so another profile can keep its own cookie;
- session cookie name for profile `team/main` is `sqd_session_team%2Fmain`, using `encodeURIComponent(profileId)`;
- session cookie payload profile ID must match the route profile ID;
- session cookie fails after `Max-Age=86400` expiry using injected `now`;
- malformed session cookie fails closed without throwing;
- session cookie includes `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Max-Age=86400`; includes `Secure` when `secure: true` is passed;
- generated dev secret warning path is not used when `SESSION_SECRET` is present;
- missing `SESSION_SECRET` with `NODE_ENV=production` throws at startup;
- rate limiter blocks the eleventh failed auth attempt in five minutes.

- [ ] **Step 2: Run failing tests**

Run: `rtk bun test tests/auth`

Expected: FAIL because auth modules do not exist.

- [ ] **Step 3: Implement auth and rate limit modules**

Use HMAC SHA-256 through Web Crypto or Bun-compatible `crypto` APIs. Cookie payload includes profile ID, view-key hash, issued-at, and expiry. Rate limiter is in-memory and keyed by `ip:profileId` or `providerAccountId` depending on caller.

- [ ] **Step 4: Implement security helpers**

Create helpers that set:

- API `Cache-Control: no-store`;
- app `Referrer-Policy: no-referrer`;
- CORS only for `http://localhost:5173` and `http://127.0.0.1:5173` in development, with methods `GET` and `POST`, allowed headers `Content-Type` and `Authorization`, and credentials enabled.

Add access-log redaction helper tests proving `Authorization`, `Cookie`, `Set-Cookie`, and JSON fields named `viewKey`, `apiKey`, or `password` are replaced with `[redacted]` before logging.

- [ ] **Step 5: Run verification**

Run: `rtk bun test tests/auth`

Expected: all tests pass.

Run: `rtk bun run typecheck`

Expected: exits 0.

- [ ] **Step 6: Commit**

Run:

```bash
rtk git add src/server/auth src/server/http/security.ts tests/auth
rtk git commit -m "feat: add dashboard access controls"
```

---

### Task 9: Hono API And Refresh Flow

**Files:**
- Modify: `src/server/http/app.ts`
- Modify: `src/server/main.ts`
- Create: `src/server/refresh/refresh-service.ts`
- Test: `tests/http/app.test.ts`
- Test: `tests/refresh/refresh-service.test.ts`

**Interfaces:**
- Consumes: config loader, storage, providers, dashboard projection, auth.
- Produces: API routes `GET /health`, `POST /api/session/:profileId`, `GET /api/dashboard/:profileId`, `POST /api/dashboard/:profileId/refresh`; `createApp(deps?: AppDeps)`.

Use this dependency shape:

```ts
export type AppDeps = {
  config: NormalizedConfig
  storage: DashboardStorage
  providers: Map<"manual" | "poe", ProviderAdapter>
  sessionSecret: string
  now?: () => Date
  staticDir?: string
  environment?: "development" | "production" | "test"
}
```

- [ ] **Step 1: Write failing HTTP tests**

Create tests proving:

- `GET /api/dashboard/self` with a query parameter named `viewKey` returns `401` because URL secrets are rejected;
- `POST /api/session/self` with JSON body sets `HttpOnly` cookie;
- `POST /api/session/self` rejects missing or non-JSON `Content-Type` when body auth is used;
- `POST /api/session/self` rejects a disallowed `Origin` header;
- `POST /api/session/self` accepts `Authorization: Bearer <viewKey>` without a request body;
- `GET /api/dashboard/self` with cookie returns profile payload;
- `GET /api/dashboard/self` accepts `Authorization: Bearer <viewKey>` without query secrets;
- `GET /api/dashboard/self?range=bad` returns `400` with a safe error body;
- `GET /api/dashboard/self` reads `provider_cache`, manual metrics, snapshots/history, and never calls provider adapters;
- `POST /api/dashboard/self/refresh` validates Origin and uses refresh service;
- `POST /api/dashboard/self/refresh` joins an existing singleflight refresh for the same provider account without consuming a rate-limit token; starting a new refresh enforces the concrete refresh rate-limit key `ip:profileId:providerAccountId` and returns `429` on the second new refresh inside 30 seconds;
- `POST /api/dashboard/self/refresh` returns stale cache with a safe provider error when provider refresh fails after cache exists;
- all API responses include `Cache-Control: no-store`.
- `/health` returns `503` when injected storage health check fails.
- `/d/self` and `/d/self?range=24h` return the Vite HTML shell in production static mode;
- `/d/self/extra/deep` returns the Vite HTML shell for client-side route handling, while `/api/health`, `/api/*`, `/health`, and `/assets/*` do not fall through to the SPA shell;
- E2E flow with fake Poe fetch: `POST /api/dashboard/self/refresh` writes cache/history/snapshots, then `GET /api/dashboard/self` returns API points, range stats, summary group, and no secrets.

- [ ] **Step 2: Run failing tests**

Run: `rtk bun test tests/http tests/refresh`

Expected: FAIL because API routes are not implemented.

- [ ] **Step 3: Implement refresh service**

Implement per-provider-account singleflight with global concurrency `2`. Refresh flow:

1. collect provider accounts used by visible subscriptions;
2. read existing cache before provider calls so stale fallback is available;
3. for each used provider account, collect all configured subscriptions/metrics for that provider account across the full config before calling adapters, so the provider-account watermark cannot skip history for hidden profiles;
4. call provider adapters with resolved runtime credentials and provider-account import state;
5. project metrics and raw provider history to configured metric keys after applying default and configured usage filters;
6. call `storage.transaction(() => ...)` to upsert cache, snapshots, projected history events, import state, and refresh run;
7. return fresh dashboard payload, or stale payload with safe error when refresh fails and cache exists.

Add refresh-service tests proving two concurrent refreshes for the same `providerAccountId` share one provider call, a joined singleflight request does not consume a rate-limit token, three concurrent provider accounts with cap `2` do not start the third provider call until one of the first two settles, undeclared provider metrics are filtered before snapshot writes, provider-account refresh includes metrics from hidden profiles before advancing `nextImportState`, raw Poe history is projected per configured usage filter into metric-specific `ProjectedHistoryEvent` rows, and `nextImportState` is persisted through `importState.upsert` inside `storage.transaction`.

- [ ] **Step 4: Implement Hono routes**

Wire config, storage, providers, session, rate limits, and dashboard projection into `createApp(deps?: AppDeps)`. Keep dependency injection in tests so external Poe network is never called. Update `/health` to call `deps.storage.healthCheck()` and return `503` on failure. Add production static serving for `dist/client/assets/*` and an SPA fallback only for `/d/:profileId` plus deeper `/d/:profileId/*` paths; `/api/*`, `/health`, and `/assets/*` must never fall through to the SPA shell. Range stays in the query string as `?range=24h`; no API or SPA route uses path segments for range selection in MVP. API routes must keep `Cache-Control: no-store`, static hashed assets must not use `no-store`.

- [ ] **Step 5: Run verification**

Run: `rtk bun test tests/http tests/refresh`

Expected: all tests pass.

Run: `rtk bun run typecheck`

Expected: exits 0.

- [ ] **Step 6: Commit**

Run:

```bash
rtk git add src/server/http src/server/main.ts src/server/refresh tests/http tests/refresh
rtk git commit -m "feat: add dashboard api routes"
```

---

### Task 10: React Dashboard UI

**Files:**
- Modify: `src/client/App.tsx`
- Create: `src/client/api.ts`
- Create: `src/client/format.ts`
- Create: `src/client/components/Dashboard.tsx`
- Create: `src/client/components/SummaryRow.tsx`
- Create: `src/client/components/SubscriptionCard.tsx`
- Create: `src/client/components/MetricCard.tsx`
- Create: `src/client/components/RangeSwitch.tsx`
- Create: `src/client/components/AuthGate.tsx`
- Create: `src/client/components/LoadingState.tsx`
- Create: `src/client/components/EmptyState.tsx`
- Create: `src/client/components/NetworkError.tsx`
- Create: `src/client/components/TimeDisplay.tsx`
- Create: `src/client/components/Sparkline.tsx`
- Modify: `src/client/styles.css`
- Test: `tests/client/dashboard.test.tsx`
- Test: `tests/client/format.test.ts`

**Interfaces:**
- Consumes: `DashboardPayload` type and API routes from Task 9.
- Produces: React Router app for `/d/:profileId?range=...`, auth gate state machine, typed API client with abort support, dark dense dashboard with viewKey entry, refresh button states, cards, CSS bars, inline SVG sparklines, stale/error/loading/empty states, accessible controls, and responsive layout.

- [ ] **Step 1: Write failing UI render test**

Create `tests/client/dashboard.test.tsx` using `happy-dom` and `@testing-library/react`. Test that a sample payload renders:

- profile name;
- `API points` metric;
- `Rolling 5h` label;
- critical status class for over-limit metric;
- range buttons `1h`, `24h`, `7d`, `30d`.
- stale badge and error banner when payload contains stale errors;
- unknown confidence text for a rolling metric with unknown stats;
- expired status text for a fixed metric past reset;
- metric without `limit` renders no progress bar;
- viewKey unauthenticated flow renders a labeled password input, disables submit while submitting, clears/focuses input after `401`, shows inline `Invalid view key.`, and shows `Too many attempts. Try again later.` after `429`;
- API `401` after an authenticated dashboard load transitions to expired auth state, preserves `?range=7d`, and shows `Session expired. Enter your view key again.`;
- direct visit with a valid HttpOnly cookie starts in `checking-session`, calls `getDashboard`, and renders dashboard without showing the view-key form and without a second fetch;
- direct visit with no valid cookie starts in `checking-session`, receives `401`, then shows unauthenticated view-key form;
- `/d/self?range=7d` parses `profileId=self` and `range=7d`; unknown client routes render 404; no client route uses path segments for range selection;
- `/d/self?range=bad` renders a client 404 and does not call `getDashboard`;
- initial dashboard fetch renders a full-page skeleton;
- empty profile renders `No subscriptions configured for this profile.`;
- network or API `500` renders a full-page retry error;
- all subscriptions unavailable renders a dashboard-level unavailable banner and greyed cards;
- refresh button transitions `idle -> refreshing -> rate-limited` and displays `Retry in Ns` from `Retry-After` or 30 seconds;
- refresh success displays `Updated` for 2 seconds before returning to idle; refresh network/API failure displays `Refresh failed` and keeps a retryable button state;
- partial refresh success with stale provider error returns button to idle and displays a warning header icon plus subscription stale banner;
- range switch updates query string to `?range=...`, calls `getDashboard`, keeps dashboard shell visible, and shows metric range-stat skeletons;
- stale aborted range response does not overwrite newer range state;
- progress bars expose `role="progressbar"` and `aria-valuenow`; error banners expose `role="alert"`;
- summary groups render compact cards with label, remaining or `-`, consumption, burn rate, exhaustion or `-`, and `≈` only when `estimatedExhaustionConfidence === "conservative"`;
- `TimeDisplay` renders `<time>` with browser-local visible text and ISO `title`; past exhaustion renders `overdue`;
- `Sparkline` renders one SVG `<polyline>` when series has at least two points and hides otherwise.

- [ ] **Step 2: Run failing UI test**

Run: `rtk bun test tests/client/dashboard.test.tsx`

Expected: FAIL because UI components do not exist.

- [ ] **Step 3: Implement browser API client**

Create `src/client/api.ts` with these exact exports so UI can distinguish auth and refresh failures:

```ts
export type ApiErrorCode = "unauthorized" | "rate-limited" | "not-found" | "network" | "server"
export type ApiResult<T> = { ok: true; value: T } | { ok: false; code: ApiErrorCode; status?: number; message: string; retryAfterSeconds?: number }

export async function createSession(profileId: string, viewKey: string, signal?: AbortSignal): Promise<ApiResult<{ profile: { id: string; name: string } }>>
export async function getDashboard(profileId: string, range: RangeKey, signal?: AbortSignal): Promise<ApiResult<DashboardPayload>>
export async function refreshDashboard(profileId: string, range: RangeKey, signal?: AbortSignal): Promise<ApiResult<DashboardPayload>>
```

Use JSON body for session and `credentials: "include"` for cookie-authenticated requests. Parse `Retry-After` into `retryAfterSeconds`; map `401`, `404`, `429`, `5xx`, network errors, and aborts into `ApiResult` without throwing into React render paths. Range changes and refresh actions must pass `AbortSignal` and ignore aborted results.

Create `src/client/format.ts` with:

```ts
export function formatNumber(value: number): string
export function formatBurnRate(value: number): string
export function formatPercentUsed(percent: number, overflow: boolean): string
export function formatRelativeTime(iso: string, now: Date): string
```

Formatting rules: below `1000` show rounded raw value; below `1_000_000` use locale thousands separators; at or above `1_000_000` use compact one-decimal notation; burn rate uses two decimals plus `/h`; percent uses `Math.round`, and overflow displays `>100%`.

- [ ] **Step 4: Implement UI components**

Use semantic markup, React Router, CSS bars, and the following component behavior:

- `App`: route table `/d/:profileId`, query-string `range`, `*` 404, sets `document.title` to `${profile.name} · Quota Dashboard` and prefixes `! ` when dashboard-level unavailable state exists.
- `AuthGate`: state machine `checking-session -> unauthenticated -> submitting -> authenticated -> expired`; `checking-session` calls `getDashboard` with existing cookies, and on `200` passes the payload to `Dashboard` so it skips its own initial fetch; unauthenticated form uses `<input type="password">`, visible `<label>`, disabled submit while submitting, server-driven error copy, and no client-side failed-attempt counter.
- `Dashboard`: owns fetch state for range changes and manual/visibility refresh; accepts an optional initial payload from `AuthGate` to avoid a duplicate initial fetch; visibility-change refetch after tab returns from at least 5 minutes hidden; no auto-polling loop.
- `LoadingState`: full-page skeleton with header and card silhouettes.
- `EmptyState`: `No subscriptions configured for this profile.`.
- `NetworkError`: full-page error with retry button.
- `SummaryRow`: one compact card per `summaryGroup`; includes label, large remaining value or `-`, selected-range consumption, burn rate, exhaustion or `-`, and `≈` only when `estimatedExhaustionConfidence === "conservative"`.
- `RangeSwitch`: buttons with `aria-pressed`; updates `?range=` and shows range-stat skeletons instead of blanking cards.
- `TimeDisplay`: `<time dateTime={iso} title={iso}>` with browser-local relative label; past exhaustion displays `overdue`.
- `Sparkline`: pure SVG `<polyline>`, `width="100%"`, height `24`, status-colored stroke, transparent fill, hidden when fewer than two series points.
- `SubscriptionCard`: `unavailable` greys the card, shows centered safe error, and hides metric details unless cached metric data exists; stale errors show warning banner, non-stale errors show critical banner.
- `MetricCard`: `rangeStats.source === "unknown"` displays `insufficient data`; status badge uses icon plus text, never color alone.

Metric card module behavior:

- `balance-card`: remaining, burn rate, reset label;
- `rolling-window-card`: duration, current usage, unknown state when source confidence unknown;
- `period-quota-card`: used/limit/remaining progress;
- `manual-status-card`: notes and updatedAt.

A11y requirements: progress bars use `role="progressbar"`, `aria-valuemin="0"`, `aria-valuemax="100"`, and `aria-valuenow` when known; error banners use `role="alert"`; range buttons use `aria-pressed`; refresh button has accessible loading text; DOM order is header, auth/range controls, summary, subscriptions, metrics.

- [ ] **Step 5: Implement responsive styles**

Create dark theme variables, compact grid, status colors, CSS progress bars with capped width, reduced-motion, high-contrast, print styles, and responsive layout.

Use these CSS tokens:

```css
:root {
  --bg-app: #0d1117;
  --bg-card: #161b22;
  --bg-elevated: #1f2937;
  --text-primary: #e6edf3;
  --text-secondary: #8b949e;
  --text-muted: #6e7681;
  --border-subtle: #30363d;
  --status-ok: #3fb950;
  --status-warn: #d29922;
  --status-critical: #f85149;
  --status-stale: #8b949e;
  --status-unavailable: #6e7681;
  --status-expired: #bc8cff;
  --accent: #58a6ff;
}
```

Responsive breakpoints: `>=1200px` subscription grid 3 columns and summary grid 4 columns; `768px..1199px` subscription grid 2 columns and summary grid 2 columns; `<768px` subscription grid 1 column and summary 1 column with optional horizontal scroll. `ui.color` is an accent border; status color controls status icon/badge. Add `@media (prefers-reduced-motion: reduce)` disabling spinner/sparkline transitions, `@media (prefers-contrast: more)` stronger borders/text, and `@media print` light background, dark text, hidden auth/refresh controls.

- [ ] **Step 6: Run verification**

Run: `rtk bun test tests/client/dashboard.test.tsx`

Expected: all UI tests pass.

Run: `rtk bun run build`

Expected: Vite build and Bun server bundle complete.

- [ ] **Step 7: Commit**

Run:

```bash
rtk git add src/client tests/client
rtk git commit -m "feat: add dashboard interface"
```

---

### Task 11: README, Environment Example, And Full Verification

**Files:**
- Modify: `README.md`
- Create: `.env.example`
- Test: no new test file; run full suite.

**Interfaces:**
- Consumes: completed app from Tasks 1-10.
- Produces: user-facing setup instructions and final verification evidence.

- [ ] **Step 1: Update README**

Document:

- `rtk bun install`;
- `.env` values `POE_API_KEY`, `SELF_DASHBOARD_VIEW_KEY`, `SESSION_SECRET`;
- `rtk bun run dev` and `rtk bun run build`;
- no `viewKey` in URLs;
- config file location and direct `apiKey` personal-local warning;
- SQLite path `data/dashboard.db`;
- security notes for public exposure;
- frontend route shape `/d/:profileId?range=24h`;
- no frontend auto-polling; manual refresh plus visibility-change refetch only;
- profile-scoped session cookie names;
- favicon is not included in MVP.

- [ ] **Step 2: Add `.env.example`**

Create:

```bash
POE_API_KEY=replace-with-poe-api-key
SELF_DASHBOARD_VIEW_KEY=replace-with-random-128-bit-view-key
SESSION_SECRET=replace-with-random-256-bit-secret
PORT=3000
```

- [ ] **Step 3: Run full verification**

Run: `rtk bun test`

Expected: all tests pass.

Run: `rtk bun run typecheck`

Expected: exits 0.

Run: `rtk bun run build`

Expected: build exits 0.

Run: `rtk git status --short`

Expected: only intended files are modified or untracked.

- [ ] **Step 4: Commit**

Run:

```bash
rtk git add README.md .env.example
rtk git commit -m "docs: document dashboard setup"
```

---

## Self-Review Checklist

- Spec coverage: Tasks cover scaffold, config validation, windows, metric keys, stats, SQLite, providers, auth, API, UI, docs, and verification.
- Type consistency: `providerMetricId`, `metricKey`, `sourceValueKind`, `summaryGroups`, `status`, and `rangeStats` names match the design spec.
- Security coverage: URL `viewKey` rejection, signed cookies, `SESSION_SECRET`, `no-store`, referrer policy, Origin checks, CORS, log redaction, and rate limits are assigned to concrete tasks.
- Provider correctness: Poe balance/history endpoints, usage filters, query ID pagination, watermark state, and account-wide balance behavior are assigned to provider and storage tasks.
- Data correctness: reset-aware deltas, filter-aware summary aggregation, dedupe rules, status precedence, percentUsed bounds, and downsampling are assigned to utilities/projection tasks.
