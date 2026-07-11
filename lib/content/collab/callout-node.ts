/**
 * Atrium callout TipTap node (Epic #1059 Meridian redesign, slice F)
 *
 * A block CONTAINER node holding block content (paragraphs, lists), rendered as the
 * Meridian gradient-tint callout (README §"2b" callout block). Two variants: `note`
 * (teal→violet wash) and `warn` (amber). It is a NET-NEW addition to the ONE shared
 * collab schema (`getSchemaExtensions`) — like slice D's embed node — so the client
 * editor, the server transformer (markdown-bridge / agent bridge), and the
 * collab-server bundle build the identical ProseMirror schema (asserted by
 * tests/smoke/atrium-collab-schema.smoke.ts).
 *
 * SCHEMA-ONLY BY DESIGN: no React import — the in-editor styling is pure CSS
 * (`.atrium-callout` in styles/atrium-content.css, already imported by the editor),
 * so no NodeView is needed. The static `renderHTML` div is what the editor shows AND
 * what `parseHTML` reads back on seeding.
 *
 * Markdown round-trip (the shared format is `lib/content/block-directives.ts`):
 *  - editor → markdown : serializes to the remark CONTAINER directive
 *    `:::callout` … `:::` (or `:::warn`), children rendered as their own markdown.
 *  - markdown → editor : the seeding/agent path (`markdown-bridge.ts`) rewrites the
 *    `:::callout`/`:::warn` container to `div.atrium-callout` before ProseMirror
 *    parses it (`generateJSON` → this node via `parseHTML`).
 *  - markdown → reader : `renderMarkdownToHtml`'s `remarkAtriumDirectives` already
 *    maps `:::callout`/`:::warn` to `<div class="atrium-callout…">` (slice E). The
 *    reader render is unchanged by this node — the node only adds the EDITOR side.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  CALLOUT_NODE_NAME,
  CALLOUT_CLASS,
  CALLOUT_WARN_CLASS,
  type CalloutVariant,
} from "../block-directives";

/**
 * The subset of tiptap-markdown's `MarkdownSerializerState` this node's serializer
 * touches. Typed locally (rather than importing tiptap-markdown here) so the shared
 * schema module stays free of the client-only markdown package — the `serialize`
 * function is only ever CALLED on the client (`getMarkdown`).
 */
interface MarkdownSerializeState {
  write(content: string): void;
  /** Render this node's block children as their own markdown. */
  renderContent(node: ProseMirrorNode): void;
  ensureNewLine(): void;
  closeBlock(node: ProseMirrorNode): void;
}

interface CalloutStorage {
  markdown: {
    serialize: (state: MarkdownSerializeState, node: ProseMirrorNode) => void;
    parse: Record<string, never>;
  };
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    atriumCallout: {
      /** Insert an empty callout of the given variant and place the cursor in it. */
      setCallout: (variant?: CalloutVariant) => ReturnType;
    };
  }
}

export const AtriumCallout = Node.create<Record<string, never>, CalloutStorage>({
  name: CALLOUT_NODE_NAME,
  group: "block",
  // Block content (paragraphs / lists) — the callout wraps rich text, not a leaf.
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: "note" as CalloutVariant,
        // The variant rides in the DOM class (never a separate attribute), so it
        // survives the marked → generateJSON seeding round-trip.
        parseHTML: (el): CalloutVariant =>
          el.classList.contains(CALLOUT_WARN_CLASS) ? "warn" : "note",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div.${CALLOUT_CLASS}` }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const warn = node.attrs.variant === "warn";
    const className = warn
      ? `${CALLOUT_CLASS} ${CALLOUT_WARN_CLASS}`
      : CALLOUT_CLASS;
    // `0` is the content hole — the block children render inside the div.
    return ["div", mergeAttributes(HTMLAttributes, { class: className }), 0];
  },

  addCommands() {
    return {
      setCallout:
        (variant: CalloutVariant = "note") =>
        ({ commands }) =>
          commands.insertContent({
            type: CALLOUT_NODE_NAME,
            attrs: { variant },
            content: [{ type: "paragraph" }],
          }),
    };
  },

  addStorage() {
    return {
      markdown: {
        // editor → markdown: the remark CONTAINER directive. Children render as
        // their own markdown between the fences.
        serialize(state, node) {
          const fence = node.attrs.variant === "warn" ? ":::warn" : ":::callout";
          state.write(`${fence}\n`);
          state.renderContent(node);
          state.ensureNewLine();
          state.write(":::");
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

export default AtriumCallout;
