/**
 * Tests for image generation support in Model Compare
 *
 * Covers the new image event type in DualStreamEvent and the
 * mergeResponseGenerators function added for issue #939.
 * Also validates URL safety checks for image events.
 */

import { describe, it, expect } from '@jest/globals'
import { mergeResponseGenerators, asyncGeneratorToStream, type DualStreamEvent } from '@/lib/compare/dual-stream-merger'
import { isSafeImageUrl } from '@/lib/utils/image-validation'

// Helper: collect all bytes from a ReadableStream and decode as text
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let result = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }

  return result
}

// Helper: parse SSE lines from a raw text string
function parseSSEEvents(raw: string): DualStreamEvent[] {
  const events: DualStreamEvent[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        events.push(JSON.parse(line.slice(6)) as DualStreamEvent)
      } catch {
        // skip malformed lines
      }
    }
  }
  return events
}

// Simple async generator for testing
async function* textGen(
  modelId: 'model1' | 'model2',
  chunks: string[]
): AsyncGenerator<DualStreamEvent> {
  for (const chunk of chunks) {
    yield { modelId, type: 'content', chunk }
  }
  yield { modelId, type: 'finish', finishReason: 'stop' }
}

// Image generator for testing
async function* imageGen(
  modelId: 'model1' | 'model2',
  imageUrl: string
): AsyncGenerator<DualStreamEvent> {
  yield { modelId, type: 'image', imageUrl }
  yield { modelId, type: 'finish', finishReason: 'stop' }
}

describe('DualStreamEvent - image type', () => {
  it('image event is a valid DualStreamEvent', () => {
    const event: DualStreamEvent = {
      modelId: 'model1',
      type: 'image',
      imageUrl: 'https://example.com/image.png'
    }
    expect(event.type).toBe('image')
    if (event.type === 'image') {
      expect(event.imageUrl).toBe('https://example.com/image.png')
    }
  })

  it('image event serializes correctly as JSON', () => {
    const event: DualStreamEvent = {
      modelId: 'model2',
      type: 'image',
      imageUrl: 'https://s3.example.com/images/abc123.png'
    }
    const json = JSON.parse(JSON.stringify(event)) as typeof event
    expect(json.modelId).toBe('model2')
    expect(json.type).toBe('image')
    if (json.type === 'image') {
      expect(json.imageUrl).toBe('https://s3.example.com/images/abc123.png')
    }
  })
})

describe('isSafeImageUrl — URL validation guard', () => {
  it('accepts valid S3 HTTPS URLs', () => {
    expect(isSafeImageUrl('https://my-bucket.s3.us-west-2.amazonaws.com/key.png?X-Amz-Signature=abc')).toBe(true)
    expect(isSafeImageUrl('https://documents.s3.amazonaws.com/image.png')).toBe(true)
  })

  it('rejects javascript: URIs', () => {
    expect(isSafeImageUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects http: (non-TLS) URLs', () => {
    expect(isSafeImageUrl('http://my-bucket.s3.amazonaws.com/image.png')).toBe(false)
  })

  it('rejects non-S3 HTTPS URLs', () => {
    expect(isSafeImageUrl('https://example.com/image.png')).toBe(false)
    expect(isSafeImageUrl('https://evil.com/.amazonaws.com/image.png')).toBe(false)
  })

  it('rejects empty and malformed strings', () => {
    expect(isSafeImageUrl('')).toBe(false)
    expect(isSafeImageUrl('not-a-url')).toBe(false)
  })
})

describe('mergeResponseGenerators', () => {
  it('merges two text generators into SSE stream', async () => {
    const gen1 = textGen('model1', ['Hello', ' world'])
    const gen2 = textGen('model2', ['Hi', ' there'])

    const merged = mergeResponseGenerators(gen1, gen2)
    const stream = asyncGeneratorToStream(merged)
    const raw = await collectStream(stream)
    const events = parseSSEEvents(raw)

    const model1Events = events.filter(e => e.modelId === 'model1')
    const model2Events = events.filter(e => e.modelId === 'model2')

    // Both models should have finish events
    expect(model1Events.some(e => e.type === 'finish')).toBe(true)
    expect(model2Events.some(e => e.type === 'finish')).toBe(true)

    // Content chunks should be present
    const model1Chunks = model1Events.filter(e => e.type === 'content')
    const model2Chunks = model2Events.filter(e => e.type === 'content')
    expect(model1Chunks).toHaveLength(2)
    expect(model2Chunks).toHaveLength(2)
  })

  it('merges an image generator with a text generator', async () => {
    const imageUrl = 'https://s3.example.com/compare-1/model1.png'
    const gen1 = imageGen('model1', imageUrl)
    const gen2 = textGen('model2', ['Text', ' response'])

    const merged = mergeResponseGenerators(gen1, gen2)
    const stream = asyncGeneratorToStream(merged)
    const raw = await collectStream(stream)
    const events = parseSSEEvents(raw)

    const model1Events = events.filter(e => e.modelId === 'model1')
    const model2Events = events.filter(e => e.modelId === 'model2')

    // Model 1 should have an image event
    const imageEvents = model1Events.filter(e => e.type === 'image')
    expect(imageEvents).toHaveLength(1)
    if (imageEvents[0].type === 'image') {
      expect(imageEvents[0].imageUrl).toBe(imageUrl)
    }

    // Model 1 should have a finish event
    expect(model1Events.some(e => e.type === 'finish')).toBe(true)

    // Model 2 should have content and finish events (no image)
    expect(model2Events.some(e => e.type === 'content')).toBe(true)
    expect(model2Events.some(e => e.type === 'finish')).toBe(true)
    expect(model2Events.some(e => e.type === 'image')).toBe(false)
  })

  it('merges two image generators', async () => {
    // Non-S3 URLs used as test fixtures — these would fail isSafeImageUrl in
    // production; the merger passes URLs through without validating them.
    const url1 = 'https://example.com/img1.png'
    const url2 = 'https://example.com/img2.png'

    const gen1 = imageGen('model1', url1)
    const gen2 = imageGen('model2', url2)

    const merged = mergeResponseGenerators(gen1, gen2)
    const stream = asyncGeneratorToStream(merged)
    const raw = await collectStream(stream)
    const events = parseSSEEvents(raw)

    const model1Image = events.find(e => e.modelId === 'model1' && e.type === 'image')
    const model2Image = events.find(e => e.modelId === 'model2' && e.type === 'image')

    expect(model1Image).toBeDefined()
    expect(model2Image).toBeDefined()
    if (model1Image?.type === 'image') expect(model1Image.imageUrl).toBe(url1)
    if (model2Image?.type === 'image') expect(model2Image.imageUrl).toBe(url2)
  })

  it('SSE output is properly formatted with data: prefix', async () => {
    const gen1 = imageGen('model1', 'https://example.com/test.png')
    const gen2 = textGen('model2', ['ok'])

    const merged = mergeResponseGenerators(gen1, gen2)
    const stream = asyncGeneratorToStream(merged)
    const raw = await collectStream(stream)

    // Every non-empty line should start with data:
    const nonEmptyLines = raw.split('\n').filter(l => l.trim().length > 0)
    expect(nonEmptyLines.every(l => l.startsWith('data: '))).toBe(true)
  })
})
