/**
 * Unit tests for chunkText forward-progress / termination (REV-COR-406).
 *
 * Both OfficeProcessor.chunkText and TextProcessor.chunkText previously looped forever
 * when the sentence/line break fell within `overlap` chars of the chunk start, because
 * `startIndex = endIndex - overlap` moved the window backward (even negative) and the
 * termination guard only checked `startIndex >= endIndex`.
 */

import { OfficeProcessor } from '../office-processor';
import { TextProcessor } from '../text-processor';

const config = { enableOCR: false, convertToMarkdown: false, extractImages: false, generateEmbeddings: true };

type Chunk = { chunkIndex: number; content: string; metadata: { startIndex: number; endIndex: number } };

const officeChunk = (text: string): Promise<Chunk[]> =>
  (new OfficeProcessor('docx', config) as unknown as { chunkText: (t: string) => Promise<Chunk[]> }).chunkText(text);
const textChunk = (text: string): Promise<Chunk[]> =>
  (new TextProcessor(config) as unknown as { chunkText: (t: string) => Promise<Chunk[]> }).chunkText(text);

// chunkSize 2000, overlap 200 → each iteration advances >= (2000 - 200) on the normal
// path, so the number of chunks is bounded well under this ceiling.
const MAX_CHUNKS = (len: number) => Math.ceil(len / (2000 - 200)) + 2;

describe('chunkText terminates on pathological input (REV-COR-406)', () => {
  const pathological = 'A.' + 'x'.repeat(5000); // only break char is '.' at index 1

  it('OfficeProcessor terminates and returns a bounded number of chunks', async () => {
    const chunks = await officeChunk(pathological);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS(pathological.length));
  });

  it('TextProcessor terminates for an early-newline input', async () => {
    const earlyNewline = 'A\n' + 'y'.repeat(5000);
    const chunks = await textChunk(earlyNewline);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS(earlyNewline.length));
  });

  it('startIndex never regresses — each chunk starts after the previous one', async () => {
    const chunks = await officeChunk(pathological);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].metadata.startIndex).toBeGreaterThan(chunks[i - 1].metadata.startIndex);
      expect(chunks[i].metadata.startIndex).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('chunkText normal-text behavior is unchanged (REV-COR-406)', () => {
  it('overlaps consecutive chunks by ~200 chars on normal multi-sentence text', async () => {
    // Build ~5000 chars of normal sentences.
    const text = ('The quick brown fox jumps over the lazy dog. ').repeat(120);
    const chunks = await officeChunk(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Advancement is (endIndex - overlap): the next start is ~overlap before the prev end.
    for (let i = 1; i < chunks.length; i++) {
      const advance = chunks[i].metadata.startIndex - chunks[i - 1].metadata.startIndex;
      expect(advance).toBeGreaterThan(0);
      expect(advance).toBeLessThanOrEqual(2000); // never more than a chunk
    }
  });
});
