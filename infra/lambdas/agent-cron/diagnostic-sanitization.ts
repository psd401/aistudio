const DEFAULT_MAX_DIAGNOSTIC_LENGTH = 500;

/**
 * Bound and redact diagnostics before they cross a persistence or logging
 * boundary. Downstream provider/DB errors can contain owner email addresses,
 * authorization headers, signed URLs, or API tokens.
 */
export function sanitizeDiagnostic(
  value: string,
  maxLength = DEFAULT_MAX_DIAGNOSTIC_LENGTH,
): string {
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? ' ' : character;
  }).join('');
  return withoutControls
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
      'Bearer [REDACTED]',
    )
    .replace(
      /((?:authorization|password|secret|token|api[-_]?key)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      '[REDACTED_EMAIL]',
    )
    .replace(
      /\bhttps?:\/\/[^\s,;]+/gi,
      '[REDACTED_URL]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
