"use client";

/**
 * Atrium comment sidebar (right rail) — Epic #1059, §18.1
 *
 * The review panel next to the DocumentEditor: the document's comment threads
 * (unresolved first), a selection-anchored "Add comment" composer, per-thread
 * reply, and resolve/reopen. Thread DATA comes from `useComments` (server
 * actions); the editor owns anchoring — a new comment sets the `atriumComment`
 * mark on the current selection (that mark IS the thread anchor, so it tracks the
 * text through concurrent edits), and clicking a thread selects + scrolls its
 * anchor. A create failure unsets the just-added anchor so no orphan highlight is
 * left behind.
 *
 * Only the comment-mark NAME is imported here (a plain string) plus the Editor
 * TYPE, so the component carries no TipTap runtime and stays jest-renderable.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/core";
import { v4 as uuidv4 } from "uuid";
import { cn } from "@/lib/utils";
import { initialsFromName } from "@/lib/atrium/presence";
import { ATRIUM_COMMENT_MARK } from "@/lib/content/collab/comment-mark";
import { useComments } from "./use-comments";
import type { CommentDTO, CommentThreadDTO } from "@/actions/db/atrium/comments";

export interface CommentSidebarProps {
  /** Content object id or slug (the useComments target). */
  idOrSlug: string;
  /** The live editor (null until ready); anchoring/scroll runs against it. */
  editor: Editor | null;
  /** Whether this user may add/reply/resolve (mirrors the collab edit token). */
  canEdit: boolean;
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/** Select + scroll to a thread's anchor (the first `atriumComment` mark for it). */
function focusThreadAnchor(editor: Editor | null, threadId: string): void {
  if (!editor) return;
  const markType = editor.schema.marks[ATRIUM_COMMENT_MARK];
  if (!markType) return;
  let range: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (range) return false;
    if (!node.isText) return true;
    const hit = node.marks.find(
      (m) => m.type === markType && m.attrs.threadId === threadId
    );
    if (hit) {
      range = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return true;
  });
  if (range) {
    editor.chain().focus().setTextSelection(range).scrollIntoView().run();
  }
}

/**
 * Mirror a thread's resolve/reopen into its EDITOR anchor mark so the inline
 * highlight reflects state without a reload. Rewrites every `atriumComment` mark
 * carrying `threadId` with the new `resolved` attr (keeping the anchor so a reopen
 * restores the highlight). Runs on the LOCAL doc; the CRDT propagates it to peers.
 */
function setCommentResolvedInEditor(
  editor: Editor | null,
  threadId: string,
  resolved: boolean
): void {
  if (!editor) return;
  const markType = editor.schema.marks[ATRIUM_COMMENT_MARK];
  if (!markType) return;
  const ranges: Array<{ from: number; to: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const hit = node.marks.find(
      (m) => m.type === markType && m.attrs.threadId === threadId
    );
    if (hit) ranges.push({ from: pos, to: pos + node.nodeSize });
    return true;
  });
  if (ranges.length === 0) return;
  const tr = editor.state.tr;
  for (const { from, to } of ranges) {
    tr.addMark(from, to, markType.create({ threadId, resolved }));
  }
  editor.view.dispatch(tr);
}

/**
 * Remove every `atriumComment` anchor for `threadId` — used to clean up an orphan
 * anchor when the backing thread failed to persist. Keyed by threadId (not static
 * positions) because the async persist may have let the doc shift underneath.
 */
function removeCommentMarkByThread(editor: Editor | null, threadId: string): void {
  if (!editor) return;
  const markType = editor.schema.marks[ATRIUM_COMMENT_MARK];
  if (!markType) return;
  const ranges: Array<{ from: number; to: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    if (node.marks.some((m) => m.type === markType && m.attrs.threadId === threadId)) {
      ranges.push({ from: pos, to: pos + node.nodeSize });
    }
    return true;
  });
  if (ranges.length === 0) return;
  const tr = editor.state.tr;
  for (const { from, to } of ranges) tr.removeMark(from, to, markType);
  editor.view.dispatch(tr);
}

