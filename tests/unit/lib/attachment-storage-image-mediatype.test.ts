/**
 * @jest-environment node
 *
 * Tests for Issue #940: processMessagesWithAttachments correctly fixes the
 * mediaType for type:"file" image parts produced by toCreateMessage, which
 * hardcodes "image/png" regardless of the actual image format.
 */
import { describe, it, expect, jest } from '@jest/globals';

// Extract mock functions with mock* prefix — required by babel-plugin-jest-hoist
// so they can be referenced inside jest.mock() factory functions.
const mockS3Send = jest.fn().mockResolvedValue({});
const mockS3Client = jest.fn().mockImplementation(() => ({ send: mockS3Send }));
const mockPutObjectCommand = jest.fn();
const mockGetObjectCommand = jest.fn();

// Mock the AWS SDK S3 client so we don't need real credentials
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: mockS3Client,
  PutObjectCommand: mockPutObjectCommand,
  GetObjectCommand: mockGetObjectCommand,
}));

// Must set env before importing the module
process.env.DOCUMENTS_BUCKET_NAME = 'test-documents-bucket';
process.env.NODE_ENV = 'test';

import { processMessagesWithAttachments } from '@/lib/services/attachment-storage-service';
import type { UIMessage } from 'ai';

const makeMessage = (parts: unknown[]): UIMessage =>
  ({ id: 'msg1', role: 'user', parts, content: '' } as unknown as UIMessage);

describe('processMessagesWithAttachments — mediaType correction (Issue #940)', () => {
  it('corrects image/png → image/jpeg for a JPEG data URL', async () => {
    const jpegDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgAB';
    const messages = [
      makeMessage([
        { type: 'text', text: 'describe this photo' },
        { type: 'file', url: jpegDataUrl, mediaType: 'image/png', filename: 'photo.jpg' },
      ]),
    ];

    const { lightweightMessages } = await processMessagesWithAttachments('conv-id', messages);

    const filePart = lightweightMessages[0].parts?.find((p: unknown) => {
      const part = p as Record<string, unknown>;
      return part.type === 'file';
    }) as Record<string, unknown> | undefined;

    expect(filePart).toBeDefined();
    expect(filePart?.mediaType).toBe('image/jpeg');
    // url should be preserved unchanged (not replaced with s3://)
    expect(filePart?.url).toBe(jpegDataUrl);
  });

  it('corrects image/png → image/webp for a WebP data URL', async () => {
    const webpDataUrl = 'data:image/webp;base64,UklGRiAA';
    const messages = [
      makeMessage([
        { type: 'file', url: webpDataUrl, mediaType: 'image/png' },
      ]),
    ];

    const { lightweightMessages } = await processMessagesWithAttachments('conv-id', messages);

    const filePart = lightweightMessages[0].parts?.find((p: unknown) => {
      const part = p as Record<string, unknown>;
      return part.type === 'file';
    }) as Record<string, unknown> | undefined;

    expect(filePart?.mediaType).toBe('image/webp');
  });

  it('leaves mediaType unchanged when it already matches the data URL', async () => {
    const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAA';
    const messages = [
      makeMessage([
        { type: 'file', url: pngDataUrl, mediaType: 'image/png' },
      ]),
    ];

    const { lightweightMessages } = await processMessagesWithAttachments('conv-id', messages);

    const filePart = lightweightMessages[0].parts?.find((p: unknown) => {
      const part = p as Record<string, unknown>;
      return part.type === 'file';
    }) as Record<string, unknown> | undefined;

    // Same as before — no update needed
    expect(filePart?.mediaType).toBe('image/png');
  });

  it('ignores crafted data URL with CRLF injection in media type', async () => {
    // CRLF in the media type segment could inject log lines or HTTP headers
    const craftedDataUrl = 'data:image/jpeg\r\nX-Injected: value;base64,/9j/abc';
    const messages = [
      makeMessage([
        { type: 'file', url: craftedDataUrl, mediaType: 'image/png' },
      ]),
    ];

    const { lightweightMessages } = await processMessagesWithAttachments('conv-id', messages);

    const filePart = lightweightMessages[0].parts?.find((p: unknown) => {
      const part = p as Record<string, unknown>;
      return part.type === 'file';
    }) as Record<string, unknown> | undefined;

    // CRLF breaks the regex match, so mediaType should remain unchanged
    expect(filePart?.mediaType).toBe('image/png');
  });

  it('ignores crafted data URL with non-image MIME type', async () => {
    // Only allowlisted image types should be extracted
    const craftedDataUrl = 'data:text/html;base64,PHNjcmlwdD4=';
    const messages = [
      makeMessage([
        { type: 'file', url: craftedDataUrl, mediaType: 'image/png' },
      ]),
    ];

    const { lightweightMessages } = await processMessagesWithAttachments('conv-id', messages);

    const filePart = lightweightMessages[0].parts?.find((p: unknown) => {
      const part = p as Record<string, unknown>;
      return part.type === 'file';
    }) as Record<string, unknown> | undefined;

    // Non-image type not in allowlist — mediaType should remain unchanged
    expect(filePart?.mediaType).toBe('image/png');
  });

  it('does not modify non-data-url file parts', async () => {
    const messages = [
      makeMessage([
        { type: 'file', url: 'https://example.com/file.jpg', mediaType: 'image/jpeg' },
      ]),
    ];

    const { lightweightMessages } = await processMessagesWithAttachments('conv-id', messages);

    const filePart = lightweightMessages[0].parts?.find((p: unknown) => {
      const part = p as Record<string, unknown>;
      return part.type === 'file';
    }) as Record<string, unknown> | undefined;

    // Should pass through unchanged
    expect(filePart?.url).toBe('https://example.com/file.jpg');
    expect(filePart?.mediaType).toBe('image/jpeg');
  });

  it('preserves text parts alongside the corrected file part', async () => {
    const jpegDataUrl = 'data:image/jpeg;base64,/9j/abc';
    const messages = [
      makeMessage([
        { type: 'text', text: 'what is this?' },
        { type: 'file', url: jpegDataUrl, mediaType: 'image/png' },
      ]),
    ];

    const { lightweightMessages } = await processMessagesWithAttachments('conv-id', messages);

    const parts = lightweightMessages[0].parts as unknown[];
    expect(parts).toHaveLength(2);

    const textPart = parts.find((p) => (p as Record<string, unknown>).type === 'text') as Record<string, unknown>;
    expect(textPart?.text).toBe('what is this?');

    const filePart = parts.find((p) => (p as Record<string, unknown>).type === 'file') as Record<string, unknown>;
    expect(filePart?.mediaType).toBe('image/jpeg');
  });
});
