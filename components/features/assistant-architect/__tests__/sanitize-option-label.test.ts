/**
 * Unit tests for sanitizeOptionLabel.
 *
 * The function was overly restrictive (allowlist regex) and silently dropped
 * any option label containing colons, slashes, ampersands, or other common
 * punctuation — causing SOP Creator dropdowns (ID 136) to render empty.
 *
 * The fix switches to a deny-list approach: strip actual XSS vectors and
 * allow all other characters.
 *
 * @see ../assistant-architect-streaming.tsx
 * @see https://github.com/psd401/aistudio/issues/938
 */

import { sanitizeOptionLabel } from '../assistant-architect-streaming'

describe('sanitizeOptionLabel', () => {
  describe('allows common punctuation that was previously blocked', () => {
    it('allows colons', () => {
      expect(sanitizeOptionLabel('Procedure: Step-by-step instructions')).toBe(
        'Procedure: Step-by-step instructions'
      )
    })

    it('allows slashes', () => {
      expect(sanitizeOptionLabel('HR/Finance')).toBe('HR/Finance')
    })

    it('allows ampersands', () => {
      expect(sanitizeOptionLabel('Health & Safety')).toBe('Health & Safety')
    })

    it('allows single quotes', () => {
      expect(sanitizeOptionLabel("Follow the 'RACI' model")).toBe("Follow the 'RACI' model")
    })

    it('allows double quotes', () => {
      expect(sanitizeOptionLabel('"Official" Category')).toBe('"Official" Category')
    })

    it('allows semicolons', () => {
      expect(sanitizeOptionLabel('Step 1; Step 2')).toBe('Step 1; Step 2')
    })

    it('allows exclamation marks', () => {
      expect(sanitizeOptionLabel('Important!')).toBe('Important!')
    })

    it('allows question marks', () => {
      expect(sanitizeOptionLabel('What is this?')).toBe('What is this?')
    })

    it('allows at-signs', () => {
      expect(sanitizeOptionLabel('user@domain')).toBe('user@domain')
    })

    it('allows hash characters', () => {
      expect(sanitizeOptionLabel('#1 Priority')).toBe('#1 Priority')
    })
  })

  describe('preserves labels that already passed the old regex', () => {
    it('allows plain words', () => {
      expect(sanitizeOptionLabel('Standard Operating Procedure')).toBe(
        'Standard Operating Procedure'
      )
    })

    it('allows parentheses', () => {
      expect(sanitizeOptionLabel('Option A (recommended)')).toBe('Option A (recommended)')
    })

    it('allows hyphens', () => {
      expect(sanitizeOptionLabel('Step-by-step')).toBe('Step-by-step')
    })

    it('allows periods', () => {
      expect(sanitizeOptionLabel('Dr. Smith')).toBe('Dr. Smith')
    })

    it('trims surrounding whitespace', () => {
      expect(sanitizeOptionLabel('  Trimmed  ')).toBe('Trimmed')
    })
  })

  describe('strips XSS vectors', () => {
    it('strips HTML tags', () => {
      expect(sanitizeOptionLabel('<script>alert(1)</script>Label')).toBe('Label')
    })

    it('strips img onerror payloads', () => {
      expect(sanitizeOptionLabel('<img src=x onerror=alert(1)>Safe')).toBe('Safe')
    })

    it('strips javascript: protocol', () => {
      expect(sanitizeOptionLabel('javascript:alert(1)')).toBe('alert(1)')
    })

    it('strips mixed-case javascript: protocol', () => {
      expect(sanitizeOptionLabel('JavaScript:void(0)')).toBe('void(0)')
    })

    it('strips inline event handlers', () => {
      expect(sanitizeOptionLabel('onclick=alert(1) Label')).toBe('Label')
    })

    it('strips onmouseover handler', () => {
      expect(sanitizeOptionLabel('onmouseover=x Label')).toBe('Label')
    })

    it('strips event handlers with surrounding whitespace', () => {
      expect(sanitizeOptionLabel('onclick = bad() Label')).toBe('Label')
    })

    it('returns empty string for a pure HTML payload', () => {
      expect(sanitizeOptionLabel('<script>xss()</script>')).toBe('')
    })
  })

  describe('handles edge cases', () => {
    it('returns empty string for empty input', () => {
      expect(sanitizeOptionLabel('')).toBe('')
    })

    it('returns empty string for null-like input (non-string)', () => {
      expect(sanitizeOptionLabel(null as unknown as string)).toBe('')
    })

    it('returns empty string for undefined input', () => {
      expect(sanitizeOptionLabel(undefined as unknown as string)).toBe('')
    })

    it('handles whitespace-only strings', () => {
      expect(sanitizeOptionLabel('   ')).toBe('')
    })

    it('handles unicode characters', () => {
      expect(sanitizeOptionLabel('Año Escolar / Currículum')).toBe('Año Escolar / Currículum')
    })
  })
})
