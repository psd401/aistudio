/** @jest-environment node */

import type { ServerResponse } from "node:http"
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

const mockInteractionDetails = jest.fn()
const mockInteractionFinished = jest.fn(
  async (...args: unknown[]): Promise<void> => {
    const response = args[1] as ServerResponse
    response.statusCode = 303
    response.setHeader(
      "Location",
      "/api/oauth/auth/resume/provider-returned"
    )
    response.end()
  }
)
const mockClientFind = jest.fn()

class TestGrant {
  static find = jest.fn()
  readonly jti = "grant-created"
  readonly accountId: string
  readonly clientId: string
  readonly addOIDCScope = jest.fn()
  readonly addOIDCClaims = jest.fn()
  readonly addResourceScope = jest.fn()
  readonly save = jest.fn(async () => this.jti)

  constructor(properties: { accountId: string; clientId: string }) {
    this.accountId = properties.accountId
    this.clientId = properties.clientId
  }
}

const mockProvider = {
  interactionDetails: mockInteractionDetails,
  interactionFinished: mockInteractionFinished,
  Client: { find: mockClientFind },
  Grant: TestGrant,
}

jest.mock("server-only", () => ({}))
jest.mock("@/lib/oauth/oidc-provider-config", () => ({
  getOidcProvider: jest.fn(async () => mockProvider),
}))
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(),
}))
jest.mock("@/lib/db/drizzle/utils", () => ({
  getUserIdByCognitoSubAsNumber: jest.fn(),
}))
jest.mock("@/lib/oauth/consent-decisions", () => ({
  consumeConsentDecision: jest.fn(),
}))
jest.mock("@/lib/logger", () => ({
  generateRequestId: () => "request-id",
  createLogger: () => ({
    warn: jest.fn(),
  }),
}))

import { getServerSession } from "@/lib/auth/server-session"
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle/utils"
import { consumeConsentDecision } from "@/lib/oauth/consent-decisions"
import { GET } from "@/app/(protected)/oauth/authorize/interaction/[uid]/[action]/route"

const mockGetServerSession = jest.mocked(getServerSession)
const mockGetUserId = jest.mocked(getUserIdByCognitoSubAsNumber)
const mockConsumeDecision = jest.mocked(consumeConsentDecision)

function request(action: string): NextRequest {
  return new UndiciRequest(
    `https://aistudio.example/oauth/authorize/interaction/interaction-1/${action}?account_id=999`,
    { headers: { cookie: "_interaction=signed-cookie" } }
  ) as unknown as NextRequest
}

function context(action: string) {
  return {
    params: Promise.resolve({
      uid: "interaction-1",
      action,
    }),
  }
}

describe("OAuth interaction completion route", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerSession.mockResolvedValue({ sub: "cognito-user" })
    mockGetUserId.mockResolvedValue(42)
    mockClientFind.mockResolvedValue({
      clientId: "third-party-client",
      scope: "openid profile content:read",
    })
    TestGrant.find.mockResolvedValue(undefined)
  })

  it("uses the authenticated server account for login, never a client value", async () => {
    mockInteractionDetails.mockResolvedValue({
      uid: "interaction-1",
      prompt: { name: "login", details: {} },
      params: { client_id: "atrium-client" },
    })

    const response = await GET(request("login"), context("login"))

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(
      "/api/oauth/auth/resume/provider-returned"
    )
    expect(mockInteractionFinished).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { login: { accountId: "42" } },
      { mergeWithLastSubmission: false }
    )
  })

  it("sends a signed-out user through district login with the uid intact", async () => {
    mockGetServerSession.mockResolvedValue(null)
    mockInteractionDetails.mockResolvedValue({
      uid: "interaction-1",
      prompt: { name: "login", details: {} },
      params: { client_id: "atrium-client" },
    })

    const response = await GET(request("login"), context("login"))

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(
      "/api/auth/signin?callbackUrl=%2Foauth%2Fauthorize%3Fuid%3Dinteraction-1"
    )
    expect(mockInteractionFinished).not.toHaveBeenCalled()
  })

  it("creates an untrusted-client consent grant from provider state", async () => {
    mockInteractionDetails.mockResolvedValue({
      uid: "interaction-1",
      grantId: undefined,
      session: { accountId: "42" },
      prompt: {
        name: "consent",
        details: {
          missingOIDCScope: ["openid", "profile"],
          missingResourceScopes: {
            "https://aistudio.example/api/oauth": ["content:read"],
          },
        },
      },
      params: { client_id: "third-party-client" },
    })
    mockConsumeDecision.mockResolvedValue({
      approved: true,
      userId: 42,
      scopes: [],
      createdAt: Date.now(),
    })

    const response = await GET(
      request("consent"),
      context("consent")
    )

    expect(response.status).toBe(303)
    const result = mockInteractionFinished.mock.calls.at(-1)?.[2]
    expect(result).toEqual({
      consent: { grantId: "grant-created" },
    })
  })

  it("fails closed when consent contains a scope absent from allowedScopes", async () => {
    mockInteractionDetails.mockResolvedValue({
      uid: "interaction-1",
      session: { accountId: "42" },
      prompt: {
        name: "consent",
        details: {
          missingResourceScopes: {
            "https://aistudio.example/api/oauth": ["content:update"],
          },
        },
      },
      params: { client_id: "third-party-client" },
    })
    mockConsumeDecision.mockResolvedValue({
      approved: true,
      userId: 42,
      scopes: [],
      createdAt: Date.now(),
    })

    const response = await GET(
      request("consent"),
      context("consent")
    )

    expect(response.status).toBe(400)
    expect(mockInteractionFinished).not.toHaveBeenCalled()
  })

  it("fails closed when the client is inactive or unavailable", async () => {
    mockClientFind.mockResolvedValue(undefined)
    mockInteractionDetails.mockResolvedValue({
      uid: "interaction-1",
      session: { accountId: "42" },
      prompt: {
        name: "consent",
        details: { missingOIDCScope: ["openid"] },
      },
      params: { client_id: "inactive-client" },
    })
    mockConsumeDecision.mockResolvedValue({
      approved: true,
      userId: 42,
      scopes: [],
      createdAt: Date.now(),
    })

    const response = await GET(
      request("consent"),
      context("consent")
    )

    expect(response.status).toBe(400)
    expect(mockInteractionFinished).not.toHaveBeenCalled()
  })

  it("preserves denial through oidc-provider's public completion API", async () => {
    mockInteractionDetails.mockResolvedValue({
      uid: "interaction-1",
      session: { accountId: "42" },
      prompt: { name: "consent", details: {} },
      params: { client_id: "third-party-client" },
    })
    mockConsumeDecision.mockResolvedValue({
      approved: false,
      userId: 42,
      scopes: [],
      createdAt: Date.now(),
    })

    const response = await GET(request("abort"), context("abort"))

    expect(response.status).toBe(303)
    expect(mockInteractionFinished).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        error: "access_denied",
        error_description: "End-User denied authorization",
      },
      { mergeWithLastSubmission: false }
    )
  })

  it("rejects a route uid that does not match the signed interaction", async () => {
    mockInteractionDetails.mockResolvedValue({
      uid: "different-interaction",
      prompt: { name: "login", details: {} },
      params: { client_id: "atrium-client" },
    })

    const response = await GET(request("login"), context("login"))

    expect(response.status).toBe(400)
    expect(mockInteractionFinished).not.toHaveBeenCalled()
  })
})
