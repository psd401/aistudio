/**
 * OKF frontmatter (de)serialization — Phase 8 (Issue #1103, spec §36)
 *
 * Pure, dependency-free serialization of the pinned v0.1 frontmatter block
 * (`./profile`). The repo carries no YAML dependency, and OKF frontmatter is a
 * FLAT map of scalar strings + one string array (`tags`) — so a small, exact
 * emitter/parser is both safer (no transitive-dep churn) and sufficient.
 *
 * The emitter writes canonical, always-double-quoted YAML so its output is
 * unambiguous. The parser is deliberately tolerant of OTHER OKF producers (OKF is
 * cross-vendor): it accepts double-quoted, single-quoted, and bare scalars, plus
 * both flow (`[a, b]`) and block (`- a`) arrays.
 */

import { OKF_FRONTMATTER_FIELDS, type OkfConcept, type OkfFrontmatter } from "./profile";

const FRONTMATTER_FENCE = "---";

/** Escape a string for a YAML double-quoted scalar. */
function quoteScalar(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * Serialize an OKF frontmatter object to a `---`-fenced YAML block (with a
 * trailing newline). Emits fields in the pinned order; omits any absent field and
 * an empty `tags` array (so a tagless concept carries no `tags:` key).
 */
export function serializeFrontmatter(fm: OkfFrontmatter): string {
  const lines: string[] = [FRONTMATTER_FENCE];
  for (const field of OKF_FRONTMATTER_FIELDS) {
    if (field === "tags") {
      const tags = fm.tags;
      if (tags && tags.length > 0) {
        lines.push(`tags: [${tags.map(quoteScalar).join(", ")}]`);
      }
      continue;
    }
    const value = fm[field];
    if (typeof value === "string" && value.length > 0) {
      lines.push(`${field}: ${quoteScalar(value)}`);
    }
  }
  lines.push(FRONTMATTER_FENCE);
  return `${lines.join("\n")}\n`;
}

/** Unquote a single YAML scalar token (double-quoted, single-quoted, or bare). */
function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    // SINGLE-PASS unescape: a chained `.replace()` corrupts sequences like `\\n`
    // (an escaped backslash followed by n) — the `\\n` pass would consume the
    // second backslash + n as a newline. One regex over `\X` escapes consumes the
    // backslash + escaped char atomically, so each escape is handled exactly once.
    return value.slice(1, -1).replace(/\\(.)/g, (_m, ch: string) => {
      switch (ch) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        // `\"`, `\\`, and any other `\X` collapse to the escaped char verbatim.
        default:
          return ch;
      }
    });
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    // YAML single-quoted: the only escape is a doubled quote.
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Parse a YAML flow sequence body (`a, "b", 'c'`) into unquoted items. */
function parseFlowSequence(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of inner) {
    if (quote === '"' && escaped) {
      // The previous char was a backslash inside a double-quoted item: this char
      // (e.g. an escaped `\"`) is literal and cannot close the quote.
      current += ch;
      escaped = false;
    } else if (quote === '"' && ch === "\\") {
      current += ch;
      escaped = true;
    } else if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) items.push(current);
  return items.map(parseScalar).filter((v) => v.length > 0);
}

/**
 * Split a markdown document into its frontmatter block (if any) and the body.
 * A document with no leading `---` fence has an empty frontmatter map and the
 * whole document as body.
 */
function splitFrontmatter(md: string): { fmLines: string[]; body: string } {
  // Strip a leading BOM (Windows/editor-generated files) then normalize CRLF, so
  // the opening-fence match is newline-agnostic and not defeated by a U+FEFF.
  const normalized = md.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`) && normalized !== FRONTMATTER_FENCE) {
    return { fmLines: [], body: md };
  }
  const lines = normalized.split("\n");
  // lines[0] is the opening fence; find the closing fence line.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_FENCE) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    // Unterminated fence — treat the whole document as body (no frontmatter).
    return { fmLines: [], body: md };
  }
  const fmLines = lines.slice(1, closeIdx);
  // Body starts after the closing fence; drop a single leading blank line.
  const bodyLines = lines.slice(closeIdx + 1);
  if (bodyLines[0] === "") bodyLines.shift();
  return { fmLines, body: bodyLines.join("\n") };
}

/**
 * Parse the frontmatter of a markdown document into a raw string/array map plus
 * the trailing body. Tolerant of quoting styles and flow/block arrays; unknown
 * keys are preserved in the map (callers pick the fields they map).
 */
export function parseFrontmatter(md: string): {
  frontmatter: Record<string, string | string[]>;
  body: string;
} {
  const { fmLines, body } = splitFrontmatter(md);
  const frontmatter: Record<string, string | string[]> = {};
  let pendingBlockKey: string | null = null;
  const blockItems: string[] = [];

  const flushBlock = () => {
    if (pendingBlockKey !== null) {
      frontmatter[pendingBlockKey] = blockItems.slice();
      blockItems.length = 0;
      pendingBlockKey = null;
    }
  };

  for (const rawLine of fmLines) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim().length === 0) continue;

    // A block-sequence item ("  - value") continues the pending key.
    const blockMatch = /^\s*-\s+(.*)$/.exec(line);
    if (blockMatch && pendingBlockKey !== null) {
      const item = parseScalar(blockMatch[1]);
      if (item.length > 0) blockItems.push(item);
      continue;
    }

    const kvMatch = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (!kvMatch) continue;
    // A new key ends any block sequence being accumulated.
    flushBlock();
    const key = kvMatch[1];
    const rest = kvMatch[2];

    if (rest.trim().length === 0) {
      // Value may be a block sequence on the following lines.
      pendingBlockKey = key;
      continue;
    }
    const trimmed = rest.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      frontmatter[key] = parseFlowSequence(trimmed.slice(1, -1));
    } else {
      frontmatter[key] = parseScalar(trimmed);
    }
  }
  flushBlock();

  return { frontmatter, body };
}

/** Coerce a raw frontmatter value to a single string (first item if an array). */
function asString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Coerce a raw frontmatter value to a string array. */
function asStringArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * Serialize a concept file: the frontmatter block followed by the body. A single
 * blank line separates them for readability; parsing tolerates its presence or
 * absence.
 */
export function serializeConceptFile(fm: OkfFrontmatter, body: string): string {
  const head = serializeFrontmatter(fm);
  if (!body) return head;
  return `${head}\n${body}\n`;
}

/**
 * Parse a concept file into its typed OKF frontmatter + body. `type` defaults to
 * `"document"` when a bundle from another producer omits it (OKF requires `type`,
 * but a tolerant import must not reject a nearly-valid concept over a missing
 * required field).
 */
export function parseConceptFile(md: string): OkfConcept {
  const { frontmatter, body } = parseFrontmatter(md);
  return {
    frontmatter: {
      type: asString(frontmatter.type) ?? "document",
      title: asString(frontmatter.title),
      description: asString(frontmatter.description),
      resource: asString(frontmatter.resource),
      tags: asStringArray(frontmatter.tags),
      timestamp: asString(frontmatter.timestamp),
    },
    body,
  };
}
