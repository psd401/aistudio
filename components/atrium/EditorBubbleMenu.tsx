"use client";

/**
 * Atrium floating formatting toolbar (Epic #1059 Meridian redesign, slice C)
 *
 * The dark floating selection toolbar (README §"Editor"): it is the ENTIRE
 * formatting UI — there is no persistent toolbar. It appears over a non-empty text
 * selection (TipTap `BubbleMenu`) and offers block style (Text ▾), the inline
 * marks B / I / U / S, a text color chip, a table insert, a bullet list toggle,
 * and a violet "✦ Ask agent" segment that opens the doc beside the Nexus chat
 * (the existing selection-adjacent re-prompt path).
 *
 * All formatting acts on the SHARED collab schema (StarterKit marks + the slice-C
 * TableKit / TextStyle+Color additions in editor-extensions.ts), so every change
 * flows through Yjs to peers and the agent bridge identically. Read-only viewers
 * never see the toolbar (`shouldShow` gates on `editor.isEditable`).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Editor } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEditorState } from "@tiptap/react";

/** Text colors offered by the color chip. Violet = agent, so it is intentionally
 *  NOT offered here as a manual text color (violet stays reserved for agent
 *  presence, not author-chosen emphasis). */
const TEXT_COLORS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Ink", value: "#191d1c" },
  { label: "Teal", value: "#10322e" },
  { label: "Green", value: "#2c7a6b" },
  { label: "Blue", value: "#4a7ce8" },
  { label: "Terracotta", value: "#b4552d" },
  { label: "Amber", value: "#c07a1e" },
  { label: "Muted", value: "#8b948f" },
];

const BLOCK_STYLES: ReadonlyArray<{
  label: string;
  isActive: (e: Editor) => boolean;
  apply: (e: Editor) => void;
}> = [
  {
    label: "Paragraph",
    isActive: (e) => e.isActive("paragraph"),
    apply: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    label: "Heading 1",
    isActive: (e) => e.isActive("heading", { level: 1 }),
    apply: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    label: "Heading 2",
    isActive: (e) => e.isActive("heading", { level: 2 }),
    apply: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: "Heading 3",
    isActive: (e) => e.isActive("heading", { level: 3 }),
    apply: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
];

/** The "Text ▾" block-style dropdown (Paragraph / Heading 1–3). */
function BlockStylePopover({
  editor,
  onPick,
}: {
  editor: Editor;
  onPick: () => void;
}): React.JSX.Element {
  return (
    <div className="mer-bubble-pop" role="menu">
      {BLOCK_STYLES.map((b) => (
        <button
          key={b.label}
          type="button"
          role="menuitem"
          className="mer-bubble-pop-item"
          data-active={b.isActive(editor) ? "true" : "false"}
          onClick={() => {
            b.apply(editor);
            onPick();
          }}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

/** The text color palette (violet is intentionally omitted — it is agent-only). */
function ColorPopover({
  editor,
  onPick,
}: {
  editor: Editor;
  onPick: () => void;
}): React.JSX.Element {
  return (
    <div className="mer-bubble-colors" role="menu">
      {TEXT_COLORS.map((c) => (
        <button
          key={c.value}
          type="button"
          role="menuitem"
          className="mer-color-dot"
          style={{ background: c.value }}
          aria-label={`Color ${c.label}`}
          title={c.label}
          onClick={() => {
            editor.chain().focus().setColor(c.value).run();
            onPick();
          }}
        />
      ))}
      <button
        type="button"
        role="menuitem"
        className="mer-color-dot"
        data-clear="true"
        aria-label="Clear color"
        title="Clear color"
        onClick={() => {
          editor.chain().focus().unsetColor().run();
          onPick();
        }}
      >
        ⊘
      </button>
    </div>
  );
}

export interface EditorBubbleMenuProps {
  editor: Editor;
  /** Where "✦ Ask agent" navigates — the doc opened beside the Nexus chat. */
  askAgentHref: string;
}

export function EditorBubbleMenu({
  editor,
  askAgentHref,
}: EditorBubbleMenuProps): React.JSX.Element {
  const router = useRouter();
  const [pop, setPop] = useState<"none" | "text" | "color">("none");

  // Re-render the toolbar when the active-mark state changes so B/I/U/S and the
  // Text ▾ label reflect the current selection.
  const marks = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      bulletList: e.isActive("bulletList"),
      blockLabel:
        BLOCK_STYLES.find((b) => b.isActive(e))?.label ?? "Text",
    }),
  });

  const closePops = () => setPop("none");

  return (
    <BubbleMenu
      editor={editor}
      // Only over a real, non-empty text selection, and only for editors (a
      // read-only viewer never gets the formatting UI).
      shouldShow={({ editor: e, from, to }) => e.isEditable && to > from}
      options={{ placement: "top", offset: 8 }}
    >
      <div className="mer-bubble" data-testid="editor-bubble-menu">
        <button
          type="button"
          className="mer-bubble-btn mer-bubble-text"
          onClick={() => setPop(pop === "text" ? "none" : "text")}
          aria-haspopup="menu"
          aria-expanded={pop === "text"}
        >
          {marks.blockLabel} ▾
        </button>
        {pop === "text" && <BlockStylePopover editor={editor} onPick={closePops} />}

        <span className="mer-bubble-sep" aria-hidden="true" />
        <button
          type="button"
          className="mer-bubble-btn mer-bubble-btn-b"
          data-active={marks.bold ? "true" : "false"}
          aria-label="Bold"
          aria-pressed={marks.bold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          B
        </button>
        <button
          type="button"
          className="mer-bubble-btn mer-bubble-btn-i"
          data-active={marks.italic ? "true" : "false"}
          aria-label="Italic"
          aria-pressed={marks.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          I
        </button>
        <button
          type="button"
          className="mer-bubble-btn mer-bubble-btn-u"
          data-active={marks.underline ? "true" : "false"}
          aria-label="Underline"
          aria-pressed={marks.underline}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          U
        </button>
        <button
          type="button"
          className="mer-bubble-btn mer-bubble-btn-s"
          data-active={marks.strike ? "true" : "false"}
          aria-label="Strikethrough"
          aria-pressed={marks.strike}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          S
        </button>

        <span className="mer-bubble-sep" aria-hidden="true" />
        <button
          type="button"
          className="mer-bubble-btn"
          aria-label="Text color"
          aria-haspopup="menu"
          aria-expanded={pop === "color"}
          onClick={() => setPop(pop === "color" ? "none" : "color")}
        >
          <span className="mer-bubble-swatch" aria-hidden="true" />
        </button>
        {pop === "color" && <ColorPopover editor={editor} onPick={closePops} />}

        <button
          type="button"
          className="mer-bubble-btn"
          aria-label="Insert table"
          title="Insert table"
          onClick={() =>
            editor
              .chain()
              .focus()
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run()
          }
        >
          ▦
        </button>
        <button
          type="button"
          className="mer-bubble-btn"
          data-active={marks.bulletList ? "true" : "false"}
          aria-label="Bulleted list"
          aria-pressed={marks.bulletList}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          ☰
        </button>

        <button
          type="button"
          className="mer-bubble-btn mer-bubble-ask"
          onClick={() => router.push(askAgentHref)}
        >
          ✦ Ask agent
        </button>
      </div>
    </BubbleMenu>
  );
}

export default EditorBubbleMenu;
