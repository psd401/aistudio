/**
 * Atrium "suggesting mode" (TipTap) — Epic #1059, §18.1
 *
 * Client-only extension that turns direct edits into PROPOSED changes while it is
 * ON (the track-changes toggle). It holds a single `suggesting` boolean in plugin
 * state (flipped by a command) and, when ON:
 *
 *  - INSERTIONS: an `appendTransaction` marks the ranges the LOCAL user just
 *    inserted with `atriumSuggestionInsert` (green underline). It mirrors
 *    authored-tracker.ts's range-collection + `isChangeOrigin` guard so REMOTE
 *    (Yjs) edits — which already carry their author's marks — are never re-marked.
 *
 *  - DELETIONS: Backspace/Delete (and a typed range-replace) do NOT remove text.
 *    Instead the affected inline range is marked `atriumSuggestionDelete` (red
 *    strikethrough); the caret advances so repeated presses walk along the text.
 *    A range-replace additionally inserts the typed text as a pending insertion.
 *    Deletion interception is deliberately confined to INLINE text within a single
 *    keystroke: at a block boundary the handler defers to ProseMirror's default so
 *    block joins/merges behave normally (they are not proposed as suggestions).
 *
 * It coexists with AuthoredTracker and ProvenanceRail (all three plugins run): a
 * suggestion is a SEPARATE visual layer over the green/purple authorship rail, so
 * inserted text reads as both human-authored (green rail) and pending (underline).
 *
 * Marked text is resolved to the accepted baseline by `resolveDocToCleanJSON` /
 * `acceptAllSuggestions` (see lib/content/collab/suggestions.ts). This module
 * imports the pure-ESM TipTap/ProseMirror runtime, so it is NOT jest-loadable; it
 * is covered by tests/smoke/atrium-suggestion-mode.smoke.ts (Bun).
 */

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { MarkType } from "@tiptap/pm/model";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { useEffect, useState } from "react";
import {
  ATRIUM_SUGGESTION_INSERT_MARK,
  ATRIUM_SUGGESTION_DELETE_MARK,
} from "@/lib/content/collab/suggestion-marks";
import { countSuggestions } from "@/lib/content/collab/suggestions";

export interface SuggestionModeOptions {
  /** The current actor's author tag stamped on suggestions, e.g. "human:42". */
  by: string;
  /** Whether suggesting mode starts ON (default false). */
  defaultOn: boolean;
}

interface SuggestionState {
  suggesting: boolean;
}

/**
 * Shared plugin key: the toggle command sets its state via meta on THIS key, and
 * the plugin + `useSuggestionState` read it — so it must be a module singleton.
 */
export const suggestionModePluginKey = new PluginKey<SuggestionState>(
  "atriumSuggestionMode"
);

/**
 * Meta flag stamped on transactions produced BY this extension (the deletion-
 * interception and range-replace handlers) so `appendTransaction` does not re-mark
 * their already-stamped inserted ranges with a second suggestion id.
 */
const SUGGESTION_HANDLED = "atriumSuggestionHandled";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    atriumSuggestionMode: {
      /** Turn suggesting mode on/off. */
      setSuggesting: (on: boolean) => ReturnType;
      /** Flip suggesting mode. */
      toggleSuggesting: () => ReturnType;
    };
  }
}

/**
 * The stable per-editor context threaded through the deletion/replace handlers:
 * the view, the current actor tag, and the two suggestion mark types (all captured
 * once in the plugin closure). Passing it as one object keeps each handler under
 * the max-params limit.
 */
interface SuggestCtx {
  view: EditorView;
  by: string;
  insertType: MarkType;
  deleteType: MarkType;
}

/** A collision-resistant suggestion id (browser crypto; Bun/Node fallback). */
function createSuggestionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Mark an inline range [from, to) as proposed-deletion (text kept) and advance the
 * caret past it so a run of Backspace/Delete walks along the text. Returns true
 * (the keystroke is handled). No-op false for an empty range.
 */
function markDeletion(ctx: SuggestCtx, from: number, to: number, keyName: string): boolean {
  if (to <= from) return false;
  const mark = ctx.deleteType.create({
    suggestionId: createSuggestionId(),
    by: ctx.by,
    at: new Date().toISOString(),
  });
  const tr = ctx.view.state.tr.addMark(from, to, mark).setMeta(SUGGESTION_HANDLED, true);
  const caret = keyName === "Backspace" ? from : to;
  tr.setSelection(TextSelection.create(tr.doc, caret));
  ctx.view.dispatch(tr);
  return true;
}

/**
 * Resolve the inline range a Backspace/Delete keystroke would remove, then mark it
 * as proposed-deletion instead of deleting. At a block boundary (nothing inline to
 * remove in this direction) it returns false so the default join/merge runs.
 */
function handleSuggestingDelete(ctx: SuggestCtx, keyName: string): boolean {
  const { selection } = ctx.view.state;
  if (!selection.empty) {
    return markDeletion(ctx, selection.from, selection.to, keyName);
  }
  const $pos = ctx.view.state.doc.resolve(selection.from);
  if (keyName === "Backspace") {
    if ($pos.parentOffset === 0) return false; // block start → default join
    return markDeletion(ctx, selection.from - 1, selection.from, keyName);
  }
  if ($pos.parentOffset === $pos.parent.content.size) return false; // block end
  return markDeletion(ctx, selection.from, selection.from + 1, keyName);
}

