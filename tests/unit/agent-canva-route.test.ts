import type { NextRequest } from "next/server"

const verifyContextMock = jest.fn()
const getSecretJsonMock = jest.fn()
const storeCanvaRefreshTokenMock = jest.fn()
const fetchMock = jest.fn()
const warnMock = jest.fn()

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: (...args: unknown[]) =>
    verifyContextMock(...args),
}))
jest.mock("@/lib/agent-workspace/secrets-manager", () => ({
  canvaSecretId: (ownerEmail: string) => `canva/${ownerEmail}`,
  getSecretJson: (...args: unknown[]) => getSecretJsonMock(...args),
  storeCanvaRefreshToken: (...args: unknown[]) =>
    storeCanvaRefreshTokenMock(...args),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: (...args: unknown[]) => warnMock(...args),
  }),
  generateRequestId: () => "canva-request-id",
  sanitizeForLogging: (value: unknown) => value,
}))

import { POST } from "@/app/api/agent/canva/route"

function request(body: unknown): NextRequest {
  return {
    json: async () => body,
  } as unknown as NextRequest
}

beforeEach(() => {
  jest.clearAllMocks()
  verifyContextMock.mockResolvedValue({
    ownerEmail: "owner@example.com",
    actorEmail: "owner@example.com",
    mode: "owner",
    sessionId: "session-1",
    nonce: "nonce-1",
  })
  getSecretJsonMock.mockResolvedValue({
    refresh_token: "stored-refresh",
    scope: "design:read",
  })
  storeCanvaRefreshTokenMock.mockResolvedValue(undefined)
  global.fetch = fetchMock as unknown as typeof fetch
})

describe("POST /api/agent/canva", () => {
  it("requires a signed owner or scheduled context", async () => {
    verifyContextMock.mockResolvedValue(null)

    const response = await POST(request({ operation: "status" }))

    expect(response.status).toBe(403)
    expect(getSecretJsonMock).not.toHaveBeenCalled()
  })

  it("rejects extra authority fields on status requests", async () => {
    const response = await POST(
      request({ operation: "status", ownerEmail: "victim@example.com" })
    )

    expect(response.status).toBe(400)
    expect(getSecretJsonMock).not.toHaveBeenCalled()
  })

  it("reports connection state from the signed owner's secret", async () => {
    const response = await POST(request({ operation: "status" }))

    expect(warnMock).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ connected: true })
    expect(getSecretJsonMock).toHaveBeenCalledWith("canva/owner@example.com")
  })

  it("rejects query keys outside the fixed Canva surface", async () => {
    const response = await POST(
      request({
        operation: "request",
        method: "GET",
        path: "/v1/designs",
        query: { ownerEmail: "victim@example.com" },
      })
    )

    expect(response.status).toBe(400)
    expect(getSecretJsonMock).not.toHaveBeenCalled()
  })

  it("returns needs-connection before contacting Canva", async () => {
    getSecretJsonMock.mockResolvedValue(null)

    const response = await POST(
      request({
        operation: "request",
        method: "GET",
        path: "/v1/users/me",
      })
    )

    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refreshes and forwards only an allowed owner-bound operation", async () => {
    getSecretJsonMock
      .mockResolvedValueOnce({
        refresh_token: "stored-refresh",
        scope: "design:read",
      })
      .mockResolvedValueOnce({
        client_id: "canva-client",
        client_secret: "canva-secret",
      })
    fetchMock
      .mockResolvedValueOnce(
        {
          ok: true,
          json: async () => ({
            access_token: "short-lived-access",
            refresh_token: "rotated-refresh",
            scope: "design:read",
          }),
        } as Response
      )
      .mockResolvedValueOnce(
        {
          status: 200,
          text: async () => JSON.stringify({ id: "user-1" }),
          headers: { get: () => null },
        } as unknown as Response
      )

    const response = await POST(
      request({
        operation: "request",
        method: "GET",
        path: "/v1/users/me",
      })
    )

    expect(warnMock).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0].toString()).toBe(
      "https://api.canva.com/rest/v1/users/me"
    )
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer short-lived-access",
    })
    expect(storeCanvaRefreshTokenMock).toHaveBeenCalledWith(
      "owner@example.com",
      expect.objectContaining({ refresh_token: "rotated-refresh" })
    )
  })
})
