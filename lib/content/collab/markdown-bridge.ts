/**
 * Atrium markdown <-> Yjs document bridge
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). Atrium's canonical storage is
 * markdown (Phase 0), but the live editor works in TipTap's native ProseMirror/
 * Yjs model. This module bridges the two at the seeding + agent-write boundaries,
 * stamping authorship as it goes.
 *
 * Seeding (markdown -> Y.Doc): an agent-drafted (or human-drafted) document's
 * markdown is parsed to editable HTML (via a `marked` instance that DROPS raw
 * HTML — see `editorMarked` below — NOT the rich reader pipeline, which adds
 * KaTeX/sanitize artifacts unsuitable for editing), turned into ProseMirror JSON
 * against the shared schema, stamped with the creator's author tag on every text
 * node, then converted to a Y.Doc by y-prosemirror's `prosemirrorJSONToYDoc`. The
 * whole initial draft therefore reads as its creator on the rail (purple for an
 * agent draft, green for a human draft).
 *
 * This module imports the pure-ESM TipTap/Yjs stack and is therefore NOT
 * jest-loadable (next/jest cannot transform it); it is covered by the Bun smoke
 * test tests/smoke/atrium-collab-bridge.smoke.ts.
 */

import { Marked } from "marked";
import type { TokenizerAndRendererExtension, Tokens } from "marked";
import { generateJSON } from "@tiptap/html";
import type { JSONContent } from "@tiptap/core";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import type { Doc as YDoc } from "yjs";
import { getSchemaExtensions, getCollabSchema } from "./editor-extensions";
import { AUTHORED_MARK, COLLAB_FIELD } from "./provenance";
import {
  ARTIFACT_EMBED_DATA_ATTR,
  ARTIFACT_EMBED_ID_ATTR,
  parseArtifactEmbedAttrs,
} from "../embed-directive";
import {
  CALLOUT_CLASS,
  CALLOUT_WARN_CLASS,
  IMAGE_GRID_CLASS,
  VIDEO_CLASS,
  isSafeMediaUrl,
  parseVideoDirectiveAttrs,
} from "../block-directives";

/**
 * A `marked` instance whose renderer DROPS raw HTML tokens (both block and inline)
 * instead of emitting them. This is the security boundary for the editor-seeding
 * path: ProseMirror's schema parser (`generateJSON`) is NOT a sanitizer — it
 * happily parses `<img onerror=...>` / `<script>` out of inline HTML, so any raw
 * HTML in the source markdown would otherwise survive into every connected
 * editor's DOM (the reader path is sanitized separately by rehype-sanitize).
 *
 * Why drop rather than route through DOMPurify: `html-sanitize.ts` pulls jsdom +
 * DOMPurify, which we deliberately keep OUT of the collab-server bundle (see the
 * note in markdown-render.ts). Authored Atrium content is canonical markdown, not
 * HTML, so raw-HTML passthrough is not a supported feature here — dropping the
 * `html` tokens neutralizes the vector at parse time with zero extra deps.
 */
const editorMarked = new Marked({ async: false });
// A renderer `html` override drops BOTH block-level (`<div>`/`<script>` blocks)
// and inline (`<img onerror=...>` mid-paragraph) raw-HTML tokens — marked routes
// both through the same renderer method. Verified by the seeding-path smoke test.
editorMarked.use({
  renderer: {
    html(): string {
      return "";
    },
  },
});

/**
 * markdown → editor for embedded artifacts (Meridian slice D). A custom BLOCK
 * extension that recognizes the `::atrium-artifact{id="<uuid>"}` leaf directive
 * (lib/content/embed-directive.ts) and emits the embed node's DOM
 * (`div[data-atrium-artifact-embed]`), which `generateJSON` then parses into the
 * `atriumArtifactEmbed` node via the node's `parseHTML`. Registered as a NAMED
 * token type (not `html`), so it uses THIS renderer rather than the raw-HTML
 * dropper above — the embed div survives while arbitrary author HTML is still
 * dropped. This closes the round-trip: the editor serializes the node back to the
 * same directive (`artifact-embed-node.ts`), so seeding/agent writes reconstruct
 * the live embed instead of leaving inert directive text.
 */
