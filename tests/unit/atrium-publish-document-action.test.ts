/**
 * Unit tests for publishDocumentAction grant.kind validation (PR #1062 review #10)
 * and destination validation / §26.4 pending-approval mapping (Epic #1059
 * completion).
 *
 * The action receives `visibility.grants[].kind` AND `destination` as plain
 * `string`s (widened for the API surface) and narrows each with a RUNTIME guard
 * (`assertGrantKind` / `assertEditorDestination`) before handing them to
 * `publishService.publish`. These tests assert:
 *  - an invalid `kind` returns an error ActionState and NEVER reaches the service
 *  - every valid `kind` passes through to the service unchanged
 *  - publishing with no visibility passes through (guard not exercised)
 *  - every editor destination (intranet/public_web/schoology/google) forwards;
 *    `okf` (API/MCP-only by design) and garbage are rejected pre-service
 *  - a service ApprovalRequiredError maps to `{ isSuccess: false,
 *    approvalRequired: true }` — the amber pending outcome, not a plain failure
 *
 * Collaborators (session, requester, capability check, publish service) are mocked
 * so this stays a pure control-flow unit test.
 */

const publishMock = jest.fn(
  async (..._args: unknown[]) => ({
    publicationId: "pub1",
    publishedVersionId: "v1",
  })
);

jest.mock("@/lib/content/publish-service", () => ({
  publishService: { publish: (...args: unknown[]) => publishMock(...args) },
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

import { publishDocumentAction } from "@/actions/db/atrium/publish-document";
import { ApprovalRequiredError } from "@/lib/content/errors";

beforeEach(() => {
  publishMock.mockClear();
  publishMock.mockResolvedValue({
    publicationId: "pub1",
    publishedVersionId: "v1",
  });
});

describe("publishDocumentAction — grant.kind runtime validation", () => {
  it("rejects an invalid grant kind without calling the service", async () => {
    const result = await publishDocumentAction("o1", {
      destination: "intranet",
      visibility: {
        level: "group",
        // `__evil__` is not a DB enum value; the runtime guard must reject it.
        grants: [{ kind: "__evil__", value: "x" }],
      },
    });
    expect(result.isSuccess).toBe(false);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it.each(["role", "building", "department", "grade", "user", "group"])(
    "accepts the valid grant kind %s and forwards it to the service",
    async (kind) => {
      const result = await publishDocumentAction("o1", {
        destination: "intranet",
        visibility: { level: "group", grants: [{ kind, value: "x" }] },
      });
      expect(result.isSuccess).toBe(true);
      expect(publishMock).toHaveBeenCalledTimes(1);
      const passedInput = publishMock.mock.calls[0][2] as {
        visibility?: { grants: { kind: string }[] };
      };
      expect(passedInput.visibility?.grants[0].kind).toBe(kind);
    }
  );

  it("publishes with no visibility (guard not exercised)", async () => {
    const result = await publishDocumentAction("o1", { destination: "intranet" });
    expect(result.isSuccess).toBe(true);
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it("does not crash when visibility is present but grants is omitted", async () => {
    // A REST/MCP caller (or a future action) can send `{ visibility: { level } }`
    // with no `grants`. Without the `?? []` guard, `grants.map()` throws a
    // TypeError. The action must coalesce to an empty list and forward it.
    const result = await publishDocumentAction("o1", {
      destination: "intranet",
      visibility: { level: "internal" },
    });
    expect(result.isSuccess).toBe(true);
    expect(publishMock).toHaveBeenCalledTimes(1);
    const passedInput = publishMock.mock.calls[0][2] as {
      visibility?: { level: string; grants: unknown[] };
    };
    expect(passedInput.visibility?.level).toBe("internal");
    expect(passedInput.visibility?.grants).toEqual([]);
  });

  it("rejects when only some grants are invalid (fails on the bad one)", async () => {
    const result = await publishDocumentAction("o1", {
      destination: "intranet",
      visibility: {
        level: "group",
        grants: [
          { kind: "role", value: "staff" },
          { kind: "nonsense", value: "y" },
        ],
      },
    });
    expect(result.isSuccess).toBe(false);
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe("publishDocumentAction — destination runtime validation (Epic #1059 completion)", () => {
  it.each(["intranet", "public_web", "schoology", "google"])(
    "accepts the editor destination %s and forwards it to the service",
    async (destination) => {
      const result = await publishDocumentAction("o1", { destination });
      expect(result.isSuccess).toBe(true);
      expect(publishMock).toHaveBeenCalledTimes(1);
      const passedInput = publishMock.mock.calls[0][2] as {
        destination: string;
      };
      expect(passedInput.destination).toBe(destination);
    }
  );

  it("rejects 'okf' (API/MCP-only by design) without calling the service", async () => {
    const result = await publishDocumentAction("o1", { destination: "okf" });
    expect(result.isSuccess).toBe(false);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("rejects a garbage destination without calling the service", async () => {
    const result = await publishDocumentAction("o1", {
      destination: "__evil__",
    });
    expect(result.isSuccess).toBe(false);
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe("publishDocumentAction — §26.4 pending-approval mapping", () => {
  it("maps a service ApprovalRequiredError to approvalRequired (not a plain failure)", async () => {
    publishMock.mockRejectedValueOnce(
      new ApprovalRequiredError("Publishing to a public destination requires approval", {})
    );
    const result = await publishDocumentAction("o1", {
      destination: "public_web",
    });
    expect(result.isSuccess).toBe(false);
    if (result.isSuccess) return;
    expect(result.approvalRequired).toBe(true);
    // The message must read as a pending outcome, not an error.
    expect(result.message).toContain("approval");
  });
});
