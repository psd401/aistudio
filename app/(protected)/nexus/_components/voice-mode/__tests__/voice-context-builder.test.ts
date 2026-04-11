/**
 * Tests for voice context builder.
 * Validates system instruction formatting, truncation, message handling,
 * and fetchConversationContext behavior.
 *
 * Issue #874
 */

import { buildVoiceSystemInstruction, fetchConversationContext, type ContextMessage } from '../voice-context-builder'

// Mock client-logger to suppress log output in tests
jest.mock('@/lib/client-logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  }),
}))

describe('buildVoiceSystemInstruction', () => {
  it('should return default instruction when no messages provided', () => {
    const result = buildVoiceSystemInstruction({ priorMessages: [] })
    expect(result).toContain('helpful AI assistant')
    expect(result).toContain('voice conversation')
  })

  it('should include conversation context in instruction', () => {
    const messages: ContextMessage[] = [
      { role: 'user', text: 'What is photosynthesis?' },
      { role: 'assistant', text: 'Photosynthesis is the process by which plants convert sunlight into energy.' },
    ]

    const result = buildVoiceSystemInstruction({ priorMessages: messages })

    expect(result).toContain('User: What is photosynthesis?')
    expect(result).toContain('Assistant: Photosynthesis is the process')
    expect(result).toContain('Prior conversation')
    expect(result).toContain('Continue the conversation')
  })

  it('should preserve message order (chronological)', () => {
    const messages: ContextMessage[] = [
      { role: 'user', text: 'First message' },
      { role: 'assistant', text: 'Second message' },
      { role: 'user', text: 'Third message' },
    ]

    const result = buildVoiceSystemInstruction({ priorMessages: messages })

    const firstIdx = result.indexOf('First message')
    const secondIdx = result.indexOf('Second message')
    const thirdIdx = result.indexOf('Third message')

    expect(firstIdx).toBeLessThan(secondIdx)
    expect(secondIdx).toBeLessThan(thirdIdx)
  })

  it('should truncate oldest messages when total exceeds limit', () => {
    // Create messages that exceed the 10K limit
    const longText = 'A'.repeat(4000)
    const messages: ContextMessage[] = [
      { role: 'user', text: `Old message: ${longText}` },
      { role: 'assistant', text: `Old response: ${longText}` },
      { role: 'user', text: 'Recent question' },
      { role: 'assistant', text: 'Recent answer' },
    ]

    const result = buildVoiceSystemInstruction({ priorMessages: messages })

    // Recent messages should be included, old ones may be truncated
    expect(result).toContain('Recent question')
    expect(result).toContain('Recent answer')
    // The instruction should not exceed the max length
    expect(result.length).toBeLessThanOrEqual(10_000)
  })

  it('should not exceed 10,000 characters total', () => {
    // Many messages to force truncation
    const messages: ContextMessage[] = Array.from({ length: 50 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `Message ${i}: ${'X'.repeat(500)}`,
    }))

    const result = buildVoiceSystemInstruction({ priorMessages: messages })
    expect(result.length).toBeLessThanOrEqual(10_000)
  })

  it('should label user and assistant messages correctly', () => {
    const messages: ContextMessage[] = [
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'Hi there' },
    ]

    const result = buildVoiceSystemInstruction({ priorMessages: messages })

    expect(result).toContain('User: Hello')
    expect(result).toContain('Assistant: Hi there')
  })

  it('should handle single message', () => {
    const messages: ContextMessage[] = [
      { role: 'user', text: 'Just one message' },
    ]

    const result = buildVoiceSystemInstruction({ priorMessages: messages })

    expect(result).toContain('User: Just one message')
    expect(result).toContain('Prior conversation')
  })
})

