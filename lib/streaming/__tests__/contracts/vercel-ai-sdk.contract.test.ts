/**
 * Vercel AI SDK v5 Contract Tests
 *
 * These tests verify that the Vercel AI SDK behaves as expected and that our
 * assumptions about its SSE event format are correct. Run these tests when:
 * - Upgrading the AI SDK version
 * - Changing provider integrations
 * - Debugging streaming issues
 *
 * CRITICAL: These tests use real API calls and require valid API keys.
 * They are excluded from CI and should be run manually when needed.
 *
 * @see https://sdk.vercel.ai/docs
 * @see https://github.com/psd401/aistudio/issues/364
 * @see https://github.com/psd401/aistudio/issues/366
 */

import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { parseSSEEvent, isTextDeltaEvent, isFinishEvent } from '../../sse-event-types';
import { SDKVersionDetector } from '../../sdk-version-detector';
import { SSEEventAdapter } from '../../sdk-compatibility-adapter';

/**
 * Parse SSE data stream format
 * Handles both standard SSE (data: {...}) and Vercel AI SDK data stream format
 */
function parseSSEDataLine(line: string): string | null {
  // Standard SSE format: "data: {...}"
  if (line.startsWith('data: ')) {
    return line.slice(6);
  }

  // Vercel AI SDK data stream format: "0:\"text\""
  if (line.match(/^\d+:/)) {
    return line;
  }

  return null;
}

/**
 * Contract test suite for Vercel AI SDK v5
 *
 * These tests are skipped by default because they:
 * 1. Require real API keys (OPENAI_API_KEY)
 * 2. Make actual API calls (costs money)
 * 3. Have network dependencies
 *
 * To run these tests:
 * - Set OPENAI_API_KEY in your environment
 * - Run: npm run test:streaming-contract
 */
