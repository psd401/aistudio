"use client";

/**
 * Atrium EditableSheetTitle — inline-editable document title (Epic #1059 polish).
 *
 * README Interactions: "New doc opens a blank sheet immediately … Title
 * auto-suggested, editable inline." The sheet H1 is a plaintext contentEditable
 * for editors: it saves on blur (only when changed + non-empty) via the same
 * `updateContentAction` the Settings dialog uses (which runs the capability /
 * canView / assertCanEdit gates server-side), then lifts the new value to the
 * parent so the topbar breadcrumb + byline stay in sync without a full reload.
 *
 * Read-only viewers get a static H1. Kept OUT of the collaborative Y.Doc — the
 * title is object metadata, not editor body content, so this never perturbs the
 * TipTap/Yjs schema or the live collab document.
 */

import { useCallback, useEffect, useRef } from "react";
import { updateContentAction } from "@/actions/db/atrium/update-content";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "EditableSheetTitle" });

interface EditableSheetTitleProps {
  objectId: string;
  /** The current title (owned by the parent so breadcrumb/byline stay in sync). */
  value: string;
  /** Whether the viewer may rename (the server re-checks regardless). */
  canEdit: boolean;
  /** Lift a committed rename to the parent (updates breadcrumb + byline live). */
  onCommit: (next: string) => void;
}

export function EditableSheetTitle({
  objectId,
  value,
  canEdit,
  onCommit,
}: EditableSheetTitleProps): React.JSX.Element {
  // The last value we persisted — so blur without a real change never fires a
  // needless server round-trip (typing then tabbing away unchanged). Synced to
  // the prop each render so an EXTERNAL rename (e.g. the Settings dialog → a
  // refreshed `value`) is never overwritten by a stale local baseline.
  const savedRef = useRef(value);
  // Sync in an effect (never during render) so an EXTERNAL rename (Settings dialog
  // → refreshed `value`) updates the baseline. An inline commit sets savedRef
  // directly in the blur handler, so this only tracks out-of-band changes.
  useEffect(() => {
    savedRef.current = value;
  }, [value]);

  const commit = useCallback(
    async (raw: string, element: HTMLElement) => {
      const next = raw.replace(/\s+/g, " ").trim();
      if (!next) {
        // Cleared + blurred: restore the visible title (never persist an empty
        // one, and never leave the H1 showing a placeholder while the real title
        // stands in the breadcrumb/DB).
        element.textContent = savedRef.current;
        return;
      }
      if (next === savedRef.current) return;
      // Optimistic: reflect immediately, roll back on failure.
      const previous = savedRef.current;
      savedRef.current = next;
      onCommit(next);
      try {
        const res = await updateContentAction(objectId, { title: next });
        if (!res.isSuccess) {
          savedRef.current = previous;
          onCommit(previous);
          log.warn("title rename failed", { message: res.message });
        }
      } catch (e) {
        savedRef.current = previous;
        onCommit(previous);
        log.error("title rename threw", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [objectId, onCommit]
  );

  if (!canEdit) {
    return <h1 className="mer-sheet-title">{value}</h1>;
  }

  return (
    <h1
      className="mer-sheet-title mer-sheet-title-edit"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label="Document title"
      data-placeholder="Untitled"
      spellCheck={false}
      onKeyDown={(e) => {
        // Enter commits (a title is single-line); Escape restores + blurs.
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.currentTarget.textContent = savedRef.current;
          (e.currentTarget as HTMLElement).blur();
        }
      }}
      onBlur={(e) => void commit(e.currentTarget.textContent ?? "", e.currentTarget)}
    >
      {value}
    </h1>
  );
}
