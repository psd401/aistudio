/**
 * Unit tests for XLSX row-truncation surfacing (REV-INFRA-099).
 *
 * processXlsx caps parsing at MAX_XLSX_ROWS_PARSE (10,000) rows per sheet via the
 * `sheetRows` option. A sheet that hits the cap must be flagged as truncated rather
 * than reporting a partial row/text subset as if it were the complete sheet.
 */

import * as XLSX from '@e965/xlsx';
import { OfficeProcessor } from '../office-processor';

const config = { enableOCR: false, convertToMarkdown: true, extractImages: false, generateEmbeddings: false };

function xlsxBuffer(rowCount: number): Buffer {
  const rows = Array.from({ length: rowCount }, (_, i) => [`row${i}`]);
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

type XlsxResult = {
  text: string;
  sheets: Array<{ rowCount: number; truncated: boolean }>;
  metadata: { anySheetTruncated: boolean };
};

const processXlsx = (proc: OfficeProcessor, buf: Buffer): Promise<XlsxResult> =>
  (proc as unknown as { processXlsx: (b: Buffer) => Promise<XlsxResult> }).processXlsx(buf);

const convertMarkdown = (proc: OfficeProcessor, content: unknown): Promise<string> =>
  (proc as unknown as { convertToMarkdown: (c: unknown, t: string) => Promise<string> })
    .convertToMarkdown(content, 'xlsx');

describe('processXlsx row-cap truncation (REV-INFRA-099)', () => {
  const proc = new OfficeProcessor('xlsx', config);

  it('flags a sheet as truncated when it hits the parse-time row cap', async () => {
    const buf = xlsxBuffer(10005);
    const result = await processXlsx(proc, buf);

    expect(result.sheets[0].truncated).toBe(true);
    expect(result.metadata.anySheetTruncated).toBe(true);
    expect(result.text).toContain('parsing stopped');
  });

  it('does not flag a small sheet as truncated', async () => {
    const buf = xlsxBuffer(50);
    const result = await processXlsx(proc, buf);

    expect(result.sheets[0].truncated).toBe(false);
    expect(result.metadata.anySheetTruncated).toBe(false);
    expect(result.text).not.toContain('parsing stopped');
  });

  it('surfaces the truncation warning in the generated markdown', async () => {
    const buf = xlsxBuffer(10005);
    const extracted = await processXlsx(proc, buf);
    const markdown = await convertMarkdown(proc, extracted);

    expect(markdown).toContain('true count unknown');
  });
});
