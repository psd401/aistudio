jest.mock('nanoid', () => ({ nanoid: () => 'test-request-id' }))

const { sanitizeLogMessage, sanitizeLogMetadata } = jest.requireActual<
  typeof import('../logger')
>('../logger')

describe('logger injection boundaries', () => {
  it('removes CR, LF, and Unicode line separators from log messages', () => {
    const result = sanitizeLogMessage(
      'request accepted\r\nERROR forged\u0085WARN forged\u2028INFO forged\u2029done'
    )

    expect(result).toBe(
      'request accepted  ERROR forged WARN forged INFO forged done'
    )
    expect(result).not.toMatch(/[\r\n\u0085\u2028\u2029]/)
  })

  it('preserves legitimate international message text', () => {
    expect(sanitizeLogMessage('café — naïve 日本語')).toBe(
      'café — naïve 日本語'
    )
  })

  it('removes line boundaries recursively from structured metadata', () => {
    const result = sanitizeLogMetadata({
      request: {
        value: 'first\r\nsecond\u2028third',
      },
    }) as { request: { value: string } }

    expect(result.request.value).not.toMatch(/[\r\n\u2028]/)
  })
})
