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

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
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
  apiRateLimit: jest.fn().mockResolvedValue(null),
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
import { uploadToS3 } from '@/lib/aws/document-upload';
import { sendToProcessingQueue } from '@/lib/aws/lambda-trigger';

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockCreateDocumentJob = createDocumentJob as jest.MockedFunction<typeof createDocumentJob>;
const mockConfirmDocumentUpload = confirmDocumentUpload as jest.MockedFunction<typeof confirmDocumentUpload>;
const mockUploadToS3 = uploadToS3 as jest.MockedFunction<typeof uploadToS3>;
const mockSendToProcessingQueue = sendToProcessingQueue as jest.MockedFunction<typeof sendToProcessingQueue>;

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
      // @ts-expect-error intentionally testing malformed session
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
      mockCreateDocumentJob.mockResolvedValue({ jobId: 'job-csv-1', s3Key: 'uploads/job-csv-1/data.csv' });
      mockUploadToS3.mockResolvedValue(undefined);
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
      mockCreateDocumentJob.mockResolvedValue({ jobId: 'job-csv-2', s3Key: 'uploads/job-csv-2/data.csv' });
      mockUploadToS3.mockResolvedValue(undefined);
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
      mockCreateDocumentJob.mockResolvedValue({ jobId: 'job-pdf-1', s3Key: 'uploads/job-pdf-1/doc.pdf' });
      mockUploadToS3.mockResolvedValue(undefined);
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
      mockCreateDocumentJob.mockResolvedValue({ jobId: 'job-success-1', s3Key: 'uploads/job-success-1/data.csv' });
      mockUploadToS3.mockResolvedValue(undefined);
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
      mockCreateDocumentJob.mockResolvedValue({ jobId: 'job-opts-1', s3Key: 'uploads/job-opts-1/doc.pdf' });
      mockUploadToS3.mockResolvedValue(undefined);
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
      mockCreateDocumentJob.mockResolvedValue({ jobId: 'job-err-1', s3Key: 'uploads/job-err-1/data.csv' });
      mockUploadToS3.mockRejectedValue(new Error('S3 bucket not found (NoSuchBucket)'));

      const req = makeRequest(makeFormData({}));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.code).toBe('STORAGE_UNAVAILABLE');
    });

    it('returns 503 when processing queue is unavailable', async () => {
      mockGetServerSession.mockResolvedValue(makeSession());
      mockCreateDocumentJob.mockResolvedValue({ jobId: 'job-err-2', s3Key: 'uploads/job-err-2/data.csv' });
      mockUploadToS3.mockResolvedValue(undefined);
      mockSendToProcessingQueue.mockRejectedValue(new Error('SQS processing_queue_url not configured'));

      const req = makeRequest(makeFormData({}));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.code).toBe('QUEUE_UNAVAILABLE');
    });
  });
});
