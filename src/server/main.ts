import { serve } from "@hono/node-server"
import { mkdirSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { createApp } from "./http/app"
import type { AppDeps } from "./http/app"
import { loadDashboardConfigFromFile } from "./config/load-config"
import { openDashboardDatabase } from "./storage/database"
import { createRepositories } from "./storage/repositories"
import { createManualProvider } from "./providers/manual"
import { createPoeProvider } from "./providers/poe"
import { createDeepseekProvider } from "./providers/deepseek"
import { createStepfunProvider } from "./providers/stepfun"
import { createSiliconflowProvider } from "./providers/siliconflow"
import { createOpenrouterProvider } from "./providers/openrouter"
import { createNovitaProvider } from "./providers/novita"
import { createKimiProvider } from "./providers/kimi"
import { createZhipuProvider } from "./providers/zhipu"
import { createMiniMaxProvider } from "./providers/minimax"
import { createZenmuxProvider } from "./providers/zenmux"
import { createVolcengineProvider } from "./providers/volcengine"
import { createCliproxyProvider } from "./providers/cliproxy"
import type { ProviderAdapter } from "./providers/types"
import { resolveSessionSecret } from "./auth/session"
import { parseTrustedProxies } from "./http/client-ip"

const port = Number(process.env.PORT ?? 3000)
// Default to loopback only. Set HOST=0.0.0.0 (or a specific interface) to
// listen on other interfaces — e.g. behind a reverse proxy on another host.
const hostname = process.env.HOST ?? "127.0.0.1"
const configPath = process.env.CONFIG_PATH ?? "config/dashboard.config.ts"
const dbPath = process.env.DASHBOARD_DB ?? "data/dashboard.db"
const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development"
const trustedProxies = parseTrustedProxies(process.env.TRUSTED_PROXIES)
// The public-facing origin for same-origin Origin checks. Set this when
// behind an HTTPS-terminating reverse proxy, e.g. https://dashboard.example.com.
// Canonicalized via new URL().origin so trailing slashes/path/query/hash are stripped.
const publicOrigin = (() => {
  const raw = process.env.PUBLIC_ORIGIN
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    // Reject credentials in the origin
    if (parsed.username || parsed.password) {
      console.error(`PUBLIC_ORIGIN must not contain credentials: ${raw}`)
      process.exit(1)
    }
    return parsed.origin
  } catch {
    console.error(`PUBLIC_ORIGIN is not a valid URL: ${raw}`)
    process.exit(1)
  }
})()

async function main(): Promise<void> {
  const config = await loadDashboardConfigFromFile(resolve(configPath))

  mkdirSync(dirname(resolve(dbPath)), { recursive: true })
  const db = openDashboardDatabase(resolve(dbPath))
  const storage = createRepositories(db)

  const providers = new Map<string, ProviderAdapter>([
    ["manual", createManualProvider()],
    ["poe", createPoeProvider()],
    ["deepseek", createDeepseekProvider()],
    ["stepfun", createStepfunProvider()],
    ["siliconflow", createSiliconflowProvider()],
    ["openrouter", createOpenrouterProvider()],
    ["novita", createNovitaProvider()],
    ["kimi", createKimiProvider()],
    ["zhipu", createZhipuProvider()],
    ["minimax", createMiniMaxProvider()],
    ["zenmux", createZenmuxProvider()],
    ["volcengine", createVolcengineProvider()],
    ["cliproxy", createCliproxyProvider()],
  ])

  const { secret: sessionSecret } = resolveSessionSecret(process.env as Record<string, string | undefined>)

  // Serve the built SPA whenever the compiled client is present. This is
  // decoupled from NODE_ENV because the Bun bundler bakes process.env.NODE_ENV
  // into the artifact at build time, so a runtime NODE_ENV check is unreliable
  // in the built server. In dev there is no build output, so the API server
  // serves no SPA and the Vite dev server (client:dev, :5173) serves the UI.
  const staticDir = existsSync(resolve("dist/client/index.html")) ? resolve("dist/client") : undefined

  const deps: AppDeps = {
    config,
    storage,
    providers,
    sessionSecret,
    environment: nodeEnv,
    trustedProxies,
    ...(publicOrigin !== undefined ? { publicOrigin } : {}),
    ...(staticDir !== undefined ? { staticDir } : {}),
  }

  const app = createApp(deps)
  serve({ fetch: app.fetch, port, hostname })
  console.log(`subscription-quota-dashboard listening on http://${hostname}:${port}`)
}

main().catch((err) => {
  console.error("Failed to start:", err)
  process.exit(1)
})
