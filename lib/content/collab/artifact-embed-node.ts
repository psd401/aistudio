/**
 * Atrium embedded-artifact TipTap node (Epic #1059 Meridian redesign, slice D)
 *
 * A block-level ATOM node that references another content object (an artifact) by
 * id, rendered live in both the editor and the readers as a Meridian bordered
 * block. It is a NET-NEW addition to the ONE shared collab schema
 * (`getSchemaExtensions`), exactly like slice C's TableKit: because the client
 * editor, the server transformer (markdown-bridge / agent bridge), and the
 * Hocuspocus-equivalent collab-server bundle all build their ProseMirror schema
 * from this single node, the Yjs document maps this node identically everywhere
 * (asserted by tests/smoke/atrium-collab-schema.smoke.ts).
 *
 * SCHEMA-ONLY BY DESIGN: this module imports NO React and NO sandbox component, so
 * adding it to the shared schema does not drag client-only code into the
 * server/collab bundle (mirroring the note in editor-extensions.ts about keeping
 * TableKit's browser-only plugins out of `getSchema()`). The live preview is a
 * React NodeView (`ArtifactEmbedNodeView`) that the CLIENT editor attaches via
 * `.extend({ addNodeView })` in DocumentEditor — the NodeView never touches the
 * schema, so client/server parity holds.
 *
 * Markdown round-trip (`lib/content/embed-directive.ts` is the shared format):
 *  - editor → markdown : `addStorage().markdown.serialize` emits the leaf
 *    directive `::atrium-artifact{id="<uuid>"}` (tiptap-markdown reads per-node
 *    serializers from `extension.storage.markdown` — verified in 0.9.0).
 *  - markdown → editor : the seeding/agent path rewrites that directive to this
 *    node's DOM (`div[data-atrium-artifact-embed]`) before ProseMirror parses it
 *    (see `markdownToProseMirrorJSON` in markdown-bridge.ts).
 *  - markdown → reader : `renderDocumentToParts` splits on the directive line.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  ARTIFACT_EMBED_DATA_ATTR,
  serializeArtifactEmbedDirective,
} from "../embed-directive";

/** The ProseMirror node name (shared by client + server schema). */
export const ARTIFACT_EMBED_NODE_NAME = "atriumArtifactEmbed";

/**
 * The subset of tiptap-markdown's `MarkdownSerializerState` this node's serializer
 * touches. Typed locally (rather than importing tiptap-markdown here) so the
 * shared schema module stays free of the client-only markdown package — the
 * `serialize` function below is only ever CALLED on the client (`getMarkdown`).
 */
interface MarkdownSerializeState {
  write(content: string): void;
  closeBlock(node: ProseMirrorNode): void;
}

/** This node's `addStorage().markdown` shape (per-node tiptap-markdown spec). */
interface ArtifactEmbedStorage {
  markdown: {
    serialize: (state: MarkdownSerializeState, node: ProseMirrorNode) => void;
    parse: Record<string, never>;
  };
}

export const AtriumArtifactEmbed = Node.create<
  Record<string, never>,
  ArtifactEmbedStorage
>({
  name: ARTIFACT_EMBED_NODE_NAME,
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      /** The embedded artifact's content-object id (a UUID). */
      artifactId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-artifact-id"),
        renderHTML: (attrs) =>
          attrs.artifactId ? { "data-artifact-id": attrs.artifactId } : {},
      },
      /**
       * A cached display title. Convenience only — the authoritative title is
       * re-resolved from the DB at render time (editor NodeView + reader), so it
       * is intentionally NOT persisted to markdown (the directive carries only the
       * id). Held in the Y.Doc so the editor can label the block before its fetch.
       */
      title: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-title"),
        renderHTML: (attrs) => (attrs.title ? { "data-title": attrs.title } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${ARTIFACT_EMBED_DATA_ATTR}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    // Static DOM fallback (server transformer + any non-NodeView mount). The
    // client editor replaces this with the live React NodeView.
    return ["div", mergeAttributes(HTMLAttributes, { [ARTIFACT_EMBED_DATA_ATTR]: "" })];
  },

  addStorage() {
    return {
      markdown: {
        // editor → markdown: emit the canonical leaf directive. A node with an
        // invalid/missing id serializes to nothing (defensive — the insert path
        // always sets a valid UUID) rather than a malformed directive.
        serialize(state, node) {
          const id =
            typeof node.attrs.artifactId === "string" ? node.attrs.artifactId : "";
          const directive = serializeArtifactEmbedDirective(id);
          if (directive) {
            state.write(directive);
            state.closeBlock(node);
          }
        },
        // markdown → editor is NOT driven by tiptap-markdown here: the collab doc's
        // content comes from Yjs (Collaboration), and the seeding path parses the
        // directive server-side in markdown-bridge.ts. No markdown-it parse rule.
        parse: {},
      },
    };
  },
});

export default AtriumArtifactEmbed;
