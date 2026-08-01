import { expect, test } from "bun:test"
import type {
  MetricConfig,
  ProviderAccountConfig,
  ProviderRuntimeState,
} from "../../src/shared/domain"
import { createPoeProvider } from "../../src/server/providers/poe"
import type { ProviderRefreshInput } from "../../src/server/providers/types"

const provider: ProviderAccountConfig = { id: "poe-1", type: "poe", apiKey: "secret-key-xxx" }
const pointsMetric: MetricConfig = {
  id: "poe-points",
  providerMetricId: "points",
  label: "Points",
  unit: "pt",
  display: { module: "balance-card" },
}
const NOW = "2026-06-25T00:00:00Z"

function buildInput(overrides: Partial<ProviderRefreshInput> = {}): ProviderRefreshInput {
  return {
    providerAccountId: provider.id,
    provider,
    runtime: { available: true, apiKey: "secret-key-xxx" },
    now: NOW,
    metrics: [pointsMetric],
    ...overrides,
  }
}

type PoeRow = {
  query_id: string
  creation_time: number
  cost_points: number
  usage_type?: string
  api_key_name?: string
  bot_name?: string
}

function row(
  query_id: string,
  creation_time_us: number,
  cost: number,
  extra: Partial<Pick<PoeRow, "usage_type" | "api_key_name" | "bot_name">> = {},
): PoeRow {
  return {
    query_id,
    creation_time: creation_time_us,
    cost_points: cost,
    usage_type: extra.usage_type ?? "API",
    api_key_name: extra.api_key_name ?? "default-key",
    bot_name: extra.bot_name ?? "GPT-4o-Mini",
  }
}

type FetchCall = { url: string; headers: Headers }

function makeResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function makeFakeFetch(opts: {
  balance?: { status?: number; body?: unknown }
  history?: { status?: number; body?: unknown; pages?: Array<{ data: PoeRow[]; has_more: boolean }> }
}): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  let historyPageIndex = 0
  const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, headers: new Headers(init?.headers) })
    if (url.includes("/usage/current_balance")) {
      const status = opts.balance?.status ?? 200
      const body = opts.balance?.body ?? { current_point_balance: 1500 }
      return makeResp(status, body)
    }
    if (url.includes("/usage/points_history")) {
      const status = opts.history?.status ?? 200
      if (status !== 200) return makeResp(status, opts.history?.body ?? { error: "upstream" })
      const pages = opts.history?.pages ?? [{ data: [], has_more: false }]
      const body = pages[Math.min(historyPageIndex, pages.length - 1)]!
      historyPageIndex++
      return makeResp(status, body)
    }
    return makeResp(404, {})
  }
  // Bun's `typeof fetch` carries a `preconnect` static; cast the plain fake.
  return { fn: raw as unknown as typeof fetch, calls }
}

function historyCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.url.includes("points_history"))
}

test("provider type is poe", () => {
  expect(createPoeProvider().type).toBe("poe")
})

test("balance maps current_point_balance to points gauge-remaining with configured label/unit", async () => {
  const fake = makeFakeFetch({
    balance: { body: { current_point_balance: 1500 } },
    history: { pages: [{ data: [], has_more: false }] },
  })
  const res = await createPoeProvider(fake.fn).refresh(buildInput())
  expect(res.metrics).toHaveLength(1)
  const m = res.metrics[0]!
  expect(m.providerMetricId).toBe("points")
  expect(m.remaining).toBe(1500)
  expect(m.sourceValueKind).toBe("gauge-remaining")
  expect(m.label).toBe("Points")
  expect(m.unit).toBe("pt")
  expect(m.sourceConfidence).toBe("known")
})

test("sends Authorization Bearer header and limit=100 on requests", async () => {
  const fake = makeFakeFetch({ history: { pages: [{ data: [], has_more: false }] } })
  await createPoeProvider(fake.fn).refresh(buildInput())
  expect(fake.calls[0]!.headers.get("Authorization")).toBe("Bearer secret-key-xxx")
  expect(historyCalls(fake.calls)[0]!.url).toContain("limit=100")
})

test("history maps query_id, microsecond creation_time -> ISO, cost_points with consumption valueKind", async () => {
  const ct_us = 1719273600000000 // 2024-06-25T00:00:00.000Z in microseconds
  const fake = makeFakeFetch({
    history: { pages: [{ data: [row("q1", ct_us, 30)], has_more: false }] },
  })
  const res = await createPoeProvider(fake.fn).refresh(buildInput())
  expect(res.historyEvents).toHaveLength(1)
  const ev = res.historyEvents![0]!
  expect(ev.providerMetricId).toBe("points")
  expect(ev.providerEventId).toBe("q1")
  expect(ev.sourceTimestamp).toBe("2024-06-25T00:00:00.000Z")
  expect(ev.value).toBe(30)
  expect(ev.valueKind).toBe("consumption")
})

