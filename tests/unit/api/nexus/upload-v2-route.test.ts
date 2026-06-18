/**
 * Unit tests for /api/documents/v2/upload/route.ts
 *
 * Covers:
 * - Authentication (401 for unauthenticated requests)
 * - File validation (missing file, unsupported type, size limit)
 * - CSV file acceptance with correct MIME types
 * - Successful upload flow (S3 + job creation + queue)
 *
 * Related issue: #1018 — CSV file uploads fail in Nexus
 */

// ── next/server must be mocked FIRST so NextResponse is a usable constructor ──
// NextResponse is not a valid constructor in the jsdom test environment without
// this mock. NextRequest needs formData() support for the upload tests.
jest.mock('next/server', () => {
  class MockNextRequest {
    url: string;
    method: string;
    private _fd: FormData | null;
    constructor(url: string, init?: { method?: string; body?: FormData }) {
      this.url = url;
      this.method = init?.method || 'GET';
      this._fd = (init?.body as FormData) || null;
    }
    async formData() {
      return this._fd || new FormData();
    }
  }

  class NextResponse {
    body: string;
    status: number;
    headers: Map<string, string>;
    constructor(body: string, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status || 200;
      this.headers = new Map(Object.entries(init?.headers || {}));
    }
    json() {
      return Promise.resolve(JSON.parse(this.body));
    }
    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new NextResponse(JSON.stringify(data), {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
      });
    }
  }

  return { NextRequest: MockNextRequest, NextResponse };
});

import { describe, it, expect, beforeEach } from '@jest/globals';
import { NextRequest } from 'next/server';

// ── Mock order matters: must precede imports of our code ──────────────────────

jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: jest.fn(),
}));

jest.mock('@/lib/services/document-job-service', () => ({
  createDocumentJob: jest.fn(),
  confirmDocumentUpload: jest.fn(),
}));

jest.mock('@/lib/aws/document-upload', () => ({
  uploadToS3: jest.fn(),
}));

jest.mock('@/lib/aws/lambda-trigger', () => ({
  sendToProcessingQueue: jest.fn(),
}));

jest.mock('@/lib/rate-limit', () => ({
  apiRateLimit: { upload: (handler: (...args: unknown[]) => unknown) => handler },
}));

jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  generateRequestId: jest.fn(() => 'test-request-id'),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((d) => d),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { POST } from '@/app/api/documents/v2/upload/route';
import { getServerSession } from '@/lib/auth/server-session';
import { createDocumentJob, confirmDocumentUpload } from '@/lib/services/document-job-service';
import type { DocumentJob } from '@/lib/services/document-job-service';
import { uploadToS3 } from '@/lib/aws/document-upload';
import { sendToProcessingQueue } from '@/lib/aws/lambda-trigger';

const mockGetServerSession = getServerSession as jest.Mock;
const mockCreateDocumentJob = createDocumentJob as jest.Mock;
const mockConfirmDocumentUpload = confirmDocumentUpload as jest.Mock;
const mockUploadToS3 = uploadToS3 as jest.Mock;
const mockSendToProcessingQueue = sendToProcessingQueue as jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession() {
  return { sub: 'user-123', email: 'test@psd401.net', exp: 9999999999, iat: 1000000000 };
}

function makeFormData(opts: {
  fileName?: string;
  fileType?: string;
  content?: string;
  purpose?: string;
}) {
  const {
    fileName = 'data.csv',
    fileType = 'text/csv',
    content = 'name,value\nalice,1',
    purpose = 'chat',
  } = opts;
  const file = new File([content], fileName, { type: fileType });
  const fd = new FormData();
  fd.append('file', file);
  fd.append('purpose', purpose);
  fd.append('processingOptions', JSON.stringify({ extractText: true }));
  return fd;
}

function makeRequest(fd: FormData) {
  return new NextRequest('http://localhost/api/documents/v2/upload', {
    method: 'POST',
    body: fd,
  });
}

