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

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Editor } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEditorState } from "@tiptap/react";
import { ARTIFACT_EMBED_NODE_NAME } from "@/lib/content/collab/artifact-embed-node";
import { isSafeMediaUrl } from "@/lib/content/block-directives";
import { listContentAction } from "@/actions/db/atrium/list-content";
import { createLogger } from "@/lib/client-logger";

const bubbleLog = createLogger({ component: "EditorBubbleMenu" });

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

/** The "📣" callout popover: insert a note or warning callout. */
function CalloutPopover({
  editor,
  onPick,
}: {
  editor: Editor;
  onPick: () => void;
}): React.JSX.Element {
  return (
    <div className="mer-bubble-pop" role="menu">
      <button
        type="button"
        role="menuitem"
        className="mer-bubble-pop-item"
        data-testid="editor-callout-note"
        onClick={() => {
          editor.chain().focus().setCallout("note").run();
          onPick();
        }}
      >
        📣 Callout
      </button>
      <button
        type="button"
        role="menuitem"
        className="mer-bubble-pop-item"
        data-testid="editor-callout-warn"
        onClick={() => {
          editor.chain().focus().setCallout("warn").run();
          onPick();
        }}
      >
        ⚠️ Warning
      </button>
    </div>
  );
}

/**
 * The "🖼" media picker: insert an image, an image grid, or a video by URL. Media
 * is referenced by a durable http/https URL — the reader (including the anonymous
 * public reader) renders it directly, so no expiring presigned URL ever lands in
 * the persisted document body. (Direct file-upload-to-S3 is deferred: this codebase
 * has no durable public asset origin — see the slice-F report — so a presigned URL
 * baked into a snapshot would break the published page when it expires.)
 */
function MediaPicker({
  editor,
  onPick,
}: {
  editor: Editor;
  onPick: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<"image" | "grid" | "video">("image");
  const [url, setUrl] = useState("");
  const [gridUrls, setGridUrls] = useState("");
  const [error, setError] = useState<string | null>(null);

  const insert = (): void => {
    setError(null);
    if (mode === "grid") {
      const urls = gridUrls
        .split(/[\n,]/)
        .map((u) => u.trim())
        .filter((u) => u.length > 0);
      const valid = urls.filter((u) => isSafeMediaUrl(u));
      if (valid.length === 0) {
        setError("Enter one or more image URLs (http/https).");
        return;
      }
      editor
        .chain()
        .focus()
        .setAtriumImageGrid(valid.map((src) => ({ src })))
        .run();
      onPick();
      return;
    }
    const trimmed = url.trim();
    if (!isSafeMediaUrl(trimmed)) {
      setError("Enter a valid http/https URL.");
      return;
    }
    if (mode === "image") {
      editor.chain().focus().setAtriumImage({ src: trimmed }).run();
    } else {
      editor.chain().focus().setAtriumVideo({ src: trimmed }).run();
    }
    onPick();
  };

  return (
    <div className="mer-bubble-pop mer-bubble-media-pop" role="menu" data-testid="editor-media-pop">
      <div className="mer-bubble-media-tabs" role="tablist">
        {(["image", "grid", "video"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className="mer-bubble-media-tab"
            data-active={mode === m ? "true" : "false"}
            data-testid={`editor-media-tab-${m}`}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
          >
            {m === "image" ? "Image" : m === "grid" ? "Grid" : "Video"}
          </button>
        ))}
      </div>
      {mode === "grid" ? (
        <textarea
          className="mer-bubble-media-input"
          rows={3}
          value={gridUrls}
          placeholder="Image URLs, one per line"
          aria-label="Image grid URLs"
          data-testid="editor-media-grid-input"
          onChange={(e) => setGridUrls(e.target.value)}
        />
      ) : (
        <input
          type="url"
          className="mer-bubble-media-input"
          value={url}
          placeholder={mode === "image" ? "Image URL" : "Video URL (mp4/webm)"}
          aria-label={mode === "image" ? "Image URL" : "Video URL"}
          data-testid="editor-media-url-input"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              insert();
            }
          }}
        />
      )}
      {error && <span className="mer-bubble-media-error">{error}</span>}
      <button
        type="button"
        className="mer-bubble-media-insert"
        data-testid="editor-media-insert"
        onClick={insert}
      >
        Insert {mode === "grid" ? "grid" : mode}
      </button>
    </div>
  );
}

/** One artifact option in the embed picker. */
interface EmbedOption {
  id: string;
  title: string;
}

/**
 * The "✦ Embed" popover: lists the artifacts the viewer can see (visibility-gated
 * by `listContentAction`) and inserts the selected one as an `atriumArtifactEmbed`
 * block AFTER the current selection (never replacing the selected text). The reader
 * re-gates each embed per viewer, so listing here is a convenience, not the
 * authorization boundary.
 */