/**
 * A typed range-replace under suggesting mode: strike the replaced inline range
 * (proposed-deletion, text kept) and insert the typed text after it as a pending
 * insertion, both tagged with one suggestion id. Returns true (handled).
 */
function replaceWithSuggestion(ctx: SuggestCtx, from: number, to: number, text: string): boolean {
  const at = new Date().toISOString();
  const suggestionId = createSuggestionId();
  const tr = ctx.view.state.tr;
  tr.addMark(from, to, ctx.deleteType.create({ suggestionId, by: ctx.by, at }));
  tr.insertText(text, to);
  tr.addMark(to, to + text.length, ctx.insertType.create({ suggestionId, by: ctx.by, at }));
  tr.setSelection(TextSelection.create(tr.doc, to + text.length));
  tr.setMeta(SUGGESTION_HANDLED, true);
  ctx.view.dispatch(tr);
  return true;
}

export const SuggestionMode = Extension.create<SuggestionModeOptions>({
  name: "atriumSuggestionMode",

  addOptions() {
    return { by: "human:unknown", defaultOn: false };
  },

  addCommands() {
    return {
      setSuggesting:
        (on: boolean) =>
        ({ state, dispatch }) => {
          if (dispatch) {
            dispatch(state.tr.setMeta(suggestionModePluginKey, { suggesting: on }));
          }
          return true;
        },
      toggleSuggesting:
        () =>
        ({ state, dispatch }) => {
          const cur = suggestionModePluginKey.getState(state)?.suggesting ?? false;
          if (dispatch) {
            dispatch(
              state.tr.setMeta(suggestionModePluginKey, { suggesting: !cur })
            );
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const by = this.options.by;
    const defaultOn = this.options.defaultOn;
    const insertType = this.editor.schema.marks[ATRIUM_SUGGESTION_INSERT_MARK];
    const deleteType = this.editor.schema.marks[ATRIUM_SUGGESTION_DELETE_MARK];
    if (!insertType || !deleteType) return [];

    return [
      new Plugin<SuggestionState>({
        key: suggestionModePluginKey,
        state: {
          init: () => ({ suggesting: defaultOn }),
          apply: (tr, value) => {
            const meta = tr.getMeta(suggestionModePluginKey) as
              | SuggestionState
              | undefined;
            return meta && typeof meta.suggesting === "boolean" ? meta : value;
          },
        },
        // Mark locally-inserted text as a pending insertion while suggesting is ON.
        appendTransaction(transactions, _oldState, newState) {
          const on = suggestionModePluginKey.getState(newState)?.suggesting ?? false;
          if (!on) return null;
          if (!transactions.some((t) => t.docChanged)) return null;

          const ranges: Array<[number, number]> = [];
          for (const tr of transactions) {
            // Skip remote (Yjs) edits — they carry their author's marks already —
            // and our own handler transactions, which stamp their inserts directly.
            if (isChangeOrigin(tr) || tr.getMeta(SUGGESTION_HANDLED)) continue;
            for (const map of tr.mapping.maps) {
              // eslint-disable-next-line unicorn/no-for-each -- StepMap API, not an array
              map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                if (newEnd > newStart) ranges.push([newStart, newEnd]);
              });
            }
          }
          if (ranges.length === 0) return null;

          const mark = insertType.create({
            suggestionId: createSuggestionId(),
            by,
            at: new Date().toISOString(),
          });
          const docSize = newState.doc.content.size;
          const tr = newState.tr;
          let modified = false;
          for (const [from, to] of ranges) {
            const f = Math.max(0, Math.min(from, docSize));
            const t = Math.max(0, Math.min(to, docSize));
            if (t > f) {
              tr.addMark(f, t, mark);
              modified = true;
            }
          }
          if (!modified) return null;
          tr.setMeta(SUGGESTION_HANDLED, true);
          return tr;
        },
        props: {
          handleKeyDown(view, event) {
            const on = suggestionModePluginKey.getState(view.state)?.suggesting ?? false;
            if (!on) return false;
            if (event.key !== "Backspace" && event.key !== "Delete") return false;
            return handleSuggestingDelete({ view, by, insertType, deleteType }, event.key);
          },
          handleTextInput(view, from, to, text) {
            const on = suggestionModePluginKey.getState(view.state)?.suggesting ?? false;
            if (!on) return false;
            // A plain insertion (no selection) is left to the default handler;
            // appendTransaction stamps it. Only a range-replace is intercepted here.
            if (from === to) return false;
            return replaceWithSuggestion({ view, by, insertType, deleteType }, from, to, text);
          },
        },
      }),
    ];
  },
});

/**
 * React hook: the live `{ suggesting, count }` for the toolbar. Subscribes to the
 * editor's transactions so the toggle state and the pending-suggestion count stay
 * in sync (count changes only on doc edits; the read is cheap).
 */
export function useSuggestionState(editor: Editor | null): {
  suggesting: boolean;
  count: number;
} {
  const [suggesting, setSuggesting] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      setSuggesting(
        suggestionModePluginKey.getState(editor.state)?.suggesting ?? false
      );
      setCount(countSuggestions(editor));
    };
    update();
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  return { suggesting, count };
}
