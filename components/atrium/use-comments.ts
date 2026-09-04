"use client";

/**
 * Atrium comments hook — Epic #1059, §18.1
 *
 * Fetches and mutates the comment THREADS for one document via the comment server
 * actions (actions/db/atrium/comments.ts). Thread bodies live in Postgres; the
 * anchor lives in the Y.Doc as the `atriumComment` mark (set by CommentSidebar).
 *
 * The hook owns only the thread DATA (list + create/reply/resolve + refetch);
 * anchoring/scrolling is the editor's concern and stays in CommentSidebar. Every
 * mutation refetches from the server so the panel reflects the authoritative
 * ordering (unresolved-first is applied in the component).
 *
 * FAILURE CONTRACT (#1714). Every mutation reports failure by RETURN VALUE —
 * `null`/`false` — never by throwing, and each one catches. A server action that
 * never reaches the app (blocked at the edge by the WAF, whose HTML 403 is not a
 * valid action response) REJECTS, and an escaping rejection here is not merely a
 * missing message: `CommentSidebar.addComment` sets the anchor mark BEFORE
 * awaiting `createThread` and removes it again only on a falsy result, so a throw
 * would strand a highlighted span with no backing thread in the shared Y.Doc —
 * visible to every collaborator — and leave the composer spinner stuck.
 *
 * Bodies are sent base64-encoded for the same reason the document and artifact
 * write paths do: the composer is a plain textarea, so a comment quoting
 * `<script>`/`<style>` reaches the POST body verbatim. See
 * `lib/content/code-encoding.ts`.
 */

import { useCallback, useEffect, useState } from "react";
import { toBase64Utf8 } from "@/lib/content/code-encoding-browser";
import {
  listCommentThreadsAction,
  createCommentThreadAction,
  replyToCommentAction,
  resolveCommentThreadAction,
  type CommentThreadDTO,
} from "@/actions/db/atrium/comments";

export interface UseComments {
  threads: CommentThreadDTO[];
  loading: boolean;
  error: string | null;
  /** Re-read the thread list from the server. */
  refetch: () => void;
  /**
   * Create a thread with a pre-generated `threadId` (the anchor mark id). Returns
   * the created thread on success, or null on failure (the caller unsets the
   * orphaned anchor). Does NOT set the mark — that is the editor's job.
   */
  createThread: (input: { threadId: string; body: string }) => Promise<CommentThreadDTO | null>;
  reply: (threadId: string, body: string) => Promise<boolean>;
  resolve: (threadId: string, resolved: boolean) => Promise<boolean>;
}

export function useComments(idOrSlug: string): UseComments {
  const [threads, setThreads] = useState<CommentThreadDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await listCommentThreadsAction(idOrSlug);
    if (result.isSuccess) {
      setThreads(result.data);
      setError(null);
    } else {
      setError(result.message ?? "Failed to load comments");
    }
    setLoading(false);
  }, [idOrSlug]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listCommentThreadsAction(idOrSlug);
      if (cancelled) return;
      if (result.isSuccess) {
        setThreads(result.data);
        setError(null);
      } else {
        setError(result.message ?? "Failed to load comments");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [idOrSlug]);

  const refetch = useCallback(() => {
    void load();
  }, [load]);

  const createThread = useCallback(
    async (input: { threadId: string; body: string }): Promise<CommentThreadDTO | null> => {
      try {
        const result = await createCommentThreadAction(
          idOrSlug,
          { ...input, body: toBase64Utf8(input.body) },
          { codeEncoding: "base64" }
        );
        if (result.isSuccess) {
          setThreads((prev) => [...prev, result.data]);
          setError(null);
          return result.data;
        }
        setError(result.message ?? "Failed to add comment");
        return null;
      } catch {
        // Returning null (rather than rethrowing) is what lets the caller strip
        // the orphaned anchor mark — see the failure contract above.
        setError("Failed to add comment");
        return null;
      }
    },
    [idOrSlug]
  );

  const reply = useCallback(
    async (threadId: string, body: string): Promise<boolean> => {
      try {
        const result = await replyToCommentAction(
          idOrSlug,
          { threadId, body: toBase64Utf8(body) },
          { codeEncoding: "base64" }
        );
        if (result.isSuccess) {
          setThreads((prev) =>
            prev.map((t) => (t.threadId === threadId ? result.data : t))
          );
          setError(null);
          return true;
        }
        setError(result.message ?? "Failed to post reply");
        return false;
      } catch {
        setError("Failed to post reply");
        return false;
      }
    },
    [idOrSlug]
  );

  // No body, so nothing to encode — but it still needs the catch: a rejected
  // resolve would otherwise leave the row's checkbox asserting the old state
  // with no error shown.
  const resolve = useCallback(
    async (threadId: string, resolved: boolean): Promise<boolean> => {
      try {
        const result = await resolveCommentThreadAction(idOrSlug, { threadId, resolved });
        if (result.isSuccess) {
          setThreads((prev) =>
            prev.map((t) => (t.threadId === threadId ? { ...t, resolved: result.data.resolved } : t))
          );
          setError(null);
          return true;
        }
        setError(result.message ?? "Failed to update thread");
        return false;
      } catch {
        setError("Failed to update thread");
        return false;
      }
    },
    [idOrSlug]
  );

  return { threads, loading, error, refetch, createThread, reply, resolve };
}
