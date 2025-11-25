import { describe, it, expect, beforeEach } from '@jest/globals';

// Mock @assistant-ui/react
jest.mock('@assistant-ui/react', () => ({
  AttachmentAdapter: class {},
  CompositeAttachmentAdapter: class {
    constructor() {
      // Mock constructor
    }
  },
  SimpleImageAttachmentAdapter: class {},
  SimpleTextAttachmentAdapter: class {},
}));

// Mock the logger to avoid console noise in tests
jest.mock('@/lib/client-logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock UUID generator
jest.mock('@/lib/utils/uuid', () => ({
  generateUUID: () => 'test-uuid-123',
}));

// Import after mocking
// eslint-disable-next-line import/first
import { HybridDocumentAdapter } from '../enhanced-attachment-adapters';

// Polyfill File.arrayBuffer() for Jest environment
if (typeof File !== 'undefined' && !File.prototype.arrayBuffer) {
  File.prototype.arrayBuffer = async function() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

describe('HybridDocumentAdapter', () => {
  let adapter: HybridDocumentAdapter;

  beforeEach(() => {
    adapter = new HybridDocumentAdapter();
  });

  describe('validateFileType', () => {
    // Helper to access private method for testing
    const validateFileType = async (file: File) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (adapter as any).validateFileType(file);
    };

    describe('CSV files', () => {
      it('should accept CSV files with text/csv MIME type', async () => {
        const file = new File(['name,value\ntest,123'], 'data.csv', {
          type: 'text/csv',
        });
        const result = await validateFileType(file);
        expect(result).toBe(true);
      });

      it('should accept CSV files with application/csv MIME type', async () => {
        const file = new File(['name,value\ntest,123'], 'data.csv', {
          type: 'application/csv',
        });
        const result = await validateFileType(file);
        expect(result).toBe(true);
      });

      it('should reject CSV files with incorrect MIME type', async () => {
        const file = new File(['name,value\ntest,123'], 'data.csv', {
          type: 'application/octet-stream',
        });
        const result = await validateFileType(file);
        expect(result).toBe(false);
      });

      it('should reject CSV files with text/html MIME type (XSS protection)', async () => {
        const file = new File(['<script>alert("xss")</script>'], 'data.csv', {
          type: 'text/html',
        });
        const result = await validateFileType(file);
        expect(result).toBe(false);
      });
    });

    describe('Text-based files', () => {
      it('should accept TXT files with text/plain MIME type', async () => {
        const file = new File(['Hello world'], 'document.txt', {
          type: 'text/plain',
        });
        const result = await validateFileType(file);
        expect(result).toBe(true);
      });

      it('should accept MD files with text/markdown MIME type', async () => {
        const file = new File(['# Heading'], 'readme.md', {
          type: 'text/markdown',
        });
        const result = await validateFileType(file);
        expect(result).toBe(true);
      });

      it('should accept JSON files with application/json MIME type', async () => {
        const file = new File(['{"key": "value"}'], 'data.json', {
          type: 'application/json',
        });
        const result = await validateFileType(file);
        expect(result).toBe(true);
      });

      it('should accept XML files with application/xml MIME type', async () => {
        const file = new File(['<root></root>'], 'data.xml', {
          type: 'application/xml',
        });
        const result = await validateFileType(file);
        expect(result).toBe(true);
      });

      it('should accept YAML files with application/x-yaml MIME type', async () => {
        const file = new File(['key: value'], 'config.yaml', {
          type: 'application/x-yaml',
        });
        const result = await validateFileType(file);
        expect(result).toBe(true);
      });
    });

    describe('PDF files (magic bytes)', () => {
      it('should accept PDF files with correct magic bytes', async () => {
        // %PDF magic bytes: 0x25 0x50 0x44 0x46
        // Need at least 8 bytes for validation
        const pdfHeader = new Uint8Array([
          0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34,
          0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a
        ]);
        const file = new File([pdfHeader], 'document.pdf', {
          type: 'application/pdf',
        });
        const result = await validateFileType(file);
        expect(result).toBe(true);
      });

      it('should reject files with .pdf extension but wrong magic bytes', async () => {
        const file = new File(['not a pdf file'], 'fake.pdf', {
          type: 'application/pdf',
        });
        const result = await validateFileType(file);
        expect(result).toBe(false);
      });
    });

    describe('Office files (magic bytes)', () => {
      it('should accept DOCX files with ZIP magic bytes', async () => {
        // ZIP magic bytes (Office 2007+): 0x50 0x4B 0x03 0x04
        // Need at least 8 bytes for validation
        const zipHeader = new Uint8Array([
          0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00,
          0x08, 0x00, 0x00, 0x00, 0x21, 0x00
        ]);
        const file = new File([zipHeader], 'document.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        const result = await validateFileType(file);
        expect(result).toBe(true);
      });

      it('should reject DOCX files with wrong magic bytes', async () => {
        const file = new File(['not a docx file'], 'fake.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        const result = await validateFileType(file);
        expect(result).toBe(false);
      });
    });

    describe('Edge cases', () => {
      it('should reject files without extensions', async () => {
        const file = new File(['data'], 'noextension', {
          type: 'text/plain',
        });
        const result = await validateFileType(file);
        expect(result).toBe(false);
      });

      it('should reject empty files', async () => {
        const file = new File([], 'empty.csv', { type: 'text/csv' });
        const result = await validateFileType(file);
        expect(result).toBe(false);
      });

      it('should handle files with multiple dots in name', async () => {
        const file = new File(['data'], 'my.file.name.csv', {
          type: 'text/csv',
        });
        const result = await validateFileType(file);
        expect(result).toBe(true);
      });

      it('should handle uppercase extensions', async () => {
        const file = new File(['data'], 'FILE.CSV', { type: 'text/csv' });
        const result = await validateFileType(file);
        expect(result).toBe(true);
      });
    });

    describe('Security validation', () => {
      it('should reject unsupported file types', async () => {
        const file = new File(['#!/bin/bash'], 'script.sh', {
          type: 'application/x-sh',
        });
        const result = await validateFileType(file);
        expect(result).toBe(false);
      });

      it('should reject executable files', async () => {
        const file = new File(['MZ'], 'malware.exe', {
          type: 'application/x-msdownload',
        });
        const result = await validateFileType(file);
        expect(result).toBe(false);
      });
    });
  });
});