const artifactEmbedMarkedExtension: TokenizerAndRendererExtension = {
  name: "atriumArtifactEmbed",
  level: "block",
  start(src: string) {
    // Only a LINE-ANCHORED directive is a real embed: it must occupy its own whole
    // line (preceded by start-of-string or a newline, up to leading whitespace),
    // exactly like the reader's whole-line ARTIFACT_EMBED_LINE_RE. A plain
    // `indexOf("::atrium-artifact{")` would also point at a directive TRAILING other
    // prose on the same line, so marked would cut the paragraph and tokenize it as a
    // live embed here — while the reader treats that same line as inert text (the
    // whole-line regex fails on the leading prose). Anchoring `start` keeps the two
    // in lockstep: prose + directive on one line stays one inert paragraph.
    const m = /(?:^|\n)[ \t]*::atrium-artifact\{/.exec(src);
    if (!m) return undefined;
    // Advance past a leading newline (if matched) to the start of the directive line
    // so the tokenizer's `^[ \t]*…` rule fires at that position.
    return m[0].startsWith("\n") ? m.index + 1 : m.index;
  },
  tokenizer(src: string) {
    const rule = /^[ \t]*::atrium-artifact\{([^}]*)\}[ \t]*(?:\n|$)/;
    const match = rule.exec(src);
    if (!match) return undefined;
    // Validate the id here (UUID shape) — an unparseable directive falls through
    // to normal paragraph handling rather than emitting an embed with a bad id.
    const artifactId = parseArtifactEmbedAttrs(match[1]);
    if (!artifactId) return undefined;
    return { type: "atriumArtifactEmbed", raw: match[0], artifactId };
  },
  renderer(token: Tokens.Generic) {
    const artifactId =
      typeof token.artifactId === "string" ? token.artifactId : "";
    if (!artifactId) return "";
    // The id is UUID-validated at tokenize time, so it is safe to interpolate into
    // the attribute; generateJSON parses this div into the embed node.
    return `<div ${ARTIFACT_EMBED_DATA_ATTR} ${ARTIFACT_EMBED_ID_ATTR}="${artifactId}"></div>\n`;
  },
};
editorMarked.use({ extensions: [artifactEmbedMarkedExtension] });

/** Escape a string for safe interpolation into a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Match every `![alt](url)` image on a line (the grid's children). */
const GRID_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * markdown → editor for the slice-F rich CONTAINER directives (Meridian slice F):
 * `:::callout` / `:::warn` (rich-text callouts) and `:::grid` (image grid). Emits
 * the same DOM the reader render + the TipTap nodes agree on:
 *  - callout/warn → `div.atrium-callout[ .atrium-callout-warn]` wrapping the inner
 *    markdown rendered recursively (so paragraphs/lists inside survive), which
 *    `generateJSON` parses into the `atriumCallout` node.
 *  - grid → `div.atrium-image-grid` of bare `<img>` (extracted from the `![]()`
 *    lines only, so the grid's `atriumImage+` content model matches exactly — no
 *    stray `<p>` wrappers), parsed into `atriumImageGrid` + `atriumImage` children.
 * Registered as NAMED token types (not `html`), so the raw-HTML dropper above does
 * NOT strip them — arbitrary author HTML is still dropped.
 */
const containerDirectiveMarkedExtension: TokenizerAndRendererExtension = {
  name: "atriumContainer",
  level: "block",
  start(src: string) {
    const m = /(?:^|\n):::(?:callout|warn|grid)\b/.exec(src);
    if (!m) return undefined;
    return m[0].startsWith("\n") ? m.index + 1 : m.index;
  },
  tokenizer(src: string) {
    // `:::name` on its own line … closing `:::` on its own line (or EOF).
    const rule =
      /^:::(callout|warn|grid)[^\n]*\n([\s\S]*?)(?:\n:::[ \t]*(?:\n|$)|$)/;
    const match = rule.exec(src);
    if (!match) return undefined;
    const name = match[1];
    const inner = match[2];
    const token: Tokens.Generic = {
      type: "atriumContainer",
      raw: match[0],
      name,
      inner,
    };
    // Callout/warn hold rich blocks → tokenize their inner markdown recursively.
    // Grid holds only image lines → parsed in the renderer, no child tokens.
    if (name !== "grid") token.tokens = this.lexer.blockTokens(inner);
    return token;
  },
  renderer(token: Tokens.Generic) {
    const name = typeof token.name === "string" ? token.name : "callout";
    if (name === "grid") {
      const inner = typeof token.inner === "string" ? token.inner : "";
      const imgs: string[] = [];
      GRID_IMAGE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = GRID_IMAGE_RE.exec(inner)) !== null) {
        const url = m[2];
        if (isSafeMediaUrl(url)) {
          imgs.push(
            `<img src="${escapeAttr(url)}" alt="${escapeAttr(m[1])}">`
          );
        }
      }
      if (imgs.length === 0) return "";
      return `<div class="${IMAGE_GRID_CLASS}">${imgs.join("")}</div>\n`;
    }
    const cls =
      name === "warn" ? `${CALLOUT_CLASS} ${CALLOUT_WARN_CLASS}` : CALLOUT_CLASS;
    const rendered = token.tokens
      ? this.parser.parse(token.tokens as Tokens.Generic[])
      : "";
    return `<div class="${cls}">${rendered}</div>\n`;
  },
};

