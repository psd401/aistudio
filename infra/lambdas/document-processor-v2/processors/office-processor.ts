import { 
  ProcessingParams, 
  ProcessingResult, 
  DocumentProcessor, 
  ProcessorConfig 
} from './factory';
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { parseString } from 'xml2js';
import { createLambdaLogger } from '../utils/lambda-logger';

/**
 * Securely removes HTML tags to prevent injection attacks
 * This function handles malformed HTML and prevents bypassing attempts
 */
function sanitizeHTML(html: string): string {
  // First, iteratively remove HTML tags until none remain
  // This prevents bypassing through nested or malformed tags
  let sanitized = html;
  let previousLength = 0;
  
  while (sanitized.length !== previousLength && /<[^>]*>/g.test(sanitized)) {
    previousLength = sanitized.length;
    sanitized = sanitized.replace(/<[^>]*>/g, ' ');
  }
  
  // AFTER tags are removed, safely decode HTML entities (prevents security bypass)
  sanitized = sanitized
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  
  // Clean up extra whitespace created by tag removal
  sanitized = sanitized
    .replace(/\s+/g, ' ')
    .trim();
    
  return sanitized;
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
    
    // Extract raw text
    const textResult = await mammoth.extractRawText({ buffer });
    
    // Also extract with HTML for better structure understanding
    const htmlResult = await mammoth.convertToHtml({ buffer });
    
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

  private async processXlsx(buffer: Buffer): Promise<any> {
    const logger = createLambdaLogger({ operation: 'OfficeProcessor.processXlsx' });
    logger.info('Processing XLSX document');
    
    const workbook = XLSX.read(buffer);
    let combinedText = '';
    const sheetData: any[] = [];
    
    workbook.SheetNames.forEach((sheetName: string, index: number) => {
      const sheet = workbook.Sheets[sheetName];
      
      // Convert to CSV for text extraction
      const csv = XLSX.utils.sheet_to_csv(sheet);
      
      // Convert to JSON for structured data
      const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      
      combinedText += `\n\n## Sheet: ${sheetName}\n${csv}`;
      
      sheetData.push({
        name: sheetName,
        index,
        csv,
        json,
        rowCount: json.length,
        columnCount: json.length > 0 ? Math.max(...json.map((row: any) => Array.isArray(row) ? row.length : 0)) : 0,
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
      let slideIndex = 1;
      let combinedText = '';
      
      // Process slides sequentially
      while (true) {
        const slideFile = zipData.file(`ppt/slides/slide${slideIndex}.xml`);
        if (!slideFile) break;
        
        const slideXml = await slideFile.async('text');
        const slideText = await this.extractTextFromSlideXml(slideXml, slideIndex);
        
        if (slideText && slideText.length > 0) {
          slides.push({
            id: slideIndex,
            text: slideText
          });
          combinedText += `\n\n## Slide ${slideIndex}\n\n${slideText.join('\n')}`;
        }
        
        slideIndex++;
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
        
        // Apply secure HTML sanitization to prevent injection attacks
        const sanitizedMarkdown = sanitizeHTML(markdown);
        return sanitizedMarkdown.trim();
      } catch (error) {
        const logger = createLambdaLogger({ operation: 'OfficeProcessor.convertDocxToMarkdown' });
        logger.warn('Failed to convert HTML to markdown, falling back to plain text', { error });
      }
    }
    
    // Fallback to plain text conversion
    return this.convertTextToMarkdown(content.text);
  }

  private convertXlsxToMarkdown(content: any): string {
    let markdown = '# Spreadsheet Data\n\n';
    
    if (content.sheets) {
      content.sheets.forEach((sheet: any) => {
        markdown += `## ${sheet.name}\n\n`;
        
        if (sheet.json && sheet.json.length > 0) {
          // Convert JSON to markdown table
          const rows = sheet.json as any[][];
          if (rows.length > 0) {
            // Header row
            const headers = rows[0];
            markdown += '| ' + headers.join(' | ') + ' |\n';
            markdown += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
            
            // Include all data rows for complete AI context
            const dataRows = rows.slice(1);
            dataRows.forEach((row: any[]) => {
              markdown += '| ' + row.join(' | ') + ' |\n';
            });
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
      
      // Try to break at sentence boundary
      if (endIndex < text.length) {
        const lastSentenceEnd = text.lastIndexOf('.', endIndex);
        if (lastSentenceEnd > startIndex) {
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
      
      startIndex = endIndex - overlap;
      if (startIndex >= endIndex) break;
    }
    
    const logger = createLambdaLogger({ operation: 'OfficeProcessor.chunkText' });
    logger.info('Text chunking completed', { 
      chunkCount: chunks.length, 
      documentType: this.documentType 
    });
    return chunks;
  }
}