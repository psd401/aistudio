const DEFAULT_MAX_DIAGNOSTIC_LENGTH = 500;

/**
 * Mask an owner address before it reaches CloudWatch. Full addresses remain
 * available only in parameterized telemetry records that intentionally key by
 * user identity.
 */
export function sanitizeEmailForLog(email: string): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return `${email.charAt(0)}***`;
  return `${local.charAt(0)}***@${domain}`;
}

/**
 * Keep provider/database diagnostics useful without persisting credentials,
 * owner addresses, or signed/authentication URLs.
 *
 * SYNC: agent-cron/diagnostic-sanitization.ts implements the same boundary for
 * the independently compiled cron Lambda bundle.
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
