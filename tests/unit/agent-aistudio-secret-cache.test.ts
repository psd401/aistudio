/** @jest-environment node */

const mockSecretsSend = jest.fn()

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  CreateSecretCommand: jest.fn((input: unknown) => ({
    command: "create",
    input,
  })),
  DeleteSecretCommand: jest.fn((input: unknown) => ({
    command: "delete",
    input,
  })),
  DescribeSecretCommand: jest.fn((input: unknown) => ({
    command: "describe",
    input,
  })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({
    command: "get",
    input,
  })),
  PutSecretValueCommand: jest.fn((input: unknown) => ({
    command: "put",
    input,
  })),
  ResourceNotFoundException: class ResourceNotFoundException extends Error {},
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
}))

import {
  aistudioOAuthSecretId,
  deleteAistudioOAuthSecret,
  getSecretJson,
  storeAistudioOAuthTokens,
  type AistudioOAuthTokenData,
} from "@/lib/agent-workspace/secrets-manager"

interface MockCommand {
  command: "create" | "delete" | "describe" | "get" | "put"
  input: {
    SecretId?: string
    SecretString?: string
  }
}

function tokenData(accessToken: string): AistudioOAuthTokenData {
  return {
    access_token: accessToken,
    refresh_token: `${accessToken}-refresh`,
    token_type: "Bearer",
    scope: "mcp",
    expires_at: "2026-07-26T23:00:00.000Z",
    obtained_at: "2026-07-26T22:00:00.000Z",
  }
}

describe("AI Studio OAuth secret cache invalidation", () => {
  const originalNodeEnv = process.env.NODE_ENV
  let storedSecret: string | null

  beforeEach(() => {
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: "test",
    })
    storedSecret = JSON.stringify(tokenData("old-access-token"))
    mockSecretsSend.mockReset().mockImplementation((rawCommand: MockCommand) => {
      const command = rawCommand
      if (command.command === "get") {
        return Promise.resolve({ SecretString: storedSecret ?? undefined })
      }
      if (command.command === "put") {
        storedSecret = command.input.SecretString ?? null
        return Promise.resolve({ ARN: "arn:aws:secretsmanager:test:aistudio" })
      }
      if (command.command === "delete") {
        storedSecret = null
        return Promise.resolve({})
      }
      return Promise.resolve({ ARN: "arn:aws:secretsmanager:test:aistudio" })
    })
  })

  afterEach(() => {
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: originalNodeEnv,
    })
  })

  it("does not serve a stale token after rotating the stored secret", async () => {
    const ownerEmail = "cache-rotate@example.com"
    const secretId = aistudioOAuthSecretId(ownerEmail)

    await expect(
      getSecretJson<AistudioOAuthTokenData>(secretId)
    ).resolves.toMatchObject({ access_token: "old-access-token" })

    await storeAistudioOAuthTokens(ownerEmail, tokenData("new-access-token"))

    await expect(
      getSecretJson<AistudioOAuthTokenData>(secretId)
    ).resolves.toMatchObject({ access_token: "new-access-token" })
    expect(
      mockSecretsSend.mock.calls.filter(
        ([command]) => (command as MockCommand).command === "get"
      )
    ).toHaveLength(2)
  })

  it("does not serve a cached token after disconnect deletes the secret", async () => {
    const ownerEmail = "cache-delete@example.com"
    const secretId = aistudioOAuthSecretId(ownerEmail)

    await expect(
      getSecretJson<AistudioOAuthTokenData>(secretId)
    ).resolves.toMatchObject({ access_token: "old-access-token" })

    await expect(deleteAistudioOAuthSecret(ownerEmail)).resolves.toBe(true)
    await expect(
      getSecretJson<AistudioOAuthTokenData>(secretId)
    ).resolves.toBeNull()
    expect(
      mockSecretsSend.mock.calls.filter(
        ([command]) => (command as MockCommand).command === "get"
      )
    ).toHaveLength(2)
  })
})
