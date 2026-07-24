/**
 * Atrium media TipTap nodes — image / image-grid / video (Meridian slice F)
 *
 * Three NET-NEW block nodes for the "2b" rich document (README §"2b"): a single
 * image, an auto-laid-out image grid, and a dark HTML5 video player. All three join
 * the ONE shared collab schema (`getSchemaExtensions`) — like slice C's TableKit and
 * slice D's embed node — so the client editor, the server transformer
 * (markdown-bridge / agent bridge), and the collab-server bundle build the identical
 * ProseMirror schema (asserted by tests/smoke/atrium-collab-schema.smoke.ts).
 *
 * SCHEMA-ONLY BY DESIGN: no React import. The editor render is the static
 * `renderHTML` (a real `<img>` / `<video controls>` / grid `<div>`), styled by
 * `.atrium-image-grid` / `.atrium-video` in styles/atrium-content.css (imported by
 * the editor). No NodeView needed, so client/server schema parity holds.
 *
 * Markdown round-trip (shared format `lib/content/block-directives.ts`):
 *  - image      : standard `![alt](url)` — reader renders it via the existing
 *                 markdown pipeline (`.atrium-content img`), no reader change.
 *  - image grid : the CONTAINER directive `:::grid` … `:::` wrapping `![]()` images.
 *  - video      : the LEAF directive `::video{src="<http(s)-url>"}`.
 * The seeding path (`markdown-bridge.ts`) rewrites the grid/video directives to
 * their DOM before ProseMirror parses; the reader (`markdown-render.ts`) maps them
 * via `remarkAtriumDirectives`. Media URLs are pinned to http/https by
 * `isSafeMediaUrl` at BOTH the serialize boundary here and the reader sanitizer.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  IMAGE_NODE_NAME,
  IMAGE_GRID_NODE_NAME,
  VIDEO_NODE_NAME,
  IMAGE_GRID_CLASS,
  VIDEO_CLASS,
  isSafeMediaUrl,
  serializeVideoDirective,
} from "../block-directives";
import {
  CONTENT_ASSET_DATA_ATTR,
  assetIdFromBytesPath,
  serializeContentAssetDirective,
} from "../asset-directive";

/** The subset of tiptap-markdown's serializer state these nodes' serializers use. */
interface MarkdownSerializeState {
  write(content: string): void;
  renderContent(node: ProseMirrorNode): void;
  ensureNewLine(): void;
  closeBlock(node: ProseMirrorNode): void;
}

interface SerializeStorage {
  markdown: {
    serialize: (state: MarkdownSerializeState, node: ProseMirrorNode) => void;
    parse: Record<string, never>;
  };
}

/** Strip characters that would break `![alt](url)` markdown syntax from alt text. */
function cleanAlt(alt: unknown): string {
  return typeof alt === "string" ? alt.replace(/[\][\r\n]/g, " ").trim() : "";
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    atriumMedia: {
      /** Insert a single image block. */
      setAtriumImage: (attrs: { src: string; alt?: string }) => ReturnType;
      /** Insert an image grid seeded with the given image sources. */
      setAtriumImageGrid: (
        images: Array<{ src: string; alt?: string }>
      ) => ReturnType;
      /** Insert a video block for an http/https source. */
      setAtriumVideo: (attrs: { src: string; title?: string }) => ReturnType;
    };
  }
}

