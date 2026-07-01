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
 * `actionError` distinguishes a red error caption from a neutral success one, and
 * `pendingApproval` an amber "submitted for review" caption from either — mirroring
 * `VisibilityChip`, so a §26.4 public publish/unpublish that returns
 * `approvalRequired` is NOT shown as a failure. Latent today (the shipped editor
 * pins `destination: "intranet"`, which never triggers the gate), but wired so any
 * future public-destination button surfaces the pending-approval outcome correctly.
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
  /** True when the last action returned a §26.4 pending-approval outcome. */
  pendingApproval: boolean;
  busy: boolean;
  handleSnapshot: () => void;
  handlePublish: () => void;
  handleUnpublish: () => void;
}

/**
 * The outcome of a toolbar action. `pending` (a §26.4 approval-required result) is
 * neither success nor error: it is a distinct amber "submitted for review" state,
 * so a caller must not collapse it into the `ok` boolean.
 */
interface ActionOutcome {
  ok: boolean;
  text: string;
  pending?: boolean;
}

export function useEditorActions({
  editor,
  idOrSlug,
  docNameRef,
}: UseEditorActionsParams): EditorActions {
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [busy, setBusy] = useState(false);

  // Run a toolbar action with shared busy/feedback handling: blocks re-entry
  // while one is in flight, records success / error / pending-approval for the
  // caption styling. A `pending` outcome is NOT an error — clear the error flag so
  // the caption renders amber (review submitted), not red (failed).
  const runAction = useCallback(
    async (run: () => Promise<ActionOutcome>) => {
      setBusy(true);
      try {
        const { ok, text, pending } = await run();
        setPendingApproval(pending ?? false);
        // A pending-approval outcome is not a failure even though `ok` is false.
        setActionError(!ok && !pending);
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
      if (result.isSuccess) {
        return { ok: true, text: "Published to intranet" };
      }
      // §26.4: a public-destination publish the caller can't authorize returns a
      // pending-approval outcome (not a failure) — surface it amber, like
      // VisibilityChip. `intranet` never trips this today; wired for future
      // public-destination publish buttons.
      if (result.approvalRequired) {
        return {
          ok: false,
          pending: true,
          text: result.message ?? "Submitted for approval.",
        };
      }
      return { ok: false, text: result.message ?? "Publish failed" };
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
      if (result.isSuccess) {
        return {
          ok: true,
          text: result.data.unpublished
            ? "Unpublished from intranet"
            : "Not currently published",
        };
      }
      // §26.4: taking a public destination offline needs the same authority as
      // publishing it — an unauthorized caller gets a pending-approval outcome.
      // `intranet` never trips this today; wired for future public-destination
      // unpublish buttons (mirrors handlePublish).
      if (result.approvalRequired) {
        return {
          ok: false,
          pending: true,
          text: result.message ?? "Submitted for approval.",
        };
      }
      return { ok: false, text: result.message ?? "Unpublish failed" };
    });
  }, [idOrSlug, docNameRef, runAction]);

  return {
    message,
    actionError,
    pendingApproval,
    busy,
    handleSnapshot,
    handlePublish,
    handleUnpublish,
  };
}
