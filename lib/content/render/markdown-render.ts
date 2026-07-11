/**
 * Atrium markdown -> sanitized HTML render
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1, spec §18.2). The single render pipeline
 * that feeds BOTH the immutable `render.html` snapshot (S3, via the version
 * service) and the live internal reader / `public_web` pages. Documents are
 * canonical markdown; this turns them into safe, styled HTML.
 *
 * Pipeline (synchronous — `processSync`, so the version-service snapshot path
 * stays sync):
 *   remark-parse -> remark-gfm -> remark-math -> remark-directive
 *     -> (atrium directive transform: :::callout / :::warn)
 *     -> remark-rehype  (allowDangerousHtml = false: raw embedded HTML is DROPPED)
 *     -> rehype-sanitize (strict allowlist; no <script>, no event handlers, no style)
 *     -> rehype-katex    (math; see ordering note)
 *     -> rehype-stringify
 *
 * ## Why sanitize runs BEFORE KaTeX
 * KaTeX's HTML output relies on inline `style` for per-glyph layout, which the
 * strict sanitizer (correctly) forbids on authored content. Sanitizing FIRST
 * removes any malicious HTML the author embedded; remark-math has already turned
 * `$…$` into inert `<span class="math math-inline">…tex…</span>` nodes whose only
 * surviving content is plain text + the math class. rehype-katex then transforms
 * those *trusted, generated* nodes into KaTeX markup AFTER the sanitize gate, so
 * its inline styles survive without ever opening a `style` hole for author input.
 * KaTeX runs with `throwOnError: false` and `trust: false` (the default — disables
 * `\href`/`\url`/`\includegraphics`).
 *
 * ## Security
 * No raw author HTML ever reaches the output: remark-rehype drops it
 * (`allowDangerousHtml` unset = false), and rehype-sanitize re-checks the
 * generated tree against a GitHub-derived allowlist extended only with the math
 * + callout classes. For sanitizing a raw HTML *string* (not markdown), use
 * `sanitizeHtml` from `./html-sanitize`.
 *
 * ## Jest note
 * This module imports the pure-ESM unified ecosystem, which `next/jest` (SWC)
 * cannot transform in node_modules. It is therefore NOT jest-loadable; tests that
 * transitively reach it (version-service) must `jest.mock` this module, and the
 * pipeline itself is verified by tests/smoke/atrium-markdown-render.smoke.ts
 * (run under Bun, which executes ESM natively) plus the reference E2E.
 *
 * Untrusted *artifact* code is never rendered through this path — artifacts run
 * only inside the cross-origin sandbox (§28.1). This renderer is for documents.
 */

import type { Root } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import {
  CALLOUT_CLASS,
  CALLOUT_WARN_CLASS,
  IMAGE_GRID_CLASS,
  VIDEO_CLASS,
  isSafeMediaUrl,
} from "../block-directives";

// NOTE: `sanitizeHtml` lives in ./html-sanitize (DOMPurify + jsdom). It is
// intentionally NOT re-exported here: this module is imported by version-service
// (and thus the collab server bundle), and re-exporting would drag jsdom into
// that bundle. Import sanitizeHtml from "./html-sanitize" directly.

/**
 * remark transform: render the curated Atrium directives to a fixed tag + class.
 * Any other directive name is left untouched (mdast-util-to-hast renders its
 * children as plain content) — we never emit a tag derived from an arbitrary
 * directive name. The curated set:
 *  - `:::callout` / `:::warn` — the gradient-tint callout (`<div>`/`<span>`).
 *  - `:::grid` — the image grid container (`<div class="atrium-image-grid">`,
 *    children are the `![]()` images the author dropped, slice F).
 *  - `::video{src="…"}` — the HTML5 video block (`<video controls src>`), slice F.
 *    The src is validated to http/https here; a directive without a safe src is
 *    left inert (rendered as its plain children) so no unsafe URL reaches the DOM.
 * The only tags this can emit are the fixed `div`/`span`/`video` above — never a
 * tag derived from the directive name.
 */
/** The shape of a remark directive node this transform reads + mutates. */
type DirectiveNode = {
  type: string;
  name?: string;
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  attributes?: Record<string, string | null | undefined>;
};

/**
 * Map ONE curated Atrium directive node to its fixed hast tag + class (mutating the
 * node's `data`). Only ever emits the fixed div/span/video tags above — never a tag
 * derived from the directive name. Split out of the visitor so `remarkAtriumDirectives`
 * stays a thin walker (keeps that closure's cyclomatic complexity low).
 */
function applyAtriumDirective(node: DirectiveNode): void {
  if (node.name === "callout" || node.name === "warn") {
    const data = (node.data ??= {});
    data.hName = node.type === "textDirective" ? "span" : "div";
    data.hProperties = {
      className:
        node.name === "warn"
          ? [CALLOUT_CLASS, CALLOUT_WARN_CLASS]
          : [CALLOUT_CLASS],
    };
    return;
  }
  if (node.name === "grid") {
    const data = (node.data ??= {});
    data.hName = "div";
    data.hProperties = { className: [IMAGE_GRID_CLASS] };
    return;
  }
  if (node.name === "video") {
    // The leaf directive carries the src as a remark-directive attribute. Only an
    // http/https src is rendered; otherwise leave the node inert (no hName), so
    // mdast-util-to-hast emits its (empty) children rather than a <video> pointing
    // at an unsafe URL.
    const src = node.attributes?.src;
    if (typeof src !== "string" || !isSafeMediaUrl(src)) return;
    const data = (node.data ??= {});
    data.hName = "video";
    data.hProperties = {
      className: [VIDEO_CLASS],
      controls: true,
      preload: "metadata",
      playsInline: true,
      src,
    };
  }
}

