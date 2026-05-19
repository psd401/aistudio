/**
 * Unit tests for extractRichEnvelope.
 *
 * Run: bun test rich-envelope.test.ts (from this directory).
 *
 * Mirrors the cases in infra/agent-image/test_chat_format.py — if you add
 * a case here, add the equivalent there, and vice versa.
 */

import { describe, expect, test } from 'bun:test';

import {
  RICH_ENVELOPE_CLOSE,
  RICH_ENVELOPE_OPEN,
  extractRichEnvelope,
} from './rich-envelope';

function wrap(payload: unknown): string {
  return `${RICH_ENVELOPE_OPEN}\n${JSON.stringify(payload)}\n${RICH_ENVELOPE_CLOSE}`;
}

describe('extractRichEnvelope', () => {
  test('empty input', () => {
    expect(extractRichEnvelope('')).toEqual({
      envelope: null,
      remaining: '',
      malformed: false,
    });
    expect(extractRichEnvelope(null)).toEqual({
      envelope: null,
      remaining: '',
      malformed: false,
    });
  });

  test('no envelope passes through', () => {
    const text = 'Just a plain reply, nothing fancy.';
    expect(extractRichEnvelope(text)).toEqual({
      envelope: null,
      remaining: text,
      malformed: false,
    });
  });

  test('envelope only', () => {
    const payload = {
      cardsV2: [{ cardId: 'x', card: { header: { title: 'Hi' } } }],
    };
    const result = extractRichEnvelope(wrap(payload));
    expect(result.envelope).toEqual(payload);
    expect(result.remaining).toBe('');
    expect(result.malformed).toBe(false);
  });

  test('envelope with prose around it', () => {
    const payload = { cardsV2: [{ cardId: 'x' }] };
    const text = `Here is your brief:\n${wrap(payload)}\nLet me know if you need more.`;
    const result = extractRichEnvelope(text);
    expect(result.envelope).toEqual(payload);
    expect(result.remaining).toBe('Here is your brief:\nLet me know if you need more.');
    expect(result.malformed).toBe(false);
  });

  test('malformed json returns original text', () => {
    const text = `prose\n${RICH_ENVELOPE_OPEN}\n{not json${RICH_ENVELOPE_CLOSE}\nmore prose`;
    const result = extractRichEnvelope(text);
    expect(result.envelope).toBeNull();
    expect(result.remaining).toBe(text);
    expect(result.malformed).toBe(true);
  });

  test('missing close marker returns original text', () => {
    const text = `prose\n${RICH_ENVELOPE_OPEN}\n{"cardsV2": []}\nno close`;
    const result = extractRichEnvelope(text);
    expect(result.envelope).toBeNull();
    expect(result.remaining).toBe(text);
    expect(result.malformed).toBe(true);
  });

  test('multiple envelopes — last wins', () => {
    const first = { cardsV2: [{ cardId: 'first' }] };
    const second = { cardsV2: [{ cardId: 'second' }] };
    const text = `a\n${wrap(first)}\nb\n${wrap(second)}\nc`;
    const result = extractRichEnvelope(text);
    expect(result.envelope).toEqual(second);
    expect(result.remaining).toBe('a\nb\nc');
    expect(result.malformed).toBe(false);
  });

  test('non-dict payload rejected', () => {
    const text = `${RICH_ENVELOPE_OPEN}\n[1, 2, 3]\n${RICH_ENVELOPE_CLOSE}`;
    const result = extractRichEnvelope(text);
    expect(result.envelope).toBeNull();
    expect(result.remaining).toBe(text);
    expect(result.malformed).toBe(true);
  });
});
