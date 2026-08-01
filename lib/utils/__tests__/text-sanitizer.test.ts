import {
  sanitizeTextForDatabase,
  sanitizeTextForMessaging,
  containsMessagingUnsafeCharacters,
  validateTextEncoding,
  sanitizeTextWithMetrics,
  decodeHtmlEntities,
  decodeHtmlEntitiesDeep
} from '../text-sanitizer';

describe('sanitizeTextForDatabase', () => {
  it('should remove null bytes from text', () => {
    const input = 'Hello\x00World';
    const result = sanitizeTextForDatabase(input);
    expect(result).toBe('HelloWorld');
  });

  it('should handle multiple null bytes', () => {
    const input = '\x00Hello\x00\x00World\x00';
    const result = sanitizeTextForDatabase(input);
    expect(result).toBe('HelloWorld');
  });

  it('should remove control characters while preserving tab and newline', () => {
    const input = 'Hello\x01\x02World\tTest\nLine';
    const result = sanitizeTextForDatabase(input);
    expect(result).toBe('HelloWorld\tTest\nLine');
  });

  it('should preserve valid UTF-8 characters', () => {
    const input = 'Hello 世界 🌍';
    const result = sanitizeTextForDatabase(input);
    expect(result).toBe('Hello 世界 🌍');
  });

  it('should handle empty strings', () => {
    const result = sanitizeTextForDatabase('');
    expect(result).toBe('');
  });

  it('should handle non-string inputs', () => {
    expect(sanitizeTextForDatabase(null as unknown as string)).toBe('');
    expect(sanitizeTextForDatabase(undefined as unknown as string)).toBe('');
    expect(sanitizeTextForDatabase(123 as unknown as string)).toBe('');
  });

  it('should normalize Unicode characters', () => {
    // é can be represented as single char or combining chars
    const composed = '\u00E9'; // é as single character
    const decomposed = 'e\u0301'; // e + combining acute accent

    const result1 = sanitizeTextForDatabase(composed);
    const result2 = sanitizeTextForDatabase(decomposed);

    // Both should normalize to the same form
    expect(result1).toBe(result2);
  });

  it('should preserve meaningful whitespace', () => {
    const input = 'Line 1\nLine 2\rLine 3\r\nLine 4\tTabbed';
    const result = sanitizeTextForDatabase(input);
    expect(result).toContain('\n');
    expect(result).toContain('\t');
  });

  it('should handle real PDF-like problematic content', () => {
    // Simulate PDF content with embedded null bytes and control chars
    const input = 'Chapter 1\x00\x00\nThis is text\x01\x02 from a PDF\x00 document.';
    const result = sanitizeTextForDatabase(input);
    expect(result).toBe('Chapter 1\nThis is text from a PDF document.');
  });
});

