/**
 * Text Sanitization Utilities
 *
 * Provides functions to sanitize text content for safe storage in PostgreSQL databases.
 * PostgreSQL does not support null bytes (0x00) in text fields, so these must be removed
 * along with other problematic control characters.
 */

/**
 * Sanitizes text for safe database storage by removing null bytes and invalid UTF-8 sequences.
 *
 * This function addresses the PostgreSQL limitation where null bytes (0x00) cannot be stored
 * in text/varchar columns. It also removes other control characters that could cause issues.
 *
 * Common sources of null bytes in document processing:
 * - PDF metadata and embedded binary data
 * - DOCX format artifacts
 * - Encoding conversion issues
 *
 * @param text - The text to sanitize
 * @returns Sanitized text safe for PostgreSQL storage
 *
 * @example
 * ```typescript
 * const pdfText = extractTextFromPDF(buffer);
 * const safeText = sanitizeTextForDatabase(pdfText);
 * await saveToDatabase(safeText);
 * ```
 */
export function sanitizeTextForDatabase(text: string): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  // Remove null bytes (0x00) - PostgreSQL cannot store these in text fields
  // eslint-disable-next-line no-control-regex
  let sanitized = text.replace(/\x00/g, '');

  // Remove other problematic control characters while preserving meaningful whitespace
  // Removes: 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F (DEL)
  // Preserves: 0x09 (tab), 0x0A (newline), 0x0D (carriage return)
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  // Normalize Unicode to canonical form (NFC) for consistent storage
  // This ensures characters like é are stored consistently
  sanitized = sanitized.normalize('NFC');

  return sanitized;
}

/**
 * Validates if a string contains null bytes or other problematic sequences.
 * Useful for debugging or validation before database operations.
 *
 * @param text - The text to validate
 * @returns Object with validation results
 *
 * @example
 * ```typescript
 * const validation = validateTextEncoding(userInput);
 * if (!validation.isValid) {
 *   console.log(`Invalid characters found: ${validation.issues.join(', ')}`);
 * }
 * ```
 */
export function validateTextEncoding(text: string): {
  isValid: boolean;
  issues: string[];
  hasNullBytes: boolean;
  hasControlChars: boolean;
} {
  const issues: string[] = [];
  let hasNullBytes = false;
  let hasControlChars = false;

  if (!text || typeof text !== 'string') {
    return {
      isValid: true,
      issues: [],
      hasNullBytes: false,
      hasControlChars: false,
    };
  }

  // Check for null bytes
  // eslint-disable-next-line no-control-regex
  if (/\x00/.test(text)) {
    hasNullBytes = true;
    issues.push('Contains null bytes (0x00)');
  }

  // Check for other problematic control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/.test(text)) {
    hasControlChars = true;
    issues.push('Contains problematic control characters');
  }

  return {
    isValid: issues.length === 0,
    issues,
    hasNullBytes,
    hasControlChars,
  };
}

/**
 * Sanitizes text and provides metrics about what was removed.
 * Useful for logging and monitoring document processing.
 *
 * @param text - The text to sanitize
 * @returns Object with sanitized text and metrics
 *
 * @example
 * ```typescript
 * const result = sanitizeTextWithMetrics(pdfContent);
 * console.log(`Removed ${result.nullBytesRemoved} null bytes`);
 * await saveToDatabase(result.sanitized);
 * ```
 */
export function sanitizeTextWithMetrics(text: string): {
  sanitized: string;
  originalLength: number;
  sanitizedLength: number;
  nullBytesRemoved: number;
  controlCharsRemoved: number;
  bytesRemoved: number;
} {
  if (!text || typeof text !== 'string') {
    return {
      sanitized: '',
      originalLength: 0,
      sanitizedLength: 0,
      nullBytesRemoved: 0,
      controlCharsRemoved: 0,
      bytesRemoved: 0,
    };
  }

  const originalLength = text.length;

  // Count null bytes before removal
  // eslint-disable-next-line no-control-regex
  const nullBytesRemoved = (text.match(/\x00/g) || []).length;

  // Remove null bytes
  // eslint-disable-next-line no-control-regex
  let sanitized = text.replace(/\x00/g, '');

  // Count control characters before removal
  // eslint-disable-next-line no-control-regex
  const controlCharsRemoved = (sanitized.match(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g) || []).length;

  // Remove other problematic control characters
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  // Normalize Unicode
  sanitized = sanitized.normalize('NFC');

  const sanitizedLength = sanitized.length;
  const bytesRemoved = originalLength - sanitizedLength;

  return {
    sanitized,
    originalLength,
    sanitizedLength,
    nullBytesRemoved,
    controlCharsRemoved,
    bytesRemoved,
  };
}
