/**
 * Markdown → neutral block IR (Issue #1898).
 *
 * `generateDocument()` is handed markdown: that is what a chat model writes and
 * what Nexus asks it for. Before this module, DOCX put the raw markdown on the
 * page (`## Heading` rendered literally) and PPTX dumped every line of a slide
 * into one text box. Both renderers now go through the small, format-neutral IR
 * produced here, so the markdown is parsed ONCE and each format decides only how
 * to draw a heading, a list item or a table.
 *
 * Deliberately pure: `marked` is the only dependency, no `docx`/`pptxgenjs`, no
 * Node built-ins. That keeps the parsing unit-testable on its own and lets the
 * generation service keep lazy-loading the heavy format libraries per branch.
 */

import { marked, type Token, type Tokens } from "marked";

/** One styled span of text inside a block. */
export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Inline code span — renderers draw it monospaced. */
  code?: boolean;
}

export type HeadingLevelNumber = 1 | 2 | 3 | 4 | 5 | 6;

/** A table cell is just its inline runs. */
export type TableCellRuns = InlineRun[];

export type MarkdownBlock =
  | { kind: "heading"; level: HeadingLevelNumber; runs: InlineRun[] }
  | { kind: "paragraph"; runs: InlineRun[] }
  | { kind: "quote"; runs: InlineRun[] }
  /**
   * `level` is 0-based nesting depth. `listId` identifies which markdown list
   * the item came from, and EVERY list gets its own — a nested one too. The IR
   * is a flat block stream, so without it a renderer cannot tell two adjacent
   * ordered lists apart and would continue one counter across both ("3. 4."
   * instead of a fresh "1. 2."); the same happens to two numbered sublists
   * under different bulleted parents when they share the parent's id, because
   * a bullet never advances the ordered counter in Word. `checked` is
   * present only for a GFM task-list item (`- [x]` / `- [ ]`). `start` is
   * present only for an ordered list whose first number is not 1 (`5. Fifth`
   * → 5): `marked` reports it as `List.start`, and a renderer that drops it
   * silently renumbers the user's "5, 6" as "1, 2".
   */
  | {
      kind: "listItem";
      ordered: boolean;
      level: number;
      listId: number;
      checked?: boolean;
      start?: number;
      runs: InlineRun[];
    }
  | { kind: "table"; header: TableCellRuns[]; rows: TableCellRuns[][] }
  | { kind: "code"; text: string; lang?: string }
  | { kind: "rule" };

/** Deepest list nesting the IR tracks; deeper items collapse onto this level. */
const MAX_LIST_LEVEL = 4;

/** Clamp a `marked` heading depth (1-6) to the IR's heading levels. */
function toHeadingLevel(depth: number): HeadingLevelNumber {
  if (!Number.isFinite(depth)) return 1;
  const clamped = Math.min(6, Math.max(1, Math.trunc(depth)));
  return clamped as HeadingLevelNumber;
}

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/**
 * Flatten `marked`'s inline token tree into styled runs.
 *
 * Nested emphasis composes (`**bold *and italic***`) because the style is
 * carried down rather than replaced. A `link` contributes its visible text plus
 * its href in parentheses when the two differ: the IR has no hyperlink block,
 * and silently dropping the target would lose information the user asked to be
 * put in the document. `image` contributes its alt text for the same reason.
 */
/**
 * Emphasis tokens: recurse with one style flag added. Driven by a table so the
 * dispatch stays flat instead of growing a branch per token type.
 */
const EMPHASIS_STYLE: Readonly<Record<string, InlineStyle>> = {
  strong: { bold: true },
  em: { italic: true },
  // No strikethrough in the IR; keep the text rather than drop it.
  del: {},
};

/** A `link`'s visible text, plus its href when the two differ. */
function collectLinkRuns(
  link: Tokens.Link,
  style: InlineStyle,
  out: InlineRun[]
): void {
  collectInlineRuns(link.tokens, style, out);
  if (link.href && link.href !== (link.text ?? "")) {
    pushRun(out, ` (${link.href})`, style);
  }
}

/**
 * Tokens with no inline children of their own. Returns false when the token is
 * not a leaf this function handles, so the caller can recurse instead.
 */
function collectLeafRun(
  token: Token,
  style: InlineStyle,
  out: InlineRun[]
): boolean {
  switch (token.type) {
    case "codespan":
      pushRun(out, (token as Tokens.Codespan).text, { ...style, code: true });
      return true;
    case "br":
      pushRun(out, " ", style);
      return true;
    case "image": {
      const image = token as Tokens.Image;
      pushRun(out, image.text || image.href || "", style);
      return true;
    }
    case "escape":
      pushRun(out, (token as Tokens.Escape).text, style);
      return true;
    default:
      return false;
  }
}

