/**
 * Behavior tests for the `unpublish_content` MCP tool handler and the
 * `list_content` `query` pass-through (Epic #1059 completion).
 *
 * `unpublish_content` must mirror the REST DELETE
 * /api/v1/content/{id}/publish/{destination} semantics exactly:
 *   - same service call (`publishService.unpublish` with the explicit
 *     content:publish_public authority flag — the §26.4 gate lives in the
 *     service, NOT here),
 *   - same audit row (action "unpublish", surface "mcp", ok /
 *     approval_required / error outcomes),
 *   - an ApprovalRequiredError surfaces as a STRUCTURED (non-error)
 *     approval_required result, never a silent failure,
 *   - `okf` is not a valid destination (a serialized bundle has no live
 *     surface to take down — the REST route rejects it too).
 *
 * `list_content` must pass the new bounded `query` title-search filter through
 * to `contentService.list` and reject an over-long one at the zod boundary.
 */

// --- mocks (hoisted above imports by jest) ---

const mockUnpublish = jest.fn();
const mockCreate = jest.fn();
const mockList = jest.fn();
const mockRecordAudit = jest.fn();
const mockRequesterFromApiAuth = jest.fn();
const mockHasPublishPublicScope = jest.fn();
const mockAssertCapability = jest.fn();
const mockResolveCollectionId = jest.fn();

jest.mock("@/lib/content", () => {
  class MockApprovalRequiredError extends Error {}
  class MockContentError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    ApprovalRequiredError: MockApprovalRequiredError,
    __MockContentError: MockContentError,
    isContentError: (err: unknown) => err instanceof MockContentError,
    contentService: {
      create: (...a: unknown[]) => mockCreate(...a),
      list: (...a: unknown[]) => mockList(...a),
    },
    hasPublishPublicScope: (...a: unknown[]) => mockHasPublishPublicScope(...a),
    okfExportService: {},
    okfImportService: {},
    publishService: {
      unpublish: (...a: unknown[]) => mockUnpublish(...a),
    },
    recordContentAudit: (...a: unknown[]) => mockRecordAudit(...a),
    requesterFromApiAuth: (...a: unknown[]) => mockRequesterFromApiAuth(...a),
    visibilityService: {},
  };
});

jest.mock("@/lib/content/surface-helpers", () => ({
  assertContentAuthoringCapability: (...a: unknown[]) => mockAssertCapability(...a),
  contentDeepLink: (slug: string) => `/c/${slug}`,
  resolveCollectionId: (...a: unknown[]) => mockResolveCollectionId(...a),
}));

// The handlers import the REST-shared zod schemas at module scope; supply real
// (minimal) zod schemas so the module loads without pulling the full REST layer.
jest.mock("@/lib/content/rest", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { z } = require("zod") as typeof import("zod");
  const grant = z.object({ kind: z.string(), value: z.string() });
  return {
    restGrantSchema: grant,
    restVisibilitySchema: z.object({
      level: z.enum(["private", "group", "internal", "public"]),
      grants: z.array(grant).optional(),
    }),
    okfImportFilesSchema: z.array(
      z.object({ path: z.string(), content: z.string() })
    ),
  };
});

import { CONTENT_TOOL_HANDLERS } from "@/lib/mcp/content-tool-handlers";
import { ApprovalRequiredError } from "@/lib/content";
import type { McpToolContext, McpToolResult } from "@/lib/mcp/types";

const REQ = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };

function context(overrides: Partial<McpToolContext> = {}): McpToolContext {
  return {
    userId: 7,
    cognitoSub: "sub-7",
    scopes: ["content:publish_internal", "content:read"],
    requestId: "req-test-1",
    authType: "api_key",
    ...overrides,
  };
}

function payloadOf(result: McpToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequesterFromApiAuth.mockResolvedValue(REQ);
  mockAssertCapability.mockResolvedValue(undefined);
  mockHasPublishPublicScope.mockReturnValue(false);
});

