/**
 * DOCX rendering from the markdown block IR (Issue #1898).
 *
 * Split out of `document-generation-service.ts` so the `docx` dependency is
 * loaded only when a DOCX is actually requested (the service lazy-imports this
 * module from its `docx` branch), and so the mapping from IR → Word elements is
 * testable without the S3/presigner mocks the service test needs.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import {
  parseMarkdownBlocks,
  type InlineRun,
  type MarkdownBlock,
  type TableCellRuns,
} from "@/lib/ai/markdown-blocks";

/** Numbering reference for ordered lists, declared on the Document. */
const ORDERED_LIST_REFERENCE = "psd-ordered-list";

/** Monospace face for inline code runs. */
const CODE_FONT = "Consolas";

const HEADING_BY_LEVEL = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/**
 * Map IR runs to Word runs.
 *
 * `force` ADDS styling (a header cell is bold, a quote is italic) rather than
 * replacing it, so a header written `**Name** (*required*)` or a quote with a
 * bold word or a code span keeps what the markdown asked for.
 */
function toTextRuns(
  runs: InlineRun[],
  force: { bold?: boolean; italics?: boolean } = {}
): TextRun[] {
  // Word needs at least one run in a paragraph's children.
  if (runs.length === 0) return [new TextRun({ text: "", ...force })];
  return runs.map(
    (run) =>
      new TextRun({
        text: run.text,
        ...(run.bold || force.bold ? { bold: true } : {}),
        ...(run.italic || force.italics ? { italics: true } : {}),
        ...(run.code ? { font: CODE_FONT } : {}),
      })
  );
}

/** Word's checked/unchecked ballot glyphs for a GFM task-list item. */
const CHECKBOX_GLYPH = { checked: "\u2612 ", unchecked: "\u2610 " } as const;

/** Ordered-list numbering definition: 1. / a. / i. by depth, matching Word. */
const ORDERED_LIST_LEVELS = [
  { format: LevelFormat.DECIMAL, text: "%1." },
  { format: LevelFormat.LOWER_LETTER, text: "%2." },
  { format: LevelFormat.LOWER_ROMAN, text: "%3." },
  { format: LevelFormat.DECIMAL, text: "%4." },
  { format: LevelFormat.LOWER_LETTER, text: "%5." },
] as const;

export function buildDocxDocument(
  title: string | undefined,
  markdown: string
): Document {
  const children = buildDocxChildren(title, markdown);
  return new Document({
    numbering: {
      config: [
        {
          reference: ORDERED_LIST_REFERENCE,
          levels: ORDERED_LIST_LEVELS.map((level, index) => ({
            level: index,
            format: level.format,
            text: level.text,
            alignment: AlignmentType.START,
            style: {
              paragraph: { indent: { left: 720 * (index + 1), hanging: 360 } },
            },
          })),
        },
      ],
    },
    sections: [{ children }],
  });
}

/** Render the IR to a Word body. Exported for unit tests. */
export function buildDocxChildren(
  title: string | undefined,
  markdown: string
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  if (title && title.trim() !== "") {
    children.push(
      new Paragraph({ text: title.trim(), heading: HeadingLevel.TITLE })
    );
  }
  for (const block of parseMarkdownBlocks(markdown)) {
    pushBlock(block, children);
  }
  // Word rejects a section with no body content.
  if (children.length === 0) children.push(new Paragraph({ text: "" }));
  return children;
}

function pushBlock(block: MarkdownBlock, out: (Paragraph | Table)[]): void {
  switch (block.kind) {
    case "heading":
      out.push(
        new Paragraph({
          heading: HEADING_BY_LEVEL[block.level - 1],
          children: toTextRuns(block.runs),
        })
      );
      break;
    case "paragraph":
      out.push(new Paragraph({ children: toTextRuns(block.runs) }));
      break;
    case "quote":
      out.push(
        new Paragraph({
          indent: { left: 720 },
          children: toTextRuns(block.runs, { italics: true }),
        })
      );
      break;
    case "listItem": {
      // A task item's `[x]` never survives markdown parsing, so without an
      // explicit glyph a done item and a not-done item render identically.
      const marker =
        block.checked === undefined
          ? []
          : [
              new TextRun({
                text: block.checked
                  ? CHECKBOX_GLYPH.checked
                  : CHECKBOX_GLYPH.unchecked,
              }),
            ];
      out.push(
        new Paragraph({
          children: [...marker, ...toTextRuns(block.runs)],
          ...(block.ordered
            ? {
                numbering: {
                  reference: ORDERED_LIST_REFERENCE,
                  level: Math.min(block.level, ORDERED_LIST_LEVELS.length - 1),
                  // One concrete numbering instance PER markdown list. Sharing
                  // the reference without an instance makes Word run a single
                  // counter across the whole document, so a second ordered list
                  // continues "3. 4." instead of restarting at "1.".
                  instance: block.listId,
                },
              }
            : { bullet: { level: block.level } }),
        })
      );
      break;
    }
    case "code":
      for (const line of block.text.split(/\r?\n/)) {
        out.push(
          new Paragraph({
            children: [new TextRun({ text: line, font: CODE_FONT })],
          })
        );
      }
      break;
    case "table":
      out.push(buildTable(block.header, block.rows));
      break;
    case "rule":
      out.push(
        new Paragraph({
          text: "",
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1 } },
        })
      );
      break;
  }
}

function buildTable(
  header: TableCellRuns[],
  rows: TableCellRuns[][]
): Table {
  const columnCount = Math.max(
    header.length,
    ...rows.map((row) => row.length),
    1
  );
  const tableRows: TableRow[] = [];
  if (header.length > 0) {
    tableRows.push(buildRow(header, columnCount, true));
  }
  for (const row of rows) {
    tableRows.push(buildRow(row, columnCount, false));
  }
  // A table with no rows is invalid OOXML.
  if (tableRows.length === 0) {
    tableRows.push(buildRow([], columnCount, false));
  }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: tableRows,
  });
}

function buildRow(
  cells: TableCellRuns[],
  columnCount: number,
  isHeader: boolean
): TableRow {
  const padded: TableCellRuns[] = [];
  for (let i = 0; i < columnCount; i++) padded.push(cells[i] ?? []);
  return new TableRow({
    ...(isHeader ? { tableHeader: true } : {}),
    children: padded.map(
      (cell) =>
        new TableCell({
          children: [
            new Paragraph({
              children: toTextRuns(cell, isHeader ? { bold: true } : {}),
            }),
          ],
        })
    ),
  });
}

/** Serialize a built document to a Buffer. */
export async function packDocx(doc: Document): Promise<Buffer> {
  return Packer.toBuffer(doc);
}
