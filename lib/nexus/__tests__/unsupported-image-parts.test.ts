/**
 * @jest-environment node
 *
 * 2026-11-15 prod report: one iPhone HEIC inlined as `data:image/heic` made every
 * later Claude/GPT turn in that Nexus conversation fail, because the client
 * resends the whole history. These pin the server guard that swaps such parts
 * for a text note in what the model sees.
 *
 * @see lib/nexus/unsupported-image-parts.ts
 */
import { describe, it, expect } from '@jest/globals'
import { replaceUnsupportedImageParts } from '../unsupported-image-parts'

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64')
// [size]["ftyp"]["heic"] — the head of every iPhone photo.
const HEIC = b64([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0])
const JPEG = b64([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1])
const PNG = b64([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D])
const BMP = b64([0x42, 0x4D, 0x36, 0, 0, 0, 0, 0, 0, 0, 0x36, 0])

type Part = Record<string, unknown>
const user = (parts: Part[]) => ({ id: 'm1', role: 'user', parts })

describe('replaceUnsupportedImageParts', () => {
  it('replaces an inline HEIC file part with a text note', () => {
    const { messages, replaced } = replaceUnsupportedImageParts([
      user([
        { type: 'text', text: 'what is this?' },
        // assistant-ui labels every image part image/png; the bytes decide.
        { type: 'file', mediaType: 'image/png', filename: 'IMG_0001.HEIC', url: `data:image/heic;base64,${HEIC}` },
      ]),
    ])
    expect(replaced).toBe(1)
    const parts = (messages[0] as { parts: Part[] }).parts
    expect(parts[0]).toEqual({ type: 'text', text: 'what is this?' })
    expect(parts[1].type).toBe('text')
    expect(parts[1].text).toContain('"IMG_0001.HEIC"')
    expect(parts[1].text).toContain('HEIC format')
  })

  it('catches a HEIC payload even when its data URL claims JPEG', () => {
    const { replaced } = replaceUnsupportedImageParts([
      user([{ type: 'file', mediaType: 'image/jpeg', url: `data:image/jpeg;base64,${HEIC}` }]),
    ])
    expect(replaced).toBe(1)
  })

  it('replaces a legacy image part and other formats no model takes (BMP)', () => {
    const { replaced } = replaceUnsupportedImageParts([
      user([
        { type: 'image', image: `data:image/heic;base64,${HEIC}` },
        { type: 'file', mediaType: 'image/bmp', url: `data:image/bmp;base64,${BMP}` },
      ]),
    ])
    expect(replaced).toBe(2)
  })

  it('leaves JPEG/PNG images, non-image files, remote URLs and text alone', () => {
    const input = [
      user([
        { type: 'file', mediaType: 'image/png', url: `data:image/jpeg;base64,${JPEG}` },
        { type: 'file', mediaType: 'image/png', url: `data:image/png;base64,${PNG}` },
        { type: 'file', mediaType: 'application/pdf', url: `data:application/pdf;base64,${b64([0x25, 0x50, 0x44, 0x46])}` },
        { type: 'file', mediaType: 'image/heic', url: 'https://example.com/a.heic' },
        { type: 'text', text: 'hi' },
      ]),
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
    ]
    const { messages, replaced } = replaceUnsupportedImageParts(input)
    expect(replaced).toBe(0)
    // Unchanged messages are returned as the same objects.
    expect(messages[0]).toBe(input[0])
    expect(messages[1]).toBe(input[1])
  })

  it('does not mutate the input', () => {
    const part = { type: 'file', mediaType: 'image/png', url: `data:image/heic;base64,${HEIC}` }
    const input = [user([part])]
    replaceUnsupportedImageParts(input)
    expect((input[0].parts as Part[])[0]).toBe(part)
    expect(part.type).toBe('file')
  })
})