describe("unpublish_content handler", () => {
  const handler = CONTENT_TOOL_HANDLERS.unpublish_content;

  it("calls publishService.unpublish with the REST DELETE's exact contract and audits ok", async () => {
    mockUnpublish.mockResolvedValue({ unpublished: true });

    const result = await handler(
      { id: "obj-1", destination: "intranet" },
      context()
    );

    expect(mockUnpublish).toHaveBeenCalledWith(REQ, "obj-1", "intranet", {
      hasPublishPublicCapability: false,
    });
    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)).toEqual({
      id: "obj-1",
      destination: "intranet",
      unpublished: true,
    });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "unpublish",
        surface: "mcp",
        objectId: "obj-1",
        destination: "intranet",
        outcome: "ok",
        requestId: "req-test-1",
      })
    );
  });

  it("surfaces the idempotent no-op (`unpublished: false`) like the REST route", async () => {
    mockUnpublish.mockResolvedValue({ unpublished: false });

    const result = await handler(
      { id: "obj-1", destination: "intranet" },
      context()
    );

    expect(result.isError).toBeUndefined();
    expect(payloadOf(result).unpublished).toBe(false);
  });

  it("passes the explicit content:publish_public authority through to the service", async () => {
    mockHasPublishPublicScope.mockReturnValue(true);
    mockUnpublish.mockResolvedValue({ unpublished: true });

    await handler({ id: "obj-1", destination: "public_web" }, context());

    expect(mockUnpublish).toHaveBeenCalledWith(REQ, "obj-1", "public_web", {
      hasPublishPublicCapability: true,
    });
  });

  it("maps ApprovalRequiredError to a STRUCTURED approval_required result (not isError) and audits it", async () => {
    mockUnpublish.mockRejectedValue(
      new ApprovalRequiredError("Unpublishing from a public destination requires approval")
    );

    const result = await handler(
      { id: "obj-1", destination: "public_web" },
      context()
    );

    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)).toEqual({
      status: "approval_required",
      message: "Unpublishing from a public destination requires approval",
    });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "unpublish",
        surface: "mcp",
        objectId: "obj-1",
        destination: "public_web",
        outcome: "approval_required",
      })
    );
  });

  it("audits an error outcome when the service throws", async () => {
    mockUnpublish.mockRejectedValue(new Error("boom"));

    const result = await handler(
      { id: "obj-1", destination: "intranet" },
      context()
    );

    expect(result.isError).toBe(true);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "unpublish",
        outcome: "error",
        error: "boom",
      })
    );
  });

  it("rejects `okf` (and any unknown destination) at the zod boundary — service never called", async () => {
    const result = await handler(
      { id: "obj-1", destination: "okf" },
      context()
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Validation failed");
    expect(mockUnpublish).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("gates session humans on the atrium-content capability before the service call", async () => {
    mockAssertCapability.mockRejectedValue(new Error("capability required"));

    const result = await handler(
      { id: "obj-1", destination: "intranet" },
      context({ authType: "session" })
    );

    expect(result.isError).toBe(true);
    expect(mockUnpublish).not.toHaveBeenCalled();
  });
});

describe("create_document handler", () => {
  const handler = CONTENT_TOOL_HANDLERS.create_document;

  it("includes visibilityLevel in the response so a create-as-private downgrade is visible to the caller", async () => {
    mockResolveCollectionId.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue({
      id: "obj-1",
      slug: "my-doc",
      visibilityLevel: "private",
    });

    const result = await handler(
      { title: "My Doc", visibility: { level: "public" } },
      context()
    );

    expect(result.isError).toBeUndefined();
    expect(payloadOf(result)).toEqual({
      id: "obj-1",
      slug: "my-doc",
      url: "/c/my-doc",
      visibilityLevel: "private",
    });
  });
});

describe("list_content `query` filter", () => {
  const handler = CONTENT_TOOL_HANDLERS.list_content;

  it("passes a bounded query through to contentService.list", async () => {
    mockResolveCollectionId.mockResolvedValue(undefined);
    mockList.mockResolvedValue([]);

    const result = await handler({ query: "acceptable use" }, context());

    expect(result.isError).toBeUndefined();
    expect(mockList).toHaveBeenCalledWith(
      REQ,
      expect.objectContaining({ query: "acceptable use" })
    );
  });

  it("omits query from the filter when not supplied", async () => {
    mockResolveCollectionId.mockResolvedValue(undefined);
    mockList.mockResolvedValue([]);

    await handler({}, context());

    expect(mockList).toHaveBeenCalledWith(
      REQ,
      expect.objectContaining({ query: undefined })
    );
  });

  it("rejects a query over 200 chars at the zod boundary — service never called", async () => {
    const result = await handler({ query: "x".repeat(201) }, context());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Validation failed");
    expect(mockList).not.toHaveBeenCalled();
  });
});
