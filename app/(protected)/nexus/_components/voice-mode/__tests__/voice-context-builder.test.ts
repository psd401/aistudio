/**
 * Tests for voice context builder.
 * Validates system instruction formatting, truncation, and message handling.
 *
 * Issue #874
 */

import { buildVoiceSystemInstruction, type ContextMessage } from '../voice-context-builder'

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