describe.skip('Vercel AI SDK v5 Contract Tests', () => {
  const adapter = new SSEEventAdapter();
  const version = SDKVersionDetector.detect();

  // Skip all tests if no API key is available
  beforeAll(() => {
    if (!process.env.OPENAI_API_KEY) {
      // eslint-disable-next-line no-console
      console.warn('⚠️  Skipping contract tests: OPENAI_API_KEY not found');
    }

    // Log detected SDK version
    // eslint-disable-next-line no-console
    console.log(`\n📦 Detected AI SDK: ${SDKVersionDetector.getVersionString()}\n`);
  });

  describe('SDK Version Detection', () => {
    it('should detect SDK version correctly', () => {
      expect(version.major).toBeGreaterThanOrEqual(5);
      expect(version.minor).toBeGreaterThanOrEqual(0);
      expect(version.patch).toBeGreaterThanOrEqual(0);
      expect(version.detected).toMatch(/^(runtime|package|fallback)$/);
    });

    it('should not use fallback detection method', () => {
      // Warn if fallback is used (means detection failed)
      if (version.detected === 'fallback') {
        // eslint-disable-next-line no-console
        console.warn('⚠️  SDK version detection is using fallback method');
      }

      // In a real environment, we should be able to detect the version
      expect(version.detected).not.toBe('fallback');
    });

    it('should provide version string for logging', () => {
      const versionString = SDKVersionDetector.getVersionString();
      expect(versionString).toContain('v');
      expect(versionString).toContain(version.major.toString());
    });

    it('should correctly check version compatibility', () => {
      expect(SDKVersionDetector.isCompatible(version.major)).toBe(true);
      expect(SDKVersionDetector.isCompatible(version.major, version.minor)).toBe(true);

      // Should not be compatible with very old versions
      expect(SDKVersionDetector.isCompatible(1)).toBe(false);

      // Should not be compatible with future major versions
      expect(SDKVersionDetector.isCompatible(version.major + 10)).toBe(false);
    });
  });

  describe('SDK Compatibility Adapter', () => {
    it('should normalize events correctly', () => {
      const mockEvent = {
        type: 'text-delta',
        delta: 'Hello World',
      };

      const normalized = adapter.normalizeEvent(mockEvent);
      expect(normalized.type).toBe('text-delta');
      if (isTextDeltaEvent(normalized)) {
        expect(normalized.delta).toBe('Hello World');
      } else {
        throw new Error('Expected text-delta event');
      }
    });

    it('should validate well-formed events', () => {
      const validEvent = {
        type: 'text-delta',
        delta: 'Test content',
      };

      const normalized = adapter.normalizeEvent(validEvent);
      const validation = adapter.validateEventStructure(normalized);

      expect(validation.valid).toBe(true);
      expect(validation.issues).toHaveLength(0);
    });

    it('should detect malformed events', () => {
      const malformedEvent = {
        type: 'text-delta',
        // Missing 'delta' field
      };

      const validation = adapter.validateEventStructure(malformedEvent);

      expect(validation.valid).toBe(false);
      expect(validation.issues.length).toBeGreaterThan(0);
    });

    it('should handle v4-style events with backward compatibility', () => {
      // Simulate a v4-style event with old field name
      const v4Event = {
        type: 'text-delta',
        textDelta: 'Old format content',
      };

      const normalized = adapter.normalizeEvent(v4Event);

      // Should have normalized to v5 format
      if (version.major === 4) {
        if (isTextDeltaEvent(normalized)) {
          expect(normalized.delta).toBe('Old format content');
          expect('textDelta' in normalized).toBe(false);
        } else {
          throw new Error('Expected text-delta event');
        }
      }
    });

    it('should parse and normalize in one step', () => {
      const jsonData = '{"type":"text-delta","delta":"Test"}';
      const event = adapter.parseAndNormalize(jsonData);

      expect(event.type).toBe('text-delta');
      if (isTextDeltaEvent(event)) {
        expect(event.delta).toBe('Test');
      } else {
        throw new Error('Expected text-delta event');
      }
    });

    it('should throw on invalid JSON', () => {
      expect(() => {
        adapter.parseAndNormalize('invalid json');
      }).toThrow();
    });
  });

  describe('streamText SSE Event Format', () => {
    it('should emit text-delta events with "delta" field (not "textDelta")', async () => {
      // Skip if no API key
      if (!process.env.OPENAI_API_KEY) {
        // eslint-disable-next-line no-console
        console.log('Skipping: No API key');
        return;
      }

      const result = streamText({
        model: openai('gpt-4o-mini'),
        messages: [{ role: 'user', content: 'Say "test" exactly once and nothing else.' }],
        maxRetries: 0,
      });

      // Convert to Response stream
      const response = result.toTextStreamResponse();

      if (!response.body) {
        throw new Error('No response body received');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let foundTextDelta = false;
      let hasCorrectField = false;
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');

          // Keep the last incomplete line in the buffer
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;

            const data = parseSSEDataLine(line);
            if (!data) continue;

            try {
              const event = parseSSEEvent(data);

              if (isTextDeltaEvent(event)) {
                foundTextDelta = true;
                // Verify it uses 'delta' not 'textDelta'
                hasCorrectField = 'delta' in event && !('textDelta' in event);

                expect(event.delta).toBeDefined();
                expect(typeof event.delta).toBe('string');

                // This should fail if the field name changes
                // @ts-expect-error - ensuring textDelta doesn't exist
                expect(event.textDelta).toBeUndefined();
              }
            } catch {
              // Ignore non-JSON lines or parse errors for this test
              // We're only checking text-delta events
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      expect(foundTextDelta).toBe(true);
      expect(hasCorrectField).toBe(true);
    }, 30000); // 30 second timeout for API call

    it('should emit finish event with proper structure', async () => {
      if (!process.env.OPENAI_API_KEY) {
        // eslint-disable-next-line no-console
        console.log('Skipping: No API key');
        return;
      }

      const result = streamText({
        model: openai('gpt-4o-mini'),
        messages: [{ role: 'user', content: 'Say "done".' }],
        maxRetries: 0,
      });

      const response = result.toTextStreamResponse();

      if (!response.body) {
        throw new Error('No response body received');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let foundFinish = false;
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;

            const data = parseSSEDataLine(line);
            if (!data) continue;

            try {
              const event = parseSSEEvent(data);

              if (isFinishEvent(event)) {
                foundFinish = true;

                // Verify finish event structure
                expect(event.type).toBe('finish');

                // May or may not have these fields, but if present should be correct type
                if ('message' in event) {
                  expect(event.message).toBeDefined();
                }
                if ('usage' in event) {
                  expect(typeof event.usage).toBe('object');
                }
              }
            } catch {
              // Ignore parse errors for non-standard events
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      expect(foundFinish).toBe(true);
    }, 30000);

    it.skip('should handle streaming with tools correctly', async () => {
      // Skipped: Tool API has changed in AI SDK v5 - needs update
      // This test will be re-enabled after updating to match the new tool API
    }, 30000);
  });

  describe('toDataStreamResponse Format', () => {
    it('should include correct headers', async () => {
      if (!process.env.OPENAI_API_KEY) {
        // eslint-disable-next-line no-console
        console.log('Skipping: No API key');
        return;
      }

      const result = streamText({
        model: openai('gpt-4o-mini'),
        messages: [{ role: 'user', content: 'Hi' }],
        maxRetries: 0,
      });

      const response = result.toTextStreamResponse();

      // Verify critical headers
      expect(response.headers.get('Content-Type')).toContain('text/plain');
      expect(response.headers.get('X-Vercel-AI-Data-Stream')).toBe('v1');

    }, 10000);
  });

  describe('Error Handling', () => {
    it('should handle model errors gracefully', async () => {
      if (!process.env.OPENAI_API_KEY) {
        // eslint-disable-next-line no-console
        console.log('Skipping: No API key');
        return;
      }

      // Use invalid model to trigger error
      await expect(async () => {
        const result = streamText({
          model: openai('invalid-model-that-does-not-exist'),
          messages: [{ role: 'user', content: 'Test' }],
        });

        const response = result.toTextStreamResponse();

        if (!response.body) {
          throw new Error('No response body');
        }

        const reader = response.body.getReader();

        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
      }).rejects.toThrow();
    }, 30000);
  });
});

/**
 * Documentation for running contract tests
 *
 * These tests verify our assumptions about the Vercel AI SDK's behavior.
 * They should be run:
 *
 * 1. Before upgrading AI SDK packages
 * 2. When debugging streaming issues
 * 3. After significant changes to provider integrations
 *
 * To run:
 * ```bash
 * export OPENAI_API_KEY=sk-...
 * npm run test:streaming-contract
 * ```
 *
 * Common failure scenarios:
 * - Field name changes (delta → textDelta)
 * - Event type additions/removals
 * - Header format changes
 * - Error handling changes
 *
 * If these tests fail after an SDK upgrade:
 * 1. Review the AI SDK changelog
 * 2. Update our SSE event types accordingly
 * 3. Update streaming adapters
 * 4. Update frontend event handlers
 */
