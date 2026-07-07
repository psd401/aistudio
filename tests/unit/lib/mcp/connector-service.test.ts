/**
 * Unit tests for lib/mcp/connector-service.ts
 *
 * Covers:
 * - REV-COR-620: getAvailableConnectors isolates a single malformed server row
 *   (unknown transport/authType) instead of failing the whole listing.
 * - REV-COR-623: rejectUnsafeMcpUrl rejects non-standard IPv4 encodings
 *   (decimal/octal/hex) of private addresses in production while allowing
 *   legitimate DNS hostnames and canonical public IPs.
 */

// ─── Mocks for the module's external dependencies ────────────────────────────
// A singleton logger inside the factory (retrieved via createLogger() below) avoids
// the TDZ that an outer `const` mock hits — hoisted ES imports evaluate the SUT's
// top-level createLogger() before an outer const would initialize.
jest.mock("@/lib/logger", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  return {
    createLogger: () => logger,
    generateRequestId: () => "req-test",
    startTimer: () => () => {},
  }
})

jest.mock("drizzle-orm", () => ({
  sql: (...args: unknown[]) => ({ _sql: args }),
  eq: (...args: unknown[]) => ({ _eq: args }),
  and: (...args: unknown[]) => ({ _and: args }),
  or: (...args: unknown[]) => ({ _or: args }),
}))

jest.mock("@/lib/db/schema", () => ({
  nexusMcpServers: { id: "id", allowedUsers: "allowed_users" },
  nexusMcpUserTokens: {},
  nexusMcpAuditLogs: {},
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
  executeTransaction: jest.fn(),
}))

// ESM-only / heavyweight deps imported at module top but unused by these tests.
jest.mock("@ai-sdk/mcp", () => ({ createMCPClient: jest.fn() }))
jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn(),
  GetSecretValueCommand: jest.fn(),
}))
jest.mock("@/lib/crypto/token-encryption", () => ({
  encryptToken: jest.fn(),
  decryptToken: jest.fn(),
}))
jest.mock("@/lib/mcp/custom-tools/registry", () => ({ loadCustomTools: jest.fn() }))
jest.mock("@/lib/mcp/mcp-oauth-provider", () => ({ ServerSideOAuthProvider: jest.fn() }))
jest.mock("@/lib/oauth/issuer-config", () => ({ getIssuerUrl: jest.fn() }))

import {
  getAvailableConnectors,
  rejectUnsafeMcpUrl,
} from "@/lib/mcp/connector-service"
import { executeQuery } from "@/lib/db/drizzle-client"
import { createLogger } from "@/lib/logger"

const executeQueryMock = executeQuery as jest.Mock
// Same singleton the SUT's module-level logger uses, so its warn calls are observable.
const loggerWarn = (createLogger({}) as unknown as { warn: jest.Mock }).warn

/** Minimal server row shaped like nexusMcpServers.$inferSelect for toMcpConnector. */
function serverRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "s-default",
    name: "Server",
    url: "https://mcp.example.com",
    transport: "http",
    authType: "oauth",
    allowedUsers: [],
    ...overrides,
  }
}

describe("getAvailableConnectors — per-row isolation (REV-COR-620)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("skips a row with an unknown transport and returns the valid connectors", async () => {
    executeQueryMock.mockResolvedValueOnce([
      serverRow({ id: "good", name: "Good", transport: "http" }),
      serverRow({ id: "bad", name: "Bad", transport: "grpc" }),
    ])

    const result = await getAvailableConnectors(1, ["administrator"])

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("good")
    expect(loggerWarn).toHaveBeenCalledWith(
      "Skipping malformed MCP server row",
      expect.objectContaining({ serverId: "bad" })
    )
  })

  it("skips a row with an unknown authType (guard still enforced)", async () => {
    executeQueryMock.mockResolvedValueOnce([
      serverRow({ id: "good", authType: "oauth" }),
      serverRow({ id: "bad", authType: "saml" }),
    ])

    const result = await getAvailableConnectors(1, ["administrator"])

    expect(result.map((c) => c.id)).toEqual(["good"])
    expect(loggerWarn).toHaveBeenCalledWith(
      "Skipping malformed MCP server row",
      expect.objectContaining({ serverId: "bad" })
    )
  })

  it("does not reject and returns [] when every row is malformed", async () => {
    executeQueryMock.mockResolvedValueOnce([
      serverRow({ id: "b1", transport: "grpc" }),
      serverRow({ id: "b2", authType: "saml" }),
    ])

    await expect(getAvailableConnectors(1, ["administrator"])).resolves.toEqual([])
    expect(loggerWarn).toHaveBeenCalledTimes(2)
  })

  it("returns all connectors when every row is valid", async () => {
    executeQueryMock.mockResolvedValueOnce([
      serverRow({ id: "a", authType: "oauth" }),
      serverRow({ id: "b", authType: "none" }),
      serverRow({ id: "c", authType: "cognito_passthrough" }),
    ])

    const result = await getAvailableConnectors(1, ["administrator"])

    expect(result.map((c) => c.id)).toEqual(["a", "b", "c"])
    expect(loggerWarn).not.toHaveBeenCalled()
  })
})

describe("rejectUnsafeMcpUrl — encoded-IP SSRF (REV-COR-623)", () => {
  const originalEnv = process.env.ENVIRONMENT

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ENVIRONMENT
    else process.env.ENVIRONMENT = originalEnv
  })

  describe("in production", () => {
    beforeEach(() => {
      process.env.ENVIRONMENT = "prod"
    })

    // These encoded forms all denote loopback/link-local. `new URL()` canonicalizes
    // them to dotted-quad, which the private-range patterns then reject in prod.
    it.each([
      ["decimal 127.0.0.1", "https://2130706433/"],
      ["hex 127.0.0.1", "https://0x7f000001/"],
      ["octal 127.0.0.1", "https://0177.0.0.1/"],
      ["decimal 169.254.169.254 (IMDS)", "https://2852039166/"],
      ["octal 192.168.0.1", "https://0300.0250.0.1/"],
    ])("rejects %s", (_label, url) => {
      expect(() => rejectUnsafeMcpUrl(url)).toThrow()
    })

    it("rejects canonical private addresses too", () => {
      expect(() => rejectUnsafeMcpUrl("https://127.0.0.1/")).toThrow(
        /private\/internal/
      )
      expect(() => rejectUnsafeMcpUrl("https://169.254.169.254/")).toThrow(
        /private\/internal/
      )
    })

    it("allows a legitimate DNS-hostname MCP URL", () => {
      expect(() => rejectUnsafeMcpUrl("https://mcp.example.com/")).not.toThrow()
    })

    it("allows a canonical public IPv4 literal", () => {
      // 93.184.216.34 (example.com) — canonical, public → not a numeric encoding.
      expect(() => rejectUnsafeMcpUrl("https://93.184.216.34/")).not.toThrow()
    })
  })

  it("rejects an invalid URL string", () => {
    expect(() => rejectUnsafeMcpUrl("not a url")).toThrow(/Invalid MCP server URL/)
  })
})
