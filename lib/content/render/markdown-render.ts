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
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";

// NOTE: `sanitizeHtml` lives in ./html-sanitize (DOMPurify + jsdom). It is
// intentionally NOT re-exported here: this module is imported by version-service
// (and thus the collab server bundle), and re-exporting would drag jsdom into
// that bundle. Import sanitizeHtml from "./html-sanitize" directly.

/**
 * remark transform: render the two curated container/leaf directives
 * (`:::callout`, `:::warn`) to a `<div>`/`<span>` with a fixed class. Any other
 * directive name is left untouched (mdast-util-to-hast renders its children as
 * plain content) — we never emit a tag derived from an arbitrary directive name.
 */
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
      if (node.name !== "callout" && node.name !== "warn") return;
      const data = (node.data ??= {});
      data.hName = node.type === "textDirective" ? "span" : "div";
      data.hProperties = {
        className:
          node.name === "warn"
            ? ["atrium-callout", "atrium-callout-warn"]
            : ["atrium-callout"],
      };
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
];

const sanitizeSchema: typeof defaultSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), classAllow],
    div: [...(defaultSchema.attributes?.div ?? []), classAllow],
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
