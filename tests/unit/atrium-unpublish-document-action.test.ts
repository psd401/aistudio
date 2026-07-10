/**
 * Unit tests for unpublishDocumentAction destination validation + outcome
 * mapping (Epic #1059 completion).
 *
 * The action receives `destination` as a plain `string` and narrows it at
 * runtime before it reaches `publishService.unpublish`. These tests assert:
 *  - every editor destination (intranet/public_web/schoology/google) forwards
 *  - `okf` (API/MCP-only by design) and garbage are rejected pre-service
 *  - the idempotent no-op path (`unpublished: false`) is a SUCCESS, not an error
 *  - a service ApprovalRequiredError (§26.4 — taking a public destination
 *    offline without authority) maps to `approvalRequired`, not a plain failure
 *
 * Collaborators (session, requester, capability check, publish service) are
 * mocked so this stays a pure control-flow unit test, mirroring
 * atrium-publish-document-action.test.ts.
 */

const unpublishMock = jest.fn(
  async (..._args: unknown[]) => ({ unpublished: true })
);

jest.mock("@/lib/content/publish-service", () => ({
  publishService: {
    unpublish: (...args: unknown[]) => unpublishMock(...args),
  },
}));

jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: jest.fn(async () => true),
}));

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "cognito-sub-1" })),
}));

jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: jest.fn(async () => ({
    kind: "user",
    userId: 7,
    roles: ["staff"],
    isAdmin: false,
  })),
}));

import { unpublishDocumentAction } from "@/actions/db/atrium/unpublish-document";
import { ApprovalRequiredError } from "@/lib/content/errors";

beforeEach(() => {
  unpublishMock.mockClear();
  unpublishMock.mockResolvedValue({ unpublished: true });
});

describe("unpublishDocumentAction — destination runtime validation", () => {
  it.each(["intranet", "public_web", "schoology", "google"])(
    "accepts the editor destination %s and forwards it to the service",
    async (destination) => {
      const result = await unpublishDocumentAction("o1", { destination });
      expect(result.isSuccess).toBe(true);
      expect(unpublishMock).toHaveBeenCalledTimes(1);
      // (requester, objectId, destination) — the narrowed destination.
      expect(unpublishMock.mock.calls[0][2]).toBe(destination);
    }
  );

  it("rejects 'okf' (API/MCP-only by design) without calling the service", async () => {
    const result = await unpublishDocumentAction("o1", { destination: "okf" });
    expect(result.isSuccess).toBe(false);
    expect(unpublishMock).not.toHaveBeenCalled();
  });

  it("rejects a garbage destination without calling the service", async () => {
    const result = await unpublishDocumentAction("o1", {
      destination: "__evil__",
    });
    expect(result.isSuccess).toBe(false);
    expect(unpublishMock).not.toHaveBeenCalled();
  });
});

describe("unpublishDocumentAction — outcome mapping", () => {
  it("treats the idempotent no-op (unpublished: false) as SUCCESS", async () => {
    unpublishMock.mockResolvedValueOnce({ unpublished: false });
    const result = await unpublishDocumentAction("o1", {
      destination: "intranet",
    });
    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.unpublished).toBe(false);
  });

  it("maps a §26.4 ApprovalRequiredError to approvalRequired (not a plain failure)", async () => {
    unpublishMock.mockRejectedValueOnce(
      new ApprovalRequiredError(
        "Unpublishing from a public destination requires approval",
        {}
      )
    );
    const result = await unpublishDocumentAction("o1", {
      destination: "public_web",
    });
    expect(result.isSuccess).toBe(false);
    if (result.isSuccess) return;
    expect(result.approvalRequired).toBe(true);
    expect(result.message).toContain("approval");
  });
});
