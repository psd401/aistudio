/** @jest-environment jsdom */

/**
 * Library artifact-create transit encoding (#1714).
 *
 * Both library artifact paths seed the new object with `ARTIFACT_STARTER_HTML`,
 * which contains a `<style>` block. Posted RAW, the ALB WAF's
 * `CrossSiteScripting_BODY` rule blocks the server-action POST with a bare 403
 * that never reaches the app — invisible in every local harness (no WAF), which
 * is why this shipped broken. The regression these tests guard is precisely
 * "the browser sent raw markup": the body must be base64 and `codeEncoding`
 * must be declared, or the deployed flow dies again.
 *
 * The dialog is stubbed to a prop-capturing shell so the assertions target the
 * LibraryView handlers and what they RESOLVE to; the dialog's own busy/error
 * lifecycle is covered by atrium-create-content-dialog.test.tsx.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// The grid/home/bulk children are irrelevant here and drag in the pure-ESM
// Atrium markdown pipeline (not jest-loadable — see the note in jest.config.js)
// plus Radix portals. Stub them so the mount is just the header + dialog.
jest.mock("@/components/atrium/LibraryList", () => ({
  LibraryList: () => <div data-testid="library-list" />,
}));
jest.mock("@/components/atrium/LibraryHome", () => ({
  LibraryHome: () => <div data-testid="library-home" />,
}));
jest.mock("@/components/atrium/LibraryBulkBar", () => ({
  LibraryBulkBar: () => <div data-testid="library-bulk-bar" />,
}));
jest.mock("@/components/atrium/PrivateCollectionsDialog", () => ({
  PrivateCollectionsDialog: () => <div data-testid="private-collections" />,
}));

const createContentActionMock = jest.fn();
jest.mock("@/actions/db/atrium/create-content", () => ({
  createContentAction: (...a: unknown[]) => createContentActionMock(...a),
}));

jest.mock("@/actions/db/atrium/list-content", () => ({
  listContentAction: jest.fn(async () => ({
    isSuccess: true,
    data: { items: [], total: 0 },
  })),
}));

jest.mock("@/actions/db/atrium/list-tags", () => ({
  listContentTagsAction: jest.fn(async () => ({ isSuccess: true, data: [] })),
}));

/**
 * The dialog's handler props, captured from the last render so a test can await
 * what the LibraryView handlers RESOLVE to — the value the real dialog uses to
 * decide between "show this error" and "the caller navigated away".
 */
const dialogProps: {
  onSubmit?: (p: string) => Promise<string | null>;
  onStartBlank?: () => Promise<string | null>;
} = {};

jest.mock("@/components/atrium/CreateContentDialog", () => ({
  CreateContentDialog: ({
    open,
    onSubmit,
    onStartBlank,
  }: {
    open: boolean;
    onSubmit: (p: string) => Promise<string | null>;
    onStartBlank?: () => Promise<string | null>;
  }) => {
    dialogProps.onSubmit = onSubmit;
    dialogProps.onStartBlank = onStartBlank;
    return open ? <div>stub-dialog</div> : null;
  },
}));

import { LibraryView } from "@/components/atrium/LibraryView";
import { ARTIFACT_STARTER_HTML } from "@/lib/content/artifact-starter";

/** The `(input, opts)` pair handed to the create action. */
function createCall(): [
  { body?: string; bodyFormat?: string; kind?: string },
  { codeEncoding?: string } | undefined,
] {
  return createContentActionMock.mock.calls[0] as [
    { body?: string; bodyFormat?: string; kind?: string },
    { codeEncoding?: string } | undefined,
  ];
}

/** Mount the library and open the artifact-create dialog. */
async function openCreateDialog(): Promise<void> {
  render(<LibraryView />);
  fireEvent.click(screen.getByRole("button", { name: /new page/i }));
  await waitFor(() => expect(screen.getByText("stub-dialog")).toBeInTheDocument());
}

/** Assert the wire shape both artifact paths must produce. */
function expectWafOpaqueArtifactCreate(): void {
  const [input, opts] = createCall();
  expect(input.kind).toBe("artifact");
  expect(opts?.codeEncoding).toBe("base64");
  // The wire body must be inert: no `<`, `>` or `"` for the WAF to match on.
  expect(input.body).not.toMatch(/[<>"]/);
  expect(Buffer.from(input.body ?? "", "base64").toString("utf8")).toBe(
    ARTIFACT_STARTER_HTML
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  delete dialogProps.onSubmit;
  delete dialogProps.onStartBlank;
  createContentActionMock.mockResolvedValue({
    isSuccess: true,
    data: { id: "obj-1" },
  });
});

describe("library artifact create sends a WAF-opaque body (#1714)", () => {
  it("is a real regression guard: the starter body carries WAF-blocked markup", () => {
    expect(ARTIFACT_STARTER_HTML).toContain("<style>");
  });

  it('base64-encodes the starter body for "Build it for me"', async () => {
    await openCreateDialog();

    await expect(dialogProps.onSubmit?.("a dashboard")).resolves.toBeNull();

    expect(createContentActionMock).toHaveBeenCalledTimes(1);
    expect(createCall()[0].bodyFormat).toBe("html");
    expectWafOpaqueArtifactCreate();
  });

  it('base64-encodes the starter body for "Start blank"', async () => {
    await openCreateDialog();

    await expect(dialogProps.onStartBlank?.()).resolves.toBeNull();

    expect(createContentActionMock).toHaveBeenCalledTimes(1);
    expectWafOpaqueArtifactCreate();
  });

  it("resolves to an error message (never hangs) when the create action REJECTS", async () => {
    createContentActionMock.mockRejectedValue(new Error("Failed to fetch"));
    await openCreateDialog();

    // A WAF-blocked server action REJECTS. Both handlers must catch it and hand
    // the dialog a message; an escaping rejection is what left the spinner on.
    await expect(dialogProps.onSubmit?.("a dashboard")).resolves.toBe(
      "Could not create the artifact"
    );
    await expect(dialogProps.onStartBlank?.()).resolves.toBe(
      "Could not create the page"
    );
  });

  it("resolves to the action's own message when the create RESOLVES unsuccessfully", async () => {
    createContentActionMock.mockResolvedValue({
      isSuccess: false,
      message: "Access denied",
    });
    await openCreateDialog();

    await expect(dialogProps.onSubmit?.("a dashboard")).resolves.toBe(
      "Access denied"
    );
    await expect(dialogProps.onStartBlank?.()).resolves.toBe("Access denied");
  });
});
