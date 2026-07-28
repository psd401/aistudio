/** @jest-environment node */

import {
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals"
import { NextRequest, NextResponse } from "next/server"

/* eslint-disable no-var */
var mockCreateAssistantsFromImport: jest.Mock
var mockUpdateAssistantFromImport: jest.Mock
var mockForkAssistant: jest.Mock
var mockGetRequiredScopes: jest.Mock
var mockGetCatalogEntry: jest.Mock
/* eslint-enable no-var */

mockCreateAssistantsFromImport = jest.fn()
mockUpdateAssistantFromImport = jest.fn()
mockForkAssistant = jest.fn()
mockGetRequiredScopes = jest.fn()
mockGetCatalogEntry = jest.fn()

jest.mock("@/lib/api", () => ({
  withApiAuth: (handler: unknown) => handler,
  requireScope: (
    auth: { scopes: string[] },
    scope: string,
    requestId: string,
  ) =>
    auth.scopes.includes("*") || auth.scopes.includes(scope)
      ? null
      : NextResponse.json(
          {
            error: {
              code: "INSUFFICIENT_SCOPE",
              message: `Missing required scope: ${scope}`,
            },
            requestId,
          },
          { status: 403 },
        ),
  createApiResponse: (
    body: unknown,
    requestId: string,
    status: number = 200,
  ) =>
    NextResponse.json(body, {
      status,
      headers: { "X-Request-Id": requestId },
    }),
  createErrorResponse: (
    requestId: string,
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) =>
    NextResponse.json(
      {
        error: {
          code,
          message,
          ...(details !== undefined ? { details } : {}),
        },
        requestId,
      },
      { status },
    ),
  extractNumericParam: (url: string, segmentName: string) => {
    const segments = new URL(url).pathname.split("/")
    const index = segments.indexOf(segmentName)
    const value = segments[index + 1]
    if (!value || !/^[1-9]\d*$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  },
  verifyAssistantAccess: jest.fn(() => null),
  isAdminByUserId: jest.fn(() => false),
}))

jest.mock("@/lib/assistant-architect/import-service", () => {
  class TestAssistantImportServiceError extends Error {
    constructor(
      public readonly code:
        | "VALIDATION_ERROR"
        | "NOT_FOUND"
        | "CONFLICT",
      message: string,
    ) {
      super(message)
    }
  }
  return {
    AssistantImportServiceError: TestAssistantImportServiceError,
    createAssistantsFromImport: (...args: unknown[]) =>
      mockCreateAssistantsFromImport(...args),
    updateAssistantFromImport: (...args: unknown[]) =>
      mockUpdateAssistantFromImport(...args),
    forkAssistant: (...args: unknown[]) => mockForkAssistant(...args),
  }
})

jest.mock("@/lib/tools/catalog/catalog", () => ({
  toolCatalogInstance: {
    get: (...args: unknown[]) => mockGetCatalogEntry(...args),
    getRequiredScopes: (...args: unknown[]) => mockGetRequiredScopes(...args),
  },
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import { POST as createAssistantsRoute } from "@/app/api/v1/assistants/import/route"
import { PUT as updateAssistantRoute } from "@/app/api/v1/assistants/[id]/route"
import { POST as forkAssistantRoute } from "@/app/api/v1/assistants/[id]/fork/route"
import { AssistantImportServiceError } from "@/lib/assistant-architect/import-service"

interface RawRouteAuth {
  userId: number
  scopes: string[]
}

type RawRouteHandler = (
  request: NextRequest,
  auth: RawRouteAuth,
  requestId: string,
) => Promise<NextResponse>

const createRoute = createAssistantsRoute as unknown as RawRouteHandler
const updateRoute = updateAssistantRoute as unknown as RawRouteHandler
const forkRoute = forkAssistantRoute as unknown as RawRouteHandler

const importEnvelope = {
  version: "1.0",
  exported_at: "2026-07-28T00:00:00.000Z",
  assistants: [
    {
      name: "REST assistant",
      description: "Created through v1",
      status: "approved",
      prompts: [
        {
          name: "Prompt",
          content: "Hello",
          model_name: "gpt-source",
          position: 0,
        },
      ],
      input_fields: [],
    },
  ],
}

function jsonRequest(
  url: string,
  method: string,
  body: string,
  contentLength?: number,
): NextRequest {
  const bytes = new TextEncoder().encode(body)
  return {
    url,
    method,
    headers: new Headers({
      "Content-Type": "application/json",
      ...(contentLength === undefined
        ? {}
        : { "Content-Length": String(contentLength) }),
    }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  } as unknown as NextRequest
}

function resetMocks(): void {
  mockCreateAssistantsFromImport.mockReset()
  mockUpdateAssistantFromImport.mockReset()
  mockForkAssistant.mockReset()
  mockGetCatalogEntry.mockReset()
  mockGetRequiredScopes.mockReset()
  mockGetCatalogEntry.mockResolvedValue(undefined)
  mockGetRequiredScopes.mockResolvedValue(["assistants:write"])
}

describe("Assistant import REST v1 routes", () => {
  beforeEach(resetMocks)

  it("denies create when the API key lacks assistants:write", async () => {
    const response = await createRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/import",
        "POST",
        JSON.stringify(importEnvelope),
      ),
      { userId: 7, scopes: [] },
      "req-create-denied",
    )

    expect(response.status).toBe(403)
    expect(mockCreateAssistantsFromImport).not.toHaveBeenCalled()
  })

  it.each([
    ["create", createRoute, "http://localhost/api/v1/assistants/import", "POST"],
    ["update", updateRoute, "http://localhost/api/v1/assistants/12", "PUT"],
    ["fork", forkRoute, "http://localhost/api/v1/assistants/12/fork", "POST"],
  ])(
    "returns a masked 404 when the %s catalog operation is disabled",
    async (_operation, route, url, method) => {
      mockGetCatalogEntry.mockResolvedValue({
        isActive: false,
        requiredScopes: ["assistants:write"],
        surfaceScopes: { rest: ["assistants:write"] },
      })

      const response = await route(
        jsonRequest(url, method, JSON.stringify(importEnvelope)),
        { userId: 7, scopes: ["assistants:write"] },
        "req-disabled",
      )

      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({
        error: { code: "NOT_FOUND" },
      })
      expect(mockCreateAssistantsFromImport).not.toHaveBeenCalled()
      expect(mockUpdateAssistantFromImport).not.toHaveBeenCalled()
      expect(mockForkAssistant).not.toHaveBeenCalled()
    },
  )

  it("denies update when the API key lacks assistants:write", async () => {
    const response = await updateRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/12",
        "PUT",
        JSON.stringify(importEnvelope),
      ),
      { userId: 7, scopes: [] },
      "req-update-denied",
    )

    expect(response.status).toBe(403)
    expect(mockUpdateAssistantFromImport).not.toHaveBeenCalled()
  })

  it("returns 400 for malformed JSON after scope authorization", async () => {
    const response = await createRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/import",
        "POST",
        "{not-json",
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-invalid-json",
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_JSON" },
    })
  })

  it("creates assistants for a scoped caller and returns model mappings", async () => {
    mockCreateAssistantsFromImport.mockResolvedValue({
      total: 1,
      successful: 1,
      failed: 0,
      results: [
        {
          name: "REST assistant",
          id: 31,
          status: "pending_approval",
        },
      ],
      modelMappings: [{ modelName: "gpt-source", mappedToId: 91 }],
    })

    const response = await createRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/import",
        "POST",
        JSON.stringify(importEnvelope),
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-create",
    )

    expect(response.status).toBe(201)
    expect(mockCreateAssistantsFromImport).toHaveBeenCalledWith(
      importEnvelope,
      7,
    )
    expect(await response.json()).toMatchObject({
      data: {
        results: [{ id: 31, status: "pending_approval" }],
        modelMappings: [{ modelName: "gpt-source", mappedToId: 91 }],
      },
    })
  })

  it("updates exactly the path assistant for a scoped caller", async () => {
    mockUpdateAssistantFromImport.mockResolvedValue({
      result: {
        name: "REST assistant",
        id: 12,
        status: "pending_approval",
      },
      modelMappings: [{ modelName: "gpt-source", mappedToId: 91 }],
    })

    const response = await updateRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/12",
        "PUT",
        JSON.stringify(importEnvelope),
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-update",
    )

    expect(response.status).toBe(200)
    expect(mockUpdateAssistantFromImport).toHaveBeenCalledWith(
      12,
      importEnvelope,
      7,
    )
  })

  it("rejects a partially numeric update path without calling the service", async () => {
    const response = await updateRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/12junk",
        "PUT",
        JSON.stringify(importEnvelope),
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-update-malformed-id",
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    })
    expect(mockUpdateAssistantFromImport).not.toHaveBeenCalled()
  })
})

