/** @jest-environment node */

import type { NextRequest } from "next/server"
import { z } from "zod"

const mockGetAssistantForAccessCheck = jest.fn()
const mockValidateAssistantAccess = jest.fn()
const mockCheckUserRole = jest.fn()

jest.mock("@/lib/api/assistant-service", () => ({
  getAssistantForAccessCheck: (...args: unknown[]) =>
    mockGetAssistantForAccessCheck(...args),
  validateAssistantAccess: (...args: unknown[]) =>
    mockValidateAssistantAccess(...args),
}))

jest.mock("@/lib/db/drizzle", () => ({
  checkUserRole: (...args: unknown[]) => mockCheckUserRole(...args),
}))

jest.mock("@/lib/db/drizzle/resource-access", () => ({
  userCanAccessResource: jest.fn(),
  filterAccessibleResourceIds: jest.fn(),
}))

import {
  parseRequestBody,
  verifyAssistantAccess,
} from "@/lib/api/route-helpers"

describe("assistant route helper security boundaries", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAssistantForAccessCheck.mockResolvedValue({
      id: 5,
      userId: 9,
      status: "pending_approval",
    })
    mockCheckUserRole.mockResolvedValue(false)
    mockValidateAssistantAccess.mockReturnValue({ allowed: false })
  })

  it("masks a non-visible assistant with the same 404 as a missing row", async () => {
    const response = await verifyAssistantAccess(
      5,
      {
        userId: 7,
        cognitoSub: "caller-sub",
        authType: "session",
        scopes: [],
      },
      "request-1"
    )

    expect(response?.status).toBe(404)
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    })
  })

  it("rejects an oversized stream before JSON parsing", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ value: "x".repeat(256) })
    )
    const response = await parseRequestBody(
      {
        headers: new Headers({ "content-type": "application/json" }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        }),
      } as NextRequest,
      z.object({ value: z.string() }),
      "request-1",
      { maximumBytes: 64 }
    )

    expect("status" in response && response.status).toBe(413)
    await expect(
      "json" in response ? response.json() : Promise.resolve(null)
    ).resolves.toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    })
  })
})
