/**
 * Unit tests for LambdaLogger.sanitizeData value redaction + proto safety (REV-INFRA-095).
 */

import { createLambdaLogger } from '../lambda-logger';

// sanitizeData is private; access it through a cast for unit testing.
const sanitize = (data: unknown): any =>
  (createLambdaLogger() as unknown as { sanitizeData: (d: unknown) => any }).sanitizeData(data);

describe('LambdaLogger.sanitizeData (REV-INFRA-095)', () => {
  it('redacts the VALUE of a sensitive key, not the key name', () => {
    expect(sanitize({ apiToken: 'abc123' })).toEqual({ apiToken: '[REDACTED]' });
    expect(sanitize({ password: 'hunter2' })).toEqual({ password: '[REDACTED]' });
    expect(sanitize({ secretKey: 'sk-1' })).toEqual({ secretKey: '[REDACTED]' });
    expect(sanitize({ authorization: 'Bearer x' })).toEqual({ authorization: '[REDACTED]' });
  });

  it('does not over-redact benign keys containing "key" as a substring', () => {
    expect(sanitize({ s3Key: 'conversations/abc/x.png' })).toEqual({ s3Key: 'conversations/abc/x.png' });
    expect(sanitize({ chunkKey: 'chunk-1' })).toEqual({ chunkKey: 'chunk-1' });
    expect(sanitize({ publicKey: 'pk-1' })).toEqual({ publicKey: 'pk-1' });
  });

  it('redacts the secret VALUE inside a string, not the keyword', () => {
    const out = sanitize('Authorization: Bearer abc123.def');
    expect(out).not.toContain('abc123.def');
    // The keyword name is preserved (not masked as the old regex did).
    expect(out).toContain('Authorization');
    expect(out).toContain('[REDACTED]');
    expect(sanitize('token=supersecret')).toBe('token=[REDACTED]');
  });

  it('does not mangle a plain string with no key=value secret', () => {
    expect(sanitize('processing document report.pdf')).toBe('processing document report.pdf');
  });

  it('does not pollute Object.prototype from a __proto__ key', () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
    const out = sanitize(payload);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(out.safe).toBe(1);
  });

  it('recurses into nested objects and arrays', () => {
    expect(sanitize({ outer: { apiKey: 'k', name: 'ok' } })).toEqual({
      outer: { apiKey: '[REDACTED]', name: 'ok' },
    });
    expect(sanitize([{ password: 'p' }])).toEqual([{ password: '[REDACTED]' }]);
  });
});
