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
import { createOpenCodeGoProvider } from "./providers/opencode-go"
import { createMiMoTokenPlanProvider } from "./providers/mimo-token-plan"
import type { ProviderAdapter } from "./providers/types"
import { resolveSessionSecret } from "./auth/session"
import { parseTrustedProxies } from "./http/client-ip"
import { createLogger, parseLogFormat, parseLogLevel } from "./logging/logger"
import { createLoggedFetch } from "./logging/fetch"
import { createRateLimiter } from "./auth/rate-limit"
import { createRefreshService } from "./refresh/refresh-service"
import { createRefreshScheduler } from "./refresh/refresh-scheduler"

const port = Number(process.env.PORT ?? 3000)
// Default to loopback only. Set HOST=0.0.0.0 (or a specific interface) to
// listen on other interfaces — e.g. behind a reverse proxy on another host.
const hostname = process.env.HOST ?? "127.0.0.1"
const configPath = process.env.CONFIG_PATH ?? "config/dashboard.config.ts"
const dbPath = process.env.DASHBOARD_DB ?? "data/dashboard.db"
const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development"
const logger = createLogger({
  level: parseLogLevel(process.env.LOG_LEVEL, nodeEnv === "production" ? "info" : "debug"),
  format: parseLogFormat(process.env.LOG_FORMAT, nodeEnv === "production" ? "json" : "pretty"),
  base: { environment: nodeEnv },
})
const trustedProxies = parseTrustedProxies(process.env.TRUSTED_PROXIES)
// The public-facing origin for same-origin Origin checks. Set this when
// behind an HTTPS-terminating reverse proxy, e.g. https://dashboard.example.com.
// Canonicalized via new URL().origin so trailing slashes/path/query/hash are stripped.
// Only http: and https: schemes are accepted; opaque origins (file:, etc.) are rejected.
const publicOrigin = (() => {
  const raw = process.env.PUBLIC_ORIGIN
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    // Reject non-HTTP schemes and opaque origins
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      logger.error("config.public_origin.invalid", { protocol: parsed.protocol, reason: "unsupported_protocol" })
      process.exit(1)
    }
    const origin = parsed.origin
    if (origin === "null") {
      logger.error("config.public_origin.invalid", { publicOrigin: raw, reason: "opaque_origin" })
      process.exit(1)
    }
    // Reject credentials in the origin
    if (parsed.username || parsed.password) {
      logger.error("config.public_origin.invalid", { reason: "contains_credentials" })
      process.exit(1)
    }
    return origin
  } catch {
    logger.error("config.public_origin.invalid", { publicOrigin: raw, reason: "invalid_url" })
    process.exit(1)
  }
})()

async function main(): Promise<void> {
  logger.info("server.starting", { hostname, port, configPath, dbPath })
  const config = await loadDashboardConfigFromFile(resolve(configPath))
  logger.info("config.loaded", {
    providerAccountCount: config.providers.size,
    subscriptionCount: config.subscriptions.size,
    profileCount: config.profiles.size,
    providerAccounts: [...config.providers.values()].map((provider) => ({
      id: provider.id,
      type: provider.type,
      runtimeAvailable: config.providerRuntime.get(provider.id)?.available ?? false,
    })),
  })

  mkdirSync(dirname(resolve(dbPath)), { recursive: true })
  const db = openDashboardDatabase(resolve(dbPath))
  const storage = createRepositories(db)
  logger.info("storage.opened", { dbPath: resolve(dbPath), healthy: storage.healthCheck() })

  const loggedFetch = createLoggedFetch(logger.child({ component: "upstream" }))
  const providers = new Map<string, ProviderAdapter>([
    ["manual", createManualProvider()],
    ["poe", createPoeProvider(loggedFetch)],
    ["deepseek", createDeepseekProvider(loggedFetch)],
    ["stepfun", createStepfunProvider(loggedFetch)],
    ["siliconflow", createSiliconflowProvider(loggedFetch)],
    ["openrouter", createOpenrouterProvider(loggedFetch)],
    ["novita", createNovitaProvider(loggedFetch)],
    ["kimi", createKimiProvider(loggedFetch)],
    ["zhipu", createZhipuProvider(loggedFetch)],
    ["minimax", createMiniMaxProvider(loggedFetch)],
    ["zenmux", createZenmuxProvider(loggedFetch)],
    ["volcengine", createVolcengineProvider(loggedFetch)],
    ["mimo-token-plan", createMiMoTokenPlanProvider(loggedFetch)],
    ["opencode-go", createOpenCodeGoProvider(loggedFetch)],
    ["cliproxy", createCliproxyProvider(loggedFetch)],
  ])

  const { secret: sessionSecret, generated: generatedSessionSecret } = resolveSessionSecret(
    process.env as Record<string, string | undefined>,
    (message) => logger.warn("auth.session_secret.generated", {}, message),
  )
  logger.debug("auth.session_secret.resolved", { generated: generatedSessionSecret })

  // Serve the built SPA whenever the compiled client is present. This is
  // decoupled from NODE_ENV because the Bun bundler bakes process.env.NODE_ENV
  // into the artifact at build time, so a runtime NODE_ENV check is unreliable
  // in the built server. In dev there is no build output, so the API server
  // serves no SPA and the Vite dev server (client:dev, :5173) serves the UI.
  const staticDir = existsSync(resolve("dist/client/index.html")) ? resolve("dist/client") : undefined
  const now = (): Date => new Date()
  const refreshService = createRefreshService({
    config,
    storage,
    providers,
    now,
    logger,
    rateLimiter: createRateLimiter({
      maxAttempts: 1,
      windowMs: 30_000,
      now: () => now().getTime(),
    }),
  })

  const deps: AppDeps = {
    config,
    storage,
    providers,
    sessionSecret,
    environment: nodeEnv,
    trustedProxies,
    logger,
    refreshService,
    ...(publicOrigin !== undefined ? { publicOrigin } : {}),
    ...(staticDir !== undefined ? { staticDir } : {}),
  }

  const app = createApp(deps)
  serve({ fetch: app.fetch, port, hostname })
  logger.info("server.started", {
    url: `http://${hostname}:${port}`,
    staticClientEnabled: staticDir !== undefined,
    logLevel: logger.level,
  })

  const refreshScheduler = createRefreshScheduler({ config, refreshService, logger })
  refreshScheduler.start()
}

main().catch((err) => {
  logger.error("server.start_failed", { error: err })
  process.exit(1)
})
