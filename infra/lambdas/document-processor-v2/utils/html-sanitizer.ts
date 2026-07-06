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
 *   1. single-pass entity decode (lookup table — never chained .replace())
 *   2. strip all `<...>` tags in one global pass
 *   3. whitespace cleanup
 *
 * `preserveNewlines` (REV-COR-408): keep line breaks so DOCX-derived Markdown retains
 * its paragraph/heading structure instead of collapsing to a single line.
 */

const ENTITY_MAP: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
  '&amp;': '&',
};

export function sanitizeHtml(html: string, opts?: { preserveNewlines?: boolean }): string {
  // Step 1: decode entities FIRST, in one pass, so entity-encoded markup is resolved
  // before tag stripping (prevents the strip-then-decode bypass).
  let sanitized = html.replace(/&(?:lt|gt|quot|#x27|#39|amp);/g, (m) => ENTITY_MAP[m] ?? m);

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
