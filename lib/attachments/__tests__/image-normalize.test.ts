/**
 * @jest-environment node
 *
 * 2026-11-15 prod report: iPhone HEIC photos attached in Nexus reached Bedrock
 * as `data:image/heic` and failed every later turn. These pin the attach-time
 * conversion: model-safe bytes pass through, HEIC and other formats become JPEG,
 * and anything unconvertible is refused with a message the user can act on.
 *
 * The decoders are injected — the real ones need a browser canvas / WASM worker.
 *
 * @see lib/attachments/image-normalize.ts
 */
import { describe, it, expect, jest } from '@jest/globals'
import {
  IMAGE_REJECTION_MESSAGES,
  ImageAttachmentRejectedError,
  isImageRejectionMessage,
  normalizeImageFile,
  toJpegFileName,
  type ImageConverters,
} from '../image-normalize'
import { sniffImageFormat } from '../image-format'

const HEIC_BYTES = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]
const JPEG_BYTES = [0xFF, 0xD8, 0xFF, 0xE1, 0, 0, 0, 0, 0, 0, 0, 0]
const PNG_BYTES = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
const WEBP_BYTES = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]
const BMP_BYTES = [0x42, 0x4D, 0x36, 0, 0, 0, 0, 0]

const file = (bytes: number[], name: string, type: string) =>
  new File([new Uint8Array(bytes)], name, { type })
const jpegBlob = () => new Blob([new Uint8Array(JPEG_BYTES)], { type: 'image/jpeg' })

function converters(overrides: Partial<ImageConverters> = {}): ImageConverters & {
  heicToJpeg: jest.Mock<ImageConverters['heicToJpeg']>
  canvasToJpeg: jest.Mock<ImageConverters['canvasToJpeg']>
} {
  return {
    heicToJpeg: jest.fn<ImageConverters['heicToJpeg']>(async () => jpegBlob()),
    canvasToJpeg: jest.fn<ImageConverters['canvasToJpeg']>(async () => null),
    ...overrides,
  } as never
}

describe('sniffImageFormat', () => {
  it('identifies the four model-safe formats and HEIC from their bytes', () => {
    expect(sniffImageFormat(new Uint8Array(JPEG_BYTES))).toBe('image/jpeg')
    expect(sniffImageFormat(new Uint8Array(PNG_BYTES))).toBe('image/png')
    expect(sniffImageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(sniffImageFormat(new Uint8Array(WEBP_BYTES))).toBe('image/webp')
    expect(sniffImageFormat(new Uint8Array(HEIC_BYTES))).toBe('heif')
  })

  it('does not call a RIFF file that is not WebP (e.g. WAV) an image', () => {
    expect(sniffImageFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull()
  })

  it('returns null for BMP and empty input', () => {
    expect(sniffImageFormat(new Uint8Array(BMP_BYTES))).toBeNull()
    expect(sniffImageFormat(new Uint8Array())).toBeNull()
  })
})

describe('normalizeImageFile', () => {
  it('passes a JPEG/PNG through untouched', async () => {
    const c = converters()
    const jpeg = file(JPEG_BYTES, 'a.jpg', 'image/jpeg')
    expect(await normalizeImageFile(jpeg, c)).toBe(jpeg)
    const png = file(PNG_BYTES, 'a.png', 'image/png')
    expect(await normalizeImageFile(png, c)).toBe(png)
    expect(c.heicToJpeg).not.toHaveBeenCalled()
    expect(c.canvasToJpeg).not.toHaveBeenCalled()
  })

  it('relabels safe bytes whose declared type is wrong (the provider trusts the label)', async () => {
    const out = await normalizeImageFile(file(JPEG_BYTES, 'IMG.HEIC', 'image/heic'), converters())
    expect(out.type).toBe('image/jpeg')
  })

  it('converts a HEIC to a .jpg JPEG with the WASM decoder when the browser cannot', async () => {
    const c = converters()
    const out = await normalizeImageFile(file(HEIC_BYTES, 'IMG_0001.HEIC', 'image/heic'), c)
    expect(c.heicToJpeg).toHaveBeenCalledTimes(1)
    expect(out.type).toBe('image/jpeg')
    expect(out.name).toBe('IMG_0001.jpg')
  })

  it('recognises HEIC from the bytes even when Chrome reports no type', async () => {
    const c = converters()
    const out = await normalizeImageFile(file(HEIC_BYTES, 'photo', ''), c)
    expect(c.heicToJpeg).toHaveBeenCalledTimes(1)
    expect(out.name).toBe('photo.jpg')
  })

  it('uses the browser decoder first when it can read HEIC (Safari)', async () => {
    const c = converters({ canvasToJpeg: jest.fn<ImageConverters['canvasToJpeg']>(async () => jpegBlob()) })
    const out = await normalizeImageFile(file(HEIC_BYTES, 'a.heic', 'image/heic'), c)
    expect(c.heicToJpeg).not.toHaveBeenCalled()
    expect(out.type).toBe('image/jpeg')
  })

  it('refuses a HEIC that cannot be decoded with a user-facing message', async () => {
    const c = converters({
      heicToJpeg: jest.fn<ImageConverters['heicToJpeg']>(async () => {
        throw new Error('libheif: unsupported codec')
      }),
    })
    const attempt = normalizeImageFile(file(HEIC_BYTES, 'a.heic', 'image/heic'), c)
    await expect(attempt).rejects.toBeInstanceOf(ImageAttachmentRejectedError)
    await expect(attempt).rejects.toThrow(IMAGE_REJECTION_MESSAGES.heicConversionFailed)
  })

  it('converts other browser-decodable formats (BMP) to JPEG via canvas', async () => {
    const c = converters({ canvasToJpeg: jest.fn<ImageConverters['canvasToJpeg']>(async () => jpegBlob()) })
    const out = await normalizeImageFile(file(BMP_BYTES, 'scan.bmp', 'image/bmp'), c)
    expect(out.type).toBe('image/jpeg')
    expect(out.name).toBe('scan.jpg')
  })

  it('refuses SVG and undecodable formats', async () => {
    await expect(
      normalizeImageFile(file([0x3C, 0x73, 0x76, 0x67], 'a.svg', 'image/svg+xml'), converters())
    ).rejects.toThrow(IMAGE_REJECTION_MESSAGES.svg)
    await expect(
      normalizeImageFile(file(BMP_BYTES, 'a.tiff', 'image/tiff'), converters())
    ).rejects.toThrow(IMAGE_REJECTION_MESSAGES.unsupported)
  })
})

describe('helpers', () => {
  it('toJpegFileName swaps or adds the extension', () => {
    expect(toJpegFileName('IMG_0001.HEIC')).toBe('IMG_0001.jpg')
    expect(toJpegFileName('a.b.heif')).toBe('a.b.jpg')
    expect(toJpegFileName('noext')).toBe('noext.jpg')
    expect(toJpegFileName('.heic')).toBe('image.jpg')
  })

  it('isImageRejectionMessage only matches messages written for the user', () => {
    for (const message of Object.values(IMAGE_REJECTION_MESSAGES)) {
      expect(isImageRejectionMessage(message)).toBe(true)
    }
    expect(isImageRejectionMessage('libheif: unsupported codec')).toBe(false)
  })
})
