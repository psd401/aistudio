"use client";

/**
 * Atrium document cover band + emoji icon (Epic #1059 Meridian slice F)
 *
 * The editor-side "2b" cover: a 170px gradient band with a "Change cover · 🖼" glass
 * pill and a 56px emoji tile overlapping its bottom (README §"2b"). The gradient is a
 * PRESET KEY (never raw CSS — `lib/atrium/cover.ts`), and the emoji is plain text; a
 * change persists through the metadata write path (`updateContentAction`, the same
 * §-gated `contentService.update` that rename/tags/section use — cover + icon are
 * presentation metadata, not screened body content). The reader shows the same band
 * via `ReaderFrame`.
 *
 * State: the cover/icon are held locally (seeded from the server props) for instant
 * feedback and persisted optimistically; a failed save reverts and surfaces an
 * error. Read-only viewers (`canEdit === false`) get the band with no pill/picker.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { updateContentAction } from "@/actions/db/atrium/update-content";
import {
  COVER_GRADIENT_KEYS,
  COVER_GRADIENT_LABELS,
  coverGradientClass,
  type CoverGradientKey,
} from "@/lib/atrium/cover";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "DocumentCover" });

export interface DocumentCoverProps {
  objectId: string;
  /** Persisted cover-gradient preset key, or null. */
  coverGradient: string | null;
  /** Persisted emoji icon, or null. */
  icon: string | null;
  /** Whether this viewer may change the cover (hides the pill + picker if false). */
  canEdit: boolean;
}

/**
 * The cover popover: gradient swatches, the emoji field, and "Remove cover".
 * Extracted from `DocumentCover` so both bodies stay under the
 * max-lines-per-function lint. Purely presentational — every mutation is a
 * callback into the parent, which owns the optimistic persist.
 */
function CoverPicker({
  grad,
  saving,
  emojiDraft,
  onEmojiDraft,
  emojiRef,
  onCommitEmoji,
  onPickGradient,
  onRemove,
}: {
  grad: string | null;
  saving: boolean;
  emojiDraft: string;
  onEmojiDraft: (v: string) => void;
  emojiRef: React.RefObject<HTMLInputElement | null>;
  onCommitEmoji: () => void;
  onPickGradient: (key: CoverGradientKey) => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className="mer-cover-picker" role="menu" data-testid="editor-cover-picker">
      <div className="mer-cover-picker-label">Cover</div>
      <div className="mer-cover-swatches">
        {COVER_GRADIENT_KEYS.map((key: CoverGradientKey) => (
          <button
            key={key}
            type="button"
            role="menuitemradio"
            aria-checked={grad === key}
            className={`mer-cover-swatch mer-cover--${key}`}
            data-selected={grad === key ? "true" : "false"}
            title={COVER_GRADIENT_LABELS[key]}
            aria-label={COVER_GRADIENT_LABELS[key]}
            disabled={saving}
            onClick={() => onPickGradient(key)}
          />
        ))}
      </div>
      <div className="mer-cover-picker-label">Icon</div>
      <div className="mer-cover-emoji-field">
        <input
          ref={emojiRef}
          type="text"
          className="mer-cover-emoji-input"
          value={emojiDraft}
          onChange={(e) => onEmojiDraft(e.target.value)}
          maxLength={16}
          placeholder="🎉 (paste an emoji)"
          aria-label="Doc emoji icon"
          data-testid="editor-cover-emoji-input"
          disabled={saving}
          onBlur={onCommitEmoji}
          onKeyDown={(e) => {
            if (e.key === "Enter") emojiRef.current?.blur();
          }}
        />
      </div>
      <div className="mer-cover-picker-actions">
        <button
          type="button"
          className="mer-cover-picker-remove"
          data-testid="editor-remove-cover"
          disabled={saving}
          onClick={onRemove}
        >
          Remove cover
        </button>
      </div>
    </div>
  );
}

