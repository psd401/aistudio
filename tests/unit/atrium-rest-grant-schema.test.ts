/**
 * REST/MCP grant-kind schema acceptance (Epic #1202 Phase 2, #1205 review).
 *
 * `restGrantSchema` in `lib/content/rest.ts` gates the REST v1 content routes
 * AND is reused verbatim by the MCP content tool handlers (`grantZ` /
 * `visibilityZ` in `lib/mcp/content-tool-handlers.ts`). The first cut of #1205
 * updated the server-action validator (`GRANT_KIND_SET`) but not this Zod
 * enum, so REST/MCP callers were 400-rejected on `kind: "group"` while the UI
 * worked — these tests pin the schema to the canonical kind list so the two
 * can never drift apart again.
 */

import { GRANT_KIND_SET } from "@/lib/content/validators";

// rest.ts pulls the request/audit machinery at module scope; inert stubs keep
// this a pure schema test (the real Zod objects are what we import).
jest.mock("@/lib/api/auth-middleware", () => ({
  createApiResponse: jest.fn(),
  createErrorResponse: jest.fn(),
}));
jest.mock("@/lib/content/audit", () => ({
  recordContentAudit: jest.fn(),
}));
jest.mock("@/lib/content/requester-from-auth", () => ({
  requesterFromApiAuth: jest.fn(),
}));

import { restGrantSchema, restVisibilitySchema } from "@/lib/content/rest";

describe("restGrantSchema (REST + MCP shared grant validation)", () => {
  it.each([...GRANT_KIND_SET])(
    "accepts every canonical grant kind, including %s",
    (kind) => {
      const parsed = restGrantSchema.safeParse({ kind, value: "x@y.com" });
      expect(parsed.success).toBe(true);
    }
  );

  it("accepts a group-level visibility payload carrying a group grant", () => {
    const parsed = restVisibilitySchema.safeParse({
      level: "group",
      grants: [{ kind: "group", value: "hs-staff-group@example.com" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("still rejects an unknown grant kind", () => {
    const parsed = restGrantSchema.safeParse({
      kind: "__evil__",
      value: "x",
    });
    expect(parsed.success).toBe(false);
  });
});
