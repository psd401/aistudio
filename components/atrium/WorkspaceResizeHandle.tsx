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
  // The ONE pointer that owns the gesture, or null. A boolean here is not
  // enough on a touch screen: a second finger landing on the handle mid-drag
  // would reset the shared state, and then the FIRST finger's pointerup would
  // end a gesture the second finger is still performing — freezing it until it
  // lifts and touches again. Identifying the owner makes every other pointer a
  // no-op for the whole gesture.
  const activePointerRef = useRef<number | null>(null);

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
      // Ignore secondary buttons so a right-click never starts a silent drag,
      // and ignore any pointer that arrives while another already owns the
      // gesture.
      if (event.button !== 0 || activePointerRef.current !== null) return;
      event.preventDefault();
      activePointerRef.current = event.pointerId;
      latestPctRef.current = widthPct;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [widthPct]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (activePointerRef.current !== event.pointerId) return;
      applyFromClientX(event.clientX);
    },
    [applyFromClientX]
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (activePointerRef.current !== event.pointerId) return;
      activePointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      onCommit(latestPctRef.current);
    },
    [onCommit]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // The value this control exposes is the DIVIDER's position from the left
      // (see the aria-* below), so the slider convention and the spatial
      // meaning agree: Right/Up move the divider right and the panel narrows,
      // Left/Down move it left and the panel widens. Up/Down are accepted as
      // well as Left/Right because a slider is expected to answer to both.
      const towardsRight =
        event.key === "ArrowRight" || event.key === "ArrowUp"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowDown"
            ? -1
            : 0;
      if (towardsRight === 0) return;
      event.preventDefault();
      // Divider right = panel smaller, hence the sign flip.
      const next = widthPct - towardsRight * KEYBOARD_STEP_PCT;
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
      // HORIZONTAL: the value moves along the horizontal axis, and the keys
      // that change it are Left/Right (plus Up/Down, per the slider pattern).
      // Announcing "vertical" would point a screen-reader user at the axis the
      // control does not travel on.
      aria-orientation="horizontal"
      aria-label="Workspace panel divider"
      // The DIVIDER's position as a percentage from the left of the split, not
      // the panel's width — so a larger value means the divider is further
      // right, which is what "increase" has to mean for a horizontal slider.
      // The consumer clamps, so it is always in range; rounding keeps the
      // announced value from reading as noise.
      aria-valuenow={Math.round((1 - widthPct) * 100)}
      aria-valuetext={`Workspace panel ${Math.round(widthPct * 100)}% of the width`}
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