describe('fetchConversationContext', () => {
  const conversationId = '550e8400-e29b-41d4-a716-446655440000'
  const originalFetch = global.fetch

  beforeEach(() => {
    // Reset fetch mock before each test
    global.fetch = jest.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  function mockFetchSequence(responses: Array<{ ok: boolean; body?: unknown; throwOnJson?: boolean }>) {
    let callIndex = 0
    ;(global.fetch as jest.Mock).mockImplementation(async () => {
      const config = responses[callIndex++]
      if (!config) throw new Error(`Unexpected fetch call #${callIndex}`)
      return {
        ok: config.ok,
        status: config.ok ? 200 : 500,
        json: config.throwOnJson
          ? () => { throw new Error('JSON parse error') }
          : () => Promise.resolve(config.body),
      } as Response
    })
  }

  it('should return empty array when probe request fails', async () => {
    mockFetchSequence([{ ok: false }])

    const result = await fetchConversationContext(conversationId, 20)
    expect(result).toEqual([])
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('should return empty array when probe response has no pagination', async () => {
    mockFetchSequence([{ ok: true, body: { messages: [], pagination: { total: 0 } } }])

    const result = await fetchConversationContext(conversationId, 20)
    expect(result).toEqual([])
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('should return empty array when probe JSON parse fails', async () => {
    mockFetchSequence([{ ok: true, throwOnJson: true }])

    const result = await fetchConversationContext(conversationId, 20)
    expect(result).toEqual([])
  })

  it('should fetch recent messages using correct offset for large conversations', async () => {
    // Conversation has 150 messages total, want last 20
    const recentMessages = Array.from({ length: 20 }, (_, i) => ({
      id: `msg-${130 + i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `Message ${130 + i}` }],
    }))

    mockFetchSequence([
      // Probe request
      { ok: true, body: { messages: [recentMessages[0]], pagination: { total: 150 } } },
      // Actual fetch with offset=130
      { ok: true, body: { messages: recentMessages, pagination: { total: 150, limit: 20, offset: 130 } } },
    ])

    const result = await fetchConversationContext(conversationId, 20)

    expect(global.fetch).toHaveBeenCalledTimes(2)
    // Verify the second call uses the correct offset
    const secondCallUrl = (global.fetch as jest.Mock).mock.calls[1][0] as string
    expect(secondCallUrl).toContain('offset=130')
    expect(secondCallUrl).toContain('limit=20')
    expect(result).toHaveLength(20)
    expect(result[0].text).toBe('Message 130')
    expect(result[19].text).toBe('Message 149')
  })

  it('should use offset=0 when total messages <= requested limit', async () => {
    const messages = [
      { id: 'msg-1', role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
    ]

    mockFetchSequence([
      { ok: true, body: { messages: [messages[0]], pagination: { total: 2 } } },
      { ok: true, body: { messages, pagination: { total: 2, limit: 20, offset: 0 } } },
    ])

    const result = await fetchConversationContext(conversationId, 20)

    const secondCallUrl = (global.fetch as jest.Mock).mock.calls[1][0] as string
    expect(secondCallUrl).toContain('offset=0')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: 'user', text: 'Hello' })
    expect(result[1]).toEqual({ role: 'assistant', text: 'Hi there' })
  })

  it('should return empty array when second fetch fails', async () => {
    mockFetchSequence([
      { ok: true, body: { messages: [], pagination: { total: 10 } } },
      { ok: false },
    ])

    const result = await fetchConversationContext(conversationId, 20)
    expect(result).toEqual([])
  })

  it('should extract only text content from messages', async () => {
    const messages = [
      {
        id: 'msg-1',
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this image' },
          { type: 'image', imageUrl: 'https://example.com/img.png' },
        ],
      },
      {
        id: 'msg-2',
        role: 'assistant',
        content: [
          { type: 'tool-call', toolName: 'search', args: {} },
          { type: 'text', text: 'Here are the results' },
        ],
      },
    ]

    mockFetchSequence([
      { ok: true, body: { messages: [messages[0]], pagination: { total: 2 } } },
      { ok: true, body: { messages, pagination: { total: 2 } } },
    ])

    const result = await fetchConversationContext(conversationId, 20)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: 'user', text: 'Look at this image' })
    expect(result[1]).toEqual({ role: 'assistant', text: 'Here are the results' })
  })

  it('should skip system messages', async () => {
    const messages = [
      { id: 'msg-1', role: 'system', content: [{ type: 'text', text: 'System prompt' }] },
      { id: 'msg-2', role: 'user', content: [{ type: 'text', text: 'User question' }] },
    ]

    mockFetchSequence([
      { ok: true, body: { messages: [messages[0]], pagination: { total: 2 } } },
      { ok: true, body: { messages, pagination: { total: 2 } } },
    ])

    const result = await fetchConversationContext(conversationId, 20)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ role: 'user', text: 'User question' })
  })

  it('should skip messages with empty text content', async () => {
    const messages = [
      { id: 'msg-1', role: 'user', content: [{ type: 'text', text: '  ' }] },
      { id: 'msg-2', role: 'assistant', content: [{ type: 'image', imageUrl: 'url' }] },
      { id: 'msg-3', role: 'user', content: [{ type: 'text', text: 'Real message' }] },
    ]

    mockFetchSequence([
      { ok: true, body: { messages: [messages[0]], pagination: { total: 3 } } },
      { ok: true, body: { messages, pagination: { total: 3 } } },
    ])

    const result = await fetchConversationContext(conversationId, 20)

    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Real message')
  })

  it('should clamp maxMessages to safe range', async () => {
    mockFetchSequence([
      { ok: true, body: { messages: [], pagination: { total: 5 } } },
      { ok: true, body: { messages: [], pagination: { total: 5 } } },
    ])

    // Request more than 100 — should be clamped to 100
    await fetchConversationContext(conversationId, 500)

    const secondCallUrl = (global.fetch as jest.Mock).mock.calls[1][0] as string
    expect(secondCallUrl).toContain('limit=100')
  })

  it('should return empty when data.messages is not an array', async () => {
    mockFetchSequence([
      { ok: true, body: { messages: [], pagination: { total: 5 } } },
      { ok: true, body: { notMessages: 'invalid' } },
    ])

    const result = await fetchConversationContext(conversationId, 20)
    expect(result).toEqual([])
  })

  it('should return empty array when second fetch JSON parse fails', async () => {
    mockFetchSequence([
      { ok: true, body: { messages: [], pagination: { total: 5 } } },
      { ok: true, throwOnJson: true },
    ])

    const result = await fetchConversationContext(conversationId, 20)
    expect(result).toEqual([])
  })
})
