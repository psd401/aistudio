/**
 * Shared HTML sanitizer for document-processor-v2 (REV-COR-409 / REV-INFRA-094).
 *
 * Both OfficeProcessor and TextProcessor previously defined their own `sanitizeHTML`
 * with OPPOSITE orderings — OfficeProcessor decoded entities first (correct) while
 * TextProcessor stripped tags first and decoded after (a double-decode bypass that
 * let entity-encoded markup like `&lt;script&gt;` round-trip into live `<script>`).
 * This single canonical implementation removes that divergence and is kept inside the
 * Lambda package so it never crosses the Code.fromAsset boundary (REV-INFRA-092).
 *
 * Order (security-critical):
 *   1. single-pass entity decode — named, decimal (&#60;), and hexadecimal (&#x3c;)
 *      (lookup table for named entities — never chained .replace())
 *   2. strip all `<...>` tags in one global pass
 *   3. whitespace cleanup
 *
 * Decoding only named entities let numeric-encoded tags (e.g. `&#60;script&#62;`)
 * bypass tag-stripping entirely — the sanitizer would pass them through as harmless
 * text, but a downstream HTML renderer decodes them back into a live `<script>`.
 *
 * `preserveNewlines` (REV-COR-408): keep line breaks so DOCX-derived Markdown retains
 * its paragraph/heading structure instead of collapsing to a single line.
 */

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
};

export function sanitizeHtml(html: string, opts?: { preserveNewlines?: boolean }): string {
  // Step 1: decode entities FIRST, in one pass, so entity-encoded markup is resolved
  // before tag stripping (prevents the strip-then-decode bypass). Handles named
  // (&amp;), decimal (&#38;), and hexadecimal (&#x26;) forms in the same pass.
  let sanitized = html.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? match;
  });

  // Step 2: strip all HTML tags in a single global pass (global replace removes every
  // non-overlapping match in one sweep — no loop, no O(n^2)).
  sanitized = sanitized.replace(/<[^>]*>/g, ' ');

  // Step 3: whitespace cleanup.
  if (opts?.preserveNewlines) {
    // Collapse horizontal whitespace runs to a single space but keep newlines; trim
    // spaces around each newline and collapse 3+ blank lines to one.
    return sanitized
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return sanitized.replace(/\s+/g, ' ').trim();
}
