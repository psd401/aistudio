import { PDFProcessor } from './pdf-processor';
import { OfficeProcessor } from './office-processor';
import { TextProcessor } from './text-processor';
import { FileTypeDetector } from '../utils/file-type-detector';
import { createLambdaLogger } from '../utils/lambda-logger';

export interface ProcessorConfig {
  enableOCR: boolean;
  convertToMarkdown: boolean;
  extractImages: boolean;
  generateEmbeddings: boolean;
}

export interface ProcessingParams {
  buffer: Buffer;
  fileName: string;
  fileType: string;
  jobId: string;
  options: {
    extractText: boolean;
    convertToMarkdown: boolean;
    extractImages: boolean;
    generateEmbeddings: boolean;
    ocrEnabled: boolean;
  };
  onProgress?: (stage: string, progress: number) => Promise<void>;
}

export interface ProcessingResult {
  text?: string;
  markdown?: string;
  chunks?: Array<{
    chunkIndex: number;
    content: string;
    embedding?: number[];
    metadata?: unknown;
  }>;
  images?: Array<{
    imageIndex: number;
    s3Key: string;
    caption?: string;
    metadata?: unknown;
  }>;
  metadata: {
    extractionMethod: string;
    processingTime: number;
    pageCount?: number;
    confidence?: number;
    [key: string]: unknown;
  };
}

export interface DocumentProcessor {
  process(params: ProcessingParams): Promise<ProcessingResult>;
}

export class DocumentProcessorFactory {
  /**
   * Create document processor using enhanced file type detection
   * @param fileType - MIME type from upload
   * @param config - Processing configuration
   * @param buffer - File buffer for magic number detection
   * @param fileName - Original filename for extension detection
   */
  static create(
    fileType: string,
    config: ProcessorConfig,
    buffer?: Buffer,
    fileName?: string
  ): DocumentProcessor {
    const logger = createLambdaLogger({ operation: 'DocumentProcessorFactory.create' });
    logger.info('Creating processor', { fileType, fileName });

    let detectedType: string;

    // Use advanced detection if buffer is provided
    if (buffer) {
      const detection = FileTypeDetector.detectFileType(buffer, fileName, fileType);
      detectedType = detection.detectedType;

      logger.info('Enhanced file type detection result', {
        detectedType: detection.detectedType,
        confidence: detection.confidence,
        method: detection.method,
        reason: detection.reason
      });

      // If detection failed, fall back to legacy method
      if (detectedType === 'unknown') {
        logger.warn('Enhanced detection failed, falling back to legacy method');
        detectedType = this.legacyDetection(fileType, fileName);
      }
    } else {
      // Fallback to legacy method without buffer
      logger.info('No buffer provided, using legacy detection');
      detectedType = this.legacyDetection(fileType, fileName);
    }

    // Create processor based on detected type
    switch (detectedType) {
      case 'pdf':
        logger.info('Selected PDF processor', { detectedType });
        return new PDFProcessor(config);

      case 'xlsx':
        logger.info('Selected XLSX processor', { detectedType });
        return new OfficeProcessor('xlsx', config);

      case 'docx':
        logger.info('Selected DOCX processor', { detectedType });
        return new OfficeProcessor('docx', config);

      case 'pptx':
        logger.info('Selected PPTX processor', { detectedType });
        return new OfficeProcessor('pptx', config);

      case 'txt':
      case 'csv':
      case 'md':
        logger.info(`Selected text processor`, { detectedType });
        return new TextProcessor(config);

      default:
        logger.error('No processor found for detected type', { detectedType, originalFileType: fileType });
        throw new Error(`Unsupported file type: ${fileType} (detected as: ${detectedType})`);
    }
  }

  /**
   * Legacy detection method for backward compatibility
   */
  private static legacyDetection(fileType: string, fileName?: string): string {
    const logger = createLambdaLogger({ operation: 'DocumentProcessorFactory.legacyDetection' });
    const normalizedType = fileType.toLowerCase();
    const normalizedFileName = fileName?.toLowerCase() || '';

    logger.debug('Legacy detection starting', { fileType, fileName });

    if (normalizedType.includes('pdf') || normalizedFileName.endsWith('.pdf')) {
      return 'pdf';
    }
    const extensionTypes = [
      ['xlsx', ['.xlsx', '.xls']],
      ['pptx', ['.pptx', '.ppt']],
      ['docx', ['.docx', '.doc']],
      ['txt', ['.txt']],
      ['csv', ['.csv']],
      ['md', ['.md', '.markdown']],
    ] as const;
    const extensionMatch = extensionTypes.find(([, extensions]) =>
      extensions.some((extension) => normalizedFileName.endsWith(extension))
    );
    if (extensionMatch) return extensionMatch[0];

    const mimeTypes = [
      ['xlsx', ['sheet', 'excel']],
      ['pptx', ['presentation', 'powerpoint']],
      ['docx', ['word', 'document']],
      ['txt', ['text', 'plain']],
      ['csv', ['csv']],
    ] as const;
    return (
      mimeTypes.find(([, terms]) =>
        terms.some((term) => normalizedType.includes(term))
      )?.[0] || 'unknown'
    );
  }
}
