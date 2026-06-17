/**
 * Unit tests for HybridDocumentAdapter.toSafeErrorMessage.
 *
 * Regression coverage for issue #1017 (FS#148338): when an unauthenticated
 * upload returns 401, the UNAUTHORIZED code must map to 'Authentication
 * required.' so the user sees a clear message in the attachment error state.
 *
 * We test the static method directly — no adapter instance required — because
 * the method is a pure lookup table with no side effects.
 */

import { jest } from '@jest/globals';

// HybridDocumentAdapter imports client-logger at module level.
// Mock it to prevent Node-environment issues with browser-only APIs.
jest.mock('@/lib/client-logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// generateUUID is used at module level via the adapter constructor; mock it
// to keep the test isolated.
jest.mock('@/lib/utils/uuid', () => ({
  generateUUID: jest.fn(() => 'test-uuid'),
}));

// assistant-ui/react exports complex React components — replace with stubs.
jest.mock('@assistant-ui/react', () => ({
  AttachmentAdapter: jest.fn(),
  CompositeAttachmentAdapter: jest.fn(),
  SimpleImageAttachmentAdapter: jest.fn(),
  SimpleTextAttachmentAdapter: jest.fn(),
}));

import { HybridDocumentAdapter } from '@/lib/nexus/enhanced-attachment-adapters';

describe('HybridDocumentAdapter.toSafeErrorMessage', () => {
  // -------------------------------------------------------------------------
  // Code-based lookup (primary path) — regression for issue #1017
  // -------------------------------------------------------------------------
  describe('code-based lookup', () => {
    it('maps UNAUTHORIZED code to "Authentication required." (issue #1017 regression)', () => {
      const msg = HybridDocumentAdapter.toSafeErrorMessage('Unauthorized', 'UNAUTHORIZED');
      expect(msg).toBe('Authentication required.');
    });

    it('maps UPLOAD_FAILED code', () => {
      const msg = HybridDocumentAdapter.toSafeErrorMessage('internal error', 'UPLOAD_FAILED');
      expect(msg).toBe('Upload failed.');
    });

    it('maps FILE_TOO_LARGE code', () => {
      const msg = HybridDocumentAdapter.toSafeErrorMessage('file too large', 'FILE_TOO_LARGE');
      expect(msg).toBe('File size exceeds the allowed limit.');
    });

    it('maps STORAGE_UNAVAILABLE code', () => {
      const msg = HybridDocumentAdapter.toSafeErrorMessage('s3 error', 'STORAGE_UNAVAILABLE');
      expect(msg).toBe('Storage service temporarily unavailable.');
    });

    it('maps UPLOAD_TIMEOUT code', () => {
      const msg = HybridDocumentAdapter.toSafeErrorMessage('timed out', 'UPLOAD_TIMEOUT');
      expect(msg).toBe('Upload timed out.');
    });

    it('maps INVALID_FORMAT code', () => {
      const msg = HybridDocumentAdapter.toSafeErrorMessage('bad format', 'INVALID_FORMAT');
      expect(msg).toBe('Invalid file format.');
    });

    it('maps CONFIG_ERROR code', () => {
      const msg = HybridDocumentAdapter.toSafeErrorMessage('config error', 'CONFIG_ERROR');
      expect(msg).toBe('Service configuration error.');
    });

    it('maps NO_FILE code', () => {
      const msg = HybridDocumentAdapter.toSafeErrorMessage('no file', 'NO_FILE');
      expect(msg).toBe('No file provided.');
    });

    it('maps VALIDATION_ERROR code', () => {
      const msg = HybridDocumentAdapter.toSafeErrorMessage('invalid', 'VALIDATION_ERROR');
      expect(msg).toBe('Invalid request data.');
    });
  });

  // -------------------------------------------------------------------------
  // Pattern-based fallback (for network errors without a code)
  // -------------------------------------------------------------------------
  describe('string-pattern fallback', () => {
    it('returns a safe message for network errors', () => {
      const msg = HybridDocumentAdapter.toSafeErrorMessage('network error during upload');
      expect(msg).toBe('Network error during upload.');
    });

    it('returns a safe message for processing timeouts', () => {
      const msg = HybridDocumentAdapter.toSafeErrorMessage('processing timeout occurred');
      expect(msg).toBe('Processing timed out.');
    });

    it('returns generic fallback for unknown error strings', () => {
      const msg = HybridDocumentAdapter.toSafeErrorMessage('totally unexpected xyzzy error 42');
      expect(msg).toBe('An unexpected error occurred during processing.');
    });

    it('does NOT leak raw server error messages to the LLM context', () => {
      // If an unknown error slips through, the safe message is always canned text —
      // never the raw string. This prevents indirect prompt injection.
      const rawServerMsg = 'INTERNAL ERROR: database connection string postgres://user:password@host/db failed';
      const msg = HybridDocumentAdapter.toSafeErrorMessage(rawServerMsg);
      expect(msg).not.toContain('password');
      expect(msg).not.toContain('postgres://');
    });
  });

  // -------------------------------------------------------------------------
  // Code takes priority over pattern matching
  // -------------------------------------------------------------------------
  describe('code priority over string patterns', () => {
    it('uses the code lookup even when the raw message also matches a pattern', () => {
      // UNAUTHORIZED code → 'Authentication required.' even if the raw message
      // contains text that could match a fallback pattern
      const msg = HybridDocumentAdapter.toSafeErrorMessage(
        'upload service temporarily unavailable due to unauthorized access',
        'UNAUTHORIZED'
      );
      // Code takes priority
      expect(msg).toBe('Authentication required.');
    });
  });
});
