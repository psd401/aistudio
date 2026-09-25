"use client";

/**
 * The Nexus workspace panel's user-controlled split width (#1793).
 *
 * Owns the fraction, the element ref used to measure the split container, and
 * the inline style the panel renders with. Lives beside `WorkspacePanel` rather
 * than inside it so the panel component stays about loading and rendering the
 * workspace object; the storage/clamping rules are in
 * `lib/atrium/workspace-panel-width.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MIN_CHAT_COLUMN_PX,
  MIN_WORKSPACE_PANEL_PX,
  clampWorkspacePanelWidthPct,
  readStoredWorkspacePanelWidthPct,
  storeWorkspacePanelWidthPct,
} from "@/lib/atrium/workspace-panel-width";

export interface WorkspacePanelWidth {
  /** Attach to the panel element — its PARENT is the split container. */
  asideRef: React.MutableRefObject<HTMLElement | null>;
  /** Current fraction (0–1) of the split taken by the panel. */
  widthPct: number;
  /** Inline width/min/max for the panel element. */
  panelStyle: React.CSSProperties;
  /** Live update during a drag — not persisted. */
  resizeTo: (pct: number) => void;
  /** End of an interaction — clamps and persists. */
  commitWidth: (pct: number) => void;
  /** Measures the split container, or null when it is not mounted. */
  measureSplit: () => { left: number; width: number } | null;
}

export function useWorkspacePanelWidth(): WorkspacePanelWidth {
  const asideRef = useRef<HTMLElement | null>(null);
  // Read synchronously on the first render — the panel is a client-only
  // (`ssr: false`) chunk, so there is no server markup to mismatch, and an
  // effect-based read would paint the default width first and then jump.
  const [widthPct, setWidthPct] = useState(readStoredWorkspacePanelWidthPct);

  const measureSplit = useCallback(() => {
    const parent = asideRef.current?.parentElement;
    if (!parent) return null;
    const rect = parent.getBoundingClientRect();
    return { left: rect.left, width: rect.width };
  }, []);

  const resizeTo = useCallback(
    (pct: number) => {
      setWidthPct(clampWorkspacePanelWidthPct(pct, measureSplit()?.width ?? 0));
    },
    [measureSplit]
  );

  const commitWidth = useCallback(
    (pct: number) => {
      const clamped = clampWorkspacePanelWidthPct(
        pct,
        measureSplit()?.width ?? 0
      );
      setWidthPct(clamped);
      storeWorkspacePanelWidthPct(clamped);
    },
    [measureSplit]
  );

  // The split container's width, tracked so the STORED preference and the
  // EFFECTIVE fraction can differ. The CSS bounds below already stop the panel
  // from rendering outside its limits after a window resize or the Nexus
  // sidebar opening, but the number in state would stay at the pre-resize
  // preference — and that number is what the handle announces as
  // `aria-valuenow` and what an arrow key steps from. Without this, shrinking
  // the window and then pressing an arrow makes the panel jump from wherever
  // CSS is drawing it to a step off a fraction nobody can see.
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const parent = asideRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setContainerWidth(parent.getBoundingClientRect().width);
    measure();
    // Absent in some test environments (jsdom) — the CSS bounds still hold, so
    // degrade to the unobserved behaviour rather than throwing.
    if (typeof ResizeObserver === "undefined") return;
    // Re-measures the element rather than reading the entry, matching
    // `use-presence.ts` and keeping one source of truth for the number.
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  // The preference is kept AS STORED and only clamped for display, so a
  // temporarily narrow window does not quietly overwrite the width the user
  // chose on a wide one — re-widening restores it.
  const effectivePct = clampWorkspacePanelWidthPct(widthPct, containerWidth);

  // `min-width` deliberately wins over `max-width` per CSS when the split is
  // too narrow for both minimums, keeping the panel out of the phone-width
  // rendering #1793 is about (see workspace-panel-width.ts). They also cover
  // the first paint, before the observer above has measured anything.
  const panelStyle = useMemo(
    () => ({
      width: `${(effectivePct * 100).toFixed(2)}%`,
      minWidth: `${MIN_WORKSPACE_PANEL_PX}px`,
      maxWidth: `calc(100% - ${MIN_CHAT_COLUMN_PX}px)`,
    }),
    [effectivePct]
  );

  return {
    asideRef,
    // What is actually on screen — never the raw preference, so the handle
    // announces and steps from the width the user can see.
    widthPct: effectivePct,
    panelStyle,
    resizeTo,
    commitWidth,
    measureSplit,
  };
}