describe('validateTextEncoding', () => {
  it('should detect null bytes', () => {
    const result = validateTextEncoding('Hello\x00World');
    expect(result.isValid).toBe(false);
    expect(result.hasNullBytes).toBe(true);
    expect(result.issues).toContain('Contains null bytes (0x00)');
  });

  it('should detect control characters', () => {
    const result = validateTextEncoding('Hello\x01World');
    expect(result.isValid).toBe(false);
    expect(result.hasControlChars).toBe(true);
    expect(result.issues).toContain('Contains problematic control characters');
  });

  it('should pass valid text', () => {
    const result = validateTextEncoding('Hello World\nNew Line\tTab');
    expect(result.isValid).toBe(true);
    expect(result.hasNullBytes).toBe(false);
    expect(result.hasControlChars).toBe(false);
    expect(result.issues).toHaveLength(0);
  });

  it('should handle empty strings', () => {
    const result = validateTextEncoding('');
    expect(result.isValid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

describe('sanitizeTextWithMetrics', () => {
  it('should count null bytes removed', () => {
    const input = 'Hello\x00\x00World\x00';
    const result = sanitizeTextWithMetrics(input);

    expect(result.sanitized).toBe('HelloWorld');
    expect(result.nullBytesRemoved).toBe(3);
    expect(result.originalLength).toBe(13);
    expect(result.sanitizedLength).toBe(10);
    expect(result.bytesRemoved).toBe(3);
  });

  it('should count control characters removed', () => {
    const input = 'Hello\x01\x02World';
    const result = sanitizeTextWithMetrics(input);

    expect(result.sanitized).toBe('HelloWorld');
    expect(result.controlCharsRemoved).toBe(2);
    expect(result.bytesRemoved).toBe(2);
  });

  it('should handle text with no problematic characters', () => {
    const input = 'Hello World';
    const result = sanitizeTextWithMetrics(input);

    expect(result.sanitized).toBe('Hello World');
    expect(result.nullBytesRemoved).toBe(0);
    expect(result.controlCharsRemoved).toBe(0);
    expect(result.bytesRemoved).toBe(0);
    expect(result.originalLength).toBe(result.sanitizedLength);
  });

  it('should provide accurate metrics for complex text', () => {
    const input = '\x00Hello\x01\x02\x00World\x00Test\x03';
    const result = sanitizeTextWithMetrics(input);

    expect(result.sanitized).toBe('HelloWorldTest');
    expect(result.nullBytesRemoved).toBe(3);
    expect(result.controlCharsRemoved).toBe(3);
    expect(result.bytesRemoved).toBe(6);
  });

  it('should handle empty strings with metrics', () => {
    const result = sanitizeTextWithMetrics('');

    expect(result.sanitized).toBe('');
    expect(result.originalLength).toBe(0);
    expect(result.sanitizedLength).toBe(0);
    expect(result.nullBytesRemoved).toBe(0);
    expect(result.controlCharsRemoved).toBe(0);
    expect(result.bytesRemoved).toBe(0);
  });

  it('should handle non-string inputs with metrics', () => {
    const result = sanitizeTextWithMetrics(null as unknown as string);

    expect(result.sanitized).toBe('');
    expect(result.originalLength).toBe(0);
    expect(result.sanitizedLength).toBe(0);
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named entities', () => {
    expect(decodeHtmlEntities('a &amp; b')).toBe('a & b');
    expect(decodeHtmlEntities('x &lt; y')).toBe('x < y');
    expect(decodeHtmlEntities('x &gt; y')).toBe('x > y');
    expect(decodeHtmlEntities('say &quot;hello&quot;')).toBe('say "hello"');
    expect(decodeHtmlEntities("it&apos;s")).toBe("it's");
  });

  it('decodes decimal numeric entities', () => {
    expect(decodeHtmlEntities('&#65;')).toBe('A');         // ASCII
    expect(decodeHtmlEntities('&#39;')).toBe("'");          // single quote
    expect(decodeHtmlEntities('&#128512;')).toBe('😀');    // emoji (above U+FFFF)
  });

  it('decodes hex numeric entities', () => {
    expect(decodeHtmlEntities('&#x41;')).toBe('A');         // A
    expect(decodeHtmlEntities('&#x27;')).toBe("'");         // single quote
    expect(decodeHtmlEntities('&#x1F600;')).toBe('😀');    // emoji
  });

  it('strips null byte entity &#0; instead of decoding', () => {
    expect(decodeHtmlEntities('&#0;')).toBe('');
    expect(decodeHtmlEntities('&#x00;')).toBe('');
    expect(decodeHtmlEntities('abc&#0;def')).toBe('abcdef');
  });

  it('strips other control character entities', () => {
    expect(decodeHtmlEntities('&#1;')).toBe('');   // SOH
    expect(decodeHtmlEntities('&#8;')).toBe('');   // BS
    expect(decodeHtmlEntities('&#127;')).toBe(''); // DEL
  });

  it('preserves safe whitespace entities', () => {
    expect(decodeHtmlEntities('&#9;')).toBe('\t');   // tab
    expect(decodeHtmlEntities('&#10;')).toBe('\n');  // newline
    expect(decodeHtmlEntities('&#13;')).toBe('\r');  // carriage return
  });

  it('is idempotent — second decode does not alter already-decoded text', () => {
    const once = decodeHtmlEntities('Students &amp; Staff');
    const twice = decodeHtmlEntities(once);
    expect(twice).toBe('Students & Staff');
    expect(once).toBe(twice);
  });

  it('does not double-decode — &amp;lt; decodes to &lt; not <', () => {
    // Single-pass: &amp;lt; → &lt; (not further decoded to <)
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('returns empty string for non-string input', () => {
    expect(decodeHtmlEntities(null as unknown as string)).toBe('');
    expect(decodeHtmlEntities(undefined as unknown as string)).toBe('');
    expect(decodeHtmlEntities(42 as unknown as string)).toBe('');
  });

  it('passes through plain text unchanged', () => {
    expect(decodeHtmlEntities('Hello World')).toBe('Hello World');
    expect(decodeHtmlEntities('')).toBe('');
  });

  it('handles real-world tool arg scenario from Issue #798', () => {
    const encoded = 'Students &amp; Staff at Peninsula SD';
    expect(decodeHtmlEntities(encoded)).toBe('Students & Staff at Peninsula SD');
  });
});

describe('decodeHtmlEntitiesDeep', () => {
  it('decodes string values in plain objects', () => {
    expect(decodeHtmlEntitiesDeep({ query: 'a &amp; b' }))
      .toEqual({ query: 'a & b' });
  });

  it('decodes nested object string values', () => {
    expect(decodeHtmlEntitiesDeep({ a: { b: 'x &amp; y' } }))
      .toEqual({ a: { b: 'x & y' } });
  });

  it('decodes string values in arrays', () => {
    expect(decodeHtmlEntitiesDeep(['a &amp; b', 'c &lt; d']))
      .toEqual(['a & b', 'c < d']);
  });

  it('passes through non-string primitives unchanged', () => {
    expect(decodeHtmlEntitiesDeep({ count: 42, flag: true, nothing: null }))
      .toEqual({ count: 42, flag: true, nothing: null });
  });

  it('passes through Date instances without converting to plain object', () => {
    const d = new Date('2024-01-01');
    expect(decodeHtmlEntitiesDeep(d)).toBe(d);
  });

  it('passes through non-plain objects unchanged', () => {
    const re = /foo/;
    expect(decodeHtmlEntitiesDeep(re)).toBe(re);
  });

  it('preserves encoded values beyond depth limit without decoding', () => {
    // Build a 25-deep nested object (exceeds depth=20 guard)
    let deep: unknown = 'leaf &amp; value';
    for (let i = 0; i < 25; i++) {
      deep = { child: deep };
    }
    const result = decodeHtmlEntitiesDeep(deep);
    // Navigate to the leaf — the first 20 levels are traversed, then it stops
    let node: Record<string, unknown> = result as Record<string, unknown>;
    for (let i = 0; i < 24; i++) {
      node = node.child as Record<string, unknown>;
    }
    // Leaf at depth 25 should still be encoded (depth guard stopped decoding)
    expect(node.child).toBe('leaf &amp; value');
  });

  it('handles mixed arrays and objects', () => {
    const input = { items: ['a &amp; b', { label: 'x &gt; y' }] };
    expect(decodeHtmlEntitiesDeep(input))
      .toEqual({ items: ['a & b', { label: 'x > y' }] });
  });
});

describe('Real-world scenarios', () => {
  it('should handle PDF extraction output', () => {
    // Simulates output from pdf-parse with embedded null bytes
    const pdfText = 'Document Title\x00\x00\n\nParagraph 1\x00 has content.\n\nParagraph 2\x01 continues here.';
    const result = sanitizeTextForDatabase(pdfText);

    expect(result).not.toContain('\x00');
    expect(result).not.toContain('\x01');
    expect(result).toContain('Document Title');
    expect(result).toContain('Paragraph 1 has content');
  });

  it('should handle DOCX extraction output', () => {
    // DOCX can have various control characters
    const docxText = 'Header\x00\n\nBody text\x02 with\x00 embedded\x01 chars.';
    const result = sanitizeTextForDatabase(docxText);

    expect(result).toBe('Header\n\nBody text with embedded chars.');
  });

  it('should handle mixed encoding issues', () => {
    // Combination of null bytes, control chars, and valid unicode
    const mixedText = 'English\x00 中文\x01 العربية\x00 Emoji 🎉\x02';
    const result = sanitizeTextForDatabase(mixedText);

    expect(result).toBe('English 中文 العربية Emoji 🎉');
  });

  it('should preserve structured data formats', () => {
    // JSON-like structure that might appear in documents
    const structuredText = '{\n  "key": "value\x00",\n  "number": 123\x01\n}';
    const result = sanitizeTextForDatabase(structuredText);

    expect(result).toContain('{\n  "key": "value"');
    expect(result).toContain('"number": 123');
    expect(result).not.toContain('\x00');
    expect(result).not.toContain('\x01');
  });
});

// SQS accepts only the XML 1.0 character set:
//   #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
// Anything outside it is rejected with "Invalid binary character ... was found
// in the message body", which is what poisoned 188 production index generations.
describe('sanitizeTextForMessaging', () => {
  it('strips U+FFFF, the code point that broke production', () => {
    expect(sanitizeTextForMessaging('math￿standards')).toBe('mathstandards');
  });

  it('strips U+FFFE', () => {
    expect(sanitizeTextForMessaging('a￾b')).toBe('ab');
  });

  it('strips the U+FDD0-U+FDEF noncharacter arc', () => {
    expect(sanitizeTextForMessaging('a﷐b﷯c')).toBe('abc');
    // The whole arc, not just its endpoints.
    for (let cp = 0xFDD0; cp <= 0xFDEF; cp++) {
      expect(sanitizeTextForMessaging(`x${String.fromCodePoint(cp)}y`)).toBe('xy');
    }
  });

  it('strips U+nFFFE and U+nFFFF in every supplementary plane', () => {
    for (let plane = 1; plane <= 16; plane++) {
      const base = plane * 0x10000;
      expect(sanitizeTextForMessaging(`a${String.fromCodePoint(base + 0xFFFE)}b`)).toBe('ab');
      expect(sanitizeTextForMessaging(`a${String.fromCodePoint(base + 0xFFFF)}b`)).toBe('ab');
    }
  });

  it('preserves well-formed surrogate pairs (emoji)', () => {
    expect(sanitizeTextForMessaging('celebrate \u{1F389}!')).toBe('celebrate \u{1F389}!');
  });

  it('preserves supplementary-plane CJK', () => {
    expect(sanitizeTextForMessaging('\u{20000}\u{2A6DF}')).toBe('\u{20000}\u{2A6DF}');
  });

  it('strips a lone high surrogate', () => {
    expect(sanitizeTextForMessaging('a\uD800b')).toBe('ab');
    expect(sanitizeTextForMessaging('a\uDBFFb')).toBe('ab');
  });

  it('strips a lone low surrogate', () => {
    expect(sanitizeTextForMessaging('a\uDC00b')).toBe('ab');
    expect(sanitizeTextForMessaging('a\uDFFFb')).toBe('ab');
  });

  it('strips a high surrogate that is not followed by a low surrogate', () => {
    // "\uD83D" would start an emoji but is orphaned here.
    expect(sanitizeTextForMessaging('emoji \uD83D end')).toBe('emoji  end');
  });

  it('preserves tab, newline and carriage return', () => {
    expect(sanitizeTextForMessaging('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('strips C0 controls and DEL', () => {
    expect(sanitizeTextForMessaging('a\x00\x01\x08\x0B\x0C\x0E\x1F\x7Fb')).toBe('ab');
  });

  it('preserves the boundary code points SQS allows', () => {
    // U+D7FF is the last code point before the surrogate block; U+E000 the
    // first after it; U+FFFD (replacement character) is explicitly legal.
    expect(sanitizeTextForMessaging('퟿�')).toBe('퟿�');
  });

  it('does NOT Unicode-normalize — removal only', () => {
    // This function feeds content that publishDocumentVersion replays and
    // compares byte-for-byte. NFC would rewrite ~1,120 SQS-legal code points
    // that are routine in extracted PDF text, breaking that replay binding
    // for a large share of the corpus while adding nothing to SQS safety.
    // If this test starts failing, normalization was reintroduced — don't.
    const decomposed = 'cafe\u0301';
    expect(sanitizeTextForMessaging(decomposed)).toBe(decomposed);
    expect(sanitizeTextForMessaging('\u2000')).toBe('\u2000'); // EN QUAD
    expect(sanitizeTextForMessaging('\u212B')).toBe('\u212B'); // ANGSTROM SIGN
    expect(sanitizeTextForMessaging('\uF900')).toBe('\uF900'); // CJK compat ideograph
    expect(sanitizeTextForMessaging('\u0344')).toBe('\u0344'); // would expand under NFC
  });

  it('returns an empty string for non-string and empty input', () => {
    expect(sanitizeTextForMessaging('')).toBe('');
    expect(sanitizeTextForMessaging(null as unknown as string)).toBe('');
    expect(sanitizeTextForMessaging(undefined as unknown as string)).toBe('');
    expect(sanitizeTextForMessaging(42 as unknown as string)).toBe('');
  });

  it('never grows the string, so byte-budgeted batching stays correct', () => {
    const poisoned = 'chunk ￿ text \uD800 more ﷐ end \u{1FFFF}';
    expect(Buffer.byteLength(sanitizeTextForMessaging(poisoned), 'utf8'))
      .toBeLessThanOrEqual(Buffer.byteLength(poisoned, 'utf8'));

    // The guarantee has to hold for the inputs that would break it under NFC:
    // composition exclusions and U+0344 expand rather than shrink.
    for (const expanding of ['\u0958', '\u09DC', '\u0F43', '\uFB2C', '\u0344']) {
      const input = expanding.repeat(500);
      expect(Buffer.byteLength(sanitizeTextForMessaging(input), 'utf8'))
        .toBeLessThanOrEqual(Buffer.byteLength(input, 'utf8'));
    }
  });

  it('is idempotent', () => {
    const once = sanitizeTextForMessaging('a￿b\uD800c \u{1F389}');
    expect(sanitizeTextForMessaging(once)).toBe(once);
  });

  it('leaves already-clean text byte-identical', () => {
    const clean = 'Grade 3 standards\n\tCCSS.MATH.CONTENT.3.OA.A.1 \u{1F389} cafe\u0301';
    expect(sanitizeTextForMessaging(clean)).toBe(clean);
  });
});

describe('containsMessagingUnsafeCharacters', () => {
  it('detects the noncharacters and lone surrogates', () => {
    expect(containsMessagingUnsafeCharacters('a￿b')).toBe(true);
    expect(containsMessagingUnsafeCharacters('a￾b')).toBe(true);
    expect(containsMessagingUnsafeCharacters('a﷐b')).toBe(true);
    expect(containsMessagingUnsafeCharacters('a\uD800b')).toBe(true);
    expect(containsMessagingUnsafeCharacters('a\uDC00b')).toBe(true);
    expect(containsMessagingUnsafeCharacters('a\u{1FFFE}b')).toBe(true);
    expect(containsMessagingUnsafeCharacters('a\x00b')).toBe(true);
  });

  it('accepts legal text including emoji and whitespace', () => {
    expect(containsMessagingUnsafeCharacters('plain text')).toBe(false);
    expect(containsMessagingUnsafeCharacters('a\tb\nc\rd')).toBe(false);
    expect(containsMessagingUnsafeCharacters('party \u{1F389}')).toBe(false);
    expect(containsMessagingUnsafeCharacters('퟿�')).toBe(false);
  });

  it('is stateless across calls (no shared regex lastIndex)', () => {
    const poisoned = 'a￿b';
    expect(containsMessagingUnsafeCharacters(poisoned)).toBe(true);
    expect(containsMessagingUnsafeCharacters(poisoned)).toBe(true);
    expect(containsMessagingUnsafeCharacters(poisoned)).toBe(true);
  });

  it('returns false for non-string and empty input', () => {
    expect(containsMessagingUnsafeCharacters('')).toBe(false);
    expect(containsMessagingUnsafeCharacters(null as unknown as string)).toBe(false);
    expect(containsMessagingUnsafeCharacters(42 as unknown as string)).toBe(false);
  });

  it('is exactly the inverse of "sanitize is a no-op"', () => {
    const samples = [
      'clean',
      'a￿b',
      'party \u{1F389}',
      'a\uD800b',
      'a\u{10FFFF}b',
      // Non-NFC inputs are the counterexample that a normalizing sanitizer
      // would break: the predicate only sees the strip class, so the two must
      // stay removal-only to agree.
      'cafe\u0301',
      '\u2000\u212B\uF900\u0344',
      'a﷐b\u{1FFFE}c',
    ];
    for (const sample of samples) {
      expect(containsMessagingUnsafeCharacters(sample)).toBe(
        sanitizeTextForMessaging(sample) !== sample
      );
    }
  });
});

// Regression guard: the messaging sanitizer must not have widened the database
// one. sanitizeTextForDatabase is used by lib/document-processing.ts and has a
// locked contract — it strips C0 controls only and lets noncharacters through.
describe('sanitizeTextForDatabase is unchanged by the messaging sanitizer', () => {
  it('still passes noncharacters through untouched', () => {
    expect(sanitizeTextForDatabase('a￿b')).toBe('a￿b');
    expect(sanitizeTextForDatabase('a￾b')).toBe('a￾b');
    expect(sanitizeTextForDatabase('a﷐b')).toBe('a﷐b');
    expect(sanitizeTextForDatabase('a\u{1FFFF}b')).toBe('a\u{1FFFF}b');
  });

  it('still passes lone surrogates through untouched', () => {
    expect(sanitizeTextForDatabase('a\uD800b')).toBe('a\uD800b');
    expect(sanitizeTextForDatabase('a\uDC00b')).toBe('a\uDC00b');
  });

  it('still strips exactly the C0 set it always stripped', () => {
    expect(sanitizeTextForDatabase('a\x00\x01\x08\x0B\x0C\x0E\x1F\x7Fb')).toBe('ab');
    expect(sanitizeTextForDatabase('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('is strictly weaker than sanitizeTextForMessaging', () => {
    const poisoned = 'a￿\x00\uD800b';
    expect(sanitizeTextForDatabase(poisoned)).not.toBe(sanitizeTextForMessaging(poisoned));
    expect(sanitizeTextForMessaging(poisoned)).toBe('ab');
  });
});
