import { isSafePlotData, MAX_IMAGE_BASE64_LENGTH } from '@/lib/utils/image-validation'

const MAX_SIZE = MAX_IMAGE_BASE64_LENGTH

describe('isSafePlotData', () => {
  it('accepts a valid image/png data URI', () => {
    expect(isSafePlotData('data:image/png;base64,abc123')).toBe(true)
  })

  it('accepts image/jpeg', () => {
    expect(isSafePlotData('data:image/jpeg;base64,abc')).toBe(true)
  })

  it('accepts image/gif', () => {
    expect(isSafePlotData('data:image/gif;base64,abc')).toBe(true)
  })

  it('accepts image/webp', () => {
    expect(isSafePlotData('data:image/webp;base64,abc')).toBe(true)
  })

  it('rejects image/svg+xml (not allowed for plot output)', () => {
    expect(isSafePlotData('data:image/svg+xml;base64,abc')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isSafePlotData('')).toBe(false)
  })

  it('rejects string exceeding MAX_PLOT_BASE64_LENGTH', () => {
    const oversized = 'data:image/png;base64,' + 'A'.repeat(MAX_SIZE)
    expect(isSafePlotData(oversized)).toBe(false)
  })

  it('accepts string exactly at the size limit', () => {
    // The total string length must not exceed MAX_SIZE.
    // Craft a valid URI whose total length === MAX_SIZE.
    const prefix = 'data:image/png;base64,'
    const payload = 'A'.repeat(MAX_SIZE - prefix.length)
    expect(isSafePlotData(prefix + payload)).toBe(true)
  })

  it('rejects string missing the data: prefix', () => {
    expect(isSafePlotData('image/png;base64,abc')).toBe(false)
  })

  it('rejects string missing semicolon after MIME type', () => {
    expect(isSafePlotData('data:image/pngbase64abc')).toBe(false)
  })

  it('rejects unknown MIME type', () => {
    expect(isSafePlotData('data:application/octet-stream;base64,abc')).toBe(false)
  })

  it('rejects data: prefix with no MIME content', () => {
    expect(isSafePlotData('data:;base64,abc')).toBe(false)
  })
})