function ArtifactEmbedPicker({
  editor,
  onPick,
}: {
  editor: Editor;
  onPick: () => void;
}): React.JSX.Element {
  const [items, setItems] = useState<EmbedOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await listContentAction({ kind: "artifact", limit: 50 });
        if (cancelled) return;
        if (res.isSuccess) {
          setItems(res.data.map((o) => ({ id: o.id, title: o.title })));
        } else {
          bubbleLog.warn("listContentAction failed", { message: res.message });
        }
      } catch (e) {
        if (cancelled) return;
        bubbleLog.error("listContentAction threw", {
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const insert = (opt: EmbedOption): void => {
    // Insert the block at the END of the selection so the selected text is kept
    // (a plain insertContent would replace it).
    const at = editor.state.selection.to;
    editor
      .chain()
      .focus()
      .insertContentAt(at, {
        type: ARTIFACT_EMBED_NODE_NAME,
        // Only the id is stored in the shared Y.Doc. NEVER stamp the title here:
        // the doc syncs to every canView(document) peer, but the artifact is gated
        // on canView(artifact), so a title in the CRDT would leak it. The title is
        // re-resolved per viewer through the visibility gate (see artifact-embed-node.ts).
        attrs: { artifactId: opt.id },
      })
      .run();
    onPick();
  };

  return (
    <div className="mer-bubble-pop mer-bubble-embed-pop" role="menu">
      {loading ? (
        <span className="mer-bubble-pop-empty">Loading artifacts…</span>
      ) : items.length === 0 ? (
        <span className="mer-bubble-pop-empty">No artifacts to embed yet</span>
      ) : (
        items.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="menuitem"
            className="mer-bubble-pop-item"
            title={opt.title}
            onClick={() => insert(opt)}
          >
            <span className="mer-agent-mark" aria-hidden="true">
              ✦
            </span>{" "}
            {opt.title}
          </button>
        ))
      )}
    </div>
  );
}

/** Which floating popover (if any) is open above the bubble toolbar. */
type BubblePop = "none" | "text" | "color" | "embed" | "callout" | "media";

/**
 * The rich-block insert buttons (callout + media) and their popovers (slice F),
 * extracted from the toolbar so `EditorBubbleMenu`'s render stays within the
 * max-lines budget. Behaviour is identical to inlining these two buttons.
 */
function RichInsertButtons({
  editor,
  pop,
  setPop,
  closePops,
}: {
  editor: Editor;
  pop: BubblePop;
  setPop: (next: BubblePop) => void;
  closePops: () => void;
}): React.JSX.Element {
  return (
    <>
      <span className="mer-bubble-sep" aria-hidden="true" />
      <button
        type="button"
        className="mer-bubble-btn"
        aria-label="Insert callout"
        title="Insert a callout"
        aria-haspopup="menu"
        aria-expanded={pop === "callout"}
        data-testid="editor-callout"
        onClick={() => setPop(pop === "callout" ? "none" : "callout")}
      >
        📣
      </button>
      {pop === "callout" && <CalloutPopover editor={editor} onPick={closePops} />}

      <button
        type="button"
        className="mer-bubble-btn"
        aria-label="Insert image or video"
        title="Insert image, image grid, or video"
        aria-haspopup="menu"
        aria-expanded={pop === "media"}
        data-testid="editor-media"
        onClick={() => setPop(pop === "media" ? "none" : "media")}
      >
        🖼
      </button>
      {pop === "media" && <MediaPicker editor={editor} onPick={closePops} />}
    </>
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
  const [pop, setPop] = useState<BubblePop>("none");

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
      <div
        className="mer-bubble"
        role="toolbar"
        aria-label="Text formatting"
        data-testid="editor-bubble-menu"
        // Keep the editor's text selection alive when a formatting control is
        // clicked: a native button would otherwise steal focus on mousedown and
        // collapse the selection BEFORE the click runs, so `toggleBold()` would
        // apply to an empty cursor (stored mark) instead of the selected span.
        // preventDefault on mousedown blocks the focus/selection change while the
        // click (onClick) still fires. The buttons inside are individually
        // keyboard-focusable, so the toolbar role carries the interaction.
        onMouseDown={(e) => e.preventDefault()}
      >
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
        <RichInsertButtons
          editor={editor}
          pop={pop}
          setPop={setPop}
          closePops={closePops}
        />

        <button
          type="button"
          className="mer-bubble-btn"
          aria-label="Embed artifact"
          title="Embed an artifact"
          aria-haspopup="menu"
          aria-expanded={pop === "embed"}
          data-testid="editor-embed-artifact"
          onClick={() => setPop(pop === "embed" ? "none" : "embed")}
        >
          ✦▦
        </button>
        {pop === "embed" && <ArtifactEmbedPicker editor={editor} onPick={closePops} />}

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
