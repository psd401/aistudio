/**
 * @jest-environment node
 */

/**
 * One-time credential entry (issue #1887).
 *
 * Agents used to ask staff to paste API keys into chat; ~15 people did, and
 * the values are still in `agent_message_content.content_text` unredacted.
 * This module is the replacement, so these tests pin the three things that
 * make the link safe to hand out: it belongs to exactly one person, it works
 * exactly once, and a failed write never leaves a reusable secret-entry form.
 *
 * `consent-token` is mocked here because it imports pure-ESM `jose`, which
 * next/jest cannot transform. The real sign/verify path — including the
 * 15-minute expiry — is covered by
 * tests/smoke/agent-credential-entry-token.smoke.ts.
 */

type FakePayload = {
  sub: string
  agent: string
  purpose: "workspace-consent"
  nonce: string
  kind?: string
  cred?: string
}

let verifyResult: FakePayload | null = null
const verifyConsentTokenMock = jest.fn(async (_token: string) => verifyResult)
jest.mock("@/lib/agent-workspace/consent-token", () => ({
  verifyConsentToken: (token: string) => verifyConsentTokenMock(token),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  sanitizeForLogging: (value: unknown) => value,
}))

/** Rows the next `claimCredentialEntryNonce` update should return. */
let claimRows: Array<{ nonce: string }> = [{ nonce: "n1" }]
/** Row the next `readCredentialEntryNonce` select should return. */
let nonceRow: Array<{ consumedAt: Date | null }> = [{ consumedAt: null }]
const executeQueryMock = jest.fn(
  async (_query: unknown, operation: string): Promise<unknown[]> => {
    if (operation === "claimCredentialEntryNonce") return claimRows
    if (operation === "readCredentialEntryNonce") return nonceRow
    throw new Error(`unexpected operation ${operation}`)
  }
)
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (query: unknown, operation: string) =>
    executeQueryMock(query, operation),
}))

/** Whether the deployment can store credentials at all (ENVIRONMENT set). */
let storageConfigured = true
jest.mock("@/lib/agent-credentials/broker", () => ({
  AgentCredentialBroker: class {
    async put() {
      throw new Error("the default broker must never be reached in tests")
    }
  },
  AgentCredentialInputError: class extends Error {},
  isCredentialStorageConfigured: () => storageConfigured,
}))

import {
  inspectCredentialEntry,
  submitCredentialEntry,
} from "@/lib/agent-workspace/credential-entry"

const OWNER = "owner@psd401.net"
const SECRET_VALUE = "fs-key-abcdef123456"

function payload(overrides: Partial<FakePayload> = {}): FakePayload {
  return {
    sub: OWNER,
    agent: "agnt_owner@psd401.net",
    purpose: "workspace-consent",
    nonce: "n1",
    kind: "credential_entry",
    cred: "freshservice_api_key",
    ...overrides,
  }
}

function brokerStub() {
  const put = jest.fn(async () => ({
    name: "freshservice_api_key",
    action: "created" as const,
  }))
  return { put }
}

beforeEach(() => {
  storageConfigured = true
  verifyResult = payload()
  claimRows = [{ nonce: "n1" }]
  nonceRow = [{ consumedAt: null }]
  executeQueryMock.mockClear()
  verifyConsentTokenMock.mockClear()
})

