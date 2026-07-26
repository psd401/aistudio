/** @jest-environment node */

import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

const verifyContextMock = jest.fn<() => Promise<
  | {
      ownerEmail: string
      actorEmail: string
      mode: "owner" | "consultation" | "scheduled"
      sessionId: string
    }
  | null
>>()
const getSecretStringMock = jest.fn<() => Promise<string | null>>()
const fetchMock = jest.fn<typeof fetch>()
const acquireAdmissionMock = jest.fn()
const finishAdmissionMock = jest.fn()
const releaseAdmissionMock = jest.fn()

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: verifyContextMock,
}))
jest.mock("@/lib/agent-workspace/secrets-manager", () => ({
  getSecretString: getSecretStringMock,
}))
jest.mock("@/lib/resource-admission", () => ({
  acquireResourceAdmission: (...args: unknown[]) =>
    acquireAdmissionMock(...args),
  finishResourceAdmission: (...args: unknown[]) =>
    finishAdmissionMock(...args),
  releaseResourceAdmission: (...args: unknown[]) =>
    releaseAdmissionMock(...args),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => "request-id",
  sanitizeForLogging: (value: unknown) => value,
}))

function request(body: unknown) {
  const bytes = Buffer.from(JSON.stringify(body))
  const requestHeaders = new Map<string, string>([
    ["content-length", String(bytes.byteLength)],
    ["content-type", "application/json"],
    ["accept", "application/json"],
  ])
  return {
    headers: {
      get: (name: string) => requestHeaders.get(name.toLowerCase()) ?? null,
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    signal: new AbortController().signal,
  }
}

describe("Agent model credential broker", () => {
  let POST: typeof import("@/app/api/agent/model-proxy/[...path]/route").POST
  let readBoundedModelRequest:
    typeof import("@/app/api/agent/model-proxy/[...path]/route").readBoundedModelRequest

  beforeAll(async () => {
    ;({ POST, readBoundedModelRequest } = await import(
      "@/app/api/agent/model-proxy/[...path]/route"
    ))
    global.fetch = fetchMock
  })

  beforeEach(() => {
    jest.clearAllMocks()
    acquireAdmissionMock.mockReset()
    finishAdmissionMock.mockReset()
    releaseAdmissionMock.mockReset()
    verifyContextMock.mockResolvedValue({
      ownerEmail: "owner@example.com",
      actorEmail: "owner@example.com",
      mode: "owner",
      sessionId: "session-id",
      nonce: "signed-nonce",
    })
    acquireAdmissionMock
      .mockResolvedValueOnce({ allowed: true, leaseId: "call-lease" })
      .mockResolvedValueOnce({ allowed: true, leaseId: "token-lease" })
      .mockResolvedValueOnce({ allowed: true, leaseId: "cost-lease" })
      .mockResolvedValue({ allowed: true, leaseId: "other-lease" })
    finishAdmissionMock.mockResolvedValue(undefined)
    releaseAdmissionMock.mockResolvedValue(undefined)
    getSecretStringMock.mockResolvedValue("trusted-web-tier-api-key")
    fetchMock.mockResolvedValue({
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type"
            ? "application/json"
            : null,
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("provider response"))
          controller.close()
        },
      }),
    } as unknown as Response)
  })

  it("requires a signed invocation before reading the key", async () => {
    verifyContextMock.mockResolvedValueOnce(null)

    const response = await POST(
      request({}) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )

    expect(response.status).toBe(403)
    expect(getSecretStringMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("admits a signed consultation to the model but not an unsigned caller", async () => {
    verifyContextMock.mockResolvedValueOnce({
      ownerEmail: "owner@example.com",
      actorEmail: "delegate@example.com",
      mode: "consultation",
      sessionId: "consultation-session",
    })
    const consultationRequest = request({
      model: "us.anthropic.claude-sonnet-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "consult" }],
    })
    const response = await POST(
      consultationRequest as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )

    expect(response.status).toBe(200)
    expect(verifyContextMock).toHaveBeenCalledWith(
      consultationRequest,
      { allowedModes: ["owner", "consultation", "scheduled"] },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("rejects unapproved endpoints, models, and output limits", async () => {
    const wrongPath = await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 100,
      }) as never,
      { params: Promise.resolve({ path: ["arbitrary"] }) },
    )
    expect(wrongPath.status).toBe(404)

    const wrongModel = await POST(
      request({ model: "attacker/model", max_tokens: 100 }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )
    expect(wrongModel.status).toBe(400)

    const oversizedOutput = await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 32_769,
      }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )
    expect(oversizedOutput.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("adds the bearer-equivalent API key only at the fixed trusted upstream", async () => {
    const response = await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 1_024,
        messages: [{ role: "user", content: "hello" }],
      }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )

    expect(acquireAdmissionMock).toHaveBeenCalledTimes(3)
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          "x-api-key": "trusted-web-tier-api-key",
        }),
      }),
    )
    const requestBytes = Buffer.byteLength(
      JSON.stringify({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 1_024,
        messages: [{ role: "user", content: "hello" }],
      }),
    )
    expect(acquireAdmissionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "model-proxy-total-tokens",
        units: requestBytes + 1_024,
      }),
    )
  })

  it("retains conservative reservations after an ambiguous dispatch failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("client aborted after dispatch"))
    const response = await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 1_024,
        messages: [{ role: "user", content: "hello" }],
      }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )

    expect(response.status).toBe(502)
    expect(finishAdmissionMock).toHaveBeenCalledTimes(3)
    expect(finishAdmissionMock).toHaveBeenCalledWith("call-lease")
    expect(finishAdmissionMock).toHaveBeenCalledWith("token-lease")
    expect(finishAdmissionMock).toHaveBeenCalledWith("cost-lease")
    expect(releaseAdmissionMock).not.toHaveBeenCalled()
  })

  it("cancels a streamed request on the first byte over the raw limit", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024))
        controller.enqueue(new Uint8Array(1))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(
      readBoundedModelRequest({
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type"
              ? "application/json"
              : null,
        } as Headers,
        body,
      }),
    ).rejects.toThrow("too large")
    expect(cancelled).toBe(true)
  })
})
