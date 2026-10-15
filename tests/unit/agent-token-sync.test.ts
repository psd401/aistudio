/** @jest-environment node */

/**
 * #1902 — sign-in must only ROTATE an existing cognito-refresh secret.
 * Creating one per signed-in user left 313 never-read secrets in prod
 * (~$125/month). Only `/agent-connect-data` may create, via
 * `{ createIfMissing: true }`.
 */

const mockSecretsSend = jest.fn()

class MockResourceNotFoundException extends Error {
  constructor() {
    super("Secrets Manager can't find the specified secret.")
    this.name = "ResourceNotFoundException"
  }
}

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  CreateSecretCommand: jest.fn((input: unknown) => ({
    command: "create",
    input,
  })),
  PutSecretValueCommand: jest.fn((input: unknown) => ({
    command: "put",
    input,
  })),
  ResourceNotFoundException: MockResourceNotFoundException,
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
}))

import {
  cognitoRefreshSecretId,
  syncCognitoRefreshForAgent,
} from "@/lib/auth/agent-token-sync"

interface MockCommand {
  command: "create" | "put"
  input: {
    Name?: string
    SecretId?: string
    SecretString?: string
    Tags?: { Key: string; Value: string }[]
  }
}

const OWNER_EMAIL = "sync-user@example.com"
const ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:cognito-refresh"

function commandsOfType(type: "create" | "put"): MockCommand[] {
  return mockSecretsSend.mock.calls
    .map(([command]) => command as MockCommand)
    .filter((command) => command.command === type)
}

describe("syncCognitoRefreshForAgent", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    mockSecretsSend.mockReset()
    process.env.ENVIRONMENT = "test-env"
    process.env.AUTH_COGNITO_CLIENT_ID = "test-client-id"
    process.env.AUTH_COGNITO_ISSUER =
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool"
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("rotates an existing secret with PutSecretValue and returns the ARN", async () => {
    mockSecretsSend.mockResolvedValue({ ARN })

    await expect(
      syncCognitoRefreshForAgent(OWNER_EMAIL, "refresh-token-1"),
    ).resolves.toBe(ARN)

    const puts = commandsOfType("put")
    expect(puts).toHaveLength(1)
    expect(puts[0].input.SecretId).toBe(cognitoRefreshSecretId(OWNER_EMAIL))
    expect(JSON.parse(puts[0].input.SecretString ?? "{}")).toMatchObject({
      refresh_token: "refresh-token-1",
      client_id: "test-client-id",
      user_pool_id: "us-east-1_testpool",
      region: "us-east-1",
    })
    expect(commandsOfType("create")).toHaveLength(0)
  })

  it("does NOT create a secret by default when none exists", async () => {
    mockSecretsSend.mockRejectedValue(new MockResourceNotFoundException())

    await expect(
      syncCognitoRefreshForAgent(OWNER_EMAIL, "refresh-token-2"),
    ).resolves.toBeNull()

    expect(commandsOfType("put")).toHaveLength(1)
    expect(commandsOfType("create")).toHaveLength(0)
  })

  it("creates the secret with tags when createIfMissing is true", async () => {
    mockSecretsSend.mockImplementation((rawCommand: MockCommand) => {
      if (rawCommand.command === "put") {
        return Promise.reject(new MockResourceNotFoundException())
      }
      return Promise.resolve({ ARN })
    })

    await expect(
      syncCognitoRefreshForAgent(OWNER_EMAIL, "refresh-token-3", {
        createIfMissing: true,
      }),
    ).resolves.toBe(ARN)

    const creates = commandsOfType("create")
    expect(creates).toHaveLength(1)
    expect(creates[0].input.Name).toBe(cognitoRefreshSecretId(OWNER_EMAIL))
    expect(creates[0].input.Tags).toEqual([
      { Key: "Environment", Value: "test-env" },
      { Key: "ManagedBy", Value: "aistudio" },
      { Key: "OwnerEmail", Value: OWNER_EMAIL },
    ])
  })

  it("falls back to PutSecretValue when a concurrent create wins the race", async () => {
    let puts = 0
    mockSecretsSend.mockImplementation((rawCommand: MockCommand) => {
      if (rawCommand.command === "put") {
        puts++
        return puts === 1
          ? Promise.reject(new MockResourceNotFoundException())
          : Promise.resolve({ ARN })
      }
      const exists = new Error("A secret with this name already exists.")
      exists.name = "ResourceExistsException"
      return Promise.reject(exists)
    })

    await expect(
      syncCognitoRefreshForAgent(OWNER_EMAIL, "refresh-token-4", {
        createIfMissing: true,
      }),
    ).resolves.toBe(ARN)

    expect(commandsOfType("create")).toHaveLength(1)
    const retried = commandsOfType("put")
    expect(retried).toHaveLength(2)
    expect(retried[1].input.SecretId).toBe(cognitoRefreshSecretId(OWNER_EMAIL))
    expect(JSON.parse(retried[1].input.SecretString ?? "{}")).toMatchObject({
      refresh_token: "refresh-token-4",
    })
  })

  it("returns null and writes nothing when no refresh token is supplied", async () => {
    await expect(syncCognitoRefreshForAgent(OWNER_EMAIL, "")).resolves.toBeNull()
    expect(mockSecretsSend).not.toHaveBeenCalled()
  })
})
