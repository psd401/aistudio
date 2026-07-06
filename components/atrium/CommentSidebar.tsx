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
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
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

/** One comment (body + author + time). */
function CommentRow({ comment }: { comment: CommentDTO }): React.JSX.Element {
  return (
    <li className="rounded border border-border/60 bg-background px-2 py-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/80">
          {comment.authorLabel}
          {comment.authorKind === "agent" ? " (agent)" : ""}
        </span>
        <span>{formatTime(comment.createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
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

  return (
    <li
      className={cn(
        "rounded-md border p-2",
        thread.resolved ? "border-dashed opacity-70" : "border-border"
      )}
      data-testid="comment-thread"
      data-resolved={thread.resolved ? "true" : "false"}
    >
      <button
        type="button"
        onClick={onFocus}
        className="mb-1 text-left text-[11px] font-medium text-primary hover:underline"
      >
        Jump to text{thread.resolved ? " · resolved" : ""}
      </button>
      <ul className="space-y-1">
        {thread.comments.map((c) => (
          <CommentRow key={c.id} comment={c} />
        ))}
      </ul>
      {canEdit && (
        <div className="mt-2 space-y-1">
          {!thread.resolved && (
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Reply…"
              rows={2}
              aria-label="Reply to thread"
            />
          )}
          <div className="flex justify-end gap-2">
            {!thread.resolved && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !reply.trim()}
                onClick={submitReply}
              >
                Reply
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onResolve(!thread.resolved)}
            >
              {thread.resolved ? "Reopen" : "Resolve"}
            </Button>
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
      editor.chain().setTextSelection({ from, to }).unsetMark(ATRIUM_COMMENT_MARK).run();
    }
  }, [editor, draft, createThread]);

  // Unresolved threads first; the server ordering is otherwise preserved.
  const ordered = useMemo(
    () =>
      [...threads].sort((a, b) => Number(a.resolved) - Number(b.resolved)),
    [threads]
  );

  return (
    <aside
      className="flex w-full flex-col gap-3 text-sm"
      aria-label="Comments"
      data-testid="comment-sidebar"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Comments
      </h2>

      {canEdit && (
        <div className="space-y-1">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              hasSelection ? "Comment on the selected text…" : "Select text to comment"
            }
            disabled={!hasSelection}
            rows={2}
            aria-label="New comment"
          />
          <Button
            size="sm"
            className="w-full"
            disabled={!hasSelection || !draft.trim() || posting}
            onClick={addComment}
          >
            Add comment
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading comments…</p>
      ) : ordered.length === 0 ? (
        <p className="text-xs text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="space-y-2">
          {ordered.map((thread) => (
            <ThreadCard
              key={thread.threadId}
              thread={thread}
              canEdit={canEdit}
              onFocus={() => focusThreadAnchor(editor, thread.threadId)}
              onReply={(body) => reply(thread.threadId, body)}
              onResolve={(resolved) => {
                void resolve(thread.threadId, resolved);
              }}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

export default CommentSidebar;
