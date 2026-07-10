/**
 * Unit tests for OfficeProcessor static helper methods.
 *
 * Run via: cd infra/lambdas/document-processor-v2 && jest
 * Note: the root jest.config.ci.js excludes /infra/ (infra has its own Jest config).
 */

import { OfficeProcessor } from '../office-processor';

// Access private static methods for unit testing
const escapeMdTableCell = (OfficeProcessor as unknown as Record<string, (v: unknown) => string>)['escapeMdTableCell'];
const sanitizeSheetName = (OfficeProcessor as unknown as Record<string, (v: string) => string>)['sanitizeSheetName'];

describe('OfficeProcessor.escapeMdTableCell', () => {
  it('escapes pipe characters', () => {
    expect(escapeMdTableCell('hello | world')).toBe('hello \\| world');
  });

  it('escapes backslashes before pipes', () => {
    expect(escapeMdTableCell('back\\slash')).toBe('back\\\\slash');
    expect(escapeMdTableCell('back\\|pipe')).toBe('back\\\\\\|pipe');
  });

  it('flattens newlines to a space', () => {
    expect(escapeMdTableCell('line1\nline2')).toBe('line1 line2');
    expect(escapeMdTableCell('line1\r\nline2')).toBe('line1 line2');
    expect(escapeMdTableCell('a\n\nb')).toBe('a b');
  });

  it('returns empty string for null and undefined', () => {
    expect(escapeMdTableCell(null)).toBe('');
    expect(escapeMdTableCell(undefined)).toBe('');
  });

  it('coerces non-string values to string', () => {
    expect(escapeMdTableCell(42)).toBe('42');
    expect(escapeMdTableCell(true)).toBe('true');
    expect(escapeMdTableCell(0)).toBe('0');
  });

  it('leaves safe text unchanged', () => {
    expect(escapeMdTableCell('hello world')).toBe('hello world');
    expect(escapeMdTableCell('')).toBe('');
  });
});

describe('OfficeProcessor.sanitizeSheetName', () => {
  it('escapes backslashes before other replacements', () => {
    expect(sanitizeSheetName('back\\slash')).toBe('back\\\\slash');
  });

  it('replaces pipe characters with a space', () => {
    expect(sanitizeSheetName('Sheet | Name')).toBe('Sheet   Name');
  });

  it('replaces newlines with a space', () => {
    expect(sanitizeSheetName('Sheet\nName')).toBe('Sheet Name');
    expect(sanitizeSheetName('Sheet\r\nName')).toBe('Sheet  Name');
  });

  it('replaces # characters with a space', () => {
    // Leading replacement spaces are then removed by the final trim.
    expect(sanitizeSheetName('## Q1 2026')).toBe('Q1 2026');
    expect(sanitizeSheetName('Q1 # 2026')).toBe('Q1   2026');
  });

  it('replaces backticks with a space', () => {
    expect(sanitizeSheetName('Sheet`Name')).toBe('Sheet Name');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeSheetName('  Sheet  ')).toBe('Sheet');
  });

  it('falls back to "Sheet" for an empty result', () => {
    expect(sanitizeSheetName('')).toBe('Sheet');
    expect(sanitizeSheetName('   ')).toBe('Sheet');
    expect(sanitizeSheetName('|||')).toBe('Sheet');
  });

  it('leaves safe names unchanged', () => {
    expect(sanitizeSheetName('Q1 2026 Revenue')).toBe('Q1 2026 Revenue');
  });
});
