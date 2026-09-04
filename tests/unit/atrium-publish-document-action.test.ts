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
  async (
    ..._args: unknown[]
  ): Promise<{
    publicationId: string;
    publishedVersionId: string;
    becamePubliclyReachable?: boolean;
  }> => ({
    publicationId: "pub1",
    publishedVersionId: "v1",
  })
);

jest.mock("@/lib/content/publish-service", () => ({
  publishService: { publish: (...args: unknown[]) => publishMock(...args) },
}));

const notifyPublicExposureMock = jest.fn(
  async (_args: {
    action: string;
    objectId: string;
    destination?: string | null;
    note: string;
  }): Promise<void> => {}
);
jest.mock("@/lib/atrium/public-publish-policy", () => ({
  // Unchanged (#1336 allow-then-notify): every in-app author may expose
  // publicly, so the action's job is to RECORD it, not to block it.
  IN_APP_PUBLISH_PUBLIC_CAPABILITY: true,
  notifyPublicExposure: (...args: unknown[]) =>
    notifyPublicExposureMock(
      ...(args as Parameters<typeof notifyPublicExposureMock>)
    ),
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
  notifyPublicExposureMock.mockClear();
  publishMock.mockResolvedValue({
    publicationId: "pub1",
    publishedVersionId: "v1",
  });
});

describe("publishDocumentAction — allow-then-notify covers BOTH switches", () => {
  it("notifies when going Live is what made a public object world-readable", async () => {
    // The gap this closes: `setVisibilityAction` notifies on the transition TO
    // `public`, so an author who set Public FIRST and went Live second produced a
    // page anonymous visitors could read with no notification anywhere — the same
    // end state as the reverse order, recorded only in one of them.
    publishMock.mockResolvedValue({
      publicationId: "pub1",
      publishedVersionId: "v1",
      becamePubliclyReachable: true,
    });

    const result = await publishDocumentAction("o1", { destination: "intranet" });
    expect(result.isSuccess).toBe(true);
    expect(notifyPublicExposureMock).toHaveBeenCalledTimes(1);
    expect(notifyPublicExposureMock.mock.calls[0][0]).toMatchObject({
      action: "publish",
      objectId: "o1",
      destination: "intranet",
    });
  });

  it("does NOT notify when the publish exposed nothing new", async () => {
    // Reported from the COMMITTED transition, not the request, so a republish of
    // an already-live public page files nothing.
    publishMock.mockResolvedValue({
      publicationId: "pub1",
      publishedVersionId: "v1",
      becamePubliclyReachable: false,
    });

    const result = await publishDocumentAction("o1", { destination: "intranet" });
    expect(result.isSuccess).toBe(true);
    expect(notifyPublicExposureMock).not.toHaveBeenCalled();
  });

  it("still notifies for a CONNECTOR destination, which is its own exposure", async () => {
    const result = await publishDocumentAction("o1", { destination: "schoology" });
    expect(result.isSuccess).toBe(true);
    expect(notifyPublicExposureMock).toHaveBeenCalledTimes(1);
    expect(notifyPublicExposureMock.mock.calls[0][0]).toMatchObject({
      destination: "schoology",
    });
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
