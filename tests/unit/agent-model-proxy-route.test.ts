/** @jest-environment node */

import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

const verifyContextMock = jest.fn<(...args: unknown[]) => Promise<
  | {
      ownerEmail: string
      actorEmail: string
      mode: "owner" | "consultation" | "scheduled" | "email-task"
      sessionId: string
      nonce: string
    }
  | null
>>()
const getSecretStringMock = jest.fn<() => Promise<string | null>>()
const fetchMock = jest.fn<typeof fetch>()
const acquireAdmissionMock =
  jest.fn<(...args: unknown[]) => Promise<unknown>>()
const finishAdmissionMock =
  jest.fn<(...args: unknown[]) => Promise<unknown>>()
const releaseAdmissionMock =
  jest.fn<(...args: unknown[]) => Promise<unknown>>()

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: verifyContextMock,
}))
jest.mock("@/lib/agent-workspace/secrets-manager", () => ({
  getSecretString: getSecretStringMock,
}))
jest.mock("@/lib/resource-admission", () => ({
  // Real implementation — the capacity-vs-replay split is behaviour under test:
  // `duplicate` must stay a hard refusal while capacity thresholds are
  // observe-only.
  isCapacityDenial: (admission: { allowed: boolean; reason?: string }) =>
    !admission.allowed && admission.reason !== "duplicate",
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
    typeof import("@/lib/agent-workspace/bounded-model-request").readBoundedModelRequest

  beforeAll(async () => {
    ;({ POST } = await import(
      "@/app/api/agent/model-proxy/[...path]/route"
    ))
    ;({ readBoundedModelRequest } = await import(
      "@/lib/agent-workspace/bounded-model-request"
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
      nonce: "consultation-nonce",
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
      { allowedModes: ["owner", "consultation", "scheduled", "email-task"] },
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

  /** The JSON actually dispatched upstream, as a string. */
  const forwardedBody = (): string => {
    const call = fetchMock.mock.calls[0]
    if (!call) throw new Error("fetch was never called")
    const init = call[1] as { body?: unknown } | undefined
    if (!init?.body) throw new Error("fetch was called without a body")
    return Buffer.from(init.body as Buffer).toString("utf8")
  }

  it("supplies anthropic_version, which Bedrock requires in the BODY", async () => {
    // Bedrock's Anthropic-compatible endpoint requires `anthropic_version` as
    // a body field. The native Anthropic API instead uses an
    // `anthropic-version` HEADER, so an Anthropic-Messages client that is
    // correct against api.anthropic.com omits the body field and Bedrock
    // rejects EVERY call with:
    //   {"type":"invalid_request_error","message":"anthropic_version: Field required"}
    // That is what took the dev agent down on 2026-07-27 — this proxy path was
    // one day old and had never completed a single successful turn.
    await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 1_024,
        messages: [{ role: "user", content: "hello" }],
      }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )

    const forwarded = JSON.parse(forwardedBody())
    expect(forwarded.anthropic_version).toBe("bedrock-2023-05-31")
    // The rest of the request must survive untouched.
    expect(forwarded.model).toBe("us.anthropic.claude-sonnet-5")
    expect(forwarded.max_tokens).toBe(1_024)
    expect(forwarded.messages).toEqual([{ role: "user", content: "hello" }])
  })

  it("does not overwrite an anthropic_version the client already set", async () => {
    await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 1_024,
        anthropic_version: "bedrock-2099-01-01",
        messages: [{ role: "user", content: "hello" }],
      }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )

    const forwarded = JSON.parse(forwardedBody())
    expect(forwarded.anthropic_version).toBe("bedrock-2099-01-01")
  })

  it("serves the request when the token/cost budget is over threshold", async () => {
    // OBSERVE-ONLY. These limits were added in #1353 calibrated as if one
    // model call per turn; an agentic turn makes many, each re-sending the
    // whole context, so a single conversation could exhaust the hourly cap and
    // the user got "I couldn't complete that" with no explanation. Until we
    // know what normal consumption looks like, over-limit must MEASURE, never
    // reject.
    // beforeEach queues mockResolvedValueOnce values that would otherwise
    // take priority over this override and make the test vacuous.
    acquireAdmissionMock.mockReset()
    acquireAdmissionMock.mockImplementation((req: unknown) => {
      const kind = (req as { kind: string }).kind
      if (kind === "model-proxy-total-tokens" || kind === "model-proxy-cost-microcents") {
        return Promise.resolve({ allowed: false, reason: "owner_hourly_units" })
      }
      return Promise.resolve({ allowed: true, leaseId: `lease-${kind}`, reservedUnits: 1 })
    })

    const response = await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 1_024,
        messages: [{ role: "user", content: "hello" }],
      }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalled()
    // Only the granted lease may be settled — a denial carries no leaseId.
    const settled = finishAdmissionMock.mock.calls.map((c) => c[0])
    expect(settled).not.toContain(undefined)
  })

  it("serves the request when the call-rate limit is over threshold", async () => {
    // beforeEach queues mockResolvedValueOnce values that would otherwise
    // take priority over this override and make the test vacuous.
    acquireAdmissionMock.mockReset()
    acquireAdmissionMock.mockImplementation((req: unknown) => {
      const kind = (req as { kind: string }).kind
      if (kind === "model-proxy-call") {
        return Promise.resolve({ allowed: false, reason: "owner_hourly_units" })
      }
      return Promise.resolve({ allowed: true, leaseId: `lease-${kind}`, reservedUnits: 1 })
    })

    const response = await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 1_024,
        messages: [{ role: "user", content: "hello" }],
      }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )

    expect(response.status).toBe(200)
  })

  it("never answers 429 for a budget or capacity threshold", async () => {
    // The contract in one line: thresholds are telemetry, not a gate.
    // beforeEach queues mockResolvedValueOnce values that would otherwise
    // take priority over this override and make the test vacuous.
    acquireAdmissionMock.mockReset()
    acquireAdmissionMock.mockResolvedValue({ allowed: false, reason: "owner_hourly_units" })

    const response = await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 1_024,
        messages: [{ role: "user", content: "hello" }],
      }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )

    expect(response.status).not.toBe(429)
    expect(response.status).toBe(200)
  })

  it("still REFUSES a duplicate — that is a replay guard, not a budget", async () => {
    // The observe-only change must not disable idempotency. `duplicate` means
    // the same key was already admitted; serving it would double-apply the
    // request.
    acquireAdmissionMock.mockReset()
    acquireAdmissionMock.mockResolvedValue({ allowed: false, reason: "duplicate" })

    const response = await POST(
      request({
        model: "us.anthropic.claude-sonnet-5",
        max_tokens: 1_024,
        messages: [{ role: "user", content: "hello" }],
      }) as never,
      { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
    )

    expect(response.status).toBe(409)
    expect(fetchMock).not.toHaveBeenCalled()
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
