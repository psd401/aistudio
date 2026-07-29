/** @jest-environment node */

import { NextRequest } from "next/server"

const mockDdbSend = jest.fn()
const mockVerifyInvocation = jest.fn()
const mockGetAccessToken = jest.fn()
const mockLogError = jest.fn()
const mockFetch = jest.fn()
const originalFetch = globalThis.fetch

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class MockDynamoDBClient {},
}))

jest.mock("@aws-sdk/lib-dynamodb", () => {
  class MockCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    DeleteCommand: MockCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: (...args: unknown[]) => mockDdbSend(...args),
      }),
    },
    GetCommand: MockCommand,
    UpdateCommand: MockCommand,
  }
})

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: (...args: unknown[]) =>
    mockVerifyInvocation(...args),
}))

jest.mock("@/lib/agent/workspace-token", () => ({
  getFreshAccessTokenForUser: (...args: unknown[]) =>
    mockGetAccessToken(...args),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => mockLogError(...args),
  }),
  generateRequestId: () => "request-1",
  sanitizeForLogging: (value: unknown) => value,
}))

import { POST } from "@/app/api/agent/email-triage/route"
import {
  EMAIL_TRIAGE_LABEL_MAPPING_PROVENANCE,
  EMAIL_TRIAGE_LABEL_MAPPING_VERSION,
  EMAIL_TRIAGE_LABELS,
} from "@/lib/agent/email-triage-label-map"

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/agent/email-triage", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

describe("email triage route label control boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    globalThis.fetch = mockFetch
    mockVerifyInvocation.mockResolvedValue({
      mode: "owner",
      ownerEmail: "owner@example.com",
    })
    mockGetAccessToken.mockResolvedValue({ access_token: "gmail-token" })
    mockDdbSend.mockResolvedValue({})
  })

  afterAll(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch
    }
  })

  it("rejects model-controlled labelIdsByKey before DynamoDB", async () => {
    const response = await POST(
      request({
        operation: "update-state",
        attrs: {
          labelIdsByKey: {
            important: "TRASH",
            later: "SPAM",
          },
        },
      })
    )

    expect(response.status).toBe(400)
    expect(mockDdbSend).not.toHaveBeenCalled()
    expect(mockGetAccessToken).not.toHaveBeenCalled()
  })

  it("resolves and persists only the signed owner's expected live user labels", async () => {
    const ids = {
      important: "Label_important",
      later: "Label_later",
      news: "Label_news",
      task: "Label_task",
    }
    const labels: Array<{ id: string; name: string; type: "user" }> =
      Object.entries(EMAIL_TRIAGE_LABELS).map(([key, name]) => ({
        id: ids[key as keyof typeof ids],
        name,
        type: "user",
      }))
    labels.push({
      id: "Label_unrelated",
      name: "Unrelated",
      type: "user",
    })
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ labels }),
      text: async () => JSON.stringify({ labels }),
    } as Response)

    const response = await POST(request({ operation: "ensure-labels" }))

    expect(mockLogError).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    expect(mockVerifyInvocation).toHaveBeenCalled()
    expect(mockGetAccessToken).toHaveBeenCalledWith(
      "owner@example.com",
      "dev",
      "user_account",
      "us-east-1"
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockDdbSend).toHaveBeenCalledTimes(1)
    const command = mockDdbSend.mock.calls[0][0] as {
      input: {
        Key: { userEmail: string }
        ExpressionAttributeValues: Record<string, unknown>
      }
    }
    expect(command.input.Key).toEqual({
      userEmail: "owner@example.com",
    })
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ":labels": EMAIL_TRIAGE_LABELS,
      ":ids": ids,
      ":version": EMAIL_TRIAGE_LABEL_MAPPING_VERSION,
      ":provenance": EMAIL_TRIAGE_LABEL_MAPPING_PROVENANCE,
      ":owner": "owner@example.com",
    })
    const body = await response.json()
    expect(body.result).toEqual({
      labels: EMAIL_TRIAGE_LABELS,
      labelIdsByKey: ids,
    })
  })

  it("does not accept caller-supplied fields on the trusted operation", async () => {
    const response = await POST(
      request({
        operation: "ensure-labels",
        labelIdsByKey: { important: "TRASH" },
      })
    )
    expect(response.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockDdbSend).not.toHaveBeenCalled()
  })
})

describe("email triage route invocation boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    globalThis.fetch = mockFetch
    mockVerifyInvocation.mockResolvedValue({
      mode: "owner",
      ownerEmail: "owner@example.com",
    })
    mockGetAccessToken.mockResolvedValue({ access_token: "gmail-token" })
    mockDdbSend.mockResolvedValue({})
  })

  it("rejects requests without a verified invocation", async () => {
    mockVerifyInvocation.mockResolvedValue(null)

    const response = await POST(request({ operation: "get-state" }))

    expect(response.status).toBe(403)
    expect(mockDdbSend).not.toHaveBeenCalled()
    expect(mockGetAccessToken).not.toHaveBeenCalled()
  })

  it("rejects caller-supplied owner selectors before any data access", async () => {
    const response = await POST(
      request({
        operation: "get-state",
        ownerEmail: "attacker@example.com",
      })
    )

    expect(response.status).toBe(400)
    expect(mockDdbSend).not.toHaveBeenCalled()
    expect(mockGetAccessToken).not.toHaveBeenCalled()
  })

  it("uses the signed owner for scheduled state reads", async () => {
    mockVerifyInvocation.mockResolvedValue({
      mode: "scheduled",
      ownerEmail: "scheduled-owner@example.com",
    })
    mockDdbSend.mockResolvedValue({ Item: { enabled: true } })

    const response = await POST(request({ operation: "get-state" }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state: { enabled: true } })
    const command = mockDdbSend.mock.calls[0][0] as {
      input: { Key: { userEmail: string } }
    }
    expect(command.input.Key).toEqual({
      userEmail: "scheduled-owner@example.com",
    })
    expect(mockGetAccessToken).not.toHaveBeenCalled()
  })

  it("does not allow scheduled invocations to mutate state", async () => {
    mockVerifyInvocation.mockResolvedValue({
      mode: "scheduled",
      ownerEmail: "scheduled-owner@example.com",
    })

    const response = await POST(
      request({
        operation: "update-state",
        attrs: { enabled: true },
      })
    )

    expect(response.status).toBe(403)
    expect(mockDdbSend).not.toHaveBeenCalled()
    expect(mockGetAccessToken).not.toHaveBeenCalled()
  })

  it("limits owner state updates to safe fields", async () => {
    const response = await POST(
      request({
        operation: "update-state",
        attrs: {
          enabled: true,
          digestTime: "08:00",
        },
      })
    )

    expect(response.status).toBe(200)
    const command = mockDdbSend.mock.calls[0][0] as {
      input: {
        Key: { userEmail: string }
        ExpressionAttributeNames: Record<string, string>
        ExpressionAttributeValues: Record<string, unknown>
      }
    }
    expect(command.input).toMatchObject({
      Key: { userEmail: "owner@example.com" },
      ExpressionAttributeNames: {
        "#field0": "enabled",
        "#field1": "digestTime",
      },
      ExpressionAttributeValues: {
        ":value0": true,
        ":value1": "08:00",
      },
    })
    expect(mockGetAccessToken).not.toHaveBeenCalled()
  })

  it("preserves authorization fallback before rejecting Gmail operations", async () => {
    mockGetAccessToken.mockResolvedValue(null)

    const response = await POST(request({ operation: "unsupported" }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ status: "needs-auth" })
    expect(mockDdbSend).not.toHaveBeenCalled()
  })
})
