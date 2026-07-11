"use client";

/**
 * Atrium editor presence (Epic #1059 Meridian redesign, slice C)
 *
 * The real, live presence layer for the collaborative editor. It reads the Yjs
 * awareness that the `WebsocketProvider` already carries (previously configured
 * but never read — see DocumentEditor) and turns it into:
 *
 *  - a `roster` of connected clients for the topbar avatar stack,
 *  - `margins` — 26px avatars anchored to each connected author's live cursor,
 *    positioned in the sheet's left margin (README: "aligned to each author's
 *    last-edited block"), and
 *  - `agentWriting` — a live signal that flips true for a few seconds whenever
 *    agent-authored (`ai:`) text lands over the CRDT (the agent edits via the
 *    server bridge, not an awareness client, so this is the honest "agent is
 *    writing now" signal rather than a faked presence dot).
 *
 * Cursor wiring uses y-prosemirror's `yCursorPlugin` registered onto the LIVE
 * editor (via `editor.registerPlugin`) once the provider is ready — the same
 * ProseMirror plugin the `CollaborationCaret` extension wraps, used directly so
 * the editor keeps its deliberate single-creation lifecycle (DocumentEditor
 * creates the editor once and never rebuilds it on provider timing).
 *
 * TipTap/y-prosemirror are pure ESM (not jest-loadable); this hook is exercised
 * by the gated Playwright spec tests/e2e/atrium-meridian-editor.spec.ts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { WebsocketProvider } from "y-websocket";
import { yCursorPlugin, yCursorPluginKey } from "y-prosemirror";
import { AUTHORED_MARK, authorKindOf } from "@/lib/content/collab/provenance";
import {
  type PresenceUser,
  type PresenceKind,
  otherHumanColor,
  renderColorFor,
} from "@/lib/atrium/presence";

/** The local caller's identity, broadcast over awareness. */
export interface LocalPresenceUser {
  id: number;
  name: string;
  initials: string;
}

/** A margin avatar: a 26px chip pinned to `top` px inside the sheet wrap. */
export interface MarginAvatar {
  key: string;
  top: number;
  initials: string;
  color: string;
  kind: PresenceKind;
}

interface UsePresenceArgs {
  editor: Editor | null;
  provider: WebsocketProvider | null;
  /** The `.mer-sheet-wrap` element — the positioning context for margin avatars. */
  sheetRef: RefObject<HTMLDivElement | null>;
  localUser: LocalPresenceUser | null;
}

interface UsePresenceResult {
  roster: PresenceUser[];
  margins: MarginAvatar[];
  agentWriting: boolean;
}

/** How long the "agent writing" pill stays lit after the last agent edit. */
const AGENT_WRITING_WINDOW_MS = 4000;

/** Build the inline remote-caret DOM node, tagged so margin avatars can find it. */
function buildCaret(user: {
  id?: number | null;
  name?: string;
  initials?: string;
  kind?: PresenceKind;
  color?: string;
}): HTMLElement {
  const color = user.color ?? otherHumanColor(user.id ?? null);
  const caret = document.createElement("span");
  caret.className = "mer-caret";
  caret.setAttribute("data-mer-uid", String(user.id ?? "?"));
  caret.setAttribute("data-mer-kind", user.kind ?? "human");
  caret.setAttribute("data-mer-initials", user.initials ?? "?");
  caret.setAttribute("data-mer-color", color);
  caret.style.setProperty("--mer-caret-color", color);
  const label = document.createElement("span");
  label.className = "mer-caret-label";
  label.style.background = color;
  label.textContent = user.name ?? "Someone";
  caret.appendChild(label);
  return caret;
}

/** Total length of `ai:`-authored text in the doc (agent-written characters). */
function agentAuthoredLength(editor: Editor): number {
  const markType = editor.schema.marks[AUTHORED_MARK];
  if (!markType) return 0;
  let total = 0;
  editor.state.doc.descendants((node) => {
    if (!node.isText) return true;
    const authored = node.marks.find((m) => m.type === markType);
    if (authored && authorKindOf(authored.attrs.by as string) === "agent") {
      total += node.text?.length ?? 0;
    }
    return true;
  });
  return total;
}

/** Build the presence roster from the provider's awareness states. Self is
 *  sorted first (so the topbar stack does not reshuffle), then by client id. */
function collectRoster(
  awareness: WebsocketProvider["awareness"],
  localId: number | null
): PresenceUser[] {
  const next: PresenceUser[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    const u = (state as { user?: Record<string, unknown> }).user;
    if (!u) continue;
    const id = typeof u.id === "number" ? u.id : null;
    next.push({
      clientId,
      id,
      name: typeof u.name === "string" ? u.name : "Someone",
      initials: typeof u.initials === "string" ? u.initials : "?",
      kind: u.kind === "agent" ? "agent" : "human",
      color: typeof u.color === "string" ? u.color : otherHumanColor(id),
    });
  }
  next.sort((a, b) => {
    const aSelf = localId != null && a.id === localId ? 0 : 1;
    const bSelf = localId != null && b.id === localId ? 0 : 1;
    return aSelf - bSelf || a.clientId - b.clientId;
  });
  return next;
}

/**
 * Live "agent is writing" signal: flips true for a few seconds whenever the total
 * `ai:`-authored length grows (a remote agent edit landed over the CRDT — local
 * human edits are always `human:`-tagged, so a rise is unambiguously the agent).
 */
