/** @jest-environment node */

import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

let outstandingCount = 0
const insertedValues: unknown[] = []
const executeMock = jest.fn(async () => undefined)
const deleteMock = jest.fn(() => ({ where: async () => undefined }))
const selectMock = jest.fn(() => ({
  from: () => ({ where: async () => [{ value: outstandingCount }] }),
}))
const insertMock = jest.fn(() => ({
  values: async (values: unknown) => {
    insertedValues.push(values)
  },
}))
const executeTransactionMock = jest.fn(
  async (callback: (tx: {
    execute: typeof executeMock
    delete: typeof deleteMock
    select: typeof selectMock
    insert: typeof insertMock
  }) => Promise<void>) =>
    callback({
      execute: executeMock,
      delete: deleteMock,
      select: selectMock,
      insert: insertMock,
    }),
)
const interactionSummaryMock = jest.fn<
  (uid: string, requestHeaders: Headers) => Promise<
    | {
        uid: string
        promptName: string
        promptDetails: Record<string, unknown>
        clientId: string
        clientName: string
        requestedScopes: string[]
      }
    | undefined
  >
>()

jest.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "signed-interaction=cookie" }),
}))
jest.mock("@/lib/oauth/interaction-service", () => ({
  getOAuthInteractionSummary: interactionSummaryMock,
}))
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: async () => ({ sub: "cognito-sub" }),
}))
jest.mock("@/lib/db/drizzle/utils", () => ({
  getUserIdByCognitoSubAsNumber: async () => 42,
}))
jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: executeTransactionMock,
}))
jest.mock("@/lib/db/schema", () => ({
  oauthConsentDecisions: {
    expiresAt: "expires_at",
    userId: "user_id",
  },
}))
jest.mock("@/lib/oauth/issuer-config", () => ({
  getIssuerUrl: () => "https://issuer.example",
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  generateRequestId: () => "request-id",
  startTimer: () => jest.fn(),
}))
jest.mock("@/lib/error-utils", () => ({
  createSuccess: (data: unknown, message: string) => ({
    isSuccess: true,
    data,
    message,
  }),
  handleError: (error: unknown) => ({
    isSuccess: false,
    message: error instanceof Error ? error.message : String(error),
  }),
  ErrorFactories: {
    authNoSession: () => new Error("no session"),
    validationFailed: () => new Error("OAuth interaction is invalid or expired"),
    bizQuotaExceeded: () => new Error("OAuth consent quota exceeded"),
  },
}))

function summary(uid: string) {
  return {
    uid,
    promptName: "consent",
    promptDetails: {},
    clientId: "client-id",
    clientName: "Client",
    requestedScopes: ["openid"],
  }
}

describe("OAuth consent allocation controls", () => {
  let approveConsent: typeof import("@/actions/oauth/consent.actions").approveConsent

  beforeAll(async () => {
    ({ approveConsent } = await import("@/actions/oauth/consent.actions"))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    insertedValues.length = 0
    outstandingCount = 0
  })

  it("rejects a uid that is not bound to the signed provider interaction", async () => {
    interactionSummaryMock.mockResolvedValueOnce(undefined)

    const result = await approveConsent("attacker-selected-uid")

    expect(result).toEqual(expect.objectContaining({
      isSuccess: false,
      message: expect.stringMatching(/invalid or expired/i),
    }))
    expect(executeTransactionMock).not.toHaveBeenCalled()
  })

  it("cleans expired rows and atomically reserves a bounded decision", async () => {
    interactionSummaryMock.mockResolvedValueOnce(summary("valid-uid"))

    const result = await approveConsent("valid-uid")

    expect(result).toEqual(expect.objectContaining({ isSuccess: true }))
    expect(executeMock).toHaveBeenCalledTimes(1)
    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(insertedValues[0]).toEqual(expect.objectContaining({
      uid: "valid-uid",
      userId: 42,
      approved: true,
    }))
  })

  it("fails closed at the outstanding-decision cap", async () => {
    outstandingCount = 10
    interactionSummaryMock.mockResolvedValueOnce(summary("valid-uid"))

    const result = await approveConsent("valid-uid")

    expect(result).toEqual(expect.objectContaining({
      isSuccess: false,
      message: expect.stringMatching(/quota exceeded/i),
    }))
    expect(insertMock).not.toHaveBeenCalled()
  })
})