export function DocumentCover({
  objectId,
  coverGradient,
  icon,
  canEdit,
}: DocumentCoverProps): React.JSX.Element | null {
  const [grad, setGrad] = useState<string | null>(coverGradient);
  const [emoji, setEmoji] = useState<string | null>(icon);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const emojiRef = useRef<HTMLInputElement | null>(null);
  // The positioning frame (band + picker). Outside-click detection tests against
  // it so clicking the "Change cover" pill or anywhere in the picker is "inside".
  const frameRef = useRef<HTMLDivElement | null>(null);

  const gradClass = coverGradientClass(grad);
  const trimmedEmoji = emoji?.trim() || null;
  const hasCover = Boolean(gradClass) || Boolean(trimmedEmoji);

  // The emoji field is CONTROLLED (#1336 B1). It used to be an uncontrolled
  // `defaultValue` input, so after an optimistic save was reverted by a failed
  // `updateContentAction` the field kept showing the value that did NOT persist.
  // Re-synced from the persisted value with the React "adjust state on prop
  // change during render" pattern — no effect, no cascading render.
  const [emojiDraft, setEmojiDraft] = useState(trimmedEmoji ?? "");
  const [syncedEmoji, setSyncedEmoji] = useState(trimmedEmoji);
  if (trimmedEmoji !== syncedEmoji) {
    setSyncedEmoji(trimmedEmoji);
    setEmojiDraft(trimmedEmoji ?? "");
  }

  // Persist a cover/icon patch optimistically; revert both on failure.
  const persist = useCallback(
    async (next: { coverGradient?: string | null; icon?: string | null }) => {
      const prevGrad = grad;
      const prevEmoji = emoji;
      if (next.coverGradient !== undefined) setGrad(next.coverGradient);
      if (next.icon !== undefined) setEmoji(next.icon);
      setSaving(true);
      try {
        const res = await updateContentAction(objectId, next);
        if (!res.isSuccess) {
          setGrad(prevGrad);
          setEmoji(prevEmoji);
          log.warn("cover update failed", { message: res.message });
        }
      } catch (e) {
        setGrad(prevGrad);
        setEmoji(prevEmoji);
        log.error("cover update threw", {
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setSaving(false);
      }
    },
    [objectId, grad, emoji]
  );

  // Flush a pending emoji edit (no-op when unchanged). Called on blur, on Enter,
  // and on every dismissal path so closing the picker can never silently drop
  // what the user just typed.
  const commitEmoji = useCallback(() => {
    const next = emojiDraft.trim();
    if (next !== (trimmedEmoji ?? "")) void persist({ icon: next || null });
  }, [emojiDraft, trimmedEmoji, persist]);

  const closePicker = useCallback(() => {
    commitEmoji();
    setOpen(false);
  }, [commitEmoji]);

  // Dismissal (#1336 B1): the picker previously had no way to close other than
  // re-clicking the pill. Escape closes it, and so does a click anywhere outside
  // the frame. Both listeners are attached only while it is open.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closePicker();
    }
    // `mousedown` rather than `click`: React unmounts the emoji input as soon as
    // the state update lands, which can pre-empt its blur handler — so the
    // dismissal path commits the draft itself (`closePicker`) instead of relying
    // on that blur firing.
    function onPointerDown(e: MouseEvent) {
      const frame = frameRef.current;
      if (frame && !frame.contains(e.target as Node)) closePicker();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, closePicker]);

  const addCover = useCallback(() => {
    void persist({ coverGradient: "default" });
    // DELIBERATELY does NOT auto-open the picker (#1336 B1): opening it
    // immediately made the clipped popover the very first thing a user saw.
    // The "Change cover · 🖼" pill is right there on the new band.
  }, [persist]);

  const removeCover = useCallback(() => {
    setOpen(false);
    void persist({ coverGradient: null, icon: null });
  }, [persist]);

  // No cover yet: a quiet "Add cover" affordance (editors only).
  if (!hasCover) {
    if (!canEdit) return null;
    return (
      <button
        type="button"
        className="mer-cover-add"
        data-testid="editor-add-cover"
        onClick={addCover}
        disabled={saving}
      >
        🖼 Add cover
      </button>
    );
  }

  return (
    <div className="mer-cover-block">
      {/* The frame is the picker's positioning context. The picker MUST NOT be a
          child of `.mer-cover`: that band keeps `overflow: hidden` (load-bearing
          for its two radial glow pseudo-elements), which clipped the popover's
          bottom third — the ICON label, the emoji field, and "Remove cover"
          (#1336 B1). */}
      <div className="mer-cover-frame" ref={frameRef}>
        <div
          className={`mer-cover ${gradClass ?? "mer-cover--default"}`}
          data-testid="editor-cover"
        >
          {canEdit && (
            <button
              type="button"
              className="mer-cover-change"
              data-testid="editor-change-cover"
              onClick={() => (open ? closePicker() : setOpen(true))}
              aria-haspopup="menu"
              aria-expanded={open}
            >
              Change cover · 🖼
            </button>
          )}
        </div>
        {open && canEdit && (
          <CoverPicker
            grad={grad}
            saving={saving}
            emojiDraft={emojiDraft}
            onEmojiDraft={setEmojiDraft}
            emojiRef={emojiRef}
            onCommitEmoji={commitEmoji}
            onPickGradient={(key) => void persist({ coverGradient: key })}
            onRemove={removeCover}
          />
        )}
      </div>
      {trimmedEmoji && (
        <div className="mer-cover-icon" data-testid="editor-cover-icon">
          {trimmedEmoji}
        </div>
      )}
    </div>
  );
}

export default DocumentCover;
