import { expect, test } from "bun:test"
import { signVolcengineRequest } from "../../src/server/providers/volcengine-sig"

const FIXED_NOW = new Date("2026-07-17T12:00:00Z")
const AK = "AKTEST123"
const SK = "SKtest456"
const REGION = "cn-beijing"

test("produces correct URL with canonical query (alphabetical)", () => {
  const result = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  expect(result.url).toBe("https://open.volcengineapi.com/?Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01")
})

test("sets required headers", () => {
  const result = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  expect(result.headers.get("X-Date")).toBe("20260717T120000Z")
  expect(result.headers.get("X-Content-Sha256")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  expect(result.headers.get("Content-Type")).toBe("application/json; charset=utf-8")
  expect(result.headers.get("Authorization")).toBeTruthy()
})

test("Authorization uses HMAC-SHA256 algorithm (not AWS4)", () => {
  const result = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  const auth = result.headers.get("Authorization")!
  expect(auth.startsWith("HMAC-SHA256 Credential=")).toBe(true)
  expect(auth).not.toContain("AWS4")
  expect(auth).toContain("SignedHeaders=host;x-date;x-content-sha256;content-type")
  expect(auth).toContain(`/cn-beijing/ark/request`)
})

test("credential scope uses short date", () => {
  const result = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  const auth = result.headers.get("Authorization")!
  expect(auth).toContain("20260717/cn-beijing/ark/request")
})

test("signature is deterministic for same input", () => {
  const r1 = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  const r2 = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  expect(r1.headers.get("Authorization")).toBe(r2.headers.get("Authorization"))
})

test("different actions produce different signatures", () => {
  const r1 = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetAFPUsage", now: FIXED_NOW })
  const r2 = signVolcengineRequest({ ak: AK, sk: SK, region: REGION, action: "GetCodingPlanUsage", now: FIXED_NOW })
  expect(r1.headers.get("Authorization")).not.toBe(r2.headers.get("Authorization"))
})

test("canonical query is alphabetically sorted", () => {
  const result = signVolcengineRequest({ ak: AK, sk: SK, region: "us-east-1", action: "GetAFPUsage", now: FIXED_NOW })
  // Action < Region < Version alphabetically
  expect(result.url).toContain("Action=GetAFPUsage&Region=us-east-1&Version=2024-01-01")
})

test("default region is cn-beijing", () => {
  const result = signVolcengineRequest({ ak: AK, sk: SK, region: "cn-beijing", action: "GetAFPUsage", now: FIXED_NOW })
  expect(result.url).toContain("Region=cn-beijing")
})
