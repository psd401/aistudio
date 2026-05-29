import { createLambdaLogger } from './lambda-logger';

export interface FileTypeDetectionResult {
  detectedType: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'txt' | 'csv' | 'md' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  method: 'magic-number' | 'extension' | 'mime-type' | 'fallback';
  reason: string;
}

/**
 * Detects file type using multiple methods in order of reliability:
 * 1. Magic number detection (file signatures)
 * 2. File extension analysis
 * 3. MIME type analysis
 * 4. Content inspection fallback
 */
export class FileTypeDetector {
  private static readonly MAGIC_NUMBERS = {
    // PDF signature
    pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
    
    // ZIP-based files (Office 2007+ formats are ZIP archives)
    // All modern Office files start with ZIP signature
    zip: [0x50, 0x4B, 0x03, 0x04], // PK..
    
    // Alternative ZIP signatures
    zipEmpty: [0x50, 0x4B, 0x05, 0x06], // PK.. (empty archive)
    zipSpanned: [0x50, 0x4B, 0x07, 0x08], // PK.. (spanned archive)
  };

  private static readonly OFFICE_CONTENT_TYPES = {
    docx: [
      'word/document.xml',
      'word/'
    ],
    xlsx: [
      'xl/workbook.xml',
      'xl/worksheets/'
    ],
    pptx: [
      'ppt/presentation.xml',
      'ppt/slides/'
    ]
  };

  private static readonly EXTENSION_MAP: Record<string, string> = {
    '.pdf': 'pdf',
    '.docx': 'docx',
    '.doc': 'docx', // Treat legacy DOC as DOCX for processing
    '.xlsx': 'xlsx',
    '.xls': 'xlsx', // Treat legacy XLS as XLSX for processing
    '.pptx': 'pptx',
    '.ppt': 'pptx', // Treat legacy PPT as PPTX for processing
    '.txt': 'txt',
    '.csv': 'csv',
    '.md': 'md',
    '.markdown': 'md',
    '.json': 'txt', // Treat JSON as text for processing
    '.xml': 'txt',  // Treat XML as text for processing
    '.yaml': 'txt', // Treat YAML as text for processing
    '.yml': 'txt'   // Treat YML as text for processing
  };

