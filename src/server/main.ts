import { serve } from "@hono/node-server"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { createApp } from "./http/app"
import type { AppDeps } from "./http/app"
import { loadDashboardConfigFromFile } from "./config/load-config"
import { openDashboardDatabase } from "./storage/database"
import { createRepositories } from "./storage/repositories"
import { createManualProvider } from "./providers/manual"
import { createPoeProvider } from "./providers/poe"
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

  const providers = new Map<"manual" | "poe", ReturnType<typeof createManualProvider>>([
    ["manual", createManualProvider()],
    ["poe", createPoeProvider()],
  ])

  const { secret: sessionSecret } = resolveSessionSecret(process.env as Record<string, string | undefined>)

  const staticDir = nodeEnv === "production" ? resolve("dist/client") : undefined

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
