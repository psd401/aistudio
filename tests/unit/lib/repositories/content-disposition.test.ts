/**
 * @jest-environment node
 *
 * toContentDispositionValue (REV-COR-071): safe Content-Disposition from a
 * user-controlled filename reflected verbatim by S3.
 */
import { describe, it, expect } from '@jest/globals'
import { toContentDispositionValue } from '@/lib/repositories/content-disposition'

const quotedForm = (v: string) => v.match(/filename="([^"]*)"/)![1]

describe('toContentDispositionValue (REV-COR-071)', () => {
  it('strips a double-quote so it cannot break out of the quoted form', () => {
    const v = toContentDispositionValue('evil".html')
    expect(quotedForm(v)).toBe('evil.html')
    expect(quotedForm(v)).not.toContain('"')
  })

  it('strips control characters', () => {
    const v = toContentDispositionValue('a\r\nb\tc')
    expect(quotedForm(v)).toBe('abc')
  })

  it('round-trips a unicode name via RFC 5987 filename*', () => {
    const v = toContentDispositionValue('résumé.pdf')
    expect(v).toContain("filename*=UTF-8''")
    expect(v).toContain('r%C3%A9sum%C3%A9.pdf')
    // The quoted ASCII form drops the non-ASCII bytes.
    expect(quotedForm(v)).toBe('rsum.pdf')
  })

  it('falls back to "download" for quote-only / empty names', () => {
    expect(quotedForm(toContentDispositionValue('"""'))).toBe('download')
    expect(quotedForm(toContentDispositionValue(''))).toBe('download')
  })
})
