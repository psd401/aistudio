/**
 * @jest-environment node
 *
 * Tests for the multi-step MCP tool-use fix (Issue #977).
 *
 * Covers three defects:
 *  - Defect 1: tool-call parts stored without state/input fields
 *  - Defect 2b: consolidated multi-step messages not normalized before convertToModelMessages
 *  - Defect 3: missing/malformed state in convertContentToParts
 */

// jest must be imported before jest.mock() calls to satisfy TypeScript type-checking.
// @jest/globals is used project-wide (not @types/jest globals) so jest is not
// available as a global type without this import. Jest's babel transform hoists
// jest.mock() calls above all imports at runtime, so the import order here only
// matters for TypeScript, not for execution.
import { jest } from '@jest/globals';

// Mock heavy dependencies so the module can load in Jest's CJS environment.
// unified-streaming-service.ts transitively loads provider-adapters/index.ts which
// instantiates @ai-sdk/* adapter classes at module level — those packages can fail
// to load without mocking. The existing unified-streaming-service.test.ts uses the
// same strategy via jest.doMock + require(). Jest auto-hoists jest.mock() calls
// above static import statements, so the mocks are registered before any module loads.
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: jest.fn(() => 'test-request-id'),
  startTimer: jest.fn(() => jest.fn()),
}));

jest.mock('@/lib/streaming/provider-adapters', () => ({
  getProviderAdapter: jest.fn(),
}));

jest.mock('@/lib/streaming/telemetry-service', () => ({
  getTelemetryConfig: jest.fn(),
}));

jest.mock('@/lib/safety', () => ({
  getContentSafetyService: jest.fn(() => ({
    isEnabled: jest.fn(() => false),
    processInput: jest.fn(),
    processOutput: jest.fn(),
  })),
}));

import { describe, it, expect } from '@jest/globals';
import { convertContentToParts } from '@/app/(protected)/nexus/_components/conversation-initializer';
import { normalizeMultiStepMessages } from '@/lib/streaming/unified-streaming-service';
import type { UIMessage } from '@ai-sdk/react';

// ---------------------------------------------------------------------------
// convertContentToParts — Defect 1 & 3 fixes
// ---------------------------------------------------------------------------

describe('convertContentToParts', () => {
  it('sets state=output-available for tool-call parts with result', () => {
    const parts = convertContentToParts([
      {
        type: 'tool-call',
        toolCallId: 'tc1',
        toolName: 'query_db',
        args: { query: 'SELECT 1' },
        result: { rows: [{ id: 1 }] },
        isError: false,
      },
    ]);

    expect(parts).toHaveLength(1);
    const toolPart = parts[0] as Record<string, unknown>;
    expect(toolPart.type).toBe('tool-query_db');
    expect(toolPart.state).toBe('output-available');
    expect(toolPart.toolCallId).toBe('tc1');
    expect(toolPart.output).toEqual({ rows: [{ id: 1 }] });
  });

  it('sets state=input-available for tool-call parts with null result', () => {
    const parts = convertContentToParts([
      {
        type: 'tool-call',
        toolCallId: 'tc2',
        toolName: 'run_query',
        args: {},
        result: null,
        isError: false,
      },
    ]);

    expect(parts).toHaveLength(1);
    const toolPart = parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe('input-available');
    expect(toolPart.output).toBeUndefined();
  });

  it('sets state=output-error when isError=true', () => {
    const parts = convertContentToParts([
      {
        type: 'tool-call',
        toolCallId: 'tc3',
        toolName: 'fetch_data',
        args: {},
        result: 'Connection refused',
        isError: true,
      },
    ]);

    expect(parts).toHaveLength(1);
    const toolPart = parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe('output-error');
  });

  it('prefers stored state=output-error even when isError flag is missing (Defect 3 guard)', () => {
    // Simulate a part that has the stored state field from the DB fix but no isError flag.
    // Cast via unknown to suppress excess-property error (state not in MessagePart schema).
    const parts = convertContentToParts([
      {
        type: 'tool-call',
        toolCallId: 'tc4',
        toolName: 'fetch_data',
        args: {},
        result: 'some error',
        isError: false,
        state: 'output-error',
      } as unknown as { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown>; result: unknown; isError: boolean },
    ]);

    expect(parts).toHaveLength(1);
    const toolPart = parts[0] as Record<string, unknown>;
    expect(toolPart.state).toBe('output-error');
  });

  it('passes through text parts unchanged', () => {
    const parts = convertContentToParts([{ type: 'text', text: 'hello world' }]);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'text', text: 'hello world' });
  });

  it('handles mixed text and tool-call parts', () => {
    const parts = convertContentToParts([
      { type: 'text', text: 'I will query the data.' },
      {
        type: 'tool-call',
        toolCallId: 'tc5',
        toolName: 'query_db',
        args: {},
        result: { count: 42 },
        isError: false,
      },
    ]);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: 'I will query the data.' });
    const toolPart = parts[1] as Record<string, unknown>;
    expect(toolPart.state).toBe('output-available');
  });

  it('handles empty content array', () => {
    const parts = convertContentToParts([]);
    expect(parts).toEqual([]);
  });

  it('returns single text part for string content', () => {
    const parts = convertContentToParts('hello');
    expect(parts).toEqual([{ type: 'text', text: 'hello' }]);
  });
});

