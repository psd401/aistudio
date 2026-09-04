/**
 * Unit tests for publishDocumentAction destination validation, the #1726
 * no-visibility contract, and §26.4 pending-approval mapping.
 *
 * The action receives `destination` as a plain `string` (widened for the API
 * surface) and narrows it with a RUNTIME guard (`assertEditorDestination`) before
 * handing it to `publishService.publish`. These tests assert:
 *  - the action NEVER forwards a visibility payload (#1726) — publishing is a
 *    Live/Draft state change, so it cannot widen the audience and cannot replace
 *    the author's grants, which is what the old bundled widen did
 *  - `destination` is optional and defaults to the live switch
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

describe("publishDocumentAction — publishing never touches visibility (#1726)", () => {
  it("forwards ONLY the destination to the service", async () => {
    const result = await publishDocumentAction("o1", { destination: "intranet" });
    expect(result.isSuccess).toBe(true);
    expect(publishMock).toHaveBeenCalledTimes(1);
    // The regression this guards: the action used to forward a `visibility`
    // payload straight into the publish transaction, where `setLevelInTx`
    // replaces the object's grant set — so publishing a Group document deleted
    // the author's named people.
    expect(publishMock.mock.calls[0][2]).toEqual({ destination: "intranet" });
  });

  it("defaults to the live switch when no destination is given", async () => {
    const result = await publishDocumentAction("o1");
    expect(result.isSuccess).toBe(true);
    expect(publishMock.mock.calls[0][2]).toEqual({ destination: "intranet" });
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
