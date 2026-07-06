/**
 * Unit tests for the shared HTML sanitizer (REV-COR-409 / REV-INFRA-094 / REV-COR-408).
 *
 * Run via: cd infra && jest lambdas/document-processor-v2 (ts-jest)
 */

import { sanitizeHtml } from '../html-sanitizer';

describe('sanitizeHtml — decode-first bypass (REV-COR-409 / REV-INFRA-094)', () => {
  it('does not re-introduce <script> from entity-encoded input', () => {
    const out = sanitizeHtml('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    // The inert text survives, but not as live markup.
    expect(out).toContain('alert(1)');
  });

  it('does not re-introduce <img onerror> from entity-encoded input', () => {
    const out = sanitizeHtml('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<');
  });

  it('strips live tags and keeps their text', () => {
    expect(sanitizeHtml('<b>bold</b> text')).toBe('bold text');
  });

  it('resolves double-encoded sequences without producing live markup', () => {
    // &amp;lt; decodes to &lt; (a literal, not a tag opener).
    const out = sanitizeHtml('&amp;lt;script&amp;gt;');
    expect(out).not.toContain('<script>');
  });

  it('passes plain text through unchanged', () => {
    expect(sanitizeHtml('just some words')).toBe('just some words');
  });
});

describe('sanitizeHtml — preserveNewlines (REV-COR-408)', () => {
  it('keeps block breaks when preserveNewlines is set', () => {
    const out = sanitizeHtml('## Heading\n\nBody paragraph', { preserveNewlines: true });
    expect(out).toContain('\n');
    // Heading marker stays at the start of a line.
    expect(out.split('\n')[0]).toBe('## Heading');
    expect(out).toContain('Body paragraph');
  });

  it('collapses all whitespace (including newlines) by default', () => {
    expect(sanitizeHtml('## Heading\n\nBody')).toBe('## Heading Body');
  });

  it('still strips tags in preserveNewlines mode', () => {
    const out = sanitizeHtml('# Title\n\n<script>alert(1)</script>text', { preserveNewlines: true });
    expect(out).not.toContain('<script>');
    expect(out).toContain('# Title');
  });
});
