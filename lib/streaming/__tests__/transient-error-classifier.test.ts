/**
 * Unit tests for isTransientStreamError — the shared transient error classifier
 * used by all provider adapters and the dual-stream merger.
 *
 * These tests guard against regression of the case-sensitivity fix (message.toLowerCase())
 * and the removal of the overly broad (item && not found) pattern that was replaced by
 * the precise 'no item with id' pattern targeting OpenAI Responses API stale references.
 *
 * @see ../provider-adapters/base-adapter.ts
 */

import { describe, it, expect } from '@jest/globals';
import { isTransientStreamError } from '../provider-adapters/base-adapter';

function makeError(message: string): Error {
  return new Error(message);
}

describe('isTransientStreamError', () => {
  describe('transient patterns — should return true', () => {
    it('matches "No output generated" (exact)', () => {
      expect(isTransientStreamError(makeError('No output generated'))).toBe(true);
    });

    it('matches "no output generated" (lowercase)', () => {
      expect(isTransientStreamError(makeError('no output generated'))).toBe(true);
    });

    // Note: "no output generated" is a substring match and will classify any error
    // containing this phrase as transient. This is intentional — the phrase is specific
    // enough that false positives are unlikely in practice. If a false positive is
    // discovered, tighten the pattern and add a test case here.
    it('matches embedded "no output generated" (substring)', () => {
      expect(isTransientStreamError(makeError('Provider returned: no output generated for request'))).toBe(true);
    });

    it('matches "timeout" (lowercase)', () => {
      expect(isTransientStreamError(makeError('Request timeout after 30s'))).toBe(true);
    });

    it('matches "Timeout" (mixed case)', () => {
      expect(isTransientStreamError(makeError('Connection Timeout'))).toBe(true);
    });

    it('matches "TIMEOUT" (uppercase)', () => {
      expect(isTransientStreamError(makeError('TIMEOUT: upstream did not respond'))).toBe(true);
    });

    it('matches "ECONNRESET"', () => {
      expect(isTransientStreamError(makeError('read ECONNRESET'))).toBe(true);
    });

    it('matches "econnreset" (lowercase)', () => {
      expect(isTransientStreamError(makeError('socket hang up econnreset'))).toBe(true);
    });

    it('matches "ETIMEDOUT"', () => {
      expect(isTransientStreamError(makeError('connect ETIMEDOUT 10.0.0.1:443'))).toBe(true);
    });

    it('matches "etimedout" (lowercase)', () => {
      expect(isTransientStreamError(makeError('etimedout'))).toBe(true);
    });

    it('matches OpenAI stale previous_response_id: "No item with id X was found"', () => {
      expect(isTransientStreamError(makeError('No item with id resp_abc123 was found'))).toBe(true);
    });

    it('matches OpenAI stale ref lowercase', () => {
      expect(isTransientStreamError(makeError('no item with id resp_xyz was found'))).toBe(true);
    });

    it('matches "Rate limit exceeded"', () => {
      expect(isTransientStreamError(makeError('Rate limit exceeded. Please try again later.'))).toBe(true);
    });

    it('matches "Too many requests"', () => {
      expect(isTransientStreamError(makeError('Too many requests'))).toBe(true);
    });

    it('matches "HTTP 429" status code in message', () => {
      expect(isTransientStreamError(makeError('HTTP 429: rate limited'))).toBe(true);
    });

    it('matches "status 429" in message', () => {
      expect(isTransientStreamError(makeError('Request failed with status 429'))).toBe(true);
    });

    it('does NOT match "42991a" (not a 429 status)', () => {
      expect(isTransientStreamError(makeError('Failed to parse response id 42991a'))).toBe(false);
    });

    it('does NOT match ":4299" port number', () => {
      expect(isTransientStreamError(makeError('Connection refused at host:4299'))).toBe(false);
    });
  });

  describe('non-transient patterns — should return false', () => {
    it('rejects generic "item not found" (old broad pattern removed in Round 4)', () => {
      expect(isTransientStreamError(makeError('Cache item not found'))).toBe(false);
    });

    it('rejects "Database item not found"', () => {
      expect(isTransientStreamError(makeError('Database item not found'))).toBe(false);
    });

    it('rejects "Config item not found in registry"', () => {
      expect(isTransientStreamError(makeError('Config item not found in registry'))).toBe(false);
    });

    it('rejects generic authentication error', () => {
      expect(isTransientStreamError(makeError('Authentication failed: invalid API key'))).toBe(false);
    });

    it('rejects invalid model error', () => {
      expect(isTransientStreamError(makeError('Model gpt-99 does not exist'))).toBe(false);
    });

    it('rejects permission error', () => {
      expect(isTransientStreamError(makeError('You do not have permission to access this model'))).toBe(false);
    });

    it('rejects empty string error', () => {
      expect(isTransientStreamError(makeError(''))).toBe(false);
    });

    it('rejects generic "not found" without "item"', () => {
      expect(isTransientStreamError(makeError('Resource not found'))).toBe(false);
    });

    it('rejects generic "item" without "not found"', () => {
      expect(isTransientStreamError(makeError('Processing item 42'))).toBe(false);
    });
  });
});
