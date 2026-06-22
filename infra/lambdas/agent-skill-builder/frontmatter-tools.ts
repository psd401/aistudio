/**
 * Pure SKILL.md frontmatter `allowed-tools` parsing for the agent-skill-builder
 * Lambda (Issue #927). Extracted from index.ts so it can be unit-tested without
 * importing the Lambda's AWS-SDK module graph.
 *
 * No deps (the Lambda keeps its bundle minimal — no YAML lib). Parses both the
 * inline comma-separated form (`allowed-tools: a, b@v1`) and the YAML list form
 * (`- a@v1`).
 */

/**
 * Find malformed `@version` pins in a SKILL.md `allowed-tools` frontmatter value
 * (Issue #927). A pin is malformed when it contains an `@` but the part after it
 * is not a `vN` token (e.g. `tool@2`, `tool@latest`, `tool@v1@v2`). Returns the
 * offending raw entries (deduped, in first-seen order) so the scanner can report
 * them. A malformed pin would silently fail to match any real tool, so surfacing
 * it at scan time turns a silent no-op into a clear lint error.
 */
export function findMalformedToolVersionPins(frontmatter: string): string[] {
  const lines = frontmatter.split('\n');
  const entries: string[] = [];
  let inListBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const inlineMatch = /^\s*allowed-tools\s*:\s*(.*)$/.exec(line);
    if (inlineMatch) {
      const value = inlineMatch[1].trim();
      if (value) {
        // Inline comma-separated list on the same line.
        for (const part of value.split(',')) entries.push(part.trim());
        inListBlock = false;
      } else {
        // Empty value -> a YAML list block follows on subsequent `- item` lines.
        inListBlock = true;
      }
      continue;
    }
    if (inListBlock) {
      const itemMatch = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (itemMatch) {
        entries.push(itemMatch[1].trim());
      } else if (line.trim() !== '') {
        // A non-list, non-blank line ends the allowed-tools block.
        inListBlock = false;
      }
    }
  }

  const bad: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || !entry.includes('@') || seen.has(entry)) continue;
    seen.add(entry);
    const [identifier, version, ...rest] = entry.split('@');
    // Valid pin: exactly one `@`, non-empty identifier, version matches `vN`.
    const isValid =
      rest.length === 0 && identifier.length > 0 && /^v\d+$/.test(version ?? '');
    if (!isValid) bad.push(entry);
  }
  return bad;
}
