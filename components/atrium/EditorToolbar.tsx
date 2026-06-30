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

type Status = "connecting" | "ready" | "error";

interface EditorToolbarProps {
  status: Status;
  canEdit: boolean;
  onSnapshot: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
}

export function EditorToolbar({
  status,
  canEdit,
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
          <button
            type="button"
            onClick={onSnapshot}
            className="rounded border px-2 py-1 hover:bg-gray-50"
          >
            Snapshot
          </button>
          <button
            type="button"
            onClick={onPublish}
            className="rounded border px-2 py-1 hover:bg-gray-50"
          >
            Publish
          </button>
          <button
            type="button"
            onClick={onUnpublish}
            className="rounded border px-2 py-1 hover:bg-gray-50"
          >
            Unpublish
          </button>
        </span>
      )}
    </div>
  );
}
