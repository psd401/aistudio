/**
 * Unit tests for logger sanitization against log injection (log forging).
 * Issue #1298: CodeQL js/log-injection alerts on lib/logger.ts.
 *
 * These lock in the neutralization of CR/LF and control characters in values
 * that reach winston. A forged newline in a logged value lets an attacker
 * append a whole fake log line (e.g. a fabricated audit entry), which is the
 * actual impact behind the alert.
 */

import { sanitizeForLogging } from '../logger'

const NUL = String.fromCharCode(0)
const BEL = String.fromCharCode(7)
const DEL = String.fromCharCode(127)

// A value crafted to close the current log line and open a fake one.
const FORGERY = 'ok\r\nWARN  [audit] user promoted to administrator'

describe('Logger log-injection sanitization', () => {
  describe('sanitizeForLogging - line breaks', () => {
    it('strips CR and LF from a top-level string', () => {
      const result = sanitizeForLogging(FORGERY) as string
      expect(result).not.toContain('\n')
      expect(result).not.toContain('\r')
    })

    it('keeps the surrounding text so logs stay useful', () => {
      const result = sanitizeForLogging(FORGERY) as string
      expect(result).toContain('ok')
      expect(result).toContain('user promoted to administrator')
    })

    it('strips CR and LF from nested object values', () => {
      const result = sanitizeForLogging({
        outer: { inner: FORGERY },
      }) as Record<string, Record<string, string>>
      expect(result.outer.inner).not.toContain('\n')
      expect(result.outer.inner).not.toContain('\r')
    })

    it('strips CR and LF from array elements', () => {
      const result = sanitizeForLogging([FORGERY, 'clean']) as string[]
      expect(result[0]).not.toContain('\n')
      expect(result[0]).not.toContain('\r')
      expect(result[1]).toBe('clean')
    })

    it('strips CR and LF from Error message and name', () => {
      const err = new Error(FORGERY)
      err.name = FORGERY
      const result = sanitizeForLogging(err) as Record<string, string>
      expect(result.message).not.toContain('\n')
      expect(result.message).not.toContain('\r')
      expect(result.name).not.toContain('\n')
    })

    it('handles a lone CR (old-Mac line ending) as well as CRLF', () => {
      const result = sanitizeForLogging('a\rb') as string
      expect(result).not.toContain('\r')
      expect(result).toBe('a b')
    })

    it('replaces line breaks with a space rather than deleting them', () => {
      // Deleting would silently splice tokens together ("ok" + "WARN" -> "okWARN")
      // and lose the fact that something was stripped.
      expect(sanitizeForLogging('a\nb')).toBe('a b')
    })
  })

  describe('sanitizeForLogging - control characters', () => {
    it('removes NUL, BEL and DEL', () => {
      const result = sanitizeForLogging(`a${NUL}b${BEL}c${DEL}d`) as string
      expect(result).not.toContain(NUL)
      expect(result).not.toContain(BEL)
      expect(result).not.toContain(DEL)
      expect(result).toBe('abcd')
    })

    it('replaces tabs with a space', () => {
      expect(sanitizeForLogging('a\tb')).toBe('a b')
    })

    it('removes the Unicode line separators U+2028 / U+2029', () => {
      // Non-ASCII, so the printable-ASCII allowlist drops them. They terminate
      // lines in some log viewers and JS parsers.
      const result = sanitizeForLogging('a\u2028b\u2029c') as string
      expect(result).toBe('abc')
    })
  })

  describe('sanitizeForLogging - non-string values are preserved', () => {
    it('keeps numbers and booleans usable', () => {
      const result = sanitizeForLogging({ count: 42, ok: true }) as Record<string, unknown>
      expect(result.count).toBe(42)
      expect(result.ok).toBe(true)
    })

    it('caps very long strings so a single value cannot flood the log', () => {
      const result = sanitizeForLogging('x'.repeat(5000)) as string
      expect(result.length).toBeLessThanOrEqual(1000)
    })
  })
})
