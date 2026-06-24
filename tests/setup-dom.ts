import { afterEach } from "bun:test"
import { cleanup } from "@testing-library/react"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

// Preserve Bun's native Web APIs (Request/Response/Headers/fetch) — happy-dom's
// GlobalRegistrator would otherwise replace them and break Hono's request/body
// parsing in the server-side test files that share this preload.
const nativeWebApi = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  URL: globalThis.URL,
  FormData: globalThis.FormData,
  Blob: globalThis.Blob,
}

GlobalRegistrator.register()
Object.assign(globalThis, nativeWebApi)

afterEach(() => cleanup())
