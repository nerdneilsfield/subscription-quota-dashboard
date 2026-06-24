import { expect, test } from "bun:test"
import { createApp } from "../src/server/http/app"

test("health endpoint reports alive", async () => {
  const res = await createApp().request("/health")
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
})
