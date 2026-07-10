/**
 * Unit tests for OfficeProcessor.processDocx single-parse behavior (REV-PERF-032):
 * mammoth.convertToHtml must only run when markdown conversion is requested.
 */

jest.mock('mammoth', () => ({
  extractRawText: jest.fn(),
  convertToHtml: jest.fn(),
}));

import * as mammoth from 'mammoth';
import { OfficeProcessor } from '../office-processor';

const mockExtract = mammoth.extractRawText as unknown as jest.Mock;
const mockHtml = mammoth.convertToHtml as unknown as jest.Mock;

const processDocx = (proc: OfficeProcessor, buf: Buffer): Promise<{ text: string; html?: string }> =>
  (proc as unknown as { processDocx: (b: Buffer) => Promise<{ text: string; html?: string }> }).processDocx(buf);

describe('processDocx (REV-PERF-032)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExtract.mockResolvedValue({ value: 'the extracted text', messages: [] });
    mockHtml.mockResolvedValue({ value: '<p>the html</p>' });
  });

  it('does NOT call convertToHtml on the text-only path', async () => {
    const proc = new OfficeProcessor('docx', {
      enableOCR: false, convertToMarkdown: false, extractImages: false, generateEmbeddings: false,
    });

    const result = await processDocx(proc, Buffer.from('x'));

    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(mockHtml).not.toHaveBeenCalled();
    expect(result.text).toBe('the extracted text');
    expect(result.html).toBeUndefined();
  });

  it('calls both parses when markdown IS requested', async () => {
    const proc = new OfficeProcessor('docx', {
      enableOCR: false, convertToMarkdown: true, extractImages: false, generateEmbeddings: false,
    });

    const result = await processDocx(proc, Buffer.from('x'));

    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(mockHtml).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('the extracted text');
    expect(result.html).toBe('<p>the html</p>');
  });
});