describe("Assistant fork REST v1 route", () => {
  beforeEach(resetMocks)

  it("forks through the catalog-resolved write scope", async () => {
    mockForkAssistant.mockResolvedValue({
      result: {
        name: "Caller copy",
        id: 44,
        status: "pending_approval",
      },
      modelMappings: [{ modelName: "gpt-source", mappedToId: 91 }],
    })

    const response = await forkRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/12/fork",
        "POST",
        JSON.stringify({ name: "Caller copy" }),
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-fork",
    )

    expect(response.status).toBe(201)
    expect(mockForkAssistant).toHaveBeenCalledWith(12, 7, "Caller copy")
    expect(await response.json()).toMatchObject({
      data: {
        sourceAssistantId: 12,
        result: { id: 44, status: "pending_approval" },
      },
    })
  })

  it("forks with the source-derived name when the optional body is empty", async () => {
    mockForkAssistant.mockResolvedValue({
      result: {
        name: "Source copy",
        id: 45,
        status: "pending_approval",
      },
      modelMappings: [],
    })

    const response = await forkRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/12/fork",
        "POST",
        "",
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-fork-empty",
    )

    expect(response.status).toBe(201)
    expect(mockForkAssistant).toHaveBeenCalledWith(12, 7, undefined)
  })

  it("rejects undocumented fork body properties before mutation", async () => {
    const response = await forkRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/12/fork",
        "POST",
        JSON.stringify({ name: "Caller copy", unexpected: true }),
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-fork-unknown-property",
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    })
    expect(mockForkAssistant).not.toHaveBeenCalled()
  })
})

