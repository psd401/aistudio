/**
 * agnt_ provisioning sheet writer (#1233).
 *
 * Tests the dedupe gate (the idempotency guarantee) and the Sheets REST calls
 * (read column A / append) via injectable seams — no live Google.
 */

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  sanitizeForLogging: (x: unknown) => x,
}))
// The module imports loadBrokerConfig + getImpersonatedAccessToken; stub them so
// the gateway can be constructed without WIF (we inject getAccessToken anyway).
jest.mock("@/lib/agent-workspace/dwd-token-broker", () => ({ loadBrokerConfig: jest.fn() }))
jest.mock("@/lib/agent-workspace/gcp-wif", () => ({ getImpersonatedAccessToken: jest.fn() }))
// getProvisioningSheetId prefers AGENT_PROVISIONING_SHEET_ID (set below) and only
// falls back to this secret; stub it to null so it never reaches AWS.
jest.mock("@/lib/agent-workspace/gcp-dwd-config", () => ({
  loadGcpDwdConfigSecret: jest.fn(async () => null),
}))

import {
  usernameAlreadyPresent,
  ensureAgentUsernameRow,
  createSheetsGateway,
  type SheetsGateway,
} from "@/lib/agent-workspace/agent-provisioning-sheet"

describe("usernameAlreadyPresent (dedupe gate)", () => {
  it("matches case-insensitively and trimmed, ignores blanks/header", () => {
    const col = ["username", "hagelk", "  Pratzm  ", ""]
    expect(usernameAlreadyPresent(col, "pratzm")).toBe(true)
    expect(usernameAlreadyPresent(col, "HAGELK")).toBe(true)
    expect(usernameAlreadyPresent(col, "newuser")).toBe(false)
    expect(usernameAlreadyPresent(col, "")).toBe(false)
  })
})

describe("ensureAgentUsernameRow", () => {
  function gateway(existing: string[]) {
    const appended: string[] = []
    const g: SheetsGateway = {
      readColumnA: async () => existing,
      appendUsername: async (u) => { appended.push(u) },
    }
    return { g, appended }
  }

  it("does NOT append when the username already exists (idempotent)", async () => {
    const { g, appended } = gateway(["username", "pratzm"])
    const res = await ensureAgentUsernameRow("pratzm", g)
    expect(res).toEqual({ written: false })
    expect(appended).toHaveLength(0)
  })

  it("appends exactly once when the username is new", async () => {
    const { g, appended } = gateway(["username", "hagelk"])
    const res = await ensureAgentUsernameRow("pratzm", g)
    expect(res).toEqual({ written: true })
    expect(appended).toEqual(["pratzm"])
  })
})

describe("createSheetsGateway (Sheets REST)", () => {
  const OLD = process.env.AGENT_PROVISIONING_SHEET_ID
  beforeAll(() => { process.env.AGENT_PROVISIONING_SHEET_ID = "sheet-123" })
  afterAll(() => { process.env.AGENT_PROVISIONING_SHEET_ID = OLD })

  it("readColumnA flattens rows and drops empties", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ values: [["username"], ["hagelk"], [""], ["pratzm"]] }),
    })) as unknown as typeof fetch
    const gw = createSheetsGateway({ fetchImpl, getAccessToken: async () => "sa-token" })
    expect(await gw.readColumnA()).toEqual(["username", "hagelk", "pratzm"])
    const call = (fetchImpl as jest.Mock).mock.calls[0]
    expect(call[0]).toContain("/values/")
    expect(call[1].headers.Authorization).toBe("Bearer sa-token")
  })

  it("appendUsername POSTs values.append with INSERT_ROWS and the username", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch
    const gw = createSheetsGateway({ fetchImpl, getAccessToken: async () => "sa-token" })
    await gw.appendUsername("pratzm")
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0]
    expect(url).toContain(":append")
    expect(url).toContain("insertDataOption=INSERT_ROWS")
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body).values).toEqual([["pratzm"]])
  })

  it("readColumnA throws on a non-OK response", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 403, text: async () => "denied" })) as unknown as typeof fetch
    const gw = createSheetsGateway({ fetchImpl, getAccessToken: async () => "sa-token" })
    await expect(gw.readColumnA()).rejects.toThrow(/HTTP 403/)
  })
})