function collectInlineRuns(
  tokens: Token[] | undefined,
  style: InlineStyle = {},
  out: InlineRun[] = []
): InlineRun[] {
  if (!tokens) return out;
  for (const token of tokens) {
    const emphasis = EMPHASIS_STYLE[token.type];
    if (emphasis) {
      collectInlineRuns(
        (token as { tokens?: Token[] }).tokens,
        { ...style, ...emphasis },
        out
      );
      continue;
    }
    if (token.type === "link") {
      collectLinkRuns(token as Tokens.Link, style, out);
      continue;
    }
    if (collectLeafRun(token, style, out)) continue;
    // `text` tokens may themselves carry inline children (list items do).
    const nested = (token as { tokens?: Token[] }).tokens;
    if (nested && nested.length > 0) {
      collectInlineRuns(nested, style, out);
      continue;
    }
    const text = (token as { text?: string }).text;
    if (typeof text === "string") pushRun(out, text, style);
  }
  return out;
}

/**
 * Append `text` to `out`, merging into the previous run when the styling is
 * identical. Keeps the run list short — `marked` emits a separate `text` token
 * per fragment — which matters because every run becomes its own `TextRun` in
 * the DOCX output.
 */
function pushRun(out: InlineRun[], text: string, style: InlineStyle): void {
  if (text === "") return;
  const last = out[out.length - 1];
  if (
    last &&
    !!last.bold === !!style.bold &&
    !!last.italic === !!style.italic &&
    !!last.code === !!style.code
  ) {
    last.text += text;
    return;
  }
  out.push({
    text,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.code ? { code: true } : {}),
  });
}

/** Trim leading/trailing whitespace across a run list without losing styling. */
function trimRuns(runs: InlineRun[]): InlineRun[] {
  const copy = runs.map((run) => ({ ...run }));
  while (copy.length > 0) {
    copy[0].text = copy[0].text.replace(/^\s+/, "");
    if (copy[0].text === "") copy.shift();
    else break;
  }
  while (copy.length > 0) {
    const last = copy[copy.length - 1];
    last.text = last.text.replace(/\s+$/, "");
    if (last.text === "") copy.pop();
    else break;
  }
  return copy;
}

/** Collapse runs to plain text (used by the slide builder and tests). */
export function runsToPlainText(runs: InlineRun[]): string {
  return runs.map((run) => run.text).join("");
}

/** What every item of one markdown list shares. */
interface ListContext {
  ordered: boolean;
  level: number;
  listId: number;
  /** Explicit first number of an ordered list, when it is not 1. */
  start: number | undefined;
  /** The parse-wide id allocator, so a nested list can take an id of its own. */
  nextListId: () => number;
}

function pushListItems(
  item: Tokens.ListItem,
  list: ListContext,
  out: MarkdownBlock[]
): void {
  // An item's own text comes first in `tokens`; everything after it — a nested
  // list, the SECOND paragraph of a loose item, a quote or a table — arrives as
  // a sibling token. Only the text before the first boundary is the item's own:
  // a `space` token is the blank line between two paragraphs, so a later
  // paragraph must not be folded into the first (the runs would be glued
  // together with no separator: "First paragraphSecond paragraph").
  const ownInline: Token[] = [];
  const trailing: Token[] = [];
  let ownTextDone = false;
  for (const child of item.tokens ?? []) {
    if (child.type === "checkbox") {
      // `marked` injects a `checkbox` token for a GFM task item — as a sibling
      // in a tight list, or spliced into the paragraph's inline tokens in a
      // loose one. It carries no `text`, so every path that looks for one drops
      // it silently. The state is read from `item.task`/`item.checked` below
      // instead, which `marked` sets in BOTH cases.
      continue;
    }
    if (child.type === "space") {
      ownTextDone = true;
      continue;
    }
    if (!ownTextDone && (child.type === "text" || child.type === "paragraph")) {
      ownInline.push(child);
      continue;
    }
    ownTextDone = true;
    trailing.push(child);
  }

  const runs = trimRuns(collectInlineRuns(ownInline));
  const nestedListCount = trailing.filter((t) => t.type === "list").length;
  // An item whose only content is a nested list still needs a marker emitted,
  // otherwise the nesting level the children sit under has no visible parent.
  if (runs.length > 0 || nestedListCount === 0) {
    out.push({
      kind: "listItem",
      ordered: list.ordered,
      level: list.level,
      listId: list.listId,
      ...(item.task === true ? { checked: item.checked === true } : {}),
      ...(list.start !== undefined ? { start: list.start } : {}),
      runs,
    });
  }

  // Emitted in source order, so a paragraph written after a nested list stays
  // after it.
  for (const token of trailing) {
    if (token.type === "list") {
      // Its own id, not the parent's: see `listId` on the IR type.
      pushList(
        token as Tokens.List,
        Math.min(list.level + 1, MAX_LIST_LEVEL),
        list.nextListId(),
        list.nextListId,
        out
      );
      continue;
    }
    // A later paragraph, quote or table inside a list item renders at top
    // level: the IR carries no indent for non-list blocks. Content and order
    // are preserved; only the indentation of this shape is lost.
    pushBlock(token, out, list.nextListId);
  }
}

