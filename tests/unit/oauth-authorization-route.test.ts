/** @jest-environment node */

import type { NextRequest } from "next/server"
import {
  Headers as UndiciHeaders,
  Request as UndiciRequest,
  Response as UndiciResponse,
} from "undici"

Object.assign(globalThis, {
  Headers: UndiciHeaders,
  Request: UndiciRequest,
  Response: UndiciResponse,
})

const providerCallback = jest.fn(
  (
    _request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse
  ) => {
    response.statusCode = 303
    response.setHeader("Location", "/oauth/authorize?uid=interaction-123")
    response.setHeader("Set-Cookie", [
      "_interaction=one; Path=/api/oauth; HttpOnly",
      "_session=two; Path=/api/oauth; HttpOnly",
    ])
    response.end("Redirecting…")
  }
)

jest.mock("@/lib/oauth/oidc-provider-config", () => ({
  getOidcProvider: jest.fn(async () => ({
    callback: () => providerCallback,
  })),
}))

jest.mock("@/lib/logger", () => ({
  generateRequestId: () => "request-id",
  createLogger: () => ({
    error: jest.fn(),
  }),
}))

import { GET, POST } from "@/app/api/oauth/[...oidc]/route"

describe("OAuth authorization route", () => {
  beforeEach(() => {
    providerCallback.mockClear()
  })

  it("returns the provider's real redirect and separate cookies", async () => {
    const response = await GET(
      new UndiciRequest(
        "https://aistudio.example/api/oauth/auth?client_id=atrium"
      ) as unknown as NextRequest
    )

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(
      "/oauth/authorize?uid=interaction-123"
    )
    expect(response.headers.getSetCookie()).toEqual([
      "_interaction=one; Path=/api/oauth; HttpOnly",
      "_session=two; Path=/api/oauth; HttpOnly",
    ])
    expect(await response.text()).toBe("Redirecting…")
  })

  it.each([
    ["/api/oauth/revocation", "/revocation"],
    ["/api/oauth/token/revocation", "/revocation"],
  ])("routes %s to the provider revocation endpoint", async (path, expected) => {
    await POST(
      new UndiciRequest(`https://aistudio.example${path}`, {
        method: "POST",
      }) as unknown as NextRequest
    )

    expect(providerCallback).toHaveBeenCalledTimes(1)
    expect(providerCallback.mock.calls[0]?.[0].url).toBe(expected)
  })
})
