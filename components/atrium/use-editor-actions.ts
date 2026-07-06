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
 * `approvalRequired` is NOT shown as a failure. With the toolbar's destination
 * picker exposing `public_web`, a non-admin publish/unpublish to a public
 * destination routinely lands on this pending path.
 */

import { useCallback, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { snapshotDocumentAction } from "@/actions/db/atrium/snapshot-document";
import {
  publishDocumentAction,
  type EditorPublishDestination,
} from "@/actions/db/atrium/publish-document";
import { unpublishDocumentAction } from "@/actions/db/atrium/unpublish-document";
import type { ActionState } from "@/types";

/**
 * Human-readable destination labels for the success/confirm copy. Shared with
 * the toolbar picker's options via `EditorPublishDestination` so a new
 * destination is a compile error here, not a silent "undefined" caption.
 */
const DESTINATION_LABELS: Record<EditorPublishDestination, string> = {
  intranet: "the intranet",
  public_web: "the public web",
  schoology: "Schoology",
  google: "Google",
};

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
  /** Publish the working head to the picked destination (toolbar picker). */
  handlePublish: (destination: EditorPublishDestination) => void;
  /** Unpublish from the picked destination (confirm-guarded). */
  handleUnpublish: (destination: EditorPublishDestination) => void;
}

/**
 * The outcome of a toolbar action. `pending` (a §26.4 approval-required result) is
 * neither success nor error: it is a distinct amber "submitted for review" state.
 * A discriminated union (rather than `{ ok: boolean; pending?: boolean }`) makes
 * the invalid `{ ok: true, pending: true }` combination unrepresentable.
 */
type ActionOutcome =
  | { status: "success"; text: string }
  | { status: "pending"; text: string }
  | { status: "error"; text: string };

/**
 * Maps a server action's `ActionState`-shaped result to an `ActionOutcome` for
 * `runAction`'s shared success/error/pending-approval handling — the identical
 * `isSuccess` / `approvalRequired` / else branching `handlePublish` and
 * `handleUnpublish` both need, centralized so a third action doesn't hand-copy it
 * again. `successText` may depend on the resolved data (e.g. unpublish's
 * "Not currently published" vs "Unpublished from intranet"), so it accepts either
 * a fixed string or a function of `result.data`.
 */
function mapActionResult<T>(
  result: ActionState<T>,
  opts: {
    successText: string | ((data: T) => string);
    failureFallback: string;
  }
): ActionOutcome {
  if (result.isSuccess) {
    const text =
      typeof opts.successText === "function"
        ? opts.successText(result.data)
        : opts.successText;
    return { status: "success", text };
  }
  // §26.4: an approval-required result is NOT a failure — surface it amber, like
  // VisibilityChip, instead of red.
  if (result.approvalRequired) {
    return {
      status: "pending",
      text: result.message ?? "Submitted for approval.",
    };
  }
  return { status: "error", text: result.message ?? opts.failureFallback };
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
  // caption styling.
  const runAction = useCallback(
    async (run: () => Promise<ActionOutcome>) => {
      setBusy(true);
      try {
        const outcome = await run();
        setPendingApproval(outcome.status === "pending");
        setActionError(outcome.status === "error");
        setMessage(outcome.text);
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
      return mapActionResult(result, {
        successText: "Snapshot saved",
        failureFallback: "Snapshot failed",
      });
    });
  }, [editor, idOrSlug, docNameRef, runAction]);

  const handlePublish = useCallback(
    (destination: EditorPublishDestination) => {
      const target = docNameRef.current ?? idOrSlug;
      const label = DESTINATION_LABELS[destination];
      void runAction(async () => {
        const result = await publishDocumentAction(target, { destination });
        // §26.4: a public destination (public_web/schoology/google) without
        // authority returns `approvalRequired`, which mapActionResult surfaces
        // as `pending` (amber "submitted for review"), not `error`.
        return mapActionResult(result, {
          successText: `Published to ${label}`,
          failureFallback: "Publish failed",
        });
      });
    },
    [idOrSlug, docNameRef, runAction]
  );

  // Unpublish: removes the live publication at the picked destination (for the
  // intranet, also hides the auto-created nav item — #1054). The action
  // 404-masks a non-viewable object and re-checks edit permission server-side.
  // Confirm first — unpublishing removes a live page, so an accidental click is
  // consequential. Unpublishing a destination with no live publication is an
  // idempotent no-op ("Not currently published there").
  const handleUnpublish = useCallback(
    (destination: EditorPublishDestination) => {
      const label = DESTINATION_LABELS[destination];
      if (
        typeof window !== "undefined" &&
        !window.confirm(
          `Unpublish this document from ${label}? Readers will no longer see it (you can republish later).`
        )
      ) {
        return;
      }
      const target = docNameRef.current ?? idOrSlug;
      void runAction(async () => {
        const result = await unpublishDocumentAction(target, { destination });
        // §26.4: taking a public destination offline needs the same authority
        // as publishing it — an unauthorized caller gets the same pending
        // (amber) outcome as handlePublish.
        return mapActionResult(result, {
          successText: (data) =>
            data.unpublished
              ? `Unpublished from ${label}`
              : "Not currently published there",
          failureFallback: "Unpublish failed",
        });
      });
    },
    [idOrSlug, docNameRef, runAction]
  );

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
