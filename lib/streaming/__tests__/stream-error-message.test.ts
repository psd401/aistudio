/**
 * @jest-environment node
 *
 * #1899 case 3 — a mid-stream failure used to render as "An error occurred.",
 * the AI SDK's default `onError`, because `toUIMessageStream()` was called with
 * no handler. Five words, and no way for the user to tell a transient outage
 * from a blocked response from a conversation that is simply too long.
 *
 * These specs pin both halves of the replacement: the right explanation is
 * chosen, and the provider's own text never reaches the browser.
 *
 * @see lib/streaming/stream-error-message.ts
 */

import {
  classifyStreamError,
  sanitizeStreamErrorMessage,
  STREAM_ERROR_MESSAGES,
} from '../stream-error-message'

describe('classifyStreamError', () => {
  it('recognises a timeout or an abort', () => {
    expect(classifyStreamError(new Error('Request timed out after 60000ms'))).toBe('timeout')
    expect(classifyStreamError({ name: 'AbortError', message: 'aborted' })).toBe('timeout')
    expect(classifyStreamError({ code: 'ETIMEDOUT', message: 'socket hang' })).toBe('timeout')
  })

  it('recognises rate limiting from the status or the text', () => {
    expect(classifyStreamError({ statusCode: 429, message: 'slow down' })).toBe('rateLimited')
    expect(classifyStreamError(new Error('Rate limit exceeded'))).toBe('rateLimited')
    expect(classifyStreamError(new Error('ThrottlingException'))).toBe('rateLimited')
    expect(classifyStreamError(new Error('quota exceeded for this model'))).toBe('rateLimited')
  })

  it('recognises a content/guardrail block', () => {
    expect(classifyStreamError(new Error('content filter triggered'))).toBe('contentBlocked')
    expect(classifyStreamError(new Error('Blocked by guardrail'))).toBe('contentBlocked')
  })

  it('recognises a context-length failure', () => {
    expect(
      classifyStreamError(new Error("This model's maximum context length is 200000 tokens"))
    ).toBe('tooLong')
    expect(classifyStreamError(new Error('prompt is too long'))).toBe('tooLong')
  })

  it('recognises an unreachable or overloaded provider', () => {
    expect(classifyStreamError({ status: 503, message: 'upstream' })).toBe('unavailable')
    expect(classifyStreamError(new Error('Overloaded'))).toBe('unavailable')
    expect(classifyStreamError(new Error('fetch failed'))).toBe('unavailable')
    expect(classifyStreamError({ code: 'ECONNRESET', message: 'read' })).toBe('unavailable')
  })

  it('reads one level into a wrapped cause', () => {
    // Providers routinely wrap the real failure in a generic API error.
    expect(
      classifyStreamError(
        Object.assign(new Error('API call failed'), {
          cause: { code: 'ECONNREFUSED', message: 'connect' },
        })
      )
    ).toBe('unavailable')
  })

  it('ranks a timeout ahead of the generic 5xx it is often reported as', () => {
    expect(classifyStreamError({ status: 504, message: 'gateway timeout' })).toBe('timeout')
  })

  it('falls back to the generic explanation for anything unrecognised', () => {
    expect(classifyStreamError(new Error('weird provider failure'))).toBe('unknown')
    expect(classifyStreamError(undefined)).toBe('unknown')
    expect(classifyStreamError(null)).toBe('unknown')
    expect(classifyStreamError(42)).toBe('unknown')
    expect(classifyStreamError('')).toBe('unknown')
  })
})

describe('sanitizeStreamErrorMessage', () => {
  it('never returns the AI SDK default', () => {
    for (const error of [
      new Error('boom'),
      { statusCode: 500 },
      'a string failure',
      undefined,
    ]) {
      expect(sanitizeStreamErrorMessage(error)).not.toBe('An error occurred.')
    }
  })

  it('returns only allow-listed prose, never the provider text', () => {
    const leaky = new Error(
      'bedrock request 8f2c-REQ-ID failed for arn:aws:bedrock:us-west-2:123456789012:model/secret'
    )
    const message = sanitizeStreamErrorMessage(leaky)

    expect(Object.values(STREAM_ERROR_MESSAGES)).toContain(message)
    expect(message).not.toContain('8f2c-REQ-ID')
    expect(message).not.toContain('arn:aws')
    expect(message).not.toContain('123456789012')
  })

  it('tells the user what happened and whether to retry', () => {
    expect(sanitizeStreamErrorMessage(new Error('timed out'))).toContain('took too long')
    expect(sanitizeStreamErrorMessage({ status: 503 })).toContain('could not be reached')
    expect(sanitizeStreamErrorMessage(new Error('content filter'))).toContain(
      'content safety filter'
    )
  })

  it('every message is actionable prose', () => {
    for (const message of Object.values(STREAM_ERROR_MESSAGES)) {
      expect(message).toMatch(/try again|start a new chat|rephrase/i)
      expect(message.length).toBeGreaterThan(40)
    }
  })
})
