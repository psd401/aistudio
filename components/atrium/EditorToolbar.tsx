"use client";

/**
 * Atrium DocumentEditor toolbar (Issue #1054 extract).
 *
 * The status row + author legend + edit actions (Snapshot / Publish / Unpublish).
 * Extracted from `DocumentEditor` so the editor component stays under the
 * max-lines lint and the toolbar can be reasoned about on its own. Presentation
 * only: the action handlers are owned by the parent (they target the resolved
 * object UUID and re-check permission server-side).
 */

import { Button } from "@/components/ui/button";

type Status = "connecting" | "ready" | "error";

interface EditorToolbarProps {
  status: Status;
  canEdit: boolean;
  /** An edit action is in flight — disables the buttons to block double-fire. */
  busy: boolean;
  onSnapshot: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
}

export function EditorToolbar({
  status,
  canEdit,
  busy,
  onSnapshot,
  onPublish,
  onUnpublish,
}: EditorToolbarProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 text-xs text-gray-500">
      <span aria-live="polite">
        {status === "connecting" && "Connecting…"}
        {status === "ready" && (canEdit ? "Connected" : "Read-only")}
        {status === "error" && "Connection error"}
      </span>
      <span className="flex items-center gap-1">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: "var(--atrium-human)" }}
        />
        You
      </span>
      <span className="flex items-center gap-1">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: "var(--atrium-agent)" }}
        />
        Agent
      </span>
      {canEdit && (
        <span className="ml-auto flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onSnapshot}
          >
            Snapshot
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={onPublish}
          >
            Publish
          </Button>
          {/* Visually separated as the "undo a public action" control so it isn't
              mistaken for Snapshot/Publish — unpublish removes a live page. */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onUnpublish}
            className="text-destructive hover:text-destructive"
          >
            Unpublish
          </Button>
        </span>
      )}
    </div>
  );
}
