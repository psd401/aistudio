// import '@ungap/with-resolvers'; // Polyfill for Promise.withResolvers - Removed
// We'll import heavy, Node-only libraries lazily to avoid issues when
// Next.js attempts to bundle these modules for runtimes (e.g. Edge) that
// don't support them. Dynamic `import()` happens at runtime in the Node
// context of our API route, so it won't break the build.

import logger from "@/lib/logger"
import { sanitizeTextWithMetrics } from "@/lib/utils/text-sanitizer"

/**
 * Document processing utility functions
 * 
 * These functions handle extracting text from different document types.
 * Currently supported: PDF, DOCX, TXT (PPT support planned for future)
 */

/**
 * Extract text from a PDF file
 */
export async function extractTextFromPDF(buffer: Buffer): Promise<{ text: string, metadata: Record<string, unknown> }> {
  try {
    // Import the library without executing its top-level debug routine that
    // exists in `index.js`.  We jump directly to the core implementation
    // found in `lib/pdf-parse.js`, which exports the same function without
    // side-effects that attempt to read test files.
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const pdfData = await pdfParse(buffer);

    // Sanitize the extracted text to remove null bytes and invalid UTF-8 sequences
    // that PostgreSQL cannot store (fixes issue #347)
    const sanitizationResult = sanitizeTextWithMetrics(pdfData.text);

    // Log if significant content was removed during sanitization
    if (sanitizationResult.bytesRemoved > 0) {
      logger.info('PDF text sanitization performed', {
        originalLength: sanitizationResult.originalLength,
        sanitizedLength: sanitizationResult.sanitizedLength,
        nullBytesRemoved: sanitizationResult.nullBytesRemoved,
        controlCharsRemoved: sanitizationResult.controlCharsRemoved,
      });
    }

    return {
      text: sanitizationResult.sanitized,
      metadata: {
        pageCount: pdfData.numpages,
        info: pdfData.info,
      }
    };
  } catch (error) {
    logger.error('Error extracting text from PDF with pdf-parse', { error })
    throw new Error('Failed to extract text from PDF');
  }
}

/**
 * Extract text from a DOCX file
 */
export async function extractTextFromDOCX(buffer: Buffer): Promise<{ text: string, metadata: Record<string, unknown> }> {
  try {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ buffer });

    // Sanitize the extracted text to remove null bytes and invalid UTF-8 sequences
    // that PostgreSQL cannot store (fixes issue #347)
    const sanitizationResult = sanitizeTextWithMetrics(result.value);

    // Log if significant content was removed during sanitization
    if (sanitizationResult.bytesRemoved > 0) {
      logger.info('DOCX text sanitization performed', {
        originalLength: sanitizationResult.originalLength,
        sanitizedLength: sanitizationResult.sanitizedLength,
        nullBytesRemoved: sanitizationResult.nullBytesRemoved,
        controlCharsRemoved: sanitizationResult.controlCharsRemoved,
      });
    }

    return {
      text: sanitizationResult.sanitized,
      metadata: {
        messages: result.messages,
      }
    };
  } catch (error) {
    logger.error('Error extracting text from DOCX', { error })
    throw new Error('Failed to extract text from DOCX');
  }
}

/**
 * Extract text from a TXT file
 */
export async function extractTextFromTXT(buffer: Buffer): Promise<{ text: string, metadata: Record<string, unknown> }> {
  try {
    const text = buffer.toString('utf-8');

    // Sanitize the extracted text to remove null bytes and invalid UTF-8 sequences
    // that PostgreSQL cannot store (fixes issue #347)
    const sanitizationResult = sanitizeTextWithMetrics(text);

    // Log if significant content was removed during sanitization
    if (sanitizationResult.bytesRemoved > 0) {
      logger.info('TXT text sanitization performed', {
        originalLength: sanitizationResult.originalLength,
        sanitizedLength: sanitizationResult.sanitizedLength,
        nullBytesRemoved: sanitizationResult.nullBytesRemoved,
        controlCharsRemoved: sanitizationResult.controlCharsRemoved,
      });
    }

    return {
      text: sanitizationResult.sanitized,
      metadata: {
        size: buffer.length,
      }
    };
  } catch (error) {
    logger.error('Error extracting text from TXT', { error })
    throw new Error('Failed to extract text from TXT');
  }
}

/**
 * Extract text from a document based on its type
 */
export async function extractTextFromDocument(
  buffer: Buffer, 
  fileType: string
): Promise<{ text: string, metadata: Record<string, unknown> }> {
  switch (fileType.toLowerCase()) {
    case 'pdf':
      return extractTextFromPDF(buffer);
    case 'docx':
      return extractTextFromDOCX(buffer);
    case 'txt':
      return extractTextFromTXT(buffer);
    case 'ppt':
    case 'pptx':
      throw new Error('PPT/PPTX parsing not implemented yet');
    default:
      throw new Error(`Unsupported file type: ${fileType}`);
  }
}

/**
 * Chunk document text into segments
 */
export function chunkText(text: string, maxChunkSize: number = 1000): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    // If adding this paragraph exceeds the chunk size, save current chunk and start a new one
    if (currentChunk.length + paragraph.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }

    // If paragraph itself exceeds chunk size, split it into sentences
    if (paragraph.length > maxChunkSize) {
      const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > maxChunkSize && currentChunk.length > 0) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        
        // Handle case where a single sentence is longer than max chunk size
        if (sentence.length > maxChunkSize) {
          // Split long sentence by words to fit within chunk size
          const words = sentence.split(' ');
          for (const word of words) {
            if (currentChunk.length + word.length + 1 > maxChunkSize) {
              chunks.push(currentChunk.trim());
              currentChunk = word + ' ';
            } else {
              currentChunk += word + ' ';
            }
          }
        } else {
          currentChunk += sentence + ' ';
        }
      }
    } else {
      currentChunk += paragraph + '\n\n';
    }
  }

  // Add the last chunk if not empty
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Get file type from file name
 */
export function getFileTypeFromFileName(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  
  switch (extension) {
    case 'pdf':
      return 'pdf';
    case 'docx':
    case 'doc':
      return 'docx';
    case 'txt':
      return 'txt';
    case 'ppt':
    case 'pptx':
      return 'ppt';
    default:
      return extension;
  }
} 