import { TextProcessor } from '../text-processor';

const config = {
  enableOCR: false,
  convertToMarkdown: true,
  extractImages: false,
  generateEmbeddings: false,
};

type CsvMarkdownInput = {
  text: string;
  method: string;
  rawData: unknown;
};

const csvToMarkdown = (content: CsvMarkdownInput): string =>
  (new TextProcessor(config) as unknown as {
    csvToMarkdown: (input: CsvMarkdownInput) => string;
  }).csvToMarkdown(content);

describe('TextProcessor CSV markdown bounds', () => {
  it('validates only the 20 records that can be rendered', () => {
    const renderedRecords = Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
      name: `Record ${index}`,
    }));
    const unrenderedRecord = new Proxy({}, {
      ownKeys: () => {
        throw new Error('record outside the rendered window was inspected');
      },
    });

    const markdown = csvToMarkdown({
      text: 'CSV data',
      method: 'csv',
      rawData: [...renderedRecords, unrenderedRecord],
    });

    expect(markdown).toContain('**21 records**');
    expect(markdown).toContain('*... and 1 more records*');
  });

  it('fails safely when a rendered record has an unexpected shape', () => {
    const markdown = csvToMarkdown({
      text: 'CSV data',
      method: 'csv',
      rawData: [{ id: 1 }],
    });

    expect(markdown).toBe('# CSV Data\n\nUnable to render malformed CSV data.');
  });
});
