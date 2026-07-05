"use client";

/**
 * Atrium DocumentEditor toolbar (Issue #1054 extract; destination picker added
 * for Epic #1059 completion).
 *
 * The status row + author legend + edit actions (Snapshot / Publish / Unpublish)
 * plus a small publish-destination picker. Extracted from `DocumentEditor` so the
 * editor component stays under the max-lines lint and the toolbar can be reasoned
 * about on its own. Presentation only: the action handlers are owned by the
 * parent (they target the resolved object UUID and re-check permission
 * server-side); the picker only chooses WHICH destination the handlers act on.
 *
 * Destination semantics:
 * - `intranet` (default) — the internal reader; never trips the §26.4 gate.
 * - `public_web` — §26.4 public destination; a caller without public-publish
 *   authority gets the amber pending-approval outcome (the picker labels this).
 * - `schoology` / `google` — visible but DISABLED ("coming soon"): their
 *   adapters are governed connector stubs that throw `implemented: false`, so
 *   offering them live would only surface an error.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { EditorPublishDestination } from "@/actions/db/atrium/publish-document";

type Status = "connecting" | "ready" | "error";

/** The picker's options — the editor-publishable destinations, in menu order. */
const DESTINATION_OPTIONS: ReadonlyArray<{
  value: EditorPublishDestination;
  label: string;
  disabled?: boolean;
}> = [
  { value: "intranet", label: "Intranet" },
  { value: "public_web", label: "Public web — may require approval" },
  { value: "schoology", label: "Schoology (coming soon)", disabled: true },
  { value: "google", label: "Google (coming soon)", disabled: true },
];

interface EditorToolbarProps {
  status: Status;
  canEdit: boolean;
  /** An edit action is in flight — disables the buttons to block double-fire. */
  busy: boolean;
  onSnapshot: () => void;
  onPublish: (destination: EditorPublishDestination) => void;
  onUnpublish: (destination: EditorPublishDestination) => void;
}

export function EditorToolbar({
  status,
  canEdit,
  busy,
  onSnapshot,
  onPublish,
  onUnpublish,
}: EditorToolbarProps): React.JSX.Element {
  // The picked destination drives BOTH Publish and Unpublish, so the "which
  // destination?" choice is one control (kept simple — spec asked for a select).
  // The disabled options cannot be picked, so this state is always a live
  // destination; intranet is the default.
  const [destination, setDestination] =
    useState<EditorPublishDestination>("intranet");

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
        <span className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onSnapshot}
          >
            Snapshot
          </Button>
          <label className="flex items-center gap-1">
            <span className="sr-only">Publish destination</span>
            {/* A native select (like the ArtifactCanvas version dropdown) — one
                small control, no new design-system surface. */}
            <select
              value={destination}
              onChange={(e) =>
                setDestination(e.target.value as EditorPublishDestination)
              }
              disabled={busy}
              className="rounded border px-1 py-1"
              data-testid="publish-destination-select"
              aria-label="Publish destination"
            >
              {DESTINATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => onPublish(destination)}
          >
            Publish
          </Button>
          {/* Visually separated as the "undo a public action" control so it isn't
              mistaken for Snapshot/Publish — unpublish removes a live page. It
              acts on the SAME picked destination as Publish, so an object live on
              several destinations (e.g. intranet + public web) can have each
              taken down individually. */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onUnpublish(destination)}
            className="text-destructive hover:text-destructive"
          >
            Unpublish
          </Button>
        </span>
      )}
    </div>
  );
}