function pushList(
  list: Tokens.List,
  level: number,
  listId: number,
  nextListId: () => number,
  out: MarkdownBlock[]
): void {
  const ordered = list.ordered === true;
  // `marked` sets `start` to the first item's number for an ordered list and
  // to "" for a bulleted one. Only a start other than the default 1 is carried
  // (mirroring `checked`): an absent field means "nothing to restore".
  const start =
    ordered && typeof list.start === "number" && list.start !== 1
      ? list.start
      : undefined;
  const context: ListContext = { ordered, level, listId, start, nextListId };
  for (const item of list.items ?? []) {
    pushListItems(item, context, out);
  }
}

/** Push a block whose only content is inline runs, skipping empty ones. */
function pushInlineBlock(
  kind: "paragraph" | "quote",
  tokens: Token[] | undefined,
  out: MarkdownBlock[]
): void {
  const runs = trimRuns(collectInlineRuns(tokens));
  if (runs.length > 0) out.push({ kind, runs });
}

function pushTable(table: Tokens.Table, out: MarkdownBlock[]): void {
  out.push({
    kind: "table",
    header: (table.header ?? []).map((cell) =>
      trimRuns(collectInlineRuns(cell.tokens))
    ),
    rows: (table.rows ?? []).map((row) =>
      row.map((cell) => trimRuns(collectInlineRuns(cell.tokens)))
    ),
  });
}

/**
 * Block types with no inline-run body of their own. Returns false when the
 * token is not one of them.
 */
function pushStructuralBlock(
  token: Token,
  out: MarkdownBlock[],
  nextListId: () => number
): boolean {
  switch (token.type) {
    case "list":
      // A new id per list; nested lists draw their own from the same allocator.
      pushList(token as Tokens.List, 0, nextListId(), nextListId, out);
      return true;
    case "table":
      pushTable(token as Tokens.Table, out);
      return true;
    case "code": {
      const code = token as Tokens.Code;
      out.push({
        kind: "code",
        text: code.text ?? "",
        ...(code.lang ? { lang: code.lang } : {}),
      });
      return true;
    }
    case "hr":
      out.push({ kind: "rule" });
      return true;
    case "space":
    case "html":
      // `space` carries no content. Raw HTML is dropped rather than printed as
      // literal markup — a model that emits a stray `<br>` should not put
      // `<br>` on the page.
      return true;
    default:
      return false;
  }
}

function pushBlock(
  token: Token,
  out: MarkdownBlock[],
  nextListId: () => number = () => 0
): void {
  if (token.type === "heading") {
    const heading = token as Tokens.Heading;
    const runs = trimRuns(collectInlineRuns(heading.tokens));
    if (runs.length > 0) {
      out.push({ kind: "heading", level: toHeadingLevel(heading.depth), runs });
    }
    return;
  }
  if (token.type === "paragraph") {
    pushInlineBlock("paragraph", (token as Tokens.Paragraph).tokens, out);
    return;
  }
  if (token.type === "text") {
    // Top-level loose text outside a paragraph (rare, but `marked` emits it).
    const text = token as Tokens.Text;
    const tokens =
      text.tokens && text.tokens.length > 0
        ? text.tokens
        : ([{ type: "text", raw: text.text ?? "", text: text.text ?? "" }] as Token[]);
    pushInlineBlock("paragraph", tokens, out);
    return;
  }
  if (token.type === "blockquote") {
    pushInlineBlock("quote", (token as Tokens.Blockquote).tokens, out);
    return;
  }
  if (pushStructuralBlock(token, out, nextListId)) return;
  const text = (token as { text?: string }).text;
  if (typeof text === "string" && text.trim() !== "") {
    out.push({ kind: "paragraph", runs: [{ text: text.trim() }] });
  }
}

