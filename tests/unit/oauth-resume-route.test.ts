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

const resumeUid = "r".repeat(43)
const providerCallback = jest.fn(
  (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse
  ) => {
    expect(request.url).toBe(`/auth/${resumeUid}`)
    response.statusCode = 303
    response.setHeader(
      "Location",
      "org.psd401.atrium-capture:/oauth/callback?code=code&state=state"
    )
    response.end()
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
    warn: jest.fn(),
  }),
}))

import { GET } from "@/app/auth/[uid]/route"

describe("OIDC provider resume route", () => {
  it("forwards the exact provider resume path and callback redirect", async () => {
    const response = await GET(
      new UndiciRequest(
        `https://aistudio.example/auth/${resumeUid}`
      ) as unknown as NextRequest
    )

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(
      "org.psd401.atrium-capture:/oauth/callback?code=code&state=state"
    )
  })

  it("rejects paths that are not provider resume identifiers", async () => {
    const response = await GET(
      new UndiciRequest(
        "https://aistudio.example/auth/not-a-provider-uid"
      ) as unknown as NextRequest
    )

    expect(response.status).toBe(404)
    expect(providerCallback).toHaveBeenCalledTimes(1)
  })
})
