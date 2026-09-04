/**
 * Component smoke: CommentSidebar (Epic #1059, §18.1).
 *
 *  - renders the document's threads (unresolved first);
 *  - "Add comment" is DISABLED while the editor selection is empty (a comment must
 *    anchor to selected text);
 *  - Resolve calls resolveCommentThreadAction with the thread id;
 *  - (#1714) the body is posted base64-encoded, and a REJECTED create still
 *    strips the orphan anchor mark and re-enables the composer.
 *
 * The comment-mark module is mocked to a name constant so no TipTap runtime loads;
 * the four comment server actions are mocked; a fake editor supplies the selection
 * + chain surface the component reads.
 */

jest.mock("@/lib/content/collab/comment-mark", () => ({
  ATRIUM_COMMENT_MARK: "atriumComment",
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
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

/**
 * A fake editor that tracks the anchor mark the way the real one is used here:
 * `setMark` records the minted threadId, `doc.descendants` then reports a text
 * node carrying it, and `view.dispatch` observes the cleanup transaction. Without
 * this, `removeCommentMarkByThread` finds no ranges and returns early, so the
 * orphan-cleanup path would be invisible to the test.
 */
function anchorTrackingEditor(): {
  editor: Editor;
  dispatched: jest.Mock;
} {
  const markType = {};
  let threadId: string | null = null;
  const chain = {
    focus: () => chain,
    setTextSelection: () => chain,
    setMark: (_name: string, attrs: { threadId: string }) => {
      threadId = attrs.threadId;
      return chain;
    },
    unsetMark: () => chain,
    scrollIntoView: () => chain,
    run: () => true,
  };
  const dispatched = jest.fn();
  const editor = {
    on: jest.fn(),
    off: jest.fn(),
    chain: () => chain,
    schema: { marks: { atriumComment: markType } },
    view: { dispatch: dispatched },
    state: {
      selection: { empty: false, from: 1, to: 5 },
      tr: { removeMark: jest.fn() },
      doc: {
        descendants: (cb: (node: unknown, pos: number) => boolean) => {
          if (!threadId) return;
          cb(
            {
              isText: true,
              nodeSize: 4,
              marks: [{ type: markType, attrs: { threadId } }],
            },
            1
          );
        },
      },
    },
  } as unknown as Editor;
  return { editor, dispatched };
}

async function typeAndSubmitComment(): Promise<HTMLElement> {
  const composer = await screen.findByLabelText("New comment");
  fireEvent.change(composer, { target: { value: "Please clarify <style>.x{}</style>" } });
  const add = screen.getByRole("button", { name: "Add comment" });
  await waitFor(() => expect(add).toBeEnabled());
  // `act` so the post's promise settles inside it: addComment awaits the action
  // and then sets state, which React otherwise flags as an un-acted update.
  await act(async () => {
    fireEvent.click(add);
  });
  return add;
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
      expect(
        screen.getByText("Highlight text to comment or ask the agent")
      ).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
  });

  it("posts the comment body base64-encoded, WAF-opaque (#1714)", async () => {
    listMock.mockResolvedValue({ isSuccess: true, message: "", data: [] });
    createMock.mockResolvedValue({ isSuccess: true, message: "", data: thread() });
    const { editor } = anchorTrackingEditor();

    render(<CommentSidebar idOrSlug="doc-1" editor={editor} canEdit />);
    await typeAndSubmitComment();

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const [, input, opts] = createMock.mock.calls[0] as [
      string,
      { body: string },
      { codeEncoding?: string } | undefined,
    ];
    expect(opts?.codeEncoding).toBe("base64");
    // The composer is a PLAIN textarea, so without this the typed <style> would
    // be raw markup on the wire.
    expect(input.body).not.toMatch(/[<>"]/);
    expect(Buffer.from(input.body, "base64").toString("utf8")).toBe(
      "Please clarify <style>.x{}</style>"
    );
  });

  it("strips the orphan anchor and frees the composer when the create REJECTS (#1714)", async () => {
    listMock.mockResolvedValue({ isSuccess: true, message: "", data: [] });
    // A WAF-blocked action REJECTS rather than resolving to isSuccess:false.
    createMock.mockRejectedValue(new Error("Failed to fetch"));
    const { editor, dispatched } = anchorTrackingEditor();

    render(<CommentSidebar idOrSlug="doc-1" editor={editor} canEdit />);
    const add = await typeAndSubmitComment();

    // The cleanup transaction ran. Without the hook catching the rejection it
    // escapes addComment entirely, so this never dispatches and a highlighted
    // span dangles in the shared Y.Doc with no thread behind it — visible to
    // every collaborator, and not removable from the UI.
    await waitFor(() => expect(dispatched).toHaveBeenCalledTimes(1));
    // …and the composer is usable again rather than stuck mid-post.
    await waitFor(() => expect(add).toBeEnabled());
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

    const resolveBtn = await screen.findByRole("button", { name: "✓ Resolve" });
    fireEvent.click(resolveBtn);

    await waitFor(() =>
      expect(resolveMock).toHaveBeenCalledWith("doc-1", {
        threadId: thread().threadId,
        resolved: true,
      })
    );
  });
});