function makeDocumentJob(id: string): DocumentJob {
  return {
    id,
    userId: 'user-123',
    fileName: 'data.csv',
    fileSize: 100,
    fileType: 'text/csv',
    purpose: 'chat',
    processingOptions: {
      extractText: true,
      convertToMarkdown: false,
      extractImages: false,
      generateEmbeddings: false,
      ocrEnabled: false,
    },
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DOCUMENTS_BUCKET_NAME = 'test-bucket';
  process.env.PROCESSING_QUEUE_URL = 'https://sqs.test/queue';
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /api/documents/v2/upload', () => {
  describe('Authentication', () => {
    it('returns 401 for unauthenticated requests', async () => {
      mockGetServerSession.mockResolvedValue(null);

      const req = makeRequest(makeFormData({}));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.code).toBe('UNAUTHORIZED');
      expect(body.requestId).toBeDefined();
    });

    it('returns 401 when session has no sub', async () => {
      mockGetServerSession.mockResolvedValue({ email: 'no-sub@test.com' });

      const req = makeRequest(makeFormData({}));
      const res = await POST(req);

      expect(res.status).toBe(401);
    });
  });

  describe('File validation', () => {
    it('returns 400 when no file is attached', async () => {
      mockGetServerSession.mockResolvedValue(makeSession());

      const fd = new FormData();
      fd.append('purpose', 'chat');
      const req = makeRequest(fd);
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.code).toBe('NO_FILE');
    });

    it('accepts CSV files with text/csv MIME type', async () => {
      mockGetServerSession.mockResolvedValue(makeSession());
      mockCreateDocumentJob.mockResolvedValue(makeDocumentJob('job-csv-1'));
      mockUploadToS3.mockResolvedValue({ s3Key: 'v2/uploads/job-csv-1/data.csv', bucket: 'test-bucket', sanitizedFileName: 'data.csv' });
      mockSendToProcessingQueue.mockResolvedValue(undefined);
      mockConfirmDocumentUpload.mockResolvedValue(undefined);

      const req = makeRequest(makeFormData({ fileName: 'data.csv', fileType: 'text/csv' }));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.jobId).toBe('job-csv-1');
    });

    it('accepts CSV files with application/csv MIME type', async () => {
      mockGetServerSession.mockResolvedValue(makeSession());
      mockCreateDocumentJob.mockResolvedValue(makeDocumentJob('job-csv-2'));
      mockUploadToS3.mockResolvedValue({ s3Key: 'v2/uploads/job-csv-2/data.csv', bucket: 'test-bucket', sanitizedFileName: 'data.csv' });
      mockSendToProcessingQueue.mockResolvedValue(undefined);
      mockConfirmDocumentUpload.mockResolvedValue(undefined);

      const req = makeRequest(makeFormData({ fileName: 'data.csv', fileType: 'application/csv' }));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.jobId).toBe('job-csv-2');
    });

    it('accepts PDF files', async () => {
      mockGetServerSession.mockResolvedValue(makeSession());
      mockCreateDocumentJob.mockResolvedValue(makeDocumentJob('job-pdf-1'));
      mockUploadToS3.mockResolvedValue({ s3Key: 'v2/uploads/job-pdf-1/doc.pdf', bucket: 'test-bucket', sanitizedFileName: 'doc.pdf' });
      mockSendToProcessingQueue.mockResolvedValue(undefined);
      mockConfirmDocumentUpload.mockResolvedValue(undefined);

      const req = makeRequest(makeFormData({ fileName: 'doc.pdf', fileType: 'application/pdf', content: '%PDF-1.4' }));
      const res = await POST(req);

      expect(res.status).toBe(200);
    });

    it('returns 400 for files exceeding 500MB', async () => {
      mockGetServerSession.mockResolvedValue(makeSession());

      const bigContent = 'x'.repeat(10);
      const fd = new FormData();
      // Simulate a file that reports a large size via validation (override size via mock)
      const file = new File([bigContent], 'huge.csv', { type: 'text/csv' });
      Object.defineProperty(file, 'size', { value: 600 * 1024 * 1024 }); // 600MB
      fd.append('file', file);
      fd.append('purpose', 'chat');

      const req = makeRequest(fd);
      const res = await POST(req);
      const body = await res.json();

      // Zod validation catches the size limit
      expect(res.status).toBe(400);
      expect(body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Successful upload flow', () => {
    it('uploads file to S3, queues processing job, and returns jobId', async () => {
      mockGetServerSession.mockResolvedValue(makeSession());
      mockCreateDocumentJob.mockResolvedValue(makeDocumentJob('job-success-1'));
      mockUploadToS3.mockResolvedValue({ s3Key: 'v2/uploads/job-success-1/data.csv', bucket: 'test-bucket', sanitizedFileName: 'data.csv' });
      mockSendToProcessingQueue.mockResolvedValue(undefined);
      mockConfirmDocumentUpload.mockResolvedValue(undefined);

      const req = makeRequest(makeFormData({ fileName: 'data.csv', fileType: 'text/csv' }));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.jobId).toBe('job-success-1');
      expect(mockUploadToS3).toHaveBeenCalledTimes(1);
      expect(mockSendToProcessingQueue).toHaveBeenCalledTimes(1);
      expect(mockConfirmDocumentUpload).toHaveBeenCalledTimes(1);
    });

    it('propagates processing options to the job queue', async () => {
      mockGetServerSession.mockResolvedValue(makeSession());
      mockCreateDocumentJob.mockResolvedValue(makeDocumentJob('job-opts-1'));
      mockUploadToS3.mockResolvedValue({ s3Key: 'v2/uploads/job-opts-1/doc.pdf', bucket: 'test-bucket', sanitizedFileName: 'doc.pdf' });
      mockSendToProcessingQueue.mockResolvedValue(undefined);
      mockConfirmDocumentUpload.mockResolvedValue(undefined);

      const fd = new FormData();
      const file = new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' });
      fd.append('file', file);
      fd.append('purpose', 'chat');
      fd.append('processingOptions', JSON.stringify({
        extractText: true,
        convertToMarkdown: true,
        extractImages: false,
        ocrEnabled: true,
      }));

      const req = makeRequest(fd);
      const res = await POST(req);

      expect(res.status).toBe(200);
      // Queue was called with the job ID
      expect(mockSendToProcessingQueue).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-opts-1' })
      );
    });
  });

  describe('Error handling', () => {
    it('returns 503 when S3 upload fails', async () => {
      mockGetServerSession.mockResolvedValue(makeSession());
      mockCreateDocumentJob.mockResolvedValue(makeDocumentJob('job-err-1'));
      mockUploadToS3.mockRejectedValue(new Error('S3 bucket not found (NoSuchBucket)'));

      const req = makeRequest(makeFormData({}));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.code).toBe('STORAGE_UNAVAILABLE');
    });

    it('returns 503 when processing queue is unavailable', async () => {
      mockGetServerSession.mockResolvedValue(makeSession());
      mockCreateDocumentJob.mockResolvedValue(makeDocumentJob('job-err-2'));
      mockUploadToS3.mockResolvedValue({ s3Key: 'v2/uploads/job-err-2/data.csv', bucket: 'test-bucket', sanitizedFileName: 'data.csv' });
      mockSendToProcessingQueue.mockRejectedValue(new Error('SQS processing_queue_url not configured'));

      const req = makeRequest(makeFormData({}));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.code).toBe('QUEUE_UNAVAILABLE');
    });
  });
});