describe("inspectCredentialEntry", () => {
  it("shows the form to the owner when the link is unspent", async () => {
    expect(await inspectCredentialEntry("t", OWNER)).toEqual({
      status: "ready",
      ownerEmail: OWNER,
      credentialName: "freshservice_api_key",
    })
  })

  it("is case-insensitive about the signed-in address", async () => {
    // Mixed-case addresses have locked users out of agent surfaces before
    // (PR #1683); the comparison must fold case on both sides.
    const outcome = await inspectCredentialEntry("t", "Owner@PSD401.net")
    expect(outcome.status).toBe("ready")
  })

  it("asks an anonymous visitor to sign in without touching the nonce", async () => {
    expect(await inspectCredentialEntry("t", null)).toEqual({
      status: "needs-signin",
      ownerEmail: OWNER,
    })
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it("refuses a different signed-in user without touching the nonce", async () => {
    expect(await inspectCredentialEntry("t", "someone.else@psd401.net")).toEqual({
      status: "wrong-user",
      expected: OWNER,
    })
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it("reports a spent link as already-used", async () => {
    nonceRow = [{ consumedAt: new Date() }]
    expect(await inspectCredentialEntry("t", OWNER)).toEqual({
      status: "already-used",
    })
  })

  it("treats an unknown nonce as an invalid link", async () => {
    nonceRow = []
    expect(await inspectCredentialEntry("t", OWNER)).toEqual({
      status: "invalid-token",
    })
  })

  it("reports a missing token without verifying anything", async () => {
    expect(await inspectCredentialEntry(undefined, OWNER)).toEqual({
      status: "missing-token",
    })
    expect(verifyConsentTokenMock).not.toHaveBeenCalled()
  })

  it("rejects an expired or tampered token", async () => {
    verifyResult = null
    expect(await inspectCredentialEntry("t", OWNER)).toEqual({
      status: "invalid-token",
    })
  })

  it("refuses a consent token minted for a different flow", async () => {
    verifyResult = payload({ kind: "canva", cred: undefined })
    expect(await inspectCredentialEntry("t", OWNER)).toEqual({
      status: "invalid-token",
    })
    expect(executeQueryMock).not.toHaveBeenCalled()
  })
})

describe("submitCredentialEntry — identity", () => {
  it("stores the value for the owner", async () => {
    const broker = brokerStub()
    expect(
      await submitCredentialEntry(
        { token: "t", sessionEmail: OWNER, value: SECRET_VALUE },
        broker
      )
    ).toEqual({
      status: "stored",
      credentialName: "freshservice_api_key",
      action: "created",
    })
    expect(broker.put).toHaveBeenCalledWith(
      OWNER,
      "freshservice_api_key",
      SECRET_VALUE
    )
  })

  it("stores under the token's owner, never the session's address", async () => {
    // The link is the authority. A session that merely matches case-insensitively
    // must not redirect the write to a differently-cased secret path.
    const broker = brokerStub()
    await submitCredentialEntry(
      { token: "t", sessionEmail: "Owner@PSD401.net", value: SECRET_VALUE },
      broker
    )
    expect(broker.put).toHaveBeenCalledWith(
      OWNER,
      "freshservice_api_key",
      SECRET_VALUE
    )
  })

  it("refuses a different user and writes nothing", async () => {
    const broker = brokerStub()
    expect(
      await submitCredentialEntry(
        {
          token: "t",
          sessionEmail: "someone.else@psd401.net",
          value: SECRET_VALUE,
        },
        broker
      )
    ).toEqual({ status: "wrong-user", expected: OWNER })
    expect(broker.put).not.toHaveBeenCalled()
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it("refuses an anonymous submit and writes nothing", async () => {
    const broker = brokerStub()
    expect(
      await submitCredentialEntry(
        { token: "t", sessionEmail: null, value: SECRET_VALUE },
        broker
      )
    ).toEqual({ status: "needs-signin", ownerEmail: OWNER })
    expect(broker.put).not.toHaveBeenCalled()
  })

  it("refuses an expired token and writes nothing", async () => {
    verifyResult = null
    const broker = brokerStub()
    expect(
      await submitCredentialEntry(
        { token: "t", sessionEmail: OWNER, value: SECRET_VALUE },
        broker
      )
    ).toEqual({ status: "invalid-token" })
    expect(broker.put).not.toHaveBeenCalled()
    expect(executeQueryMock).not.toHaveBeenCalled()
  })
})

describe("submitCredentialEntry — single use", () => {
  it("refuses a reused link: the claim wins no row, so nothing is written", async () => {
    claimRows = []
    nonceRow = [{ consumedAt: new Date() }]
    const broker = brokerStub()
    expect(
      await submitCredentialEntry(
        { token: "t", sessionEmail: OWNER, value: SECRET_VALUE },
        broker
      )
    ).toEqual({ status: "already-used" })
    expect(broker.put).not.toHaveBeenCalled()
  })

  it("claims the nonce BEFORE writing the secret", async () => {
    // Ordering is the whole guarantee: if the write came first, a failed write
    // would leave a live secret-entry form that anyone with the URL could
    // resubmit.
    const order: string[] = []
    executeQueryMock.mockImplementationOnce(async () => {
      order.push("claim")
      return [{ nonce: "n1" }]
    })
    const broker = {
      put: jest.fn(async () => {
        order.push("put")
        return { name: "freshservice_api_key", action: "created" as const }
      }),
    }
    await submitCredentialEntry(
      { token: "t", sessionEmail: OWNER, value: SECRET_VALUE },
      broker
    )
    expect(order).toEqual(["claim", "put"])
  })

  it("reports write-failed — and the link stays spent — when the broker throws", async () => {
    const broker = {
      put: jest.fn(async () => {
        throw new Error("Secrets Manager unavailable")
      }),
    }
    expect(
      await submitCredentialEntry(
        { token: "t", sessionEmail: OWNER, value: SECRET_VALUE },
        broker
      )
    ).toEqual({
      status: "write-failed",
      credentialName: "freshservice_api_key",
    })
    // The claim still happened, so a second submit cannot retry.
    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      "claimCredentialEntryNonce"
    )
  })

  it("calls a vanished nonce row invalid, not already-used", async () => {
    // The cleanup job can delete an old row mid-flight. Telling someone their
    // unused link was "already used" sends them hunting for a theft that never
    // happened.
    claimRows = []
    nonceRow = []
    const broker = brokerStub()
    expect(
      await submitCredentialEntry(
        { token: "t", sessionEmail: OWNER, value: SECRET_VALUE },
        broker
      )
    ).toEqual({ status: "invalid-token" })
    expect(broker.put).not.toHaveBeenCalled()
  })

  it("refuses to spend the link when the deployment cannot store secrets", async () => {
    // A deployment with no ENVIRONMENT would otherwise burn every link it
    // issues on a write that was never going to succeed.
    storageConfigured = false
    const broker = brokerStub()
    expect(
      await submitCredentialEntry(
        { token: "t", sessionEmail: OWNER, value: SECRET_VALUE },
        broker
      )
    ).toEqual({ status: "not-configured" })
    expect(executeQueryMock).not.toHaveBeenCalled()
    expect(broker.put).not.toHaveBeenCalled()
  })

  it("surfaces a rotation distinctly from a first write", async () => {
    const broker = {
      put: jest.fn(async () => ({
        name: "freshservice_api_key",
        action: "rotated" as const,
      })),
    }
    expect(
      await submitCredentialEntry(
        { token: "t", sessionEmail: OWNER, value: SECRET_VALUE },
        broker
      )
    ).toEqual({
      status: "stored",
      credentialName: "freshservice_api_key",
      action: "rotated",
    })
  })
})

describe("submitCredentialEntry — value validation", () => {
  it.each([
    ["an empty value", ""],
    ["whitespace only", "   "],
    ["a too-short value", "abc"],
    ["an unreplaced placeholder", "<your-api-key>"],
  ])("rejects %s without spending the link", async (_label, value) => {
    const broker = brokerStub()
    const outcome = await submitCredentialEntry(
      { token: "t", sessionEmail: OWNER, value },
      broker
    )
    expect(outcome.status).toBe("invalid-value")
    // A typo must not cost the user their one-time link.
    expect(executeQueryMock).not.toHaveBeenCalled()
    expect(broker.put).not.toHaveBeenCalled()
  })

  it("rejects an over-long value without spending the link", async () => {
    const broker = brokerStub()
    const outcome = await submitCredentialEntry(
      { token: "t", sessionEmail: OWNER, value: "x".repeat(4097) },
      broker
    )
    expect(outcome.status).toBe("invalid-value")
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it("rejects a non-string value", async () => {
    const broker = brokerStub()
    const outcome = await submitCredentialEntry(
      { token: "t", sessionEmail: OWNER, value: { key: "nope" } },
      broker
    )
    expect(outcome.status).toBe("invalid-value")
    expect(broker.put).not.toHaveBeenCalled()
  })

  it("never echoes the submitted value back in any outcome", async () => {
    const broker = brokerStub()
    for (const value of [SECRET_VALUE, "abc", "<placeholder>"]) {
      const outcome = await submitCredentialEntry(
        { token: "t", sessionEmail: OWNER, value },
        broker
      )
      expect(JSON.stringify(outcome)).not.toContain(value)
    }
  })
})
