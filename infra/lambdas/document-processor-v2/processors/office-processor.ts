import { 
  ProcessingParams, 
  ProcessingResult, 
  DocumentProcessor, 
  ProcessorConfig 
} from './factory';
import * as mammoth from 'mammoth';
import * as XLSX from '@e965/xlsx';
import JSZip from 'jszip';
import { parseString } from 'xml2js';
import { createLambdaLogger } from '../utils/lambda-logger';
import { sanitizeHtml } from '../utils/html-sanitizer';

interface XlsxSheetData {
  name: unknown;
  json: unknown[][];
  rowCount: number;
  columnCount: number;
}

interface XlsxContent {
  sheets?: XlsxSheetData[];
}

export class OfficeProcessor implements DocumentProcessor {
  constructor(
    private documentType: 'docx' | 'xlsx' | 'pptx',
    private config: ProcessorConfig
  ) {}

  async process(params: ProcessingParams): Promise<ProcessingResult> {
    const startTime = Date.now();
    const { buffer, fileName, onProgress } = params;
    const logger = createLambdaLogger({ 
      operation: 'OfficeProcessor.process',
      documentType: this.documentType,
      fileName,
      fileSize: buffer.length
    });
    
    logger.info('Starting office document processing', { 
      documentType: this.documentType.toUpperCase(), 
      fileName, 
      bufferSize: buffer.length 
    });
    
    await onProgress?.('parsing_document', 40);
    
    let extractedContent: any;
    
    try {
      switch (this.documentType) {
        case 'docx':
          extractedContent = await this.processDocx(buffer);
          break;
        case 'xlsx':
          extractedContent = await this.processXlsx(buffer);
          break;
        case 'pptx':
          extractedContent = await this.processPptx(buffer);
          break;
        default:
          throw new Error(`Unsupported document type: ${this.documentType}`);
      }
    } catch (error) {
      logger.error(`Error processing ${this.documentType}`, error);
      throw new Error(`Failed to process ${this.documentType}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    if (!extractedContent.text) {
      throw new Error(`No text content extracted from ${this.documentType}`);
    }
    
    await onProgress?.('post_processing', 70);
    
    // Build result
    const result: ProcessingResult = {
      text: extractedContent.text,
      metadata: {
        extractionMethod: `office-processor-${this.documentType}`,
        processingTime: Date.now() - startTime,
        originalSize: buffer.length,
        ...extractedContent.metadata,
      }
    };
    
    // Convert to Markdown if requested
    if (this.config.convertToMarkdown) {
      await onProgress?.('converting_markdown', 80);
      result.markdown = await this.convertToMarkdown(extractedContent, this.documentType);
    }
    
    // Generate chunks if requested
    if (this.config.generateEmbeddings) {
      await onProgress?.('chunking_text', 90);
      result.chunks = await this.chunkText(extractedContent.text);
    }
    
    result.metadata.processingTime = Date.now() - startTime;
    
    logger.info(`${this.documentType.toUpperCase()} processing completed successfully`, {
      processingTime: result.metadata.processingTime,
      textLength: result.text?.length || 0,
      hasMarkdown: !!result.markdown,
      chunkCount: result.chunks?.length || 0
    });
    return result;
  }

  private async processDocx(buffer: Buffer): Promise<any> {
    const logger = createLambdaLogger({ operation: 'OfficeProcessor.processDocx' });
    logger.info('Processing DOCX document');

    // mammoth.convertToHtml re-unzips and fully re-parses the DOCX; its output is only
    // consumed by convertDocxToMarkdown. Skip it entirely on the common text-only path,
    // and when markdown IS requested run both parses concurrently (REV-PERF-032).
    if (this.config.convertToMarkdown) {
      const [textResult, htmlResult] = await Promise.all([
        mammoth.extractRawText({ buffer }),
        mammoth.convertToHtml({ buffer }),
      ]);
      return {
        text: textResult.value,
        html: htmlResult.value,
        metadata: {
          messages: textResult.messages,
          wordCount: textResult.value.split(/\s+/).length,
          characterCount: textResult.value.length,
        }
      };
    }

    const textResult = await mammoth.extractRawText({ buffer });
    return {
      text: textResult.value,
      html: undefined,
      metadata: {
        messages: textResult.messages,
        wordCount: textResult.value.split(/\s+/).length,
        characterCount: textResult.value.length,
      }
    };
  }

  private static readonly MAX_XLSX_BYTES = 25 * 1024 * 1024; // 25 MB
  private static readonly MAX_XLSX_ROWS_PARSE = 10000; // hard cap at parse time

  private async processXlsx(buffer: Buffer): Promise<any> {
    const logger = createLambdaLogger({ operation: 'OfficeProcessor.processXlsx' });
    logger.info('Processing XLSX document');

    if (buffer.length > OfficeProcessor.MAX_XLSX_BYTES) {
      throw new Error(`XLSX file exceeds maximum allowed size of ${OfficeProcessor.MAX_XLSX_BYTES} bytes`);
    }

    const workbook = XLSX.read(buffer, {
      cellFormula: false,
      sheetRows: OfficeProcessor.MAX_XLSX_ROWS_PARSE,
    });
    let combinedText = '';
    const sheetData: any[] = [];

    workbook.SheetNames.forEach((sheetName: string, index: number) => {
      const sheet = workbook.Sheets[sheetName];

      // Convert to CSV for text extraction
      const csv = XLSX.utils.sheet_to_csv(sheet);

      // Convert to JSON for structured data — { header: 1 } returns array-of-arrays,
      // avoiding prototype pollution through column-named __proto__ keys
      const json = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

      const safeSheetName = OfficeProcessor.sanitizeSheetName(sheetName);
      combinedText += `\n\n## Sheet: ${safeSheetName}\n${csv}`;

      sheetData.push({
        name: sheetName,
        index,
        csv,
        json,
        rowCount: json.length,
        // Cap spread to avoid stack overflow on sheets with thousands of columns
        columnCount: json.length > 0
          ? Math.min(10000, Math.max(0, ...json.map((row) => Array.isArray(row) ? row.length : 0)))
          : 0,
      });
    });
    
    return {
      text: combinedText.trim(),
      sheets: sheetData,
      metadata: {
        sheetCount: workbook.SheetNames.length,
        sheetNames: workbook.SheetNames,
        totalRows: sheetData.reduce((sum, sheet) => sum + sheet.rowCount, 0),
      }
    };
  }

