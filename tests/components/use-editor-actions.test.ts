/**
 * useEditorActions hook tests (#1054 extract; §26.4 approval wiring, #1090).
 *
 * Covers the toolbar-action state machine the editor renders from:
 *  - a successful publish/unpublish sets a neutral (non-error, non-pending) caption
 *  - a §26.4 `approvalRequired` result maps to the amber `pendingApproval` state,
 *    NOT the red `actionError` state (the regression this issue fixes: publish /
 *    unpublish previously branched only on isSuccess, so a pending-approval outcome
 *    was shown as a failure)
 *  - a genuine failure still sets `actionError`
 *  - (#1714) a snapshot posts its markdown base64-encoded, and a REJECTED action
 *    (the shape a WAF-blocked POST takes — an HTML 403 the action client cannot
 *    parse) sets an explicit error caption instead of silently clearing `busy`
 *
 * The three server actions are mocked so the hook runs without a session/DB.
 */

import { renderHook, act, waitFor } from "@testing-library/react";
import type { RefObject } from "react";

const mockPublish =
  jest.fn<Promise<unknown>, [string, { destination: string }]>();
const mockUnpublish =
  jest.fn<Promise<unknown>, [string, { destination: string }]>();
const mockSnapshot =
  jest.fn<
    Promise<unknown>,
    [string, { body: string }, { codeEncoding?: string }?]
  >();

/** The markdown `toCleanMarkdown` yields — carries WAF-matched markup on purpose. */
const mockDocMarkdown = "# Runbook\n\n<style>.a{}</style>";

jest.mock("@/actions/db/atrium/publish-document", () => ({
  publishDocumentAction: (...args: [string, { destination: string }]) =>
    mockPublish(...args),
}));
jest.mock("@/actions/db/atrium/unpublish-document", () => ({
  unpublishDocumentAction: (...args: [string, { destination: string }]) =>
    mockUnpublish(...args),
}));
jest.mock("@/actions/db/atrium/snapshot-document", () => ({
  snapshotDocumentAction: (
    ...args: [string, { body: string }, { codeEncoding?: string }?]
  ) => mockSnapshot(...args),
}));

// handleSnapshot serializes the live editor; the hook's contract (what it POSTs,
// and how it recovers) is what is under test, not ProseMirror serialization.
jest.mock("@/lib/content/collab/suggestions", () => ({
  toCleanMarkdown: () => mockDocMarkdown,
}));


const { useEditorActions } = require("@/components/atrium/use-editor-actions");

// A resolved-UUID ref (the buttons only render once this is set); `editor` is not
// touched by publish/unpublish, so null is fine for those paths.
const docNameRef = { current: "obj-123" } as RefObject<string | null>;

function setup() {
  return renderHook(() =>
    useEditorActions({ editor: null, idOrSlug: "my-slug", docNameRef })
  );
}

// handleSnapshot no-ops without an editor; publish/unpublish never touch it.
function setupWithEditor() {
  return renderHook(() =>
    useEditorActions({ editor: {}, idOrSlug: "my-slug", docNameRef })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useEditorActions — publish", () => {
  it("maps a §26.4 approvalRequired result to pendingApproval (amber), not an error", async () => {
    mockPublish.mockResolvedValue({
      isSuccess: false,
      approvalRequired: true,
      message: "Publishing to this destination requires administrator approval.",
    });

    const { result } = setup();
    act(() => result.current.handlePublish("intranet"));

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.pendingApproval).toBe(true);
    expect(result.current.actionError).toBe(false);
    expect(result.current.message).toContain("approval");
  });

  it("sets a neutral success caption on a successful publish", async () => {
    mockPublish.mockResolvedValue({ isSuccess: true, data: {} });

    const { result } = setup();
    act(() => result.current.handlePublish("intranet"));

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.pendingApproval).toBe(false);
    expect(result.current.actionError).toBe(false);
    expect(result.current.message).toBe("Published to the intranet");
  });

  it("sets actionError on a genuine publish failure", async () => {
    mockPublish.mockResolvedValue({ isSuccess: false, message: "Publish failed" });

    const { result } = setup();
    act(() => result.current.handlePublish("intranet"));

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.actionError).toBe(true);
    expect(result.current.pendingApproval).toBe(false);
  });
});

describe("useEditorActions — snapshot (#1714)", () => {
  it("posts the markdown base64-encoded, WAF-opaque", async () => {
    mockSnapshot.mockResolvedValue({ isSuccess: true, data: {} });

    const { result } = setupWithEditor();
    act(() => result.current.handleSnapshot());

    await waitFor(() => expect(mockSnapshot).toHaveBeenCalledTimes(1));
    const [, input, opts] = mockSnapshot.mock.calls[0];
    expect(opts?.codeEncoding).toBe("base64");
    // Inert on the wire: nothing for CrossSiteScripting_BODY to match.
    expect(input.body).not.toMatch(/[<>"]/);
    expect(Buffer.from(input.body, "base64").toString("utf8")).toBe(
      mockDocMarkdown
    );
    expect(result.current.actionError).toBe(false);
  });

  it("shows an explicit not-saved caption when the action REJECTS", async () => {
    // A WAF-blocked POST rejects rather than resolving to isSuccess:false. This
    // used to escape as an unhandled rejection: busy cleared, no caption — so a
    // failed autosave was indistinguishable from a successful one.
    mockSnapshot.mockRejectedValue(new Error("Failed to fetch"));

    const { result } = setupWithEditor();
    act(() => result.current.handleSnapshot());

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.actionError).toBe(true);
    expect(result.current.pendingApproval).toBe(false);
    expect(result.current.message).toBe(
      "Snapshot failed — your changes are not saved."
    );
  });

  it("still reports a resolved failure through the action's own message", async () => {
    mockSnapshot.mockResolvedValue({ isSuccess: false, message: "Read only" });

    const { result } = setupWithEditor();
    act(() => result.current.handleSnapshot());

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.actionError).toBe(true);
    expect(result.current.message).toBe("Read only");
  });
});

describe("useEditorActions — unpublish", () => {
  beforeEach(() => {
    // handleUnpublish confirms first; auto-confirm in the test environment.
    jest.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("maps a §26.4 approvalRequired unpublish result to pendingApproval, not an error", async () => {
    mockUnpublish.mockResolvedValue({
      isSuccess: false,
      approvalRequired: true,
      message: "Unpublishing requires administrator approval.",
    });

    const { result } = setup();
    act(() => result.current.handleUnpublish("intranet"));

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.pendingApproval).toBe(true);
    expect(result.current.actionError).toBe(false);
  });

  it("sets an error caption when a publish REJECTS instead of resolving", async () => {
    mockUnpublish.mockRejectedValue(new Error("Failed to fetch"));

    const { result } = setup();
    act(() => result.current.handleUnpublish("intranet"));

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.actionError).toBe(true);
    expect(result.current.message).toBe("Unpublish failed. Please try again.");
    // Publication state may have changed before the response was lost, so
    // watchers are still told to re-read rather than trust a stale badge.
    expect(result.current.actionSeq).toBe(1);
  });

  it("reports the idempotent 'not currently published' outcome as a neutral success", async () => {
    mockUnpublish.mockResolvedValue({
      isSuccess: true,
      data: { unpublished: false },
    });

    const { result } = setup();
    act(() => result.current.handleUnpublish("intranet"));

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.actionError).toBe(false);
    expect(result.current.pendingApproval).toBe(false);
    expect(result.current.message).toBe("Not currently published there");
  });
});
