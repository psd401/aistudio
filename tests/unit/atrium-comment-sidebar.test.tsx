/**
 * Component smoke: CommentSidebar (Epic #1059, §18.1).
 *
 *  - renders the document's threads (unresolved first);
 *  - "Add comment" is DISABLED while the editor selection is empty (a comment must
 *    anchor to selected text);
 *  - Resolve calls resolveCommentThreadAction with the thread id.
 *
 * The comment-mark module is mocked to a name constant so no TipTap runtime loads;
 * the four comment server actions are mocked; a fake editor supplies the selection
 * + chain surface the component reads.
 */

jest.mock("@/lib/content/collab/comment-mark", () => ({
  ATRIUM_COMMENT_MARK: "atriumComment",
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { CommentSidebar } from "@/components/atrium/CommentSidebar";
import type { CommentThreadDTO } from "@/actions/db/atrium/comments";

const listMock = jest.fn();
const createMock = jest.fn();
const replyMock = jest.fn();
const resolveMock = jest.fn();
jest.mock("@/actions/db/atrium/comments", () => ({
  listCommentThreadsAction: (...a: unknown[]) => listMock(...a),
  createCommentThreadAction: (...a: unknown[]) => createMock(...a),
  replyToCommentAction: (...a: unknown[]) => replyMock(...a),
  resolveCommentThreadAction: (...a: unknown[]) => resolveMock(...a),
}));

function thread(over: Partial<CommentThreadDTO> = {}): CommentThreadDTO {
  return {
    threadId: "11111111-1111-4111-a111-111111111111",
    resolved: false,
    comments: [
      {
        id: "c-1",
        body: "Please tighten this sentence",
        authorLabel: "Kris",
        authorKind: "human",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    ...over,
  };
}

/** A fake editor exposing the selection + chain surface CommentSidebar uses. */
function fakeEditor(selectionEmpty: boolean): Editor {
  const chain = {
    focus: () => chain,
    setTextSelection: () => chain,
    setMark: () => chain,
    unsetMark: () => chain,
    scrollIntoView: () => chain,
    run: () => true,
  };
  return {
    on: jest.fn(),
    off: jest.fn(),
    chain: () => chain,
    schema: { marks: { atriumComment: {} } },
    state: {
      selection: { empty: selectionEmpty, from: 1, to: selectionEmpty ? 1 : 5 },
      doc: { descendants: jest.fn() },
    },
  } as unknown as Editor;
}

beforeEach(() => {
  listMock.mockReset();
  createMock.mockReset();
  replyMock.mockReset();
  resolveMock.mockReset();
});

describe("CommentSidebar", () => {
  it("renders threads once loaded", async () => {
    listMock.mockResolvedValue({
      isSuccess: true,
      message: "",
      data: [
        thread(),
        thread({ threadId: "22222222-2222-4222-a222-222222222222", resolved: true }),
      ],
    });
    render(<CommentSidebar idOrSlug="doc-1" editor={fakeEditor(true)} canEdit />);

    await waitFor(() =>
      expect(screen.getAllByTestId("comment-thread")).toHaveLength(2)
    );
    expect(
      screen.getAllByText("Please tighten this sentence").length
    ).toBeGreaterThan(0);
  });

  it("disables Add comment when the selection is empty", async () => {
    listMock.mockResolvedValue({ isSuccess: true, message: "", data: [] });
    render(<CommentSidebar idOrSlug="doc-1" editor={fakeEditor(true)} canEdit />);

    await waitFor(() =>
      expect(screen.getByText("No comments yet.")).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
  });

  it("calls resolveCommentThreadAction when Resolve is clicked", async () => {
    listMock.mockResolvedValue({
      isSuccess: true,
      message: "",
      data: [thread()],
    });
    resolveMock.mockResolvedValue({
      isSuccess: true,
      message: "",
      data: { threadId: thread().threadId, resolved: true },
    });
    render(<CommentSidebar idOrSlug="doc-1" editor={fakeEditor(false)} canEdit />);

    const resolveBtn = await screen.findByRole("button", { name: "Resolve" });
    fireEvent.click(resolveBtn);

    await waitFor(() =>
      expect(resolveMock).toHaveBeenCalledWith("doc-1", {
        threadId: thread().threadId,
        resolved: true,
      })
    );
  });
});
