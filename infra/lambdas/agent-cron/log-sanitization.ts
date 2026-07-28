/**
 * Mask an email address before it reaches CloudWatch. Full owner addresses
 * remain available only in the parameterized telemetry database records.
 */
export function sanitizeEmailForLog(email: string): string {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return `${email.charAt(0)}***`;
  return `${local.charAt(0)}***@${domain}`;
}
