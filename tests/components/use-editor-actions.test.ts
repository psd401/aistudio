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
 *
 * The three server actions are mocked so the hook runs without a session/DB.
 */

import { renderHook, act, waitFor } from "@testing-library/react";
import type { RefObject } from "react";

const mockPublish =
  jest.fn<Promise<unknown>, [string, { destination: string }]>();
const mockUnpublish =
  jest.fn<Promise<unknown>, [string, { destination: string }]>();
const mockSnapshot = jest.fn<Promise<unknown>, [string, { body: string }]>();

jest.mock("@/actions/db/atrium/publish-document", () => ({
  publishDocumentAction: (...args: [string, { destination: string }]) =>
    mockPublish(...args),
}));
jest.mock("@/actions/db/atrium/unpublish-document", () => ({
  unpublishDocumentAction: (...args: [string, { destination: string }]) =>
    mockUnpublish(...args),
}));
jest.mock("@/actions/db/atrium/snapshot-document", () => ({
  snapshotDocumentAction: (...args: [string, { body: string }]) =>
    mockSnapshot(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useEditorActions } = require("@/components/atrium/use-editor-actions");

// A resolved-UUID ref (the buttons only render once this is set); `editor` is not
// touched by publish/unpublish, so null is fine for those paths.
const docNameRef = { current: "obj-123" } as RefObject<string | null>;

function setup() {
  return renderHook(() =>
    useEditorActions({ editor: null, idOrSlug: "my-slug", docNameRef })
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
    act(() => result.current.handlePublish());

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.pendingApproval).toBe(true);
    expect(result.current.actionError).toBe(false);
    expect(result.current.message).toContain("approval");
  });

  it("sets a neutral success caption on a successful publish", async () => {
    mockPublish.mockResolvedValue({ isSuccess: true, data: {} });

    const { result } = setup();
    act(() => result.current.handlePublish());

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.pendingApproval).toBe(false);
    expect(result.current.actionError).toBe(false);
    expect(result.current.message).toBe("Published to intranet");
  });

  it("sets actionError on a genuine publish failure", async () => {
    mockPublish.mockResolvedValue({ isSuccess: false, message: "Publish failed" });

    const { result } = setup();
    act(() => result.current.handlePublish());

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.actionError).toBe(true);
    expect(result.current.pendingApproval).toBe(false);
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
    act(() => result.current.handleUnpublish());

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.pendingApproval).toBe(true);
    expect(result.current.actionError).toBe(false);
  });

  it("reports the idempotent 'not currently published' outcome as a neutral success", async () => {
    mockUnpublish.mockResolvedValue({
      isSuccess: true,
      data: { unpublished: false },
    });

    const { result } = setup();
    act(() => result.current.handleUnpublish());

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.actionError).toBe(false);
    expect(result.current.pendingApproval).toBe(false);
    expect(result.current.message).toBe("Not currently published");
  });
});
