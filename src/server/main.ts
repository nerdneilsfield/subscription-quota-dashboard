import { serve } from "@hono/node-server"
import { createApp } from "./http/app"

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: createApp().fetch, port })
console.log(`subscription-quota-dashboard listening on http://127.0.0.1:${port}`)
