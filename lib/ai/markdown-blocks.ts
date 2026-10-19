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
  /** `level` is 0-based nesting depth. */
  | { kind: "listItem"; ordered: boolean; level: number; runs: InlineRun[] }
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

function pushListItems(
  item: Tokens.ListItem,
  ordered: boolean,
  level: number,
  out: MarkdownBlock[]
): void {
  // An item's own text and its nested lists arrive as siblings in `tokens`.
  const ownInline: Token[] = [];
  const nestedLists: Tokens.List[] = [];
  const nestedBlocks: Token[] = [];
  for (const child of item.tokens ?? []) {
    if (child.type === "list") {
      nestedLists.push(child as Tokens.List);
    } else if (child.type === "text" || child.type === "paragraph") {
      ownInline.push(child);
    } else {
      nestedBlocks.push(child);
    }
  }

  const runs = trimRuns(collectInlineRuns(ownInline));
  // An item whose only content is a nested list still needs a marker emitted,
  // otherwise the nesting level the children sit under has no visible parent.
  if (runs.length > 0 || nestedLists.length === 0) {
    out.push({ kind: "listItem", ordered, level, runs });
  }

  for (const nested of nestedLists) {
    pushList(nested, Math.min(level + 1, MAX_LIST_LEVEL), out);
  }
  for (const block of nestedBlocks) {
    pushBlock(block, out);
  }
}

function pushList(list: Tokens.List, level: number, out: MarkdownBlock[]): void {
  const ordered = list.ordered === true;
  for (const item of list.items ?? []) {
    pushListItems(item, ordered, level, out);
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
function pushStructuralBlock(token: Token, out: MarkdownBlock[]): boolean {
  switch (token.type) {
    case "list":
      pushList(token as Tokens.List, 0, out);
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

function pushBlock(token: Token, out: MarkdownBlock[]): void {
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
  if (pushStructuralBlock(token, out)) return;
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
  for (const token of tokens) {
    pushBlock(token, blocks);
  }
  return blocks;
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
 * Turn markdown into slides.
 *
 * ONE rule covers both conventions the tool documents, because in markdown they
 * are the same token: a heading starts a new slide, and so does a thematic break
 * (`---`), which is the delimiter `documents.create` has always advertised. A
 * slide that has no heading promotes its first paragraph to the title, so a deck
 * written as plain `---`-separated chunks keeps the old behaviour.
 */
export function markdownToSlides(markdown: string): SlideSpec[] {
  const blocks = parseMarkdownBlocks(markdown);
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

  const addBullet = (text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    ensure().bullets.push(trimmed);
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
      case "paragraph":
      case "quote":
      case "listItem":
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