/** Single image — block atom, serialized as standard `![alt](url)`. */
export const AtriumImage = Node.create<Record<string, never>, SerializeStorage>({
  name: IMAGE_NODE_NAME,
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => el.getAttribute("src"),
        renderHTML: (attrs) => (attrs.src ? { src: attrs.src } : {}),
      },
      alt: {
        default: "",
        parseHTML: (el) => el.getAttribute("alt") ?? "",
        renderHTML: (attrs) => (attrs.alt ? { alt: attrs.alt } : {}),
      },
      assetId: {
        default: null,
        parseHTML: (el) =>
          el.getAttribute(CONTENT_ASSET_DATA_ATTR) ??
          assetIdFromBytesPath(el.getAttribute("src") ?? ""),
        renderHTML: (attrs) =>
          attrs.assetId
            ? { [CONTENT_ASSET_DATA_ATTR]: attrs.assetId }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },

  addCommands() {
    return {
      setAtriumImage:
        (attrs) =>
        ({ commands }) => {
          if (!isSafeMediaUrl(attrs.src)) return false;
          return commands.insertContent({
            type: IMAGE_NODE_NAME,
            attrs: { src: attrs.src, alt: cleanAlt(attrs.alt) },
          });
        },
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
          const assetId =
            typeof node.attrs.assetId === "string"
              ? node.attrs.assetId
              : assetIdFromBytesPath(src);
          if (assetId) {
            const directive = serializeContentAssetDirective(
              assetId,
              cleanAlt(node.attrs.alt)
            );
            if (directive) state.write(directive);
            state.closeBlock(node);
            return;
          }
          if (!isSafeMediaUrl(src)) return;
          state.write(`![${cleanAlt(node.attrs.alt)}](${src})`);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

/** Image grid — a container of image nodes, serialized as `:::grid` … `:::`. */
export const AtriumImageGrid = Node.create<Record<string, never>, SerializeStorage>({
  name: IMAGE_GRID_NODE_NAME,
  group: "block",
  // Holds one-or-more image nodes; the CSS lays them out (one tall + stacked).
  content: `${IMAGE_NODE_NAME}+`,
  defining: true,

  parseHTML() {
    return [{ tag: `div.${IMAGE_GRID_CLASS}` }];
  },

  renderHTML({ HTMLAttributes, node }) {
    // The editor caps the visible cells to 3 and shows a "+N" overflow pill on the
    // third (README §"2b" grid). `data-extra` is the count beyond 3; the CSS
    // (.atrium-image-grid[data-extra]) hides the rest and renders the pill via
    // `content: "+" attr(data-extra)`. ProseMirror re-runs this toDOM when the
    // child set changes, so the count stays live as images are added/removed. The
    // reader render (remark) carries no `data-extra`, so a published grid shows all
    // its images uncapped.
    const extra = node.childCount - 3;
    const attrs =
      extra > 0
        ? { class: IMAGE_GRID_CLASS, "data-extra": String(extra) }
        : { class: IMAGE_GRID_CLASS };
    return ["div", mergeAttributes(HTMLAttributes, attrs), 0];
  },

  addCommands() {
    return {
      setAtriumImageGrid:
        (images) =>
        ({ commands }) => {
          const safe = images.filter((i) => isSafeMediaUrl(i.src));
          if (safe.length === 0) return false;
          return commands.insertContent({
            type: IMAGE_GRID_NODE_NAME,
            content: safe.map((i) => ({
              type: IMAGE_NODE_NAME,
              attrs: { src: i.src, alt: cleanAlt(i.alt) },
            })),
          });
        },
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(":::grid\n");
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

/** Video — block atom, serialized as the leaf directive `::video{src="…"}`. */
export const AtriumVideo = Node.create<Record<string, never>, SerializeStorage>({
  name: VIDEO_NODE_NAME,
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => el.getAttribute("src"),
        renderHTML: (attrs) => (attrs.src ? { src: attrs.src } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "video[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    // A real player (native controls = play button + progress + timestamp). The
    // dark 12px-radius framing is CSS (`.atrium-video`). No autoplay.
    return [
      "video",
      mergeAttributes(HTMLAttributes, {
        class: VIDEO_CLASS,
        controls: "controls",
        preload: "metadata",
        playsinline: "true",
      }),
    ];
  },

  addCommands() {
    return {
      setAtriumVideo:
        (attrs) =>
        ({ commands }) => {
          if (!isSafeMediaUrl(attrs.src)) return false;
          return commands.insertContent({
            type: VIDEO_NODE_NAME,
            attrs: { src: attrs.src },
          });
        },
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
          const directive = serializeVideoDirective(src);
          if (!directive) return;
          state.write(directive);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});