function remarkAtriumDirectives() {
  return (tree: Root): undefined => {
    visit(tree, (node) => {
      if (
        node.type !== "containerDirective" &&
        node.type !== "leafDirective" &&
        node.type !== "textDirective"
      ) {
        return;
      }
      applyAtriumDirective(node as unknown as DirectiveNode);
    });
  };
}

/**
 * Strict sanitize schema: the GitHub-derived default, extended ONLY to keep the
 * generated math + callout classes (so rehype-katex can find the math nodes and
 * the callout styling applies). The tuple form restricts `className` to the exact
 * tokens — no arbitrary classes pass. No `style`, `script`, event handlers, or
 * embedding tags are added; those remain disallowed by the default.
 */
// `[name, ...allowedValues]` tuple: hast-util-sanitize restricts `className` to
// exactly these tokens (any other class is dropped). Typed as the same shape as
// `defaultSchema` so it slots into rehype-sanitize without widening.
// Only classes the pipeline actually GENERATES are listed. The directive
// transform (`remarkAtriumDirectives`) emits exactly `atrium-callout` and
// `atrium-callout-warn`; remark-math emits the `math*` classes. No directive
// produces `atrium-callout-title`, so it is intentionally absent — allowing a
// class no transform emits would only widen the surface for any future raw-HTML
// path without a corresponding feature.
const classAllow: [string, ...string[]] = [
  "className",
  "math",
  "math-inline",
  "math-display",
  "atrium-callout",
  "atrium-callout-warn",
  // Slice-F rich blocks: the image-grid container + the video player class.
  IMAGE_GRID_CLASS,
  VIDEO_CLASS,
];

const sanitizeSchema: typeof defaultSchema = {
  ...defaultSchema,
  // Pin `img[src]` to http/https explicitly. `defaultSchema.protocols` already
  // restricts `src` to http/https (and `href`/`cite`/`longDesc` to safe schemes),
  // so a `data:`/`javascript:` URI in `![](data:…)` is stripped — verified by
  // tests/smoke/atrium-markdown-render.smoke.ts. This explicit copy is
  // defense-in-depth: it freezes the `src` contract here so a future
  // `hast-util-sanitize` bump that loosened the default could not silently re-open
  // a `data:`-URI img XSS hole. Other protocol entries inherit the default unchanged.
  protocols: {
    ...defaultSchema.protocols,
    src: ["http", "https"],
  },
  // Slice F: admit the <video> player tag. Its `src` is already pinned to
  // http/https by `protocols.src` above (which hast-util-sanitize applies to the
  // `src` attribute wherever it appears), so a `javascript:`/`data:` video src is
  // stripped exactly like an <img> src. Only the fixed presentation attributes are
  // allowed — no event handlers, no `autoplay` (a published page never auto-plays),
  // no arbitrary attributes. Authored video is trusted district content and no
  // worse a privacy surface than the already-allowed remote <img>.
  tagNames: [...(defaultSchema.tagNames ?? []), "video"],
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), classAllow],
    div: [...(defaultSchema.attributes?.div ?? []), classAllow],
    video: [classAllow, "src", "controls", "preload", "playsinline", "poster", "width", "height"],
  },
};

/**
 * Build the frozen unified processor once and reuse it. `freeze()` makes
 * `processSync` safe to call repeatedly without re-running the attachers.
 */
const buildProcessor = () =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkDirective)
    .use(remarkAtriumDirectives)
    .use(remarkRehype)
    .use(rehypeSanitize, sanitizeSchema)
    // rehype-slug runs AFTER the sanitize gate on purpose: it adds a stable `id`
    // to every heading so the reader's "ON THIS PAGE" TOC (Epic #1059 slice E) can
    // anchor to it and in-page `#slug` links resolve. The id is derived by
    // github-slugger from the heading text (lower-cased, `[a-z0-9-]` only), so it
    // is fully generated — never author-controlled raw — and opens no injection
    // surface even though it is applied after sanitize. `lib/content/render/
    // headings.ts` slugs the SAME heading text with the SAME github-slugger, so the
    // TOC ids and these DOM ids always agree.
    .use(rehypeSlug)
    // rehype-katex defaults to catching parse errors (rendering them inline in
    // errorColor) rather than throwing, and `trust: false` (no \href/\url). No
    // options needed; sanitize already ran, so KaTeX's inline styles survive.
    .use(rehypeKatex)
    .use(rehypeStringify)
    .freeze();

let processor: ReturnType<typeof buildProcessor> | null = null;

function getProcessor(): ReturnType<typeof buildProcessor> {
  if (!processor) processor = buildProcessor();
  return processor;
}

/**
 * Render markdown to a sanitized, styled HTML string. Synchronous. The same
 * output is snapshotted to S3 (`render.html`) and rendered by the reader, so the
 * stored snapshot and the live page never diverge.
 */
export function renderMarkdownToHtml(markdown: string): string {
  if (!markdown) return "";
  return String(getProcessor().processSync(markdown));
}
