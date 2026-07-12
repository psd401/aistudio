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

import { useCallback, useRef, useState } from "react";
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

  const gradClass = coverGradientClass(grad);
  const trimmedEmoji = emoji?.trim() || null;
  const hasCover = Boolean(gradClass) || Boolean(trimmedEmoji);

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

  const addCover = useCallback(() => {
    void persist({ coverGradient: "default" });
    setOpen(true);
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
    <>
      <div
        className={`mer-cover ${gradClass ?? "mer-cover--default"}`}
        data-testid="editor-cover"
      >
        {canEdit && (
          <button
            type="button"
            className="mer-cover-change"
            data-testid="editor-change-cover"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            Change cover · 🖼
          </button>
        )}
        {open && canEdit && (
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
                  onClick={() => void persist({ coverGradient: key })}
                />
              ))}
            </div>
            <div className="mer-cover-picker-label">Icon</div>
            <div className="mer-cover-emoji-field">
              <input
                ref={emojiRef}
                type="text"
                className="mer-cover-emoji-input"
                defaultValue={trimmedEmoji ?? ""}
                maxLength={16}
                placeholder="🎉 (paste an emoji)"
                aria-label="Doc emoji icon"
                data-testid="editor-cover-emoji-input"
                disabled={saving}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (trimmedEmoji ?? "")) void persist({ icon: v || null });
                }}
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
                onClick={removeCover}
              >
                Remove cover
              </button>
            </div>
          </div>
        )}
      </div>
      {trimmedEmoji && (
        <div className="mer-cover-icon" data-testid="editor-cover-icon">
          {trimmedEmoji}
        </div>
      )}
    </>
  );
}

export default DocumentCover;
