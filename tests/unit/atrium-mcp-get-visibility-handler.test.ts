/**
 * Behavior tests for the `get_visibility` MCP tool handler (#1763).
 *
 * `get_content` reports only a `grantCount` integer and `set_visibility`
 * REPLACES the grant list, so an MCP caller changing an audience without this
 * read has to guess the existing entries — and a wrong guess silently drops
 * access no audit trail can restore. What this pins:
 *
 *   - it goes through the SHARED `readVisibilityForEdit`, the same helper the
 *     REST v1 GET and the agent broker use, so the three surfaces cannot drift
 *     apart on who may enumerate an audience,
 *   - it does NOT call `assertContentAuthoringCapability` — reading back an
 *     audience you already own is not authoring, and gating it would hide an
 *     owner's own grants from them (matches `get_content`),
 *   - it writes NO audit row (§27 does not audit reads) and maps a denial
 *     through the read path, preserving the service's 404-mask vs 403 shape
 *     rather than flattening both into one message.
 */

const mockReadVisibilityForEdit = jest.fn();
const mockRecordAudit = jest.fn();
const mockRequesterFromApiAuth = jest.fn();
const mockAssertCapability = jest.fn();

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
    contentService: {},
    hasPublishPublicScope: () => false,
    okfExportService: {},
    okfImportService: {},
    publishService: {},
    readVisibilityForEdit: (...a: unknown[]) => mockReadVisibilityForEdit(...a),
    recordContentAudit: (...a: unknown[]) => mockRecordAudit(...a),
    requesterFromApiAuth: (...a: unknown[]) => mockRequesterFromApiAuth(...a),
    visibilityService: {},
  };
});

jest.mock("@/lib/content/surface-helpers", () => ({
  assertContentAuthoringCapability: (...a: unknown[]) =>
    mockAssertCapability(...a),
  contentDeepLink: (slug: string) => `/c/${slug}`,
  contentSurfaceLink: (object: { id: string; slug: string }) =>
    `/c/${object.slug}`,
  resolveCollectionId: jest.fn(),
}));

jest.mock("@/lib/content/rest", () => {
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
import type { McpToolContext, McpToolResult } from "@/lib/mcp/types";

const REQ = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };

function context(overrides: Partial<McpToolContext> = {}): McpToolContext {
  return {
    userId: 7,
    cognitoSub: "sub-7",
    scopes: ["content:read"],
    requestId: "req-get-visibility-1",
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
});

describe("get_visibility handler (#1763)", () => {
  const handler = CONTENT_TOOL_HANDLERS.get_visibility;

  it("returns the level and the ACTUAL grant entries, not just a count", async () => {
    mockReadVisibilityForEdit.mockResolvedValue({
      id: "obj-1",
      visibility: {
        visibilityLevel: "group",
        grants: [
          { kind: "role", value: "staff" },
          { kind: "user", value: "41" },
        ],
      },
    });

    const result = await handler({ id: "some-slug" }, context());

    expect(result.isError).toBeFalsy();
    expect(payloadOf(result)).toEqual({
      id: "obj-1",
      visibilityLevel: "group",
      grants: [
        { kind: "role", value: "staff" },
        { kind: "user", value: "41" },
      ],
      // The count stays alongside the entries so a caller migrating off
      // get_content's grantCount does not have to change two things at once.
      grantCount: 2,
    });
    // Resolved by the caller's slug-or-id, as the requester built from the
    // MCP session — never a bare view.
    expect(mockReadVisibilityForEdit).toHaveBeenCalledWith(REQ, "some-slug");
  });

  it("does not gate the read on the authoring capability, and audits nothing", async () => {
    mockReadVisibilityForEdit.mockResolvedValue({
      id: "obj-1",
      visibility: { visibilityLevel: "internal", grants: [] },
    });

    await handler({ id: "obj-1" }, context({ authType: "session" }));

    // Reading your own audience is not authoring — even for a session caller,
    // which is the only authType that gate applies to.
    expect(mockAssertCapability).not.toHaveBeenCalled();
    // §27 audits writes, not reads.
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("reports an empty audience as an empty list, not a missing field", async () => {
    mockReadVisibilityForEdit.mockResolvedValue({
      id: "obj-2",
      visibility: { visibilityLevel: "private", grants: [] },
    });

    expect(payloadOf(await handler({ id: "obj-2" }, context()))).toEqual({
      id: "obj-2",
      visibilityLevel: "private",
      grants: [],
      grantCount: 0,
    });
  });

  it("surfaces the service's denial code so the 404 mask stays distinguishable", async () => {
    const { __MockContentError } = jest.requireMock("@/lib/content") as {
      __MockContentError: new (code: string, message: string) => Error;
    };
    mockReadVisibilityForEdit.mockRejectedValue(
      new __MockContentError("CONTENT_NOT_FOUND", "Content not found")
    );

    const result = await handler({ id: "obj-1" }, context());

    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toEqual({
      error: "CONTENT_NOT_FOUND",
      message: "Content not found",
    });
    // A read failure is not an audited event.
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("rejects a missing id at the zod boundary before resolving the caller", async () => {
    const result = await handler({}, context());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Validation failed");
    expect(mockRequesterFromApiAuth).not.toHaveBeenCalled();
    expect(mockReadVisibilityForEdit).not.toHaveBeenCalled();
  });
});
