/** @jest-environment node */

import { beforeEach, describe, expect, it } from "@jest/globals";
import type { NextRequest } from "next/server";

/* eslint-disable no-var */
var mockCreateAssistantsFromImport: jest.Mock;
var mockRequireAdmin: jest.Mock;
var mockGetServerSession: jest.Mock;
var mockResolveUserId: jest.Mock;
/* eslint-enable no-var */

mockCreateAssistantsFromImport = jest.fn();
mockRequireAdmin = jest.fn();
mockGetServerSession = jest.fn();
mockResolveUserId = jest.fn();

jest.mock("@/lib/auth/admin-check", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("@/lib/auth/resolve-user", () => ({
  resolveUserId: (...args: unknown[]) => mockResolveUserId(...args),
}));

jest.mock("@/lib/assistant-architect/import-service", () => {
  class TestAssistantImportServiceError extends Error {
    constructor(
      public readonly code: "VALIDATION_ERROR" | "NOT_FOUND" | "FORBIDDEN",
      message: string,
    ) {
      super(message);
    }
  }

  return {
    AssistantImportServiceError: TestAssistantImportServiceError,
    IMPORTED_ASSISTANT_STATUS: "pending_approval",
    createAssistantsFromImport: (...args: unknown[]) =>
      mockCreateAssistantsFromImport(...args),
  };
});

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "req-admin-import",
  startTimer: () => jest.fn(),
}));

import { POST } from "@/app/api/admin/assistants/import/route";
import { AssistantImportServiceError } from "@/lib/assistant-architect/import-service";

function uploadRequest(contents: string): NextRequest {
  const file = {
    size: Buffer.byteLength(contents),
    type: "application/json",
    text: async () => contents,
  } as File;

  return {
    formData: async () => ({
      get: (name: string) => (name === "file" ? file : null),
    }),
  } as unknown as NextRequest;
}

describe("admin assistant import route", () => {
  beforeEach(() => {
    mockCreateAssistantsFromImport.mockReset();
    mockRequireAdmin.mockReset();
    mockGetServerSession.mockReset();
    mockResolveUserId.mockReset();
    mockRequireAdmin.mockResolvedValue(null);
    mockGetServerSession.mockResolvedValue({ sub: "admin-sub" });
    mockResolveUserId.mockResolvedValue(7);
  });

  it("returns the shared 400 validation response for a malformed envelope", async () => {
    mockCreateAssistantsFromImport.mockRejectedValue(
      new AssistantImportServiceError(
        "VALIDATION_ERROR",
        "Invalid file format: missing assistants array",
      ),
    );

    const response = await POST(uploadRequest("{}"));

    expect(mockCreateAssistantsFromImport).toHaveBeenCalledWith({}, 7);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      isSuccess: false,
      message: "Invalid file format: missing assistants array",
    });
  });
});
