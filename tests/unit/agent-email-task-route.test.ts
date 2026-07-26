/** @jest-environment node */

import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

type Invocation = {
  ownerEmail: string
  actorEmail: string
  mode: "email-task"
  sessionId: string
  nonce: string
}

const verifyContextMock =
  jest.fn<(...args: unknown[]) => Promise<Invocation | null>>()
const getSecretStringMock = jest.fn<() => Promise<string | null>>()
const executeGitHubCommandMock =
  jest.fn<(...args: unknown[]) => Promise<unknown>>()
const executeWorkspaceCommandMock =
  jest.fn<(...args: unknown[]) => Promise<unknown>>()
const mintAgentTokenMock = jest.fn<() => Promise<{ accessToken: string }>>()
const getUserTokenMock =
  jest.fn<(...args: unknown[]) => Promise<{ access_token: string } | null>>()

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: (...args: unknown[]) =>
    verifyContextMock(...args),
}))
jest.mock("@/lib/agent-workspace/secrets-manager", () => ({
  getSecretString: () => getSecretStringMock(),
}))
jest.mock("@/lib/agent-github/command-executor", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/agent-github/command-executor")
  >("@/lib/agent-github/command-executor")
  return {
    ...actual,
    executeGitHubCommand: (...args: unknown[]) =>
      executeGitHubCommandMock(...args),
  }
})
jest.mock("@/lib/agent-workspace/command-executor", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/agent-workspace/command-executor")
  >("@/lib/agent-workspace/command-executor")
  return {
    ...actual,
    executeWorkspaceCommand: (...args: unknown[]) =>
      executeWorkspaceCommandMock(...args),
  }
})
jest.mock("@/lib/agent-workspace/mint-client", () => ({
  mintAgentWorkspaceTokenViaBoundary: () => mintAgentTokenMock(),
}))
jest.mock("@/lib/agent/workspace-token", () => ({
  getFreshAccessTokenForUser: (...args: unknown[]) => getUserTokenMock(...args),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => "request-id",
  sanitizeForLogging: (value: unknown) => value,
}))

function request(body: unknown) {
  return { json: async () => body }
}

describe("email-task route confinement", () => {
  let githubPost: typeof import("@/app/api/agent/github-execute/route").POST
  let workspacePost:
    typeof import("@/app/api/agent/workspace-execute/route").POST

  beforeAll(async () => {
    ;({ POST: githubPost } = await import(
      "@/app/api/agent/github-execute/route"
    ))
    ;({ POST: workspacePost } = await import(
      "@/app/api/agent/workspace-execute/route"
    ))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    verifyContextMock.mockResolvedValue({
      ownerEmail: "owner@example.com",
      actorEmail: "owner@example.com",
      mode: "email-task",
      sessionId: "email-task-session",
      nonce: "email-task-nonce",
    })
    getSecretStringMock.mockResolvedValue("owner-github-token")
    executeGitHubCommandMock.mockResolvedValue({ stdout: "#42", stderr: "" })
    executeWorkspaceCommandMock.mockResolvedValue({ stdout: "task", stderr: "" })
    mintAgentTokenMock.mockResolvedValue({ accessToken: "agent-token" })
    getUserTokenMock.mockResolvedValue({ access_token: "owner-google-token" })
  })

  it("allows GitHub issue creation but blocks other GitHub mutations", async () => {
    const rejected = await githubPost(
      request({
        argv: [
          "issue",
          "edit",
          "42",
          "--repo",
          "owner/tasks",
          "--title",
          "injected",
        ],
      }) as never,
    )
    expect(rejected.status).toBe(400)
    expect(getSecretStringMock).not.toHaveBeenCalled()

    const accepted = await githubPost(
      request({
        argv: [
          "issue",
          "create",
          "--repo",
          "owner/tasks",
          "--title",
          "Review email",
          "--body",
          "Sender-controlled excerpt",
        ],
      }) as never,
    )
    expect(accepted.status).toBe(200)
    expect(executeGitHubCommandMock).toHaveBeenCalledTimes(1)
  })

  it("allows Google task insertion but blocks all other Workspace access", async () => {
    const rejected = await workspacePost(
      request({
        scope: "user",
        argv: ["gmail", "users", "messages", "list"],
      }) as never,
    )
    expect(rejected.status).toBe(400)
    expect(getUserTokenMock).not.toHaveBeenCalled()

    const accepted = await workspacePost(
      request({
        scope: "user",
        argv: [
          "tasks",
          "tasks",
          "insert",
          "--params",
          '{"tasklist":"@default"}',
          "--json",
          '{"title":"Review email"}',
        ],
      }) as never,
    )
    expect(accepted.status).toBe(200)
    expect(getUserTokenMock).toHaveBeenCalledTimes(1)
    expect(executeWorkspaceCommandMock).toHaveBeenCalledTimes(1)
    expect(mintAgentTokenMock).not.toHaveBeenCalled()
  })
})