  private static readonly MIME_TYPE_MAP: Record<string, string> = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'docx',
    'application/vnd.ms-excel': 'xlsx',
    'application/vnd.ms-powerpoint': 'pptx',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'text/markdown': 'md',
    'application/json': 'txt',
    'application/xml': 'txt',
    'text/xml': 'txt',
    'application/x-yaml': 'txt',
    'text/yaml': 'txt',
    'text/x-yaml': 'txt'
  };

  /**
   * Main detection method that combines all detection strategies
   */
  static detectFileType(
    buffer: Buffer,
    fileName?: string,
    mimeType?: string
  ): FileTypeDetectionResult {
    const logger = createLambdaLogger({ operation: 'FileTypeDetector.detectFileType' });
    logger.info('Analyzing file type', { fileName, mimeType, bufferSize: buffer.length });

    // Strategy 1: Magic number detection (most reliable)
    const magicResult = this.detectByMagicNumber(buffer, fileName);
    if (magicResult.confidence === 'high') {
      logger.info('High confidence detection via magic numbers', { detectedType: magicResult.detectedType });
      return magicResult;
    }

    // Strategy 2: File extension (reliable for most cases)
    if (fileName) {
      const extensionResult = this.detectByExtension(fileName);
      if (extensionResult.detectedType !== 'unknown') {
        logger.info('Detected via file extension', { detectedType: extensionResult.detectedType });
        return extensionResult;
      }
    }

    // Strategy 3: MIME type (less reliable but useful)
    if (mimeType) {
      const mimeResult = this.detectByMimeType(mimeType);
      if (mimeResult.detectedType !== 'unknown') {
        logger.info('Detected via MIME type', { detectedType: mimeResult.detectedType });
        return mimeResult;
      }
    }

    // Strategy 4: Content inspection for Office files
    const contentResult = this.detectOfficeByContent(buffer);
    if (contentResult.detectedType !== 'unknown') {
      logger.info('Detected via content inspection', { detectedType: contentResult.detectedType });
      return contentResult;
    }

    // Fallback to unknown
    logger.warn('Unable to determine file type, returning unknown');
    return {
      detectedType: 'unknown',
      confidence: 'low',
      method: 'fallback',
      reason: 'Unable to determine file type using any detection method'
    };
  }

  /**
   * Detect file type by examining magic numbers/file signatures
   */
  private static detectByMagicNumber(buffer: Buffer, fileName?: string): FileTypeDetectionResult {
    if (buffer.length < 4) {
      return {
        detectedType: 'unknown',
        confidence: 'low',
        method: 'magic-number',
        reason: 'Buffer too small for magic number detection'
      };
    }

    // PDF spec (ISO 32000-1:2008 §7.5.2) allows the %PDF header anywhere
    // within the first 1024 bytes, so scan rather than checking byte 0 only.
    const scanLength = Math.min(buffer.length, 1024);
    const pdfSig = Buffer.from(this.MAGIC_NUMBERS.pdf);
    const pdfOffset = buffer.indexOf(pdfSig, 0);
    if (pdfOffset !== -1 && pdfOffset < scanLength) {
      return {
        detectedType: 'pdf',
        confidence: 'high',
        method: 'magic-number',
        reason: pdfOffset === 0
          ? 'PDF magic number detected (%PDF)'
          : `PDF magic number detected (%PDF) at byte offset ${pdfOffset}`
      };
    }

    const header = Array.from(buffer.slice(0, 4));

    // Check for ZIP signatures (Office files)
    const isZip = this.arraysEqual(header, this.MAGIC_NUMBERS.zip) ||
                  this.arraysEqual(header, this.MAGIC_NUMBERS.zipEmpty) ||
                  this.arraysEqual(header, this.MAGIC_NUMBERS.zipSpanned);

    if (isZip) {
      // For ZIP files, we need to inspect content to determine Office type
      const officeType = this.detectOfficeTypeFromZip(buffer, fileName);
      if (officeType !== 'unknown') {
        return {
          detectedType: officeType as any,
          confidence: 'high',
          method: 'magic-number',
          reason: `ZIP archive with ${officeType.toUpperCase()} content structure detected`
        };
      }

      return {
        detectedType: 'unknown',
        confidence: 'medium',
        method: 'magic-number',
        reason: 'ZIP archive detected but unable to determine Office document type'
      };
    }

    return {
      detectedType: 'unknown',
      confidence: 'low',
      method: 'magic-number',
      reason: 'No recognized magic number found'
    };
  }

  /**
   * Detect Office document type by inspecting ZIP archive structure
   */
  private static detectOfficeTypeFromZip(buffer: Buffer, fileName?: string): string {
    try {
      // Convert buffer to string to search for internal file paths
      const content = buffer.toString('binary', 0, Math.min(buffer.length, 8192)); // Check first 8KB

      // Check for DOCX patterns
      for (const pattern of this.OFFICE_CONTENT_TYPES.docx) {
        if (content.includes(pattern)) {
          return 'docx';
        }
      }

      // Check for XLSX patterns
      for (const pattern of this.OFFICE_CONTENT_TYPES.xlsx) {
        if (content.includes(pattern)) {
          return 'xlsx';
        }
      }

      // Check for PPTX patterns
      for (const pattern of this.OFFICE_CONTENT_TYPES.pptx) {
        if (content.includes(pattern)) {
          return 'pptx';
        }
      }

      // If we can't determine from content, use filename as hint
      if (fileName) {
        const ext = fileName.toLowerCase();
        if (ext.includes('.docx') || ext.includes('.doc')) return 'docx';
        if (ext.includes('.xlsx') || ext.includes('.xls')) return 'xlsx';
        if (ext.includes('.pptx') || ext.includes('.ppt')) return 'pptx';
      }

    } catch (error) {
      const logger = createLambdaLogger({ operation: 'FileTypeDetector.detectOfficeTypeFromZip' });
      logger.warn('Error inspecting ZIP content', { error });
    }

    return 'unknown';
  }

  /**
   * Detect file type by file extension
   */
  private static detectByExtension(fileName: string): FileTypeDetectionResult {
    const lowercaseFileName = fileName.toLowerCase();
    
    for (const [ext, type] of Object.entries(this.EXTENSION_MAP)) {
      if (lowercaseFileName.endsWith(ext)) {
        return {
          detectedType: type as any,
          confidence: 'medium',
          method: 'extension',
          reason: `File extension ${ext} indicates ${type.toUpperCase()} file`
        };
      }
    }

    return {
      detectedType: 'unknown',
      confidence: 'low',
      method: 'extension',
      reason: 'No recognized file extension found'
    };
  }

  /**
   * Detect file type by MIME type
   */
  private static detectByMimeType(mimeType: string): FileTypeDetectionResult {
    const normalizedMimeType = mimeType.toLowerCase().split(';')[0].trim();
    
    const detectedType = this.MIME_TYPE_MAP[normalizedMimeType];
    if (detectedType) {
      return {
        detectedType: detectedType as any,
        confidence: 'medium',
        method: 'mime-type',
        reason: `MIME type ${mimeType} indicates ${detectedType.toUpperCase()} file`
      };
    }

    // Check for partial matches
    if (normalizedMimeType.includes('pdf')) {
      return {
        detectedType: 'pdf',
        confidence: 'low',
        method: 'mime-type',
        reason: 'MIME type contains "pdf"'
      };
    }

    if (normalizedMimeType.includes('word') || normalizedMimeType.includes('document')) {
      return {
        detectedType: 'docx',
        confidence: 'low',
        method: 'mime-type',
        reason: 'MIME type suggests Word document'
      };
    }

    if (normalizedMimeType.includes('excel') || normalizedMimeType.includes('sheet')) {
      return {
        detectedType: 'xlsx',
        confidence: 'low',
        method: 'mime-type',
        reason: 'MIME type suggests Excel spreadsheet'
      };
    }

    if (normalizedMimeType.includes('powerpoint') || normalizedMimeType.includes('presentation')) {
      return {
        detectedType: 'pptx',
        confidence: 'low',
        method: 'mime-type',
        reason: 'MIME type suggests PowerPoint presentation'
      };
    }

    return {
      detectedType: 'unknown',
      confidence: 'low',
      method: 'mime-type',
      reason: 'Unrecognized MIME type'
    };
  }

  /**
   * Fallback method to detect Office files by content inspection
   */
  private static detectOfficeByContent(buffer: Buffer): FileTypeDetectionResult {
    try {
      // Check if it's a ZIP file first
      if (buffer.length >= 4) {
        const header = Array.from(buffer.slice(0, 4));
        const isZip = this.arraysEqual(header, this.MAGIC_NUMBERS.zip);
        
        if (isZip) {
          const officeType = this.detectOfficeTypeFromZip(buffer);
          if (officeType !== 'unknown') {
            return {
              detectedType: officeType as any,
              confidence: 'medium',
              method: 'fallback',
              reason: `Content inspection identified ${officeType.toUpperCase()} structure`
            };
          }
        }
      }

      // Check for text-based content
      const text = buffer.toString('utf-8', 0, Math.min(buffer.length, 1024));
      if (this.isPrintableText(text)) {
        // Try to determine if it's CSV or plain text
        if (text.includes(',') && text.includes('\n') && text.split('\n').length > 2) {
          return {
            detectedType: 'csv',
            confidence: 'low',
            method: 'fallback',
            reason: 'Content appears to be CSV based on comma delimiters'
          };
        }

        return {
          detectedType: 'txt',
          confidence: 'low',
          method: 'fallback',
          reason: 'Content appears to be plain text'
        };
      }

    } catch (error) {
      const logger = createLambdaLogger({ operation: 'FileTypeDetector.detectOfficeByContent' });
      logger.warn('Error in content inspection', { error });
    }

    return {
      detectedType: 'unknown',
      confidence: 'low',
      method: 'fallback',
      reason: 'Content inspection failed to identify file type'
    };
  }

  /**
   * Utility method to compare byte arrays
   */
  private static arraysEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((val, i) => val === b[i]);
  }

  /**
   * Check if content is mostly printable text
   */
  private static isPrintableText(text: string): boolean {
    if (!text) return false;
    
    const printableChars = text.split('').filter(char => {
      const code = char.charCodeAt(0);
      return (code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13;
    });
    
    const printableRatio = printableChars.length / text.length;
    return printableRatio > 0.8;
  }
}