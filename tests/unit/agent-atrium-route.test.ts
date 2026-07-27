let context:
  | {
      ownerEmail: string
      actorEmail: string
      mode: "owner" | "scheduled"
      sessionId: string
    }
  | null = {
  ownerEmail: "owner@psd401.net",
  actorEmail: "owner@psd401.net",
  mode: "owner",
  sessionId: "session-1",
}
const executeOwnerAtriumOperationMock = jest.fn()

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: jest.fn(async () => context),
}))
jest.mock("@/lib/agent-workspace/atrium-owner-operation", () => ({
  executeOwnerAtriumOperation: (...args: unknown[]) =>
    executeOwnerAtriumOperationMock(...args),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: () => "request-test",
  sanitizeForLogging: (value: unknown) => value,
}))

import type { NextRequest } from "next/server"
import { POST } from "@/app/api/agent/atrium/route"

function request(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest
}

beforeEach(() => {
  context = {
    ownerEmail: "owner@psd401.net",
    actorEmail: "owner@psd401.net",
    mode: "owner",
    sessionId: "session-1",
  }
  executeOwnerAtriumOperationMock.mockReset().mockResolvedValue({
    httpStatus: 201,
    payload: { data: { id: "content-1" } },
  })
})

describe("POST /api/agent/atrium", () => {
  it("requires signed authority and rejects owner selectors", async () => {
    context = null
    expect((await POST(request({ method: "GET", path: "" }))).status).toBe(403)
    context = {
      ownerEmail: "owner@psd401.net",
      actorEmail: "owner@psd401.net",
      mode: "owner",
      sessionId: "session-1",
    }
    expect(
      (
        await POST(
          request({
            method: "GET",
            path: "",
            ownerEmail: "victim@psd401.net",
          })
        )
      ).status
    ).toBe(400)
    expect(executeOwnerAtriumOperationMock).not.toHaveBeenCalled()
  })

  it("executes the operation directly as only the signed owner", async () => {
    const response = await POST(
      request({
        method: "POST",
        path: "/content-1/versions",
        body: { title: "v2" },
      })
    )
    expect(response.status).toBe(200)
    expect(executeOwnerAtriumOperationMock).toHaveBeenCalledWith({
      ownerEmail: "owner@psd401.net",
      requestId: "request-test",
      method: "POST",
      path: "/content-1/versions",
      body: { title: "v2" },
    })
    expect(await response.json()).toEqual({
      httpStatus: 201,
      payload: { data: { id: "content-1" } },
    })
  })

  it.each([
    ["GET", "/content-1/source"],
    ["GET", "/content-1/assets"],
    ["GET", "/content-1/assets/asset-1/bytes"],
    ["POST", "/content-1/assets"],
    ["POST", "/content-1/assets/asset-1/complete"],
  ])("admits the asset + source surface %s %s", async (method, path) => {
    const response = await POST(request({ method, path }))
    expect(response.status).toBe(200)
    expect(executeOwnerAtriumOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({ method, path })
    )
  })

  it.each([
    ["POST", "/content-1/publish/public_web"],
    ["GET", "/content-1/../../admin"],
    ["PUT", "/content-1"],
    ["DELETE", "/content-1/publish/attacker"],
    // Asset paths are exact: no deeper nesting, no unknown leaf, and no
    // DELETE/PATCH verbs (asset removal is not an agent-reachable operation).
    ["GET", "/content-1/assets/asset-1"],
    ["GET", "/content-1/assets/asset-1/bytes/extra"],
    ["POST", "/content-1/assets/asset-1"],
    ["POST", "/content-1/assets/asset-1/complete/extra"],
    ["POST", "/content-1/source"],
    ["DELETE", "/content-1/assets/asset-1"],
    ["PATCH", "/content-1/assets"],
  ])("rejects operation %s %s outside the fixed API surface", async (method, path) => {
    const response = await POST(request({ method, path }))
    expect(response.status).toBe(400)
    expect(executeOwnerAtriumOperationMock).not.toHaveBeenCalled()
  })

  it("rejects unexpected query fields", async () => {
    const response = await POST(
      request({
        method: "GET",
        path: "",
        query: { redirect: "https://attacker.example" },
      })
    )
    expect(response.status).toBe(400)
    expect(executeOwnerAtriumOperationMock).not.toHaveBeenCalled()
  })
})