test("history preserves raw usageType, apiKeyName, botName without filtering by usage_type", async () => {
  const fake = makeFakeFetch({
    history: {
      pages: [
        {
          data: [
            row("q1", 1719273600000000, 10, { usage_type: "API", api_key_name: "key-A", bot_name: "Bot1" }),
            row("q2", 1719273601000000, 20, { usage_type: "SUBSCRIPTION", api_key_name: "key-B", bot_name: "Bot2" }),
          ],
          has_more: false,
        },
      ],
    },
  })
  const res = await createPoeProvider(fake.fn).refresh(buildInput())
  // Provider MUST NOT filter to usage_type "API" only.
  expect(res.historyEvents).toHaveLength(2)
  expect(res.historyEvents![0]!.usageType).toBe("API")
  expect(res.historyEvents![0]!.apiKeyName).toBe("key-A")
  expect(res.historyEvents![0]!.botName).toBe("Bot1")
  expect(res.historyEvents![1]!.usageType).toBe("SUBSCRIPTION")
  expect(res.historyEvents![1]!.apiKeyName).toBe("key-B")
  expect(res.historyEvents![1]!.botName).toBe("Bot2")
  expect(res.historyEvents![0]!.raw).toBeDefined()
})

test("pagination uses last raw row query_id as starting_after cursor across pages", async () => {
  const fake = makeFakeFetch({
    history: {
      pages: [
        { data: [row("a", 3000000, 1), row("b", 2000000, 2), row("c", 1500000, 3)], has_more: true },
        { data: [row("d", 1000000, 4)], has_more: false },
      ],
    },
  })
  const res = await createPoeProvider(fake.fn).refresh(buildInput())
  const hc = historyCalls(fake.calls)
  expect(hc).toHaveLength(2)
  expect(hc[1]!.url).toContain("starting_after=c")
  expect(res.historyEvents!.map((e) => e.providerEventId)).toEqual(["a", "b", "c", "d"])
})

test("first refresh computes nextImportState from highest creation_time and all query_ids at it", async () => {
  const fake = makeFakeFetch({
    history: {
      pages: [
        { data: [row("a", 3000000, 1), row("b", 3000000, 2), row("c", 1000000, 3)], has_more: false },
      ],
    },
  })
  const res = await createPoeProvider(fake.fn).refresh(buildInput())
  expect(res.nextImportState).toEqual({
    maxCreationTime: 3000000,
    importedQueryIdsAtMaxCreationTime: ["a", "b"],
  })
})

test("401 returns Poe authentication failed error, no metrics/history, no secret echo", async () => {
  const fake = makeFakeFetch({ balance: { status: 401, body: { error: "nope" } }, history: { status: 401 } })
  const res = await createPoeProvider(fake.fn).refresh(buildInput())
  expect(res.errors).toEqual([{ message: "Poe authentication failed", retryable: false }])
  expect(res.metrics).toEqual([])
  expect(res.historyEvents).toEqual([])
  const blob = JSON.stringify(res)
  expect(blob).not.toContain("secret-key-xxx")
  expect(blob).not.toContain("Bearer")
})

test("missing apiKey returns unavailable error without calling fetch", async () => {
  let called = false
  const inner = makeFakeFetch({})
  const fn = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    called = true
    return inner.fn(...args)
  }) as unknown as typeof fetch
  const runtime: ProviderRuntimeState = { available: false, reason: "API key not configured" }
  const res = await createPoeProvider(fn).refresh(buildInput({ runtime }))
  expect(called).toBe(false)
  expect(res.errors).toHaveLength(1)
  expect(res.errors![0]!.retryable).toBe(false)
  expect(res.metrics).toEqual([])
  expect(JSON.stringify(res)).not.toContain("secret-key-xxx")
})

test("second refresh with watermark dedups watermark ids, stops at strictly-older rows, and advances watermark", async () => {
  // watermark: maxCreationTime=3000000, imported=[q3]
  // page1 (has_more true): q5(5M new), q4(4M new), q3(3M dup), q2(2M strictly older -> stop)
  // page2 must NOT be fetched.
  const fake = makeFakeFetch({
    history: {
      pages: [
        {
          data: [row("q5", 5000000, 5), row("q4", 4000000, 4), row("q3", 3000000, 3), row("q2", 2000000, 2)],
          has_more: true,
        },
        { data: [row("q1", 1000000, 1)], has_more: false },
      ],
    },
  })
  const input = buildInput({
    importState: { maxCreationTime: 3000000, importedQueryIdsAtMaxCreationTime: ["q3"] },
  })
  const res = await createPoeProvider(fake.fn).refresh(input)
  expect(res.historyEvents!.map((e) => e.providerEventId)).toEqual(["q5", "q4"])
  expect(historyCalls(fake.calls)).toHaveLength(1)
  expect(res.nextImportState).toEqual({
    maxCreationTime: 5000000,
    importedQueryIdsAtMaxCreationTime: ["q5"],
  })
})

