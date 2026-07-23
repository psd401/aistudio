"use client";

/**
 * Atrium DocumentEditor toolbar — the "editing mode" cluster (Issue #1054
 * extract; Meridian topbar polish, Epic #1059).
 *
 * The left half of the editor topbar controls: the suggesting (track-changes)
 * toggle + a conditional "Accept all" for pending suggestions, plus a read-only
 * status chip for viewers. The publish cluster (destination / publish / unpublish
 * / snapshot) now lives in `PublishMenu` as the primary "Publish ▾" split control,
 * and History / Settings / Visibility are injected by the topbar alongside — so
 * the row reads like the spec: Suggesting ▾ · History · Publish ▾.
 *
 * Presentation only: the toggle/accept handlers are owned by the parent.
 */

type Status = "connecting" | "ready" | "error";

interface EditorToolbarProps {
  status: Status;
  canEdit: boolean;
  /** An edit action is in flight — disables the buttons to block double-fire. */
  busy: boolean;
  /** Whether "suggesting mode" (track changes) is currently ON. */
  suggesting: boolean;
  /** Distinct pending-suggestion groups in the doc (drives the hint + Accept all). */
  suggestionCount: number;
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
  onToggleSuggesting,
  onAcceptAll,
}: EditorToolbarProps): React.JSX.Element {
  // Read-only viewers get no action cluster — a quiet status chip instead. Live
  // presence + the sheet byline convey connection state for editors.
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
    // The Meridian "editing mode" cluster — the unresolved hint, Suggesting toggle,
    // and (only while there are pending suggestions) Accept all. flex-wrap keeps it
    // from clipping in the narrow §17 panel.
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
      {suggestionCount > 0 && (
        <button
          type="button"
          className="mer-ectl"
          disabled={busy}
          onClick={onAcceptAll}
          data-testid="accept-all"
        >
          Accept all
        </button>
      )}
    </div>
  );
}
