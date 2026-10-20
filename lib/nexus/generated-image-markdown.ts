/**
 * Markdown for a Nexus generated image (#1900).
 *
 * The alt text is the image's own description, not a fixed "Generated Image"
 * placeholder: it is what a screen reader announces, and what the
 * "Image unavailable" fallback in `markdown-text.tsx` names when the image
 * cannot load. Rows saved before #1900 carry no description and keep the
 * placeholder.
 */

const PLACEHOLDER_ALT = "Generated Image";

/** Long enough to name the image, short enough for the fallback chip. */
const MAX_ALT_GRAPHEMES = 125;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function toMarkdownAlt(altText: string | undefined): string {
  const collapsed = (altText ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return PLACEHOLDER_ALT;
  // Clip by grapheme so an emoji is never split in half.
  const parts = Array.from(graphemes.segment(collapsed), (s) => s.segment);
  const clipped =
    parts.length > MAX_ALT_GRAPHEMES
      ? `${parts.slice(0, MAX_ALT_GRAPHEMES - 1).join("").trimEnd()}…`
      : collapsed;
  // Brackets and backslashes would end or corrupt the `![...]` label.
  return clipped.replace(/[\\[\]]/g, "\\$&");
}

export function generatedImageMarkdown(url: string, altText?: string): string {
  return `![${toMarkdownAlt(altText)}](${url})`;
}