  private async processPptx(buffer: Buffer): Promise<any> {
    const logger = createLambdaLogger({ operation: 'OfficeProcessor.processPptx' });
    logger.info('Processing PPTX document using custom JSZip parser');
    
    try {
      // Load PPTX as ZIP archive
      const zip = new JSZip();
      const zipData = await zip.loadAsync(buffer);
      
      // Extract text from all slides
      const slides: any[] = [];
      let combinedText = '';

      // Enumerate the slide entries actually present in the archive, sorted by their
      // numeric index (REV-COR-413). PPTX does not guarantee contiguous slide file
      // numbering — deleting a slide can leave a gap (slide1, slide2, slide4) — so
      // the old `while(true)` that broke at the first missing index silently dropped
      // every slide after a gap.
      const slideNames = Object.keys(zipData.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) =>
          Number(a.match(/slide(\d+)\.xml$/)![1]) - Number(b.match(/slide(\d+)\.xml$/)![1])
        );

      for (const name of slideNames) {
        const slideFile = zipData.file(name);
        if (!slideFile) continue;

        const slideNumber = Number(name.match(/slide(\d+)\.xml$/)![1]);
        const slideXml = await slideFile.async('text');
        const slideText = await this.extractTextFromSlideXml(slideXml, slideNumber);

        if (slideText && slideText.length > 0) {
          slides.push({
            id: slideNumber,
            text: slideText
          });
          combinedText += `\n\n## Slide ${slideNumber}\n\n${slideText.join('\n')}`;
        }
      }
      
      if (slides.length === 0) {
        throw new Error('No slides found in PPTX - file might be corrupted or empty');
      }
      
      const cleanedText = combinedText.trim();
      
      if (!cleanedText) {
        throw new Error('No readable text found in PPTX slides');
      }
      
      return {
        text: cleanedText,
        slides: slides, // Keep structured slide data
        metadata: {
          extractionMethod: 'custom-jszip-pptx',
          characterCount: cleanedText.length,
          slideCount: slides.length,
          slidesWithContent: slides.length
        }
      };
    } catch (error) {
      logger.error('PPTX processing failed', error);
      throw new Error(`Failed to process PPTX: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Extract text from a single slide's XML content
   */
  private async extractTextFromSlideXml(slideXml: string, slideNumber: number): Promise<string[]> {
    return new Promise((resolve) => {
      parseString(slideXml, { explicitArray: false, ignoreAttrs: true }, (err: any, result: any) => {
        const logger = createLambdaLogger({ operation: 'OfficeProcessor.extractTextFromSlideXml' });
        if (err) {
          logger.warn(`Error parsing slide ${slideNumber} XML`, { error: err });
          resolve([]);
          return;
        }

        const textBlocks: string[] = [];
        
        try {
          // Navigate through the PPTX XML structure to find text elements
          // Structure: p:sld -> p:cSld -> p:spTree -> p:sp -> p:txBody -> a:p -> a:r -> a:t
          const slide = result['p:sld'];
          if (slide && slide['p:cSld'] && slide['p:cSld']['p:spTree']) {
            const shapes = slide['p:cSld']['p:spTree']['p:sp'];
            const shapesArray = Array.isArray(shapes) ? shapes : [shapes];
            
            for (const shape of shapesArray) {
              if (shape && shape['p:txBody'] && shape['p:txBody']['a:p']) {
                const paragraphs = Array.isArray(shape['p:txBody']['a:p']) ? 
                  shape['p:txBody']['a:p'] : [shape['p:txBody']['a:p']];
                
                for (const paragraph of paragraphs) {
                  if (paragraph && paragraph['a:r']) {
                    const runs = Array.isArray(paragraph['a:r']) ? 
                      paragraph['a:r'] : [paragraph['a:r']];
                    
                    let paragraphText = '';
                    for (const run of runs) {
                      if (run && run['a:t']) {
                        paragraphText += run['a:t'];
                      }
                    }
                    
                    if (paragraphText.trim()) {
                      textBlocks.push(paragraphText.trim());
                    }
                  }
                  
                  // Handle direct text in paragraphs (without runs)
                  if (paragraph && paragraph['a:t']) {
                    const directText = paragraph['a:t'];
                    if (directText && directText.trim()) {
                      textBlocks.push(directText.trim());
                    }
                  }
                }
              }
            }
          }
        } catch (parseError) {
          const logger = createLambdaLogger({ operation: 'OfficeProcessor.extractTextFromSlideXml' });
          logger.warn(`Error extracting text from slide ${slideNumber}`, { error: parseError });
        }
        
        resolve(textBlocks);
      });
    });
  }

  private async convertToMarkdown(extractedContent: any, docType: string): Promise<string> {
    const text = extractedContent.text;
    if (!text) return '';
    
    switch (docType) {
      case 'docx':
        return this.convertDocxToMarkdown(extractedContent);
      case 'xlsx':
        return this.convertXlsxToMarkdown(extractedContent);
      case 'pptx':
        return this.convertPptxToMarkdown(extractedContent);
      default:
        return this.convertTextToMarkdown(text);
    }
  }

  private convertDocxToMarkdown(content: any): string {
    // Use HTML content if available for better structure
    if (content.html) {
      try {
        // Simple HTML to Markdown conversion
        const markdown = content.html
          .replace(/<h([1-6])[^>]*>/g, (match: string, level: string) => '#'.repeat(parseInt(level)) + ' ')
          .replace(/<\/h[1-6]>/g, '\n\n')
          .replace(/<p[^>]*>/g, '')
          .replace(/<\/p>/g, '\n\n')
          .replace(/<strong[^>]*>/g, '**')
          .replace(/<\/strong>/g, '**')
          .replace(/<em[^>]*>/g, '*')
          .replace(/<\/em>/g, '*')
          .replace(/<br[^>]*>/g, '\n')
          .replace(/\n{3,}/g, '\n\n'); // Clean up excessive newlines

        // Apply secure HTML sanitization to prevent injection attacks. Preserve
        // newlines (REV-COR-408) so the paragraph/heading structure just built above
        // survives — the default sanitizer collapses every \n into a space, which
        // flattened DOCX markdown to a single line.
        const sanitizedMarkdown = sanitizeHtml(markdown, { preserveNewlines: true });
        return sanitizedMarkdown.trim();
      } catch (error) {
        const logger = createLambdaLogger({ operation: 'OfficeProcessor.convertDocxToMarkdown' });
        logger.warn('Failed to convert HTML to markdown, falling back to plain text', { error });
      }
    }
    
    // Fallback to plain text conversion
    return this.convertTextToMarkdown(content.text);
  }

  // Cap rows per sheet so the Markdown payload stays within API route body limits.
  private static readonly MAX_ROWS_PER_SHEET = 500;

  private static escapeMdTableCell(value: unknown): string {
    return String(value ?? '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|');
  }

  // Sanitize a sheet name before interpolating into a Markdown heading.
  private static sanitizeSheetName(name: string): string {
    return name
      .replace(/\\/g, '\\\\')
      .replace(/[\r\n|#`]/g, ' ')
      .trim() || 'Sheet';
  }

  private convertXlsxToMarkdown(content: XlsxContent): string {
    let markdown = '# Spreadsheet Data\n\n';

    if (content.sheets) {
      content.sheets.forEach((sheet: XlsxSheetData) => {
        const safeSheetName = OfficeProcessor.sanitizeSheetName(String(sheet.name ?? ''));
        markdown += `## ${safeSheetName}\n\n`;

        if (sheet.json && sheet.json.length > 0) {
          const rows = sheet.json;
          if (rows.length > 0) {
            const headers = rows[0];
            markdown += '| ' + headers.map(OfficeProcessor.escapeMdTableCell).join(' | ') + ' |\n';
            markdown += '| ' + headers.map(() => '---').join(' | ') + ' |\n';

            const allDataRows = rows.slice(1);
            const truncated = allDataRows.length > OfficeProcessor.MAX_ROWS_PER_SHEET;
            const dataRows = truncated
              ? allDataRows.slice(0, OfficeProcessor.MAX_ROWS_PER_SHEET)
              : allDataRows;
            markdown += dataRows
              .map((row: unknown[]) => '| ' + row.map(OfficeProcessor.escapeMdTableCell).join(' | ') + ' |\n')
              .join('');

            if (truncated) {
              markdown += `\n> ⚠️ **Showing first ${OfficeProcessor.MAX_ROWS_PER_SHEET} of ${allDataRows.length} rows.** Upload a filtered version of this sheet to analyze the full dataset.\n`;
            }
          }
        }

        markdown += `\n**Sheet Stats:** ${sheet.rowCount} rows, ${sheet.columnCount} columns\n\n`;
      });
    }

    return markdown;
  }

  private convertPptxToMarkdown(content: any): string {
    let markdown = '# PowerPoint Presentation\n\n';
    
    // Use structured slide data from node-pptx-parser if available
    if (content.slides && Array.isArray(content.slides)) {
      content.slides.forEach((slide: any, index: number) => {
        if (slide.text && slide.text.length > 0) {
          markdown += `## Slide ${index + 1}\n\n`;
          
          // Join slide text with proper formatting
          const slideContent = slide.text.join('\n').trim();
          if (slideContent) {
            markdown += `${slideContent}\n\n`;
          }
        }
      });
    } else {
      // Fallback to text-based parsing if structured data not available
      const text = content.text;
      const sections = text.split(/## Slide \d+/).filter((section: string) => section.trim().length > 0);
      
      sections.forEach((section: string, index: number) => {
        const trimmedSection = section.trim();
        if (trimmedSection) {
          if (index === 0 && !text.includes('## Slide')) {
            markdown += `## Slide 1\n\n${trimmedSection}\n\n`;
          } else if (index > 0) {
            markdown += `## Slide ${index + 1}\n\n${trimmedSection}\n\n`;
          } else {
            markdown += `${trimmedSection}\n\n`;
          }
        }
      });
    }
    
    // Add metadata
    markdown += '\n---\n';
    if (content.metadata?.slideCount) {
      markdown += `**Total Slides:** ${content.metadata.slideCount}\n`;
    }
    if (content.metadata?.slidesWithContent) {
      markdown += `**Slides with Content:** ${content.metadata.slidesWithContent}\n`;
    }
    markdown += `**Extraction Method:** ${content.metadata?.extractionMethod || 'custom-jszip-pptx'}\n`;
    
    return markdown;
  }

  private convertTextToMarkdown(text: string): string {
    // Simple text to markdown conversion
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    
    let markdown = '';
    
    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();
      
      // Detect potential headers
      if (trimmed.length < 100 && !/[.!?]$/.test(trimmed) && /^[A-Z]/.test(trimmed)) {
        const words = trimmed.split(' ');
        if (words.length <= 10) {
          markdown += `## ${trimmed}\n\n`;
          continue;
        }
      }
      
      // Regular paragraph
      markdown += `${trimmed}\n\n`;
    }
    
    return markdown.trim();
  }

  private async chunkText(text: string): Promise<any[]> {
    const chunkSize = 2000;
    const overlap = 200;
    
    const chunks = [];
    let startIndex = 0;
    let chunkIndex = 0;
    
    while (startIndex < text.length) {
      let endIndex = Math.min(startIndex + chunkSize, text.length);
      
      // Try to break at a sentence boundary — but only when the break still leaves
      // a chunk larger than the overlap. Otherwise `endIndex - overlap` would move
      // the next window BACKWARD and the loop would never terminate (REV-COR-406).
      if (endIndex < text.length) {
        const lastSentenceEnd = text.lastIndexOf('.', endIndex);
        if (lastSentenceEnd > startIndex && (lastSentenceEnd + 1 - startIndex) > overlap) {
          endIndex = lastSentenceEnd + 1;
        }
      }

      const chunkContent = text.substring(startIndex, endIndex).trim();

      if (chunkContent.length > 0) {
        chunks.push({
          chunkIndex,
          content: chunkContent,
          metadata: {
            startIndex,
            endIndex,
            length: chunkContent.length,
            documentType: this.documentType,
          },
        });
        chunkIndex++;
      }

      // Once a chunk reaches the end of the text, everything is covered — stop
      // (REV-COR-406). Without this the loop would keep emitting tiny overlapping
      // tail windows because `endIndex - overlap` sits behind `startIndex` near the end.
      if (endIndex >= text.length) break;

      // Advance with guaranteed forward progress (REV-COR-406): never regress and
      // always move at least one character past the previous start.
      const nextStart = Math.max(startIndex + 1, endIndex - overlap);
      if (nextStart <= startIndex) break; // defensive; should be unreachable
      startIndex = nextStart;
    }
    
    const logger = createLambdaLogger({ operation: 'OfficeProcessor.chunkText' });
    logger.info('Text chunking completed', { 
      chunkCount: chunks.length, 
      documentType: this.documentType 
    });
    return chunks;
  }
}