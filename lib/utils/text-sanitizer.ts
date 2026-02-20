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
  let sanitized = text.replace(/\u0000/g, '');

  // Remove other problematic control characters while preserving meaningful whitespace
  // Removes: 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F (DEL)
  // Preserves: 0x09 (tab), 0x0A (newline), 0x0D (carriage return)
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

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
  if (/\u0000/.test(text)) {
    hasNullBytes = true;
    issues.push('Contains null bytes (0x00)');
  }

  // Check for other problematic control characters
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
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
  const nullBytesRemoved = (text.match(/\u0000/g) || []).length;

  // Remove null bytes
  // eslint-disable-next-line no-control-regex
  let sanitized = text.replace(/\u0000/g, '');

  // Count control characters before removal
  // eslint-disable-next-line no-control-regex
  const controlCharsRemoved = (sanitized.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) || []).length;

  // Remove other problematic control characters
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

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

/**
 * Returns true if the Unicode code point is safe for database storage and UI rendering.
 * Rejects null bytes and the same control character ranges stripped by sanitizeTextForDatabase:
 * 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F (DEL).
 * Preserves tab (0x09), newline (0x0A), and carriage return (0x0D).
 */
function isSafeCodePoint(cp: number): boolean {
  return !(
    cp === 0 ||
    (cp >= 0x01 && cp <= 0x08) ||
    cp === 0x0B ||
    cp === 0x0C ||
    (cp >= 0x0E && cp <= 0x1F) ||
    cp === 0x7F
  );
}

/**
 * Decodes common HTML entities in a string using a single-pass replacement.
 * Handles: &amp; &lt; &gt; &quot; and numeric character references (decimal and hex).
 *
 * Uses a single regex pass to avoid double-decoding (e.g., &amp;lt; decoding twice
 * to produce <). Numeric entities that decode to control characters (null bytes,
 * 0x01-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F) are stripped rather than decoded.
 * Uses String.fromCodePoint to correctly handle supplementary-plane characters
 * (emoji, rare CJK symbols above U+FFFF).
 *
 * Used to clean tool call arguments where AI models may generate HTML-encoded
 * characters (e.g., "Students &amp; Staff" instead of "Students & Staff").
 */
export function decodeHtmlEntities(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(
    /&amp;|&lt;|&gt;|&quot;|&#(\d+);|&#x([\dA-Fa-f]+);/g,
    (match, dec, hex) => {
      if (dec !== undefined) {
        const cp = Number.parseInt(dec, 10);
        return isSafeCodePoint(cp) ? String.fromCodePoint(cp) : '';
      }
      if (hex !== undefined) {
        const cp = Number.parseInt(hex, 16);
        return isSafeCodePoint(cp) ? String.fromCodePoint(cp) : '';
      }
      switch (match) {
        case '&amp;': return '&';
        case '&lt;': return '<';
        case '&gt;': return '>';
        case '&quot;': return '"';
        default: return match;
      }
    }
  );
}

/**
 * Recursively decodes HTML entities in all string values within an object.
 * Traverses plain objects and arrays, returning a new structure (no mutation).
 * Only decodes string values — object keys and non-string primitives are unchanged.
 * Non-plain objects (Date, RegExp, etc.) are passed through without traversal.
 *
 * Depth-limited to 20 levels to guard against pathologically nested tool call arguments.
 */
export function decodeHtmlEntitiesDeep(value: unknown, _depth = 0): unknown {
  if (_depth > 20) return value;
  if (typeof value === 'string') {
    return decodeHtmlEntities(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => decodeHtmlEntitiesDeep(item, _depth + 1));
  }
  // Only traverse plain objects — pass through Date, RegExp, and other class instances unchanged
  if (value !== null && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = decodeHtmlEntitiesDeep(val, _depth + 1);
    }
    return result;
  }
  return value;
}
