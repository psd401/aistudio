import type { NextRequest } from "next/server"

const verifyContextMock = jest.fn()
const listWorkspaceObjectsMock = jest.fn()
const createWorkspaceDownloadUrlMock = jest.fn()
const createWorkspaceUploadUrlMock = jest.fn()
const createPublicArtifactUploadMock = jest.fn()
const createPublicArtifactDownloadUrlMock = jest.fn()
const completeWorkspaceUploadMock = jest.fn()

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: (...args: unknown[]) =>
    verifyContextMock(...args),
}))
jest.mock("@/lib/agent-workspace/storage-broker", () => ({
  WorkspaceStorageAdmissionError: class WorkspaceStorageAdmissionError extends Error {},
  WorkspaceStorageCompletionError: class WorkspaceStorageCompletionError extends Error {},
  listWorkspaceObjects: (...args: unknown[]) =>
    listWorkspaceObjectsMock(...args),
  createWorkspaceDownloadUrl: (...args: unknown[]) =>
    createWorkspaceDownloadUrlMock(...args),
  createWorkspaceUploadUrl: (...args: unknown[]) =>
    createWorkspaceUploadUrlMock(...args),
  createPublicArtifactUpload: (...args: unknown[]) =>
    createPublicArtifactUploadMock(...args),
  createPublicArtifactDownloadUrl: (...args: unknown[]) =>
    createPublicArtifactDownloadUrlMock(...args),
  completeWorkspaceUpload: (...args: unknown[]) =>
    completeWorkspaceUploadMock(...args),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
  }),
  generateRequestId: () => "storage-request-id",
  sanitizeForLogging: (value: unknown) => value,
}))

import { POST } from "@/app/api/agent/workspace-storage/route"
import { WorkspaceStorageCompletionError } from "@/lib/agent-workspace/storage-broker"

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
    workspacePrefix: "workspaces/owner/",
  })
  listWorkspaceObjectsMock.mockResolvedValue({ keys: [] })
  createWorkspaceUploadUrlMock.mockResolvedValue({
    uploadUrl: "https://upload.example",
    reservationId: "11111111-2222-4333-8444-555555555555",
    requiredHeaders: {},
  })
  completeWorkspaceUploadMock.mockResolvedValue({
    key: "workspaces/owner/file.txt",
  })
})

describe("POST /api/agent/workspace-storage", () => {
  it("requires a signed owner or scheduled context", async () => {
    verifyContextMock.mockResolvedValue(null)

    const response = await POST(request({ operation: "list" }))

    expect(response.status).toBe(403)
    expect(listWorkspaceObjectsMock).not.toHaveBeenCalled()
  })

  it("lists only from the signed workspace prefix", async () => {
    const response = await POST(
      request({ operation: "list", continuationToken: "next-page" })
    )

    expect(response.status).toBe(200)
    expect(listWorkspaceObjectsMock).toHaveBeenCalledWith(
      "workspaces/owner/",
      "next-page"
    )
  })

  it("rejects undeclared fields before dispatch", async () => {
    const response = await POST(
      request({
        operation: "list",
        ownerEmail: "victim@example.com",
      })
    )

    expect(response.status).toBe(400)
    expect(listWorkspaceObjectsMock).not.toHaveBeenCalled()
  })

  it("requires every integrity field for uploads", async () => {
    const response = await POST(
      request({
        operation: "upload",
        path: "file.txt",
        contentLength: 12,
      })
    )

    expect(response.status).toBe(400)
    expect(createWorkspaceUploadUrlMock).not.toHaveBeenCalled()
  })

  it("maps completion conflicts without exposing broker details", async () => {
    completeWorkspaceUploadMock.mockRejectedValue(
      new WorkspaceStorageCompletionError("already verifying")
    )

    const response = await POST(
      request({
        operation: "complete-upload",
        reservationId: "11111111-2222-4333-8444-555555555555",
      })
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Workspace storage operation failed",
    })
    expect(completeWorkspaceUploadMock).toHaveBeenCalledWith(
      "owner@example.com",
      "11111111-2222-4333-8444-555555555555"
    )
  })
})
