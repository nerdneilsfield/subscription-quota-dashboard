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
import type { ProviderAdapter } from "./providers/types"
import { resolveSessionSecret } from "./auth/session"

const port = Number(process.env.PORT ?? 3000)
const configPath = process.env.CONFIG_PATH ?? "config/dashboard.config.ts"
const dbPath = process.env.DASHBOARD_DB ?? "data/dashboard.db"
const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development"

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
    ...(staticDir !== undefined ? { staticDir } : {}),
  }

  const app = createApp(deps)
  serve({ fetch: app.fetch, port })
  console.log(`subscription-quota-dashboard listening on http://127.0.0.1:${port}`)
}

main().catch((err) => {
  console.error("Failed to start:", err)
  process.exit(1)
})