/** One comment (author head + body). Meridian: 22px avatar (violet ✦ for agent),
 *  name, time, then the body. */
function CommentRow({ comment }: { comment: CommentDTO }): React.JSX.Element {
  const isAgent = comment.authorKind === "agent";
  return (
    <li>
      <div className="mer-comment-head">
        <span className="mer-comment-avatar" data-kind={comment.authorKind}>
          {isAgent ? "✦" : initialsFromName(comment.authorLabel)}
        </span>
        <span className="mer-comment-name">
          {comment.authorLabel}
          {isAgent ? "" : ""}
        </span>
        {/* toLocaleString differs by server/client locale+tz → suppress the
            SSR/hydration diff on this non-semantic timestamp. */}
        <span className="mer-comment-time" suppressHydrationWarning>
          {formatTime(comment.createdAt)}
        </span>
      </div>
      <p className="mer-comment-body">{comment.body}</p>
    </li>
  );
}

interface ThreadCardProps {
  thread: CommentThreadDTO;
  canEdit: boolean;
  onFocus: () => void;
  onReply: (body: string) => Promise<boolean>;
  onResolve: (resolved: boolean) => void;
}

function ThreadCard({
  thread,
  canEdit,
  onFocus,
  onReply,
  onResolve,
}: ThreadCardProps): React.JSX.Element {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  const submitReply = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    const ok = await onReply(reply.trim());
    setBusy(false);
    if (ok) setReply("");
  };

  // The card reads as an AGENT card (violet-tinted border) when the thread was
  // opened by the agent — the first comment's author kind (README §"Comments").
  const isAgentThread = thread.comments[0]?.authorKind === "agent";

  // DEFERRED — the agent "⟳ Working…" chip (README §"2b", Meridian slice F). The
  // mockup shows an agent reply ("On it — building the shuttle map… I'll embed it
  // when it's ready") carrying a "⟳ Working…" chip that clears when the artifact
  // LANDS in the doc. Rendering that honestly needs a per-thread agent-task
  // lifecycle: SET when the agent acknowledges a request, CLEARED when its async
  // result is applied to the document body. The clear signal is the agent-bridge
  // live-edit loopback (`applyAgentEdit` → the doc gains the embed) which — exactly
  // like the slice-D backlink re-sync deferred at
  // `lib/content/version-service.ts:100-115` — depends on the server-side
  // ProseMirror-JSON→markdown serializer / `readAgentDocMarkdown` added in PR #1186
  // (now on dev) plus new thread-lifecycle plumbing. The comment schema (migration 098)
  // carries only thread-level `resolved`, no working/pending state. Adding a
  // `working` flag now would either never clear (a chip stuck on "Working…"
  // forever) or fake it from the global `agentWriting` presence signal (which is
  // not thread-scoped and would mislabel every agent comment) — both hacks. So the
  // chip is deferred to the follow-up that lands on top of #1186; the agent card's
  // violet treatment ships now, the working-state chip does not.

  return (
    <li
      className={cn(
        "mer-comment-card",
        isAgentThread && "mer-comment-card-agent"
      )}
      data-testid="comment-thread"
      data-resolved={thread.resolved ? "true" : "false"}
    >
      <button type="button" onClick={onFocus} className="mer-comment-jump">
        Jump to text{thread.resolved ? " · resolved" : ""}
      </button>
      <ul>
        {thread.comments.map((c) => (
          <CommentRow key={c.id} comment={c} />
        ))}
      </ul>
      {canEdit && (
        <div className="mt-2 space-y-2">
          {!thread.resolved && (
            <textarea
              className="mer-comment-reply"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Reply…"
              rows={2}
              aria-label="Reply to thread"
            />
          )}
          <div className="mer-comment-actions" style={{ justifyContent: "flex-end" }}>
            {!thread.resolved && (
              <button
                type="button"
                className="mer-comment-chip"
                disabled={busy || !reply.trim()}
                onClick={submitReply}
              >
                Reply
              </button>
            )}
            <button
              type="button"
              className="mer-comment-chip mer-comment-chip-ghost"
              disabled={busy}
              onClick={() => onResolve(!thread.resolved)}
            >
              {thread.resolved ? "Reopen" : "✓ Resolve"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function CommentSidebar({
  idOrSlug,
  editor,
  canEdit,
}: CommentSidebarProps): React.JSX.Element {
  const { threads, loading, error, createThread, reply, resolve } =
    useComments(idOrSlug);
  const [draft, setDraft] = useState("");
  const [hasSelection, setHasSelection] = useState(false);
  const [posting, setPosting] = useState(false);

  // Track whether the editor has a non-empty selection (enables "Add comment").
  useEffect(() => {
    if (!editor) return;
    const update = () => setHasSelection(!editor.state.selection.empty);
    update();
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [editor]);

  const addComment = useCallback(async () => {
    if (!editor || !draft.trim()) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const threadId = uuidv4();
    // Set the anchor mark, THEN persist the thread. On failure, unset the anchor
    // so a highlighted span never dangles without a backing thread.
    editor.chain().focus().setMark(ATRIUM_COMMENT_MARK, { threadId }).run();
    setPosting(true);
    const created = await createThread({ threadId, body: draft.trim() });
    setPosting(false);
    if (created) {
      setDraft("");
    } else {
      // Remove the orphan anchor by its THREAD ID, not the original {from,to}:
      // the persist is async, so the user may have edited/reselected meanwhile,
      // which would make static positions stale (and clear the wrong span).
      removeCommentMarkByThread(editor, threadId);
    }
  }, [editor, draft, createThread]);

  // Unresolved threads first; the server ordering is otherwise preserved.
  const ordered = useMemo(
    () =>
      [...threads].sort((a, b) => Number(a.resolved) - Number(b.resolved)),
    [threads]
  );
  const openCount = useMemo(
    () => threads.filter((t) => !t.resolved).length,
    [threads]
  );

  return (
    <aside
      className="flex w-full flex-col gap-3"
      aria-label="Comments"
      data-testid="comment-sidebar"
    >
      <h2 className="mer-comments-head">
        Comments{openCount > 0 ? ` · ${openCount} open` : ""}
      </h2>

      {canEdit && (
        <div className="mer-comment-composer">
          <textarea
            className="mer-comment-reply"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              hasSelection ? "Comment on the selected text…" : "Select text to comment"
            }
            disabled={!hasSelection}
            rows={2}
            aria-label="New comment"
          />
          <button
            type="button"
            className="mer-comment-chip mer-comment-chip-agent"
            disabled={!hasSelection || !draft.trim() || posting}
            onClick={addComment}
          >
            Add comment
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs" style={{ color: "#b4552d" }}>
          {error}
        </p>
      )}
      {loading ? (
        <p className="mer-comments-empty">Loading comments…</p>
      ) : ordered.length === 0 ? (
        <div className="mer-comments-empty">
          Highlight text to comment or ask the agent
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {ordered.map((thread) => (
            <ThreadCard
              key={thread.threadId}
              thread={thread}
              canEdit={canEdit}
              onFocus={() => focusThreadAnchor(editor, thread.threadId)}
              onReply={(body) => reply(thread.threadId, body)}
              onResolve={(resolved) => {
                // Reflect the decision inline immediately, then persist. On a
                // persist failure `resolve` reverts the sidebar state; re-mirror
                // so the editor mark doesn't drift from the (reverted) truth.
                setCommentResolvedInEditor(editor, thread.threadId, resolved);
                void resolve(thread.threadId, resolved).then((ok) => {
                  if (!ok) setCommentResolvedInEditor(editor, thread.threadId, !resolved);
                });
              }}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

export default CommentSidebar;
