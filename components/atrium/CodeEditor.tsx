"use client";

/**
 * Atrium artifact code editor (#1052, Epic #1059, Phase 2, spec §19.1)
 *
 * A minimal CodeMirror 6 editor for the artifact `Code` tab. The author edits the
 * raw artifact source (HTML or JS) and saves; a save creates a NEW human-authored
 * version (`createVersion`), so the provenance rail records the human edit (green)
 * distinct from agent-authored versions (purple).
 *
 * CodeMirror 6 is the lowest-level (`@codemirror/view` + `@codemirror/state`)
 * editor, with the HTML / JavaScript language packages for syntax highlighting.
 * We intentionally do NOT execute the code here — this is a text editor only.
 * Rendering of the (untrusted) code happens exclusively in the cross-origin
 * `<ArtifactSandbox>` (§28.1).
 *
 * State model: the editor is uncontrolled internally (CodeMirror owns its
 * document) but is seeded from `value` and reseeded when the incoming `value`
 * changes (e.g. switching versions). We track the last externally-applied value
 * so a parent re-render that passes the SAME value does not clobber in-progress
 * edits, while a genuine value change (new version selected) does replace the
 * document.
 */

import { useEffect, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import type { BodyFormat } from "@/lib/content";

export interface CodeEditorProps {
  /** The artifact source to seed the editor with. */
  value: string;
  /** Body format — selects the syntax-highlighting language. */
  bodyFormat: BodyFormat;
  /** Whether the editor is editable (false = read-only viewer). */
  editable?: boolean;
  /**
   * Called when the author saves. Receives the current editor contents. The
   * parent persists it as a new human-authored version. Returns a promise so the
   * editor can show a pending state.
   */
  onSave?: (next: string) => Promise<void> | void;
}

/** Pick the CodeMirror language extension for the artifact's body format. */
function languageExtension(bodyFormat: BodyFormat): Extension {
  switch (bodyFormat) {
    case "html":
      return html();
    case "jsx":
      // JSX rendering is deferred (spec §33 #6), but the editor can still
      // highlight JSX-flavored source if a version carries it.
      return javascript({ jsx: true });
    default:
      // Artifacts are html/jsx; markdown never reaches this editor. Default to JS
      // highlighting for any non-html artifact source.
      return javascript();
  }
}

export function CodeEditor({
  value,
  bodyFormat,
  editable = true,
  onSave,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The last value we pushed INTO the editor from props, so we only reseed the
  // document on a genuine external change (not on every parent re-render).
  const appliedValueRef = useRef<string>(value);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Create the editor once (on mount). Language + editability changes are applied
  // via reconfiguration effects below rather than recreating the view (which
  // would lose cursor/scroll state).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        languageExtension(bodyFormat),
        EditorView.editable.of(editable),
        EditorState.readOnly.of(!editable),
        EditorView.theme({
          "&": { fontSize: "13px", maxHeight: "480px" },
          ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)" },
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    appliedValueRef.current = value;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount-only: subsequent prop changes are handled by the effects below so the
    // editor is not torn down (which would drop undo history / cursor).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reseed the document when the incoming `value` genuinely changes (e.g. a new
  // version is selected). Guard against re-applying the value we already pushed,
  // which would clobber the author's in-progress edits on an unrelated re-render.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value === appliedValueRef.current) return;
    appliedValueRef.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  const handleSave = async () => {
    const view = viewRef.current;
    if (!view || !onSave) return;
    const next = view.state.doc.toString();
    setSaving(true);
    setMessage(null);
    try {
      await onSave(next);
      // Treat the saved content as the new external baseline so the reseed effect
      // does not fire when the parent re-renders with the refreshed version.
      appliedValueRef.current = next;
      setMessage("Saved as new version");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={hostRef}
        className="atrium-code-editor rounded border"
        data-testid="artifact-code-editor"
      />
      {editable && onSave && (
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded border px-2 py-1 hover:bg-gray-50 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save version"}
          </button>
          {message && <span aria-live="polite">{message}</span>}
        </div>
      )}
    </div>
  );
}

export default CodeEditor;
