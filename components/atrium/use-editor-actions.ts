"use client";

/**
 * Atrium editor actions hook (#1054 extract).
 *
 * Snapshot / publish / unpublish for the `DocumentEditor`, with shared in-flight
 * (`busy`) and success/error feedback state. Extracted from the component so its
 * body stays under the max-lines lint, and so the busy-guard + confirm + caption
 * styling logic can be reasoned about (and reused) on its own.
 *
 * `busy` blocks re-entry while an action runs — a double-click can't fire two
 * publish/unpublish calls, whose nav-item side effects race outside the row lock.
 * `actionError` distinguishes a red error caption from a neutral success one.
 */

import { useCallback, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { snapshotDocumentAction } from "@/actions/db/atrium/snapshot-document";
import { publishDocumentAction } from "@/actions/db/atrium/publish-document";
import { unpublishDocumentAction } from "@/actions/db/atrium/unpublish-document";

interface UseEditorActionsParams {
  editor: Editor | null;
  /** The mount prop — MAY be a slug; the resolved UUID in `docNameRef` wins. */
  idOrSlug: string;
  /** The resolved object UUID from the collab session (null until resolved). */
  docNameRef: RefObject<string | null>;
}

export interface EditorActions {
  message: string | null;
  actionError: boolean;
  busy: boolean;
  handleSnapshot: () => void;
  handlePublish: () => void;
  handleUnpublish: () => void;
}

export function useEditorActions({
  editor,
  idOrSlug,
  docNameRef,
}: UseEditorActionsParams): EditorActions {
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);
  const [busy, setBusy] = useState(false);

  // Run a toolbar action with shared busy/feedback handling: blocks re-entry
  // while one is in flight, records success vs. error for the caption styling.
  const runAction = useCallback(
    async (run: () => Promise<{ ok: boolean; text: string }>) => {
      setBusy(true);
      try {
        const { ok, text } = await run();
        setActionError(!ok);
        setMessage(text);
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const handleSnapshot = useCallback(() => {
    if (!editor) return;
    // Target the resolved UUID, not the (possibly slug) mount prop. The buttons
    // only render once canEdit is true, which is set together with docName, so
    // the ref is populated; idOrSlug is a defensive fallback.
    const target = docNameRef.current ?? idOrSlug;
    const body = editor.storage.markdown.getMarkdown();
    void runAction(async () => {
      const result = await snapshotDocumentAction(target, { body });
      return {
        ok: result.isSuccess,
        text: result.isSuccess ? "Snapshot saved" : result.message ?? "Snapshot failed",
      };
    });
  }, [editor, idOrSlug, docNameRef, runAction]);

  const handlePublish = useCallback(() => {
    const target = docNameRef.current ?? idOrSlug;
    void runAction(async () => {
      const result = await publishDocumentAction(target, { destination: "intranet" });
      return {
        ok: result.isSuccess,
        text: result.isSuccess
          ? "Published to intranet"
          : result.message ?? "Publish failed",
      };
    });
  }, [idOrSlug, docNameRef, runAction]);

  // Unpublish: removes the live intranet publication and hides the auto-created
  // nav item (#1054). The action 404-masks a non-viewable object and re-checks
  // edit permission server-side. Confirm first — unpublishing removes a live,
  // publicly-visible page, so an accidental click is consequential.
  const handleUnpublish = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Unpublish this document from the intranet? Readers will no longer see it (you can republish later)."
      )
    ) {
      return;
    }
    const target = docNameRef.current ?? idOrSlug;
    void runAction(async () => {
      const result = await unpublishDocumentAction(target, { destination: "intranet" });
      return {
        ok: result.isSuccess,
        text: result.isSuccess
          ? result.data.unpublished
            ? "Unpublished from intranet"
            : "Not currently published"
          : result.message ?? "Unpublish failed",
      };
    });
  }, [idOrSlug, docNameRef, runAction]);

  return { message, actionError, busy, handleSnapshot, handlePublish, handleUnpublish };
}