test("new query_id at watermark timestamp is imported and merged into importedQueryIdsAtMaxCreationTime", async () => {
  // watermark: maxCreationTime=3000000, imported=[q3]
  // page1 (has_more false): q4(3M new at watermark), q3(3M dup)
  const fake = makeFakeFetch({
    history: {
      pages: [{ data: [row("q4", 3000000, 4), row("q3", 3000000, 3)], has_more: false }],
    },
  })
  const input = buildInput({
    importState: { maxCreationTime: 3000000, importedQueryIdsAtMaxCreationTime: ["q3"] },
  })
  const res = await createPoeProvider(fake.fn).refresh(input)
  expect(res.historyEvents!.map((e) => e.providerEventId)).toEqual(["q4"])
  expect(res.nextImportState).toEqual({
    maxCreationTime: 3000000,
    importedQueryIdsAtMaxCreationTime: ["q3", "q4"],
  })
})

test("duplicate entries at watermark are not returned and nextImportState is preserved", async () => {
  // watermark: maxCreationTime=3000000, imported=[q3,q4]
  // page1 (has_more true): q3(3M dup), q4(3M dup), q2(2M older -> stop). page2 not fetched.
  const fake = makeFakeFetch({
    history: {
      pages: [
        { data: [row("q3", 3000000, 3), row("q4", 3000000, 4), row("q2", 2000000, 2)], has_more: true },
        { data: [row("q1", 1000000, 1)], has_more: false },
      ],
    },
  })
  const input = buildInput({
    importState: { maxCreationTime: 3000000, importedQueryIdsAtMaxCreationTime: ["q3", "q4"] },
  })
  const res = await createPoeProvider(fake.fn).refresh(input)
  expect(res.historyEvents).toEqual([])
  expect(historyCalls(fake.calls)).toHaveLength(1)
  expect(res.nextImportState).toEqual({
    maxCreationTime: 3000000,
    importedQueryIdsAtMaxCreationTime: ["q3", "q4"],
  })
})

test("5xx response is retryable and free of secrets", async () => {
  const fake = makeFakeFetch({ balance: { status: 503, body: {} }, history: { status: 503 } })
  const res = await createPoeProvider(fake.fn).refresh(buildInput())
  expect(res.errors).toHaveLength(1)
  expect(res.errors![0]!.retryable).toBe(true)
  expect(JSON.stringify(res)).not.toContain("secret-key-xxx")
})

test("network error is retryable and free of secrets", async () => {
  let attempts = 0
  const fn = (async (): Promise<Response> => {
    attempts++
    throw new Error("connect ECONNREFUSED 127.0.0.1:443")
  }) as unknown as typeof fetch
  const res = await createPoeProvider(fn).refresh(buildInput())
  expect(res.errors).toHaveLength(1)
  expect(res.errors![0]!.retryable).toBe(true)
  expect(res.errors![0]!.message).toContain("after 3 attempts")
  expect(attempts).toBe(3)
  expect(JSON.stringify(res)).not.toContain("secret-key-xxx")
})

test("transient balance network error is retried and succeeds", async () => {
  let balanceAttempts = 0
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("current_balance")) {
      balanceAttempts++
      if (balanceAttempts === 1) throw new TypeError("connection reset")
      return makeResp(200, { current_point_balance: 987654 })
    }
    return makeResp(200, { data: [], has_more: false })
  }
  const res = await createPoeProvider(raw as unknown as typeof fetch).refresh(buildInput())
  expect(balanceAttempts).toBe(2)
  expect(res.errors).toBeUndefined()
  expect(res.metrics[0]!.remaining).toBe(987654)
})

test("transient history 503 is retried without discarding balance", async () => {
  let historyAttempts = 0
  const raw = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("current_balance")) return makeResp(200, { current_point_balance: 500000 })
    historyAttempts++
    if (historyAttempts === 1) return makeResp(503, { error: "temporary" })
    return makeResp(200, { data: [], has_more: false })
  }
  const res = await createPoeProvider(raw as unknown as typeof fetch).refresh(buildInput())
  expect(historyAttempts).toBe(2)
  expect(res.errors).toBeUndefined()
  expect(res.metrics[0]!.remaining).toBe(500000)
})