/**
 * markdown → editor for the slice-F `::video{src="…"}` LEAF directive. Emits
 * `<video class="atrium-video" controls src="…">` (src is UUID-free but URL-safety
 * validated at tokenize time), which `generateJSON` parses into `atriumVideo`.
 */
const videoMarkedExtension: TokenizerAndRendererExtension = {
  name: "atriumVideo",
  level: "block",
  start(src: string) {
    const m = /(?:^|\n)[ \t]*::video\{/.exec(src);
    if (!m) return undefined;
    return m[0].startsWith("\n") ? m.index + 1 : m.index;
  },
  tokenizer(src: string) {
    const rule = /^[ \t]*::video\{([^}]*)\}[ \t]*(?:\n|$)/;
    const match = rule.exec(src);
    if (!match) return undefined;
    const videoSrc = parseVideoDirectiveAttrs(match[1]);
    if (!videoSrc) return undefined;
    return { type: "atriumVideo", raw: match[0], videoSrc };
  },
  renderer(token: Tokens.Generic) {
    const videoSrc = typeof token.videoSrc === "string" ? token.videoSrc : "";
    if (!isSafeMediaUrl(videoSrc)) return "";
    return `<video class="${VIDEO_CLASS}" controls src="${escapeAttr(videoSrc)}"></video>\n`;
  },
};

editorMarked.use({
  extensions: [containerDirectiveMarkedExtension, videoMarkedExtension],
});

/**
 * Parse markdown into ProseMirror JSON against the shared Atrium schema.
 *
 * Trust model: raw HTML is DROPPED by `editorMarked` (its renderer returns "" for
 * every `html` token — see above) BEFORE the HTML string reaches `generateJSON`.
 * The ProseMirror schema is an additional safety net (unknown tags/attrs are
 * dropped), but it is NOT relied on as the sanitization boundary — the schema
 * parser is not a security control. Do NOT pipe this through the reader's rich
 * pipeline (KaTeX, DOMPurify, etc.) — those add artifacts unsuitable for the
 * editable TipTap model.
 */
export function markdownToProseMirrorJSON(markdown: string): JSONContent {
  const html = editorMarked.parse(markdown ?? "", { async: false });
  if (typeof html !== "string") {
    throw new TypeError("marked.parse returned a non-string; expected sync output");
  }
  return generateJSON(html, getSchemaExtensions());
}

/**
 * Return a deep copy of `node` with the `atriumAuthored` mark set to `by` on
 * every text node (replacing any existing author mark). Non-text nodes are
 * recursed into. Used to stamp a freshly-seeded draft with its creator.
 */
export function stampAuthor(node: JSONContent, by: string): JSONContent {
  const authoredMark = { type: AUTHORED_MARK, attrs: { by } };
  const walk = (n: JSONContent): JSONContent => {
    const next: JSONContent = { ...n };
    if (n.type === "text") {
      const kept = (n.marks ?? []).filter((m) => m.type !== AUTHORED_MARK);
      next.marks = [...kept, authoredMark];
    }
    if (Array.isArray(n.content)) {
      next.content = n.content.map(walk);
    }
    return next;
  };
  return walk(node);
}

/**
 * Build a Y.Doc for a fresh document from its markdown, stamped with the
 * creator's author tag. Returned doc is ready to seed a new collab room (its
 * `COLLAB_FIELD` fragment is populated) — see `getOrCreateDoc` in collab-server.ts.
 */
export function seedYDocFromMarkdown(markdown: string, by: string): YDoc {
  const json = stampAuthor(markdownToProseMirrorJSON(markdown), by);
  return prosemirrorJSONToYDoc(getCollabSchema(), json, COLLAB_FIELD);
}

/** Convert a live Y.Doc back to ProseMirror JSON (for inspection / re-stamping). */
export function yDocToProseMirrorJSON(doc: YDoc): JSONContent {
  return yDocToProsemirrorJSON(doc, COLLAB_FIELD) as JSONContent;
}