/**
 * Parse markdown into the block IR. Unparseable input degrades to a single
 * paragraph per blank-line-separated chunk rather than throwing, so a document
 * request never fails because of the body's formatting.
 */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  if (typeof markdown !== "string" || markdown.trim() === "") return [];
  let tokens: Token[];
  try {
    tokens = marked.lexer(markdown);
  } catch {
    return markdown
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk !== "")
      .map((chunk): MarkdownBlock => ({ kind: "paragraph", runs: [{ text: chunk }] }));
  }
  const blocks: MarkdownBlock[] = [];
  let listCounter = 0;
  const nextListId = () => ++listCounter;
  for (const token of tokens) {
    pushBlock(token, blocks, nextListId);
  }
  return blocks;
}

/**
 * A list item's bullet text for a slide. A checklist slide must still
 * distinguish done from not-done, and the IR carries the state because the
 * markdown `[x]` never survives parsing.
 */
function listItemBulletText(
  block: Extract<MarkdownBlock, { kind: "listItem" }>
): string {
  const text = runsToPlainText(block.runs);
  if (block.checked === undefined) return text;
  return `${block.checked ? "[x]" : "[ ]"} ${text}`;
}

/** One PPTX slide: a title line plus its bullet lines. */
export interface SlideSpec {
  title: string;
  bullets: string[];
}

/** Slides past this are dropped — a deck request is not a book. */
const MAX_SLIDES = 100;
/** Bullets past this on one slide are dropped so text stays on the layout. */
const MAX_BULLETS_PER_SLIDE = 12;

/**
 * Make a lone `---` delimiter line parse as a thematic break.
 *
 * `documents.create` has always documented "slides separated by a line
 * containing only `---`", and that is written WITHOUT a blank line before the
 * delimiter — which in markdown makes it a *setext heading underline* for the
 * preceding paragraph, not a horizontal rule. Left alone, the long-advertised
 * delimiter would silently stop splitting slides: "Slide one\nbody\n---\nSlide
 * two" would collapse into a single slide titled "Slide one body".
 *
 * Inserting a blank line restores the intent. Only applied on the slide path:
 * in a DOCX a setext heading really is a heading and must stay one.
 *
 * Exported for unit testing.
 */
export function normalizeSlideDelimiters(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (
      /^\s*-{3,}\s*$/.test(line) &&
      previous !== undefined &&
      previous.trim() !== ""
    ) {
      out.push("");
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Turn markdown into slides.
 *
 * ONE rule covers both conventions the tool documents, because in markdown they
 * are the same token: a heading starts a new slide, and so does a thematic break
 * (`---`), which is the delimiter `documents.create` has always advertised. A
 * slide that has no heading promotes its first paragraph to the title, so a deck
 * written as plain `---`-separated chunks keeps the old behaviour.
 */
export function markdownToSlides(markdown: string): SlideSpec[] {
  const blocks = parseMarkdownBlocks(normalizeSlideDelimiters(markdown));
  const slides: SlideSpec[] = [];
  let current: SlideSpec | null = null;

  const flush = () => {
    if (!current) return;
    if (current.title !== "" || current.bullets.length > 0) {
      // Untitled slide: promote the first bullet so the slide has a heading.
      if (current.title === "" && current.bullets.length > 0) {
        current.title = current.bullets.shift() as string;
      }
      slides.push(current);
    }
    current = null;
  };

  const ensure = (): SlideSpec => {
    if (!current) current = { title: "", bullets: [] };
    return current;
  };

  // One bullet per LINE. A markdown paragraph keeps its soft line breaks in a
  // single token, and the `---`-delimited convention writes a slide as several
  // consecutive lines, so a multi-line paragraph is several bullets rather than
  // one bullet containing newlines.
  const addBullet = (text: string) => {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed !== "") ensure().bullets.push(trimmed);
    }
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        const title = runsToPlainText(block.runs).trim();
        // A sub-heading inside a slide that has no title yet becomes the title
        // rather than forcing an extra, emptier slide.
        if (current && current.title === "" && current.bullets.length === 0) {
          current.title = title;
          break;
        }
        flush();
        current = { title, bullets: [] };
        break;
      }
      case "rule":
        flush();
        break;
      case "listItem":
        addBullet(listItemBulletText(block));
        break;
      case "paragraph":
      case "quote":
        addBullet(runsToPlainText(block.runs));
        break;
      case "code":
        for (const line of block.text.split(/\r?\n/)) addBullet(line);
        break;
      case "table": {
        for (const row of block.rows) {
          addBullet(row.map((cell) => runsToPlainText(cell)).join(" — "));
        }
        break;
      }
    }
  }
  flush();

  return slides
    .slice(0, MAX_SLIDES)
    .map((slide) => ({
      title: slide.title,
      bullets: slide.bullets.slice(0, MAX_BULLETS_PER_SLIDE),
    }));
}
