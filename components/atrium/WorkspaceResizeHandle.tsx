"use client";

/**
 * Drag handle for the Nexus chat ↔ workspace-panel split (#1793).
 *
 * Sits on the panel's left edge. Pointer events are CAPTURED on pointerdown,
 * which is load-bearing rather than tidy: the panel renders `ArtifactCanvas`,
 * whose preview is a cross-origin `<iframe>`. Without capture the first
 * pointermove that crosses into the iframe is delivered to the iframe's
 * document instead of this page and the drag dies mid-gesture.
 *
 * Keyboard users get the same control through the `separator` role — arrows
 * step the split — because a drag-only affordance would make the widened panel
 * unreachable without a mouse.
 */

import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

export interface WorkspaceResizeHandleProps {
  /** Current panel fraction (0–1) of the split container. */
  widthPct: number;
  /** Live width during a drag — NOT persisted. */
  onResize: (pct: number) => void;
  /** End of an interaction: persist this fraction. */
  onCommit: (pct: number) => void;
  /**
   * Measures the split container. Returns null when it cannot be measured (the
   * panel is unmounting), in which case the gesture is a no-op.
   */
  measure: () => { left: number; width: number } | null;
}

/** One arrow press moves the divider by this fraction of the split. */
const KEYBOARD_STEP_PCT = 0.02;

export function WorkspaceResizeHandle({
  widthPct,
  onResize,
  onCommit,
  measure,
}: WorkspaceResizeHandleProps) {
  // The latest fraction produced by the in-flight drag. `widthPct` is a prop
  // captured at render time, so pointerup's handler would otherwise commit the
  // value from before the gesture.
  const latestPctRef = useRef(widthPct);
  const draggingRef = useRef(false);

  const applyFromClientX = useCallback(
    (clientX: number) => {
      const rect = measure();
      if (!rect || rect.width <= 0) return;
      // The panel is the RIGHT column: its width is the distance from the
      // pointer to the container's right edge.
      const pct = (rect.left + rect.width - clientX) / rect.width;
      latestPctRef.current = pct;
      onResize(pct);
    },
    [measure, onResize]
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Ignore secondary buttons so a right-click never starts a silent drag.
      if (event.button !== 0) return;
      event.preventDefault();
      draggingRef.current = true;
      latestPctRef.current = widthPct;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [widthPct]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      applyFromClientX(event.clientX);
    },
    [applyFromClientX]
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      onCommit(latestPctRef.current);
    },
    [onCommit]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Left widens the panel (the divider moves left), right narrows it.
      const direction =
        event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
      if (direction === 0) return;
      event.preventDefault();
      const next = widthPct + direction * KEYBOARD_STEP_PCT;
      onResize(next);
      onCommit(next);
    },
    [onCommit, onResize, widthPct]
  );

  return (
    <div
      // `slider`, not `separator`: a window splitter is conventionally a
      // focusable separator, but that role is non-interactive, so the tabIndex
      // and the arrow-key handler below would be reported as an a11y defect.
      // `slider` is interactive, takes the same aria-value* contract, and
      // announces exactly what this control does — move a value with arrows.
      role="slider"
      aria-orientation="vertical"
      aria-label="Resize workspace panel"
      // The consumer clamps, so the rendered fraction is always within range;
      // rounding keeps the announced value from reading as noise.
      aria-valuenow={Math.round(widthPct * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      data-testid="workspace-resize-handle"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      className={cn(
        // Straddles the panel's border so the grab target is comfortable
        // without a visible gutter eating layout width.
        "absolute inset-y-0 left-0 z-10 w-3 -translate-x-1/2 cursor-col-resize",
        "touch-none select-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent",
        "hover:after:bg-primary/40 focus-visible:after:bg-primary",
        "focus-visible:outline-none"
      )}
    />
  );
}
