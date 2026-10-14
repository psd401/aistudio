/**
 * broker.put's write-audit row (#1887, PR #1915 review).
 *
 * The audit insert runs after the secret is already live in Secrets Manager,
 * so it must not turn a successful write into a reported failure. It does get
 * a longer transient-retry budget than executeQuery's default, and only once
 * that is spent is the gap logged and the write still reported as stored.
 */

const executeQuery = jest.fn()
const logError = jest.fn()

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQuery(...args),
  toPgRows: jest.fn(),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: (...args: unknown[]) => logError(...args),
  }),
  sanitizeForLogging: (value: unknown) => value,
}))

import {
  AgentCredentialBroker,
  CREDENTIAL_AUDIT_RETRY,
} from "@/lib/agent-credentials/broker"
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager"

const OWNER = "owner@psd401.net"
const NAME = "freshservice_api_key"
const VALUE = "not-a-real-key"

function broker(): AgentCredentialBroker {
  const secrets = { send: jest.fn().mockResolvedValue({}) }
  return new AgentCredentialBroker(secrets as unknown as SecretsManagerClient)
}

const originalEnvironment = process.env.ENVIRONMENT

beforeEach(() => {
  executeQuery.mockReset()
  logError.mockReset()
  process.env.ENVIRONMENT = "dev"
})

afterAll(() => {
  if (originalEnvironment === undefined) delete process.env.ENVIRONMENT
  else process.env.ENVIRONMENT = originalEnvironment
})

describe("AgentCredentialBroker.put write audit", () => {
  it("runs the audit insert on the longer retry budget", async () => {
    executeQuery.mockResolvedValue(undefined)

    await expect(broker().put(OWNER, NAME, VALUE)).resolves.toEqual({
      name: NAME,
      action: "created",
    })

    const auditCall = executeQuery.mock.calls.find(
      (call) => call[1] === "agentCredentialWriteAudit"
    )
    expect(auditCall?.[2]).toBe(CREDENTIAL_AUDIT_RETRY)
    // Must be strictly longer than executeQuery's default (3 attempts, 100ms).
    expect(CREDENTIAL_AUDIT_RETRY.maxRetries).toBeGreaterThan(3)
    expect(CREDENTIAL_AUDIT_RETRY.initialDelay).toBeGreaterThan(100)
    expect(logError).not.toHaveBeenCalled()
  })

  it("still reports the write as stored once the retries are spent, and logs the gap", async () => {
    executeQuery.mockRejectedValue(new Error("connection reset"))

    await expect(broker().put(OWNER, NAME, VALUE)).resolves.toEqual({
      name: NAME,
      action: "created",
    })
    expect(logError).toHaveBeenCalledWith(
      "Credential stored but the write audit row was not recorded",
      expect.objectContaining({ credentialName: NAME, action: "created" })
    )
    // The secret value never reaches the log line.
    expect(JSON.stringify(logError.mock.calls)).not.toContain(VALUE)
  })
})
