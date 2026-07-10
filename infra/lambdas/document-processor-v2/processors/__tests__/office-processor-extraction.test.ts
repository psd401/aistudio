/**
 * Unit tests for OfficeProcessor PPTX slide enumeration (REV-COR-413) and DOCX→Markdown
 * newline preservation (REV-COR-408).
 */

import JSZip from 'jszip';
import { OfficeProcessor } from '../office-processor';

const config = { enableOCR: false, convertToMarkdown: true, extractImages: false, generateEmbeddings: false };

function slideXml(text: string): string {
  return `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

async function pptxBuffer(slideNumbers: number[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const n of slideNumbers) {
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(`Slide ${n} content`));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

const processPptx = (proc: OfficeProcessor, buf: Buffer): Promise<{ text: string; slides: Array<{ id: number }> }> =>
  (proc as unknown as { processPptx: (b: Buffer) => Promise<{ text: string; slides: Array<{ id: number }> }> }).processPptx(buf);

describe('processPptx slide enumeration (REV-COR-413)', () => {
  const proc = new OfficeProcessor('pptx', config);

  it('extracts all slides even when the numbering has a gap (1, 2, 4)', async () => {
    const buf = await pptxBuffer([1, 2, 4]); // slide3 deleted → gap
    const result = await processPptx(proc, buf);

    expect(result.text).toContain('Slide 1 content');
    expect(result.text).toContain('Slide 2 content');
    expect(result.text).toContain('Slide 4 content'); // would have been dropped by the old loop
    expect(result.slides.map((s) => s.id)).toEqual([1, 2, 4]);
  });

  it('extracts contiguous slides in order (regression)', async () => {
    const buf = await pptxBuffer([1, 2, 3]);
    const result = await processPptx(proc, buf);
    expect(result.slides.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it('handles out-of-order archive entries by sorting numerically', async () => {
    const buf = await pptxBuffer([4, 1, 2]); // inserted out of order
    const result = await processPptx(proc, buf);
    expect(result.slides.map((s) => s.id)).toEqual([1, 2, 4]);
  });
});

describe('convertPptxToMarkdown slide heading numbering (REV-INFRA-098)', () => {
  const proc = new OfficeProcessor('pptx', config);
  const convertMarkdown = (content: unknown): Promise<string> =>
    (proc as unknown as { convertToMarkdown: (c: unknown, t: string) => Promise<string> })
      .convertToMarkdown(content, 'pptx');

  it('labels headings with the real slide id, not its array position, when numbering has a gap', async () => {
    const buf = await pptxBuffer([1, 2, 4]); // slide3 deleted → gap
    const extracted = await processPptx(proc, buf);
    const markdown = await convertMarkdown(extracted);

    expect(markdown).toContain('## Slide 1');
    expect(markdown).toContain('## Slide 2');
    expect(markdown).toContain('## Slide 4'); // would have been "## Slide 3" with index + 1
    expect(markdown).not.toContain('## Slide 3');
  });
});

describe('convertDocxToMarkdown newline preservation (REV-COR-408)', () => {
  const proc = new OfficeProcessor('docx', config);
  const convert = (content: unknown): string =>
    (proc as unknown as { convertDocxToMarkdown: (c: unknown) => string }).convertDocxToMarkdown(content);

  it('keeps heading and body on separate lines', () => {
    const md = convert({ html: '<h2>Heading</h2><p>Body paragraph</p>' });
    expect(md).toContain('\n');
    // Heading marker at the start of a line.
    expect(md.split('\n')[0]).toBe('## Heading');
    expect(md).toContain('Body paragraph');
    // Not flattened to a single line.
    expect(md).not.toBe('## Heading Body paragraph');
  });

  it('still neutralizes injected script markup in the output', () => {
    const md = convert({ html: '<h2>Title</h2><p>ok</p><script>alert(1)</script>' });
    expect(md).not.toContain('<script>');
    expect(md).toContain('## Title');
  });
});
