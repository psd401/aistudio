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
  /** Whether "suggesting mode" (track changes) is currently ON. */
  suggesting: boolean;
  /** Distinct pending-suggestion groups in the doc (drives the hint + Accept all). */
  suggestionCount: number;
  onSnapshot: () => void;
  onPublish: (destination: EditorPublishDestination) => void;
  onUnpublish: (destination: EditorPublishDestination) => void;
  /** Flip suggesting mode. */
  onToggleSuggesting: () => void;
  /** Resolve every pending suggestion to the accepted baseline. */
  onAcceptAll: () => void;
}

export function EditorToolbar({
  status,
  canEdit,
  busy,
  suggesting,
  suggestionCount,
  onSnapshot,
  onPublish,
  onUnpublish,
  onToggleSuggesting,
  onAcceptAll,
}: EditorToolbarProps): React.JSX.Element {
  // The picked destination drives BOTH Publish and Unpublish, so the "which
  // destination?" choice is one control (kept simple — spec asked for a select).
  // The disabled options cannot be picked, so this state is always a live
  // destination; intranet is the default.
  const [destination, setDestination] =
    useState<EditorPublishDestination>("intranet");

  // Read-only viewers get no action cluster — a quiet status chip instead. Live
  // presence + the sheet byline convey connection state for editors (the old
  // static You/Agent legend is superseded by the real presence avatars).
  if (!canEdit) {
    return (
      <span className="mer-legend" aria-live="polite">
        {status === "connecting" && "Connecting…"}
        {status === "ready" && "Read-only"}
        {status === "error" && (
          <span className="mer-legend-warn">Connection error</span>
        )}
      </span>
    );
  }

  return (
    // The Meridian editor controls cluster — Suggesting / Accept all / Snapshot /
    // Publish ▾ / Unpublish. History + Settings are injected alongside by the
    // parent topbar. flex-wrap keeps it from clipping in the narrow §17 panel.
    <div className="mer-ectl-group" data-testid="editor-controls">
      {suggestionCount > 0 && (
        <span data-testid="suggestion-count" className="mer-legend-warn">
          {suggestionCount} unresolved
        </span>
      )}
      {/* Track-changes toggle: while ON, edits become proposed suggestions. */}
      <button
        type="button"
        className="mer-ectl"
        data-active={suggesting ? "true" : "false"}
        aria-pressed={suggesting}
        disabled={busy}
        onClick={onToggleSuggesting}
        data-testid="suggesting-toggle"
      >
        Suggesting {suggesting ? "on" : "▾"}
      </button>
      <button
        type="button"
        className="mer-ectl"
        disabled={busy || suggestionCount === 0}
        onClick={onAcceptAll}
        data-testid="accept-all"
      >
        Accept all
      </button>
      <button
        type="button"
        className="mer-ectl"
        disabled={busy}
        onClick={onSnapshot}
      >
        Snapshot
      </button>
      <label className="mer-ectl-select-wrap">
        <span className="sr-only">Publish destination</span>
        {/* A native select (like the ArtifactCanvas version dropdown) — one small
            control, no new design-system surface. */}
        <select
          value={destination}
          onChange={(e) =>
            setDestination(e.target.value as EditorPublishDestination)
          }
          disabled={busy}
          className="mer-ectl-select"
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
      <button
        type="button"
        className="mer-ectl mer-ectl-primary"
        disabled={busy}
        onClick={() => onPublish(destination)}
      >
        Publish ▾
      </button>
      {/* Visually separated as the "undo a public action" control so it isn't
          mistaken for Snapshot/Publish — unpublish removes a live page. It acts on
          the SAME picked destination as Publish, so an object live on several
          destinations (e.g. intranet + public web) can have each taken down
          individually. */}
      <button
        type="button"
        className="mer-ectl mer-ectl-danger"
        disabled={busy}
        onClick={() => onUnpublish(destination)}
      >
        Unpublish
      </button>
    </div>
  );
}
