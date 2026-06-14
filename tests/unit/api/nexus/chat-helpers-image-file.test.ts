/**
 * @jest-environment node
 *
 * Tests for Issue #940: JPEG image uploads crash Nexus chat.
 * Verifies that extractUserContent correctly handles type:"file" image parts
 * produced by @assistant-ui/react-ai-sdk's toCreateMessage conversion.
 */
import { describe, it, expect } from '@jest/globals';
import { extractUserContent } from '@/app/api/nexus/chat/chat-helpers';

describe('extractUserContent — file-type image parts (Issue #940)', () => {
  it('handles type:"file" part with image mediaType', () => {
    const message = {
      id: 'msg1',
      role: 'user' as const,
      parts: [
        { type: 'text', text: 'what is in this photo?' },
        { type: 'file', url: 'data:image/jpeg;base64,/9j/abc123', mediaType: 'image/jpeg', filename: 'photo.jpg' },
      ],
    };

    const { content, parts } = extractUserContent(message);

    expect(content).toBe('what is in this photo?');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: 'what is in this photo?' });
    expect(parts[1]).toEqual({ type: 'image', metadata: { hasImage: true } });
  });

  it('handles type:"file" part with hardcoded image/png mediaType for a JPEG url', () => {
    // toCreateMessage hardcodes "image/png" regardless of actual format
    const message = {
      id: 'msg1',
      role: 'user' as const,
      parts: [
        { type: 'text', text: 'describe this' },
        { type: 'file', url: 'data:image/jpeg;base64,/9j/abc123', mediaType: 'image/png' },
      ],
    };

    const { content, parts } = extractUserContent(message);

    expect(content).toBe('describe this');
    // The image part should be saved even when mediaType says png but url says jpeg
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({ type: 'image', metadata: { hasImage: true } });
  });

  it('handles type:"file" part with image data URL when mediaType is missing', () => {
    const message = {
      id: 'msg1',
      role: 'user' as const,
      parts: [
        { type: 'file', url: 'data:image/webp;base64,UklGRiAA', filename: 'image.webp' },
      ],
    };

    const { parts } = extractUserContent(message);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'image', metadata: { hasImage: true } });
  });

  it('does not treat non-image file parts as images', () => {
    const message = {
      id: 'msg1',
      role: 'user' as const,
      parts: [
        { type: 'text', text: 'here is a doc' },
        { type: 'file', url: 'data:application/pdf;base64,JVBE', mediaType: 'application/pdf' },
      ],
    };

    const { content, parts } = extractUserContent(message);

    expect(content).toBe('here is a doc');
    // The PDF file part should be dropped (not an image)
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'text', text: 'here is a doc' });
  });

  it('preserves legacy type:"image" part handling unchanged', () => {
    const message = {
      id: 'msg1',
      role: 'user' as const,
      parts: [
        { type: 'text', text: 'legacy image' },
        { type: 'image', image: 'data:image/png;base64,abc' },
      ],
    };

    const { parts } = extractUserContent(message);

    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({ type: 'image', metadata: { hasImage: true } });
  });

  it('serializes image part for attachment-only messages (no text)', () => {
    // An image-only message with no text should save the image part to DB
    const message = {
      id: 'msg1',
      role: 'user' as const,
      parts: [
        { type: 'file', url: 'data:image/jpeg;base64,/9j/abc', mediaType: 'image/png' },
      ],
    };

    const { content, parts } = extractUserContent(message);

    expect(content).toBe('');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'image', metadata: { hasImage: true } });
  });
});