describe("Assistant import REST v1 payload limits", () => {
  beforeEach(resetMocks)

  it("rejects an oversized streamed create payload without Content-Length", async () => {
    const oversizedBody = `{"padding":"${"x".repeat(10 * 1024 * 1024)}"}`
    const request = jsonRequest(
      "http://localhost/api/v1/assistants/import",
      "POST",
      oversizedBody,
    )

    expect(request.headers.get("content-length")).toBeNull()
    const response = await createRoute(
      request,
      { userId: 7, scopes: ["assistants:write"] },
      "req-create-stream-too-large",
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    })
    expect(mockCreateAssistantsFromImport).not.toHaveBeenCalled()
  })

  it("rejects an oversized create payload before parsing or importing", async () => {
    const response = await createRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/import",
        "POST",
        JSON.stringify(importEnvelope),
        10 * 1024 * 1024 + 1,
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-create-too-large",
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    })
    expect(mockCreateAssistantsFromImport).not.toHaveBeenCalled()
  })

  it("rejects an oversized update payload before parsing or importing", async () => {
    const response = await updateRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/12",
        "PUT",
        JSON.stringify(importEnvelope),
        10 * 1024 * 1024 + 1,
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-update-too-large",
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    })
    expect(mockUpdateAssistantFromImport).not.toHaveBeenCalled()
  })

  it("rejects an oversized streamed fork payload before forking", async () => {
    const response = await forkRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/12/fork",
        "POST",
        JSON.stringify({ name: "x".repeat(4 * 1024) }),
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-fork-too-large",
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    })
    expect(mockForkAssistant).not.toHaveBeenCalled()
  })
})

describe("Assistant import REST v1 service authorization errors", () => {
  beforeEach(resetMocks)

  it("returns a masked 404 when a staff caller updates another owner's assistant", async () => {
    mockUpdateAssistantFromImport.mockRejectedValue(
      new AssistantImportServiceError(
        "NOT_FOUND",
        "Assistant not found: 12",
      ),
    )

    const response = await updateRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/12",
        "PUT",
        JSON.stringify(importEnvelope),
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-update-forbidden",
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    })
  })

  it("returns 409 when an execution is still using the assistant prompts", async () => {
    mockUpdateAssistantFromImport.mockRejectedValue(
      new AssistantImportServiceError(
        "CONFLICT",
        "Assistant cannot be updated while an execution is in progress",
      ),
    )

    const response = await updateRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/12",
        "PUT",
        JSON.stringify(importEnvelope),
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-update-conflict",
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: "CONFLICT" },
    })
  })

  it("returns a masked 404 when the fork source is not visible", async () => {
    mockForkAssistant.mockRejectedValue(
      new AssistantImportServiceError("NOT_FOUND", "Assistant not found: 12"),
    )

    const response = await forkRoute(
      jsonRequest(
        "http://localhost/api/v1/assistants/12/fork",
        "POST",
        "{}",
      ),
      { userId: 7, scopes: ["assistants:write"] },
      "req-fork-hidden",
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    })
  })
})
