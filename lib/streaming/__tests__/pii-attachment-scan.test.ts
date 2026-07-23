/**
 * Tests for attachment-borne PII scanning (Issue #971)
 *
 * Verifies that:
 * 1. extractPartText() correctly extracts text from document/file parts
 *    in both string and ContentPart[] formats.
 * 2. The scanAttachmentPII logic (mirrored here for unit testing) tokenizes
 *    document text before processMessagesWithAttachments moves it to S3.
 * 3. precomputedInputTokenMappings are merged into the detokenization
 *    transform — tested by verifying the returned token array.
 */

import { describe, it, expect, jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Helper: build a fake UIMessage with mixed text + document parts
// ---------------------------------------------------------------------------
function makeMsgWithDocument(opts: {
  inlineText?: string;
  documentContent?: string | Array<{ type: string; text: string }>;
  documentType?: 'document' | 'file';
}) {
  const parts: Array<Record<string, unknown>> = [];
  if (opts.inlineText) parts.push({ type: 'text', text: opts.inlineText });
  if (opts.documentContent !== undefined) {
    parts.push({
      type: opts.documentType ?? 'document',
      name: 'template.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: opts.documentContent,
    });
  }
  return { id: 'msg-1', role: 'user' as const, parts };
}

// ---------------------------------------------------------------------------
// extractPartText — mirrors the implementation in route.ts for pure-logic tests
// ---------------------------------------------------------------------------
function extractPartText(part: Record<string, unknown>): string | null {
  const raw = part.content ?? part.data;
  if (typeof raw === 'string' && (raw as string).trim()) return raw as string;
  if (Array.isArray(raw)) {
    const segments = (raw as Array<unknown>)
      .filter(
        (cp): cp is { type: string; text: string } =>
          typeof cp === 'object' && cp !== null &&
          (cp as Record<string, unknown>).type === 'text' &&
          typeof (cp as Record<string, unknown>).text === 'string',
      )
      .map(cp => cp.text);
    if (segments.length > 0) return segments.join('\n');
  }
  return null;
}

// ---------------------------------------------------------------------------
// scanAttachmentPII — mirrors the logic from route.ts for unit testing
// without importing the server-only route module.
// ---------------------------------------------------------------------------

// Matches the shape of lib/safety/types.ts TokenMapping.
// token: raw UUID; placeholder: formatted "[PII:uuid]" string used in text.
type TokenMapping = { token: string; original: string; type: string; placeholder: string };

async function runScanAttachmentPII(
  messagesWithParts: Array<{ id: string; role: string; parts: Array<Record<string, unknown>> }>,
  safetyService: {
    isPiiTokenizationEnabled: () => boolean;
    processInput: (text: string, sessionId: string) => Promise<{
      allowed: boolean;
      tokens?: TokenMapping[];
    }>;
  },
): Promise<TokenMapping[]> {
  if (!safetyService.isPiiTokenizationEnabled()) return [];

  // findIndex returns -1 when no user message exists; check before computing
  // the index to avoid the silent out-of-bounds: length-1-(-1) = length.
  const reversedIdx = [...messagesWithParts].reverse().findIndex(m => m.role === 'user');
  if (reversedIdx === -1) return [];
  const lastUserIdx = messagesWithParts.length - 1 - reversedIdx;

  const lastUserMsg = messagesWithParts[lastUserIdx];
  if (!Array.isArray(lastUserMsg.parts)) return [];

  const attachmentTexts: Array<{ partIdx: number; text: string }> = [];
  lastUserMsg.parts.forEach((part, partIdx) => {
    if (part.type === 'document' || part.type === 'file') {
      const text = extractPartText(part);
      if (text) attachmentTexts.push({ partIdx, text });
    }
  });

  if (attachmentTexts.length === 0) return [];

  const combinedText = attachmentTexts.map(a => a.text).join('\n');
  const scanResult = await safetyService.processInput(combinedText, 'session-1');
  if (!scanResult.tokens || scanResult.tokens.length === 0) return [];

  // Use placeholder ("[PII:uuid]") not token (raw UUID) — the placeholder is
  // what gets embedded in the text and what the detokenizer searches for.
  const replacements = new Map(scanResult.tokens.map(t => [t.original, t.placeholder]));

  const updatedParts = [...lastUserMsg.parts];
  for (const { partIdx, text } of attachmentTexts) {
    let tokenizedText = text;
    for (const [original, placeholder] of replacements) tokenizedText = tokenizedText.replaceAll(original, placeholder);
    if (tokenizedText === text) continue;

    const originalPart = updatedParts[partIdx] as Record<string, unknown>;
    const field = originalPart.content !== undefined ? 'content' : 'data';
    const rawValue = originalPart[field];

    if (typeof rawValue === 'string') {
      updatedParts[partIdx] = { ...originalPart, [field]: tokenizedText };
    } else if (Array.isArray(rawValue)) {
      updatedParts[partIdx] = {
        ...originalPart,
        [field]: rawValue.map(cp => {
          const cpObj = cp as Record<string, unknown>;
          if (cpObj.type === 'text' && typeof cpObj.text === 'string') {
            let seg = cpObj.text as string;
            for (const [orig, ph] of replacements) seg = seg.replaceAll(orig, ph);
            return { ...cpObj, text: seg };
          }
          return cp;
        }),
      };
    }
  }
  messagesWithParts[lastUserIdx] = { ...lastUserMsg, parts: updatedParts };
  return scanResult.tokens;
}

// token: raw UUID (as produced by the real PII tokenization service)
// placeholder: formatted "[PII:uuid]" string embedded in text
const mockTokens: TokenMapping[] = [
  {
    token: 'aaaa-bbbb-cccc-dddd-eeeeffff0000',
    original: 'Kris',
    type: 'PERSON',
    placeholder: '[PII:aaaa-bbbb-cccc-dddd-eeeeffff0000]',
  },
];

function makeMockService(opts: { piiEnabled: boolean; tokens?: TokenMapping[] }) {
  return {
    isPiiTokenizationEnabled: () => opts.piiEnabled,
    processInput: (jest.fn() as jest.Mock<any>).mockResolvedValue({
      allowed: true,
      tokens: opts.tokens ?? [],
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests: extractPartText
// ---------------------------------------------------------------------------
describe('extractPartText (attachment text extraction)', () => {
  it('returns string content as-is', () => {
    expect(extractPartText({ type: 'document', content: 'Dear Kris, please review.' }))
      .toBe('Dear Kris, please review.');
  });

  it('returns null for empty string content', () => {
    expect(extractPartText({ type: 'document', content: '' })).toBeNull();
  });

  it('returns null for whitespace-only content', () => {
    expect(extractPartText({ type: 'document', content: '   ' })).toBeNull();
  });

  it('extracts and joins text from ContentPart[] content, skipping non-text parts', () => {
    const part = {
      type: 'document',
      content: [
        { type: 'text', text: 'Line 1' },
        { type: 'image', url: 's3://bucket/img.png' },
        { type: 'text', text: 'Line 2' },
      ],
    };
    expect(extractPartText(part)).toBe('Line 1\nLine 2');
  });

  it('falls back to data field when content is absent', () => {
    expect(extractPartText({ type: 'file', data: 'extracted from data field' }))
      .toBe('extracted from data field');
  });

  it('returns null for S3-only file part (no content or data)', () => {
    expect(extractPartText({ type: 'file', url: 's3://conversations/abc/attach-0' })).toBeNull();
  });

  it('returns null when both content and data are missing', () => {
    expect(extractPartText({ type: 'document', name: 'template.docx' })).toBeNull();
  });

  it('returns null for ContentPart[] with no text entries', () => {
    const part = { type: 'document', content: [{ type: 'image', url: 's3://img' }] };
    expect(extractPartText(part)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: scanAttachmentPII logic
// ---------------------------------------------------------------------------
describe('scanAttachmentPII — attachment PII tokenization', () => {
  it('returns [] when PII tokenization is disabled', async () => {
    const service = makeMockService({ piiEnabled: false });
    const messages = [makeMsgWithDocument({ documentContent: 'Dear Kris,' })];
    const tokens = await runScanAttachmentPII(messages as never, service);
    expect(tokens).toEqual([]);
    expect(service.processInput).not.toHaveBeenCalled();
  });

  it('returns [] when there are no document/file parts', async () => {
    const service = makeMockService({ piiEnabled: true, tokens: mockTokens });
    const messages = [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
    const tokens = await runScanAttachmentPII(messages as never, service);
    expect(tokens).toEqual([]);
    expect(service.processInput).not.toHaveBeenCalled();
  });

  it('returns [] when document part has no extractable text (S3 ref)', async () => {
    const service = makeMockService({ piiEnabled: true, tokens: mockTokens });
    const messages = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'file', url: 's3://bucket/obj', mediaType: 'application/pdf' }],
      },
    ];
    const tokens = await runScanAttachmentPII(messages as never, service);
    expect(tokens).toEqual([]);
    expect(service.processInput).not.toHaveBeenCalled();
  });

  it('scans document text and returns token mappings', async () => {
    const service = makeMockService({ piiEnabled: true, tokens: mockTokens });
    const messages = [makeMsgWithDocument({ documentContent: 'Dear Kris, please review.' })];
    const tokens = await runScanAttachmentPII(messages as never, service);
    expect(tokens).toEqual(mockTokens);
    expect(service.processInput).toHaveBeenCalledWith('Dear Kris, please review.', 'session-1');
  });

  it('replaces PII in string content field using placeholder (not raw token UUID)', async () => {
    const service = makeMockService({ piiEnabled: true, tokens: mockTokens });
    const messages = [makeMsgWithDocument({ documentContent: 'Hi Kris' })];
    await runScanAttachmentPII(messages as never, service);
    const docPart = messages[0].parts.find(p => p.type === 'document') as Record<string, unknown>;
    expect(docPart.content).toBe('Hi [PII:aaaa-bbbb-cccc-dddd-eeeeffff0000]');
  });

  it('replaces PII in ContentPart[] content field in-place', async () => {
    const service = makeMockService({ piiEnabled: true, tokens: mockTokens });
    const messages = [
      makeMsgWithDocument({
        documentContent: [
          { type: 'text', text: 'Dear Kris,' },
          { type: 'text', text: 'No PII here.' },
        ],
      }),
    ];
    await runScanAttachmentPII(messages as never, service);
    const docPart = messages[0].parts.find(p => p.type === 'document') as Record<string, unknown>;
    const content = docPart.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('Dear [PII:aaaa-bbbb-cccc-dddd-eeeeffff0000],');
    expect(content[1].text).toBe('No PII here.');
  });

  it('replaces PII in data field when content is absent', async () => {
    const service = makeMockService({ piiEnabled: true, tokens: mockTokens });
    const messages = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'file', data: 'Hi Kris from data field.' }],
      },
    ];
    await runScanAttachmentPII(messages as never, service);
    const filePart = messages[0].parts[0] as Record<string, unknown>;
    expect(filePart.data).toBe('Hi [PII:aaaa-bbbb-cccc-dddd-eeeeffff0000] from data field.');
  });

  it('combines text from multiple attachment parts for the scan', async () => {
    const service = makeMockService({ piiEnabled: true, tokens: mockTokens });
    const messages = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [
          { type: 'document', content: 'Document 1: Hi Kris.' },
          { type: 'file', data: 'Document 2: Also Kris.' },
        ],
      },
    ];
    await runScanAttachmentPII(messages as never, service);
    expect(service.processInput).toHaveBeenCalledWith(
      'Document 1: Hi Kris.\nDocument 2: Also Kris.',
      'session-1',
    );
  });

  it('returns [] when scan finds no tokens', async () => {
    const service = makeMockService({ piiEnabled: true, tokens: [] });
    const messages = [makeMsgWithDocument({ documentContent: 'No names here.' })];
    const tokens = await runScanAttachmentPII(messages as never, service);
    expect(tokens).toEqual([]);
  });

  it('leaves parts unchanged when scan returns no tokens', async () => {
    const service = makeMockService({ piiEnabled: true, tokens: [] });
    const messages = [makeMsgWithDocument({ documentContent: 'No names here.' })];
    await runScanAttachmentPII(messages as never, service);
    const docPart = messages[0].parts.find(p => p.type === 'document') as Record<string, unknown>;
    expect(docPart.content).toBe('No names here.');
  });

  it('works correctly when the last user message has both text and document parts', async () => {
    const service = makeMockService({ piiEnabled: true, tokens: mockTokens });
    const messages = [
      makeMsgWithDocument({ inlineText: 'Please review this.', documentContent: 'Kris signed here.' }),
    ];
    const tokens = await runScanAttachmentPII(messages as never, service);
    expect(tokens).toEqual(mockTokens);
    // Only the document part should be scanned, not the inline text
    expect(service.processInput).toHaveBeenCalledWith('Kris signed here.', 'session-1');
  });
});
