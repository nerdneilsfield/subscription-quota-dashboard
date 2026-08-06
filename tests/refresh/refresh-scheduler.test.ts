import { expect, test } from "bun:test"
import { loadDashboardConfig } from "../../src/server/config/load-config"
import {
  createRefreshScheduler,
  resolveProviderRefreshSchedules,
} from "../../src/server/refresh/refresh-scheduler"
import type { DashboardConfigInput } from "../../src/shared/domain"

function config(overrides: Partial<DashboardConfigInput> = {}) {
  return loadDashboardConfig({
    refresh: { intervalSeconds: 300 },
    providers: [
      { id: "shared", type: "manual" },
      { id: "disabled", type: "manual" },
      { id: "dynamic", type: "cliproxy", baseUrl: "http://127.0.0.1:8317" },
    ],
    subscriptions: [
      { id: "fast", name: "Fast", providerId: "shared", refresh: { intervalSeconds: 60 }, metrics: [] },
      { id: "global", name: "Global", providerId: "shared", metrics: [] },
      { id: "off", name: "Off", providerId: "disabled", refresh: { intervalSeconds: 0 }, metrics: [] },
    ],
    profiles: [{
      id: "self",
      name: "Self",
      viewKey: "secret",
      subscriptionIds: ["fast", "global", "off"],
      dynamicProviderIds: ["dynamic"],
    }],
    ...overrides,
  })
}

test("subscription interval overrides global and shared providers use the shortest enabled interval", () => {
  expect(resolveProviderRefreshSchedules(config())).toEqual([
    {
      upstreamKey: "cliproxy:http://127.0.0.1:8317",
      providerType: "cliproxy",
      upstreamUrl: "http://127.0.0.1:8317",
      providerAccountIds: ["dynamic"],
      intervalSeconds: 300,
      subscriptionIds: [],
    },
    {
      upstreamKey: "manual:default",
      providerType: "manual",
      upstreamUrl: "default",
      providerAccountIds: ["shared"],
      intervalSeconds: 60,
      subscriptionIds: ["fast", "global"],
    },
  ])
})

test("subscription zero disables its provider even when global refresh is enabled", () => {
  const schedules = resolveProviderRefreshSchedules(config())
  expect(schedules.some((schedule) => schedule.providerAccountIds.includes("disabled"))).toBe(false)
})

test("same provider type and normalized upstream URL share the shortest interval", () => {
  const normalized = loadDashboardConfig({
    refresh: { intervalSeconds: 300 },
    providers: [
      { id: "proxy-a", type: "cliproxy", baseUrl: "http://127.0.0.1:8317" },
      { id: "proxy-b", type: "cliproxy", baseUrl: "http://127.0.0.1:8317/" },
      { id: "proxy-c", type: "cliproxy", baseUrl: "http://127.0.0.1:8318" },
    ],
    subscriptions: [
      { id: "a", name: "A", providerId: "proxy-a", metrics: [] },
      { id: "b", name: "B", providerId: "proxy-b", refresh: { intervalSeconds: 60 }, metrics: [] },
      { id: "c", name: "C", providerId: "proxy-c", refresh: { intervalSeconds: 120 }, metrics: [] },
    ],
    profiles: [{ id: "self", name: "Self", viewKey: "secret", subscriptionIds: ["a", "b", "c"] }],
  })

  expect(resolveProviderRefreshSchedules(normalized)).toEqual([
    {
      upstreamKey: "cliproxy:http://127.0.0.1:8317",
      providerType: "cliproxy",
      upstreamUrl: "http://127.0.0.1:8317",
      providerAccountIds: ["proxy-a", "proxy-b"],
      intervalSeconds: 60,
      subscriptionIds: ["a", "b"],
    },
    {
      upstreamKey: "cliproxy:http://127.0.0.1:8318",
      providerType: "cliproxy",
      upstreamUrl: "http://127.0.0.1:8318",
      providerAccountIds: ["proxy-c"],
      intervalSeconds: 120,
      subscriptionIds: ["c"],
    },
  ])
})

test("scheduler refreshes immediately, rearms after completion, and stops timers", async () => {
  const refreshes: Array<{ ids: string[]; trigger?: string }> = []
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = []
  const scheduler = createRefreshScheduler({
    config: config({
      refresh: { intervalSeconds: 0 },
      subscriptions: [
        { id: "fast", name: "Fast", providerId: "shared", refresh: { intervalSeconds: 60 }, metrics: [] },
      ],
      profiles: [{ id: "self", name: "Self", viewKey: "secret", subscriptionIds: ["fast"] }],
    }),
    refreshService: {
      async refreshProviderAccounts(ids, trigger) {
        refreshes.push({ ids, ...(trigger === undefined ? {} : { trigger }) })
      },
    },
    setTimeoutFn(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutFn(handle) {
      ;(handle as { cleared: boolean }).cleared = true
    },
  })

  scheduler.start()
  await Bun.sleep(0)
  expect(refreshes).toEqual([{ ids: ["shared"], trigger: "scheduler" }])
  expect(timers[0]?.delayMs).toBe(60_000)

  scheduler.stop()
  expect(timers[0]?.cleared).toBe(true)
})
