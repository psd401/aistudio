/** @jest-environment node */

import { beforeEach, describe, expect, it } from "@jest/globals";
import { NextRequest } from "next/server";

/* eslint-disable no-var */
var mockAuthenticateRequest: jest.Mock;
var mockCheckRateLimit: jest.Mock;
var mockRecordUsage: jest.Mock;
var mockParseJsonRpcRequest: jest.Mock;
var mockHandleJsonRpcRequest: jest.Mock;
/* eslint-enable no-var */

mockAuthenticateRequest = jest.fn();
mockCheckRateLimit = jest.fn();
mockRecordUsage = jest.fn();
mockParseJsonRpcRequest = jest.fn();
mockHandleJsonRpcRequest = jest.fn();

jest.mock("@/lib/api/auth-middleware", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
}));

jest.mock("@/lib/api/rate-limiter", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimitResponse: jest.fn(),
  addRateLimitHeaders: jest.fn(),
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}));

jest.mock("@/lib/mcp/jsonrpc-handler", () => ({
  parseJsonRpcRequest: (...args: unknown[]) => mockParseJsonRpcRequest(...args),
  handleJsonRpcRequest: (...args: unknown[]) =>
    mockHandleJsonRpcRequest(...args),
}));

jest.mock("@/lib/logger", () => ({
  generateRequestId: () => "mcp-size-request",
  startTimer: () => jest.fn(),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { POST } from "@/app/api/mcp/route";
import { MCP_REQUEST_MAX_BYTES } from "@/lib/mcp/request-limits";

describe("MCP request body limits", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockCheckRateLimit.mockReset();
    mockRecordUsage.mockReset();
    mockParseJsonRpcRequest.mockReset();
    mockHandleJsonRpcRequest.mockReset();
    mockAuthenticateRequest.mockResolvedValue({
      userId: 7,
      cognitoSub: "user-7",
      scopes: ["mcp:assistants:create"],
      authType: "api-key",
    });
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      limit: 100,
      remaining: 99,
      resetAt: new Date(),
    });
  });

  it("rejects an oversized chunked-style body before JSON-RPC dispatch", async () => {
    const body = "{\"padding\":\"small\"}";
    const bytes = new TextEncoder().encode(body);
    const request = {
      url: "http://localhost/api/mcp",
      nextUrl: new URL("http://localhost/api/mcp"),
      method: "POST",
      headers: new Headers({
        "Content-Type": "application/json",
        "Content-Length": String(MCP_REQUEST_MAX_BYTES + 1),
      }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    } as unknown as NextRequest;

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: {
        message: "Request payload too large",
      },
    });
    expect(mockHandleJsonRpcRequest).not.toHaveBeenCalled();
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.anything(),
      request,
      413,
      expect.any(Number),
    );
  });

  it("preserves non-assistant MCP operations above the assistant envelope limit", async () => {
    const body = `{"padding":"${"x".repeat(11 * 1024 * 1024)}"}`;
    const bytes = new TextEncoder().encode(body);
    const request = {
      url: "http://localhost/api/mcp",
      nextUrl: new URL("http://localhost/api/mcp"),
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    } as unknown as NextRequest;
    mockParseJsonRpcRequest.mockReturnValue({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "import_okf", arguments: {} },
    });
    mockHandleJsonRpcRequest.mockResolvedValue({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [] },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockHandleJsonRpcRequest).toHaveBeenCalled();
  });
});
