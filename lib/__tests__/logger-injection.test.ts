/**
 * Unit tests for logger sanitization against log injection (log forging).
 * Issue #1298: CodeQL js/log-injection alerts on lib/logger.ts.
 *
 * These lock in the neutralization of CR/LF and control characters in values
 * that reach winston. A forged newline in a logged value lets an attacker
 * append a whole fake log line (e.g. a fabricated audit entry), which is the
 * actual impact behind the alert.
 */

// The subjects here are pure functions, but reaching them means loading the
// real lib/logger.ts, which takes two steps.
//
// 1. jest.setup.js installs a repo-wide `jest.mock('@/lib/logger', ...)`. That
//    stub exposes `sanitizeForLogging` as an identity function and does not
//    export `sanitizeLogMessage` or `sanitizeLogMetadata` at all, so under the
//    default registry this suite tests nothing — the message-path cases throw
//    "not a function" and the metadata-path cases assert against a passthrough.
//    jest.requireActual bypasses the registry for this module only.
//
// 2. requireActual still resolves the module's own imports normally, and
//    logger.ts pulls in winston and nanoid purely to build the singleton
//    logger — none of which any assertion below touches. Stubbing them keeps
//    this suite on the default jsdom environment: switching to
//    `@jest-environment node` makes nanoid resolve to its ESM entry, which
//    next/jest does not transform inside node_modules ("Cannot use import
//    statement outside a module"), and the winston load would then depend on
//    Node globals jsdom omits. Only the module-load surface is stubbed.
jest.mock('nanoid', () => ({ nanoid: () => 'test-request-id' }))

jest.mock('winston', () => {
  const noopFormat = () => ({})
  const format = {
    printf: noopFormat,
    combine: noopFormat,
    timestamp: noopFormat,
    errors: noopFormat,
    colorize: noopFormat,
    json: noopFormat,
  }
  const winstonStub = {
    createLogger: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
    format,
    transports: { Console: class Console {} },
  }
  return { __esModule: true, default: winstonStub, ...winstonStub }
})

const { sanitizeForLogging, sanitizeLogMessage, sanitizeLogMetadata } =
  jest.requireActual<typeof import('../logger')>('../logger')

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

  describe('sanitizeLogMessage - the message path', () => {
    // The message path and the metadata path sanitize differently: metadata gets
    // a printable-ASCII allowlist, messages only get line terminators and
    // control characters removed so international text survives. That asymmetry
    // is where U+2028 slipped through, so it gets its own coverage.

    it('strips CR and LF', () => {
      const result = sanitizeLogMessage(FORGERY)
      expect(result).not.toContain('\n')
      expect(result).not.toContain('\r')
      expect(result).toContain('user promoted to administrator')
    })

    it('strips the Unicode line terminators U+2028 / U+2029 / U+0085', () => {
      // These are NOT in the C0/DEL range, and JSON.stringify does not escape
      // U+2028/U+2029 in string values — so before this they reached the log
      // line as raw bytes and could forge a line break in a terminal or in a
      // Unicode-aware log splitter.
      const result = sanitizeLogMessage('a b cd')
      expect(result).not.toContain(' ')
      expect(result).not.toContain(' ')
      expect(result).not.toContain('')
      expect(result).toBe('a b c d')
    })

    it('strips control characters', () => {
      expect(sanitizeLogMessage(`a${NUL}b${BEL}c${DEL}d`)).toBe('abcd')
    })

    it('preserves non-ASCII text that is not a line terminator', () => {
      // Deliberately NOT the metadata path's ASCII allowlist — mangling every
      // accented or non-Latin character in a log message is a real cost, and
      // none of these can forge a line.
      const result = sanitizeLogMessage('café — naïve 日本語')
      expect(result).toContain('café')
      expect(result).toContain('naïve')
      expect(result).toContain('日本語')
    })

    it('coerces non-string input instead of throwing', () => {
      expect(sanitizeLogMessage(42)).toBe('42')
      expect(sanitizeLogMessage(null)).toBe('null')
      expect(sanitizeLogMessage(undefined)).toBe('undefined')
    })

    it('caps message length', () => {
      expect(sanitizeLogMessage('x'.repeat(5000)).length).toBeLessThanOrEqual(1000)
    })
  })

  describe('sanitizeLogMetadata - Dates survive the metadata path', () => {
    // This path runs filterSensitiveData() BEFORE sanitizeForLogger(), the
    // opposite of sanitizeForLogging(). A Date has no own enumerable
    // properties, so the filter pass's generic object traversal flattened it to
    // {} before the ISO branch could ever see it — startTimer(...)({
    // completedAt: date }) logged an empty object and the timestamp was gone.
    const ISO = '2026-07-27T12:34:56.000Z'

    it('emits an ISO string rather than {}', () => {
      const result = sanitizeLogMetadata({ operation: 'act', completedAt: new Date(ISO) })
      expect(result.completedAt).toBe(ISO)
      expect(result.operation).toBe('act')
    })

    it('converts nested and array Dates too', () => {
      const result = sanitizeLogMetadata({ a: { when: new Date(ISO) }, list: [new Date(ISO)] })
      expect((result.a as Record<string, unknown>).when).toBe(ISO)
      expect((result.list as unknown[])[0]).toBe(ISO)
    })

    it('renders the same Date instance twice, not [Circular]', () => {
      // A Date is a leaf and cannot form a cycle, but it used to be recorded in
      // the shared `seen` set before the ISO branch ran, so the second
      // reference to one instance came out as '[Circular]'.
      const d = new Date(ISO)
      const result = sanitizeLogMetadata({ startedAt: d, endedAt: d })
      expect(result.startedAt).toBe(ISO)
      expect(result.endedAt).toBe(ISO)
    })

    it('guards an invalid Date instead of throwing', () => {
      expect(sanitizeLogMetadata({ bad: new Date('nope') }).bad).toBe('[Invalid Date]')
    })

    it('still strips line breaks from metadata values', () => {
      expect(sanitizeLogMetadata({ note: FORGERY }).note).not.toContain('\n')
      expect(sanitizeLogMetadata({ note: FORGERY }).note).not.toContain('\r')
    })

    it('drops prototype-manipulating keys and pollutes nothing', () => {
      // JSON.parse so the __proto__ key is a real own property rather than a
      // literal that would invoke the setter at construction time.
      const poison = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"keep":"yes"}')
      const result = sanitizeLogMetadata(poison)
      expect(Object.keys(result)).toEqual(['keep'])
      expect(Object.getPrototypeOf(result)).toBeNull()
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })
  })
})