// ---------------------------------------------------------------------------
// normalizeMultiStepMessages — Defect 2b fix
// ---------------------------------------------------------------------------

describe('normalizeMultiStepMessages', () => {
  function makeMsg(
    id: string,
    role: 'user' | 'assistant',
    parts: Array<Record<string, unknown>>
  ): UIMessage {
    return { id, role, parts } as unknown as UIMessage;
  }

  it('splits assistant message with resolved tool parts AND text into two messages', () => {
    const messages = [
      makeMsg('u1', 'user', [{ type: 'text', text: 'query' }]),
      makeMsg('a1', 'assistant', [
        { type: 'tool-query_db', toolCallId: 'tc1', state: 'output-available', input: {}, output: { rows: [] } },
        { type: 'tool-process', toolCallId: 'tc2', state: 'output-available', input: {}, output: 'done' },
        { type: 'text', text: 'Here is the result.' },
      ]),
      makeMsg('u2', 'user', [{ type: 'text', text: 'follow-up' }]),
    ];

    const result = normalizeMultiStepMessages(messages as UIMessage[]);

    // Original 3 messages → 4 after split
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe('user');

    // First assistant message: only tool parts
    const toolMsg = result[1] as unknown as { role: string; parts: Array<Record<string, unknown>> };
    expect(toolMsg.role).toBe('assistant');
    expect(toolMsg.parts.every(p => (p.type as string).startsWith('tool-'))).toBe(true);
    expect(toolMsg.parts).toHaveLength(2);

    // Second assistant message: only text
    const textMsg = result[2] as unknown as { role: string; parts: Array<Record<string, unknown>> };
    expect(textMsg.role).toBe('assistant');
    expect(textMsg.parts).toHaveLength(1);
    expect(textMsg.parts[0].type).toBe('text');

    // Follow-up user message unchanged
    expect(result[3].role).toBe('user');
  });

  it('does NOT split assistant message that has only tool parts (no text)', () => {
    const messages = [
      makeMsg('a1', 'assistant', [
        { type: 'tool-query_db', toolCallId: 'tc1', state: 'output-available', input: {}, output: {} },
      ]),
    ];

    const result = normalizeMultiStepMessages(messages as UIMessage[]);
    expect(result).toHaveLength(1);
  });

  it('does NOT split assistant message that has only text parts', () => {
    const messages = [
      makeMsg('a1', 'assistant', [{ type: 'text', text: 'hello' }]),
    ];

    const result = normalizeMultiStepMessages(messages as UIMessage[]);
    expect(result).toHaveLength(1);
  });

  it('does NOT split when tool parts are in input-available state (unresolved)', () => {
    const messages = [
      makeMsg('a1', 'assistant', [
        { type: 'tool-query_db', toolCallId: 'tc1', state: 'input-available', input: {} },
        { type: 'text', text: 'calling tool...' },
      ]),
    ];

    const result = normalizeMultiStepMessages(messages as UIMessage[]);
    // No split because no resolved tools
    expect(result).toHaveLength(1);
  });

  it('preserves user and system messages unchanged', () => {
    const messages = [
      makeMsg('u1', 'user', [{ type: 'text', text: 'hello' }]),
    ];

    const result = normalizeMultiStepMessages(messages as UIMessage[]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(messages[0]);
  });

  it('handles an empty message array', () => {
    expect(normalizeMultiStepMessages([])).toEqual([]);
  });

  it('gives split text message a distinct ID to avoid key conflicts', () => {
    const messages = [
      makeMsg('msg-abc', 'assistant', [
        { type: 'tool-query_db', toolCallId: 'tc1', state: 'output-available', input: {}, output: {} },
        { type: 'text', text: 'Done.' },
      ]),
    ];

    const result = normalizeMultiStepMessages(messages as UIMessage[]);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('msg-abc');
    expect(result[1].id).toBe('msg-abc-text');
  });
});