function useAgentWriting(editor: Editor | null): boolean {
  const [agentWriting, setAgentWriting] = useState(false);
  useEffect(() => {
    if (!editor) return;
    let prev = agentAuthoredLength(editor);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      const now = agentAuthoredLength(editor);
      if (now > prev) {
        setAgentWriting(true);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => setAgentWriting(false), AGENT_WRITING_WINDOW_MS);
      }
      prev = now;
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [editor]);
  return agentWriting;
}

export function usePresence({
  editor,
  provider,
  sheetRef,
  localUser,
}: UsePresenceArgs): UsePresenceResult {
  const [roster, setRoster] = useState<PresenceUser[]>([]);
  const [margins, setMargins] = useState<MarginAvatar[]>([]);
  const agentWriting = useAgentWriting(editor);

  const localIdRef = useRef<number | null>(localUser?.id ?? null);
  localIdRef.current = localUser?.id ?? null;

  // --- Read the awareness roster into React state -----------------------------
  const readRoster = useCallback(() => {
    if (!provider) return;
    setRoster(collectRoster(provider.awareness, localIdRef.current));
  }, [provider]);

  // --- Compute margin avatars from live cursor positions ----------------------
  const recomputeMargins = useCallback(() => {
    const wrap = sheetRef.current;
    if (!editor || !wrap) return;
    const wrapTop = wrap.getBoundingClientRect().top;
    const seen = new Set<string>();
    const next: MarginAvatar[] = [];

    // Remote carets rendered by yCursorPlugin (tagged by buildCaret).
    const carets = editor.view.dom.querySelectorAll<HTMLElement>("[data-mer-uid]");
    for (const el of carets) {
      const uid = el.getAttribute("data-mer-uid") ?? "?";
      if (seen.has(uid)) continue;
      seen.add(uid);
      const rect = el.getBoundingClientRect();
      next.push({
        key: `remote-${uid}`,
        top: Math.max(0, rect.top - wrapTop),
        initials: el.getAttribute("data-mer-initials") ?? "?",
        color: el.getAttribute("data-mer-color") ?? otherHumanColor(null),
        kind: (el.getAttribute("data-mer-kind") as PresenceKind) ?? "human",
      });
    }

    // The local caller's own margin avatar (self is green; yCursorPlugin does not
    // render a caret for the local client, so derive it from the live selection).
    const local = localUser;
    if (local) {
      try {
        const coords = editor.view.coordsAtPos(editor.state.selection.head);
        next.push({
          key: `self-${local.id}`,
          top: Math.max(0, coords.top - wrapTop),
          initials: local.initials,
          color: renderColorFor({ id: local.id, kind: "human", color: "" }, local.id),
          kind: "human",
        });
      } catch {
        // coordsAtPos throws if the position is momentarily unmapped mid-sync —
        // skip the self avatar this pass; the next recompute will place it.
      }
    }
    setMargins(next);
  }, [editor, sheetRef, localUser]);

  // Schedule a margins recompute on the next frame (coalesces bursts of events).
  const rafRef = useRef<number | null>(null);
  const scheduleRecompute = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      recomputeMargins();
    });
  }, [recomputeMargins]);

  // --- Wire awareness + the cursor plugin onto the live editor -----------------
  useEffect(() => {
    if (!editor || !provider || !localUser) return;
    const awareness = provider.awareness;

    // Broadcast this client's identity. Humans broadcast their stable "other"
    // color (peers render it); the local view overrides self to green.
    awareness.setLocalStateField("user", {
      id: localUser.id,
      name: localUser.name,
      initials: localUser.initials,
      kind: "human" as PresenceKind,
      color: otherHumanColor(localUser.id),
    });

    // Register the collaboration cursor plugin (idempotent per editor/provider).
    if (!yCursorPluginKey.getState(editor.state)) {
      editor.registerPlugin(
        yCursorPlugin(awareness, {
          cursorBuilder: buildCaret as (user: Record<string, unknown>) => HTMLElement,
        })
      );
    }

    const onAwareness = () => {
      readRoster();
      scheduleRecompute();
    };
    awareness.on("change", onAwareness);
    readRoster();
    scheduleRecompute();

    return () => {
      awareness.off("change", onAwareness);
      awareness.setLocalStateField("user", null);
      // Best-effort: the editor may already be torn down when this cleanup runs.
      try {
        editor.unregisterPlugin(yCursorPluginKey);
      } catch {
        /* editor destroyed — nothing to unregister */
      }
    };
  }, [editor, provider, localUser, readRoster, scheduleRecompute]);

  // --- Recompute margins when the doc/selection/viewport changes --------------
  useEffect(() => {
    if (!editor) return;
    const onChange = () => scheduleRecompute();
    editor.on("update", onChange);
    editor.on("selectionUpdate", onChange);

    const wrap = sheetRef.current;
    const ro = wrap ? new ResizeObserver(() => scheduleRecompute()) : null;
    if (wrap && ro) ro.observe(wrap);
    window.addEventListener("scroll", onChange, true);
    window.addEventListener("resize", onChange);

    return () => {
      editor.off("update", onChange);
      editor.off("selectionUpdate", onChange);
      ro?.disconnect();
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [editor, sheetRef, scheduleRecompute]);

  return { roster, margins, agentWriting };
}
