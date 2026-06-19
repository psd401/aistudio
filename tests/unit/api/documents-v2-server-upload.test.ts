// Unit tests for /api/documents/v2/upload — regression coverage for issue #1017 (FS#148338).

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// AWS SDK mocks — must be declared before any imports that pull in SDK clients
// ---------------------------------------------------------------------------
const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn(),
  CreateMultipartUploadCommand: jest.fn(),
  UploadPartCommand: jest.fn(),
  CompleteMultipartUploadCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: jest.fn() })),
  SendMessageCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: jest.fn() })),
  PutItemCommand: jest.fn(),
  QueryCommand: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Application-layer mocks
// ---------------------------------------------------------------------------
jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  generateRequestId: jest.fn(() => 'test-request-id'),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((d: unknown) => d),
}));

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

// Bypass rate limiting so tests focus on handler logic.
// IMPORTANT: outer-scope mock* variable required — SWC hoists jest.mock()
// factories that reference outer-scope variables whose names start with "mock".
// Factories with only inline jest.fn() calls are NOT reliably hoisted, which
// causes the real withRateLimit to run and hit `response instanceof NextResponse`
// (TypeError) because tests/setup.ts mocks NextResponse as a plain object.
const mockApiRateLimitUpload = jest.fn().mockImplementation(h => h);

jest.mock('@/lib/rate-limit', () => ({
  apiRateLimit: {
    upload: mockApiRateLimitUpload,
  },
}));

// ---------------------------------------------------------------------------
// Route import — after all mocks are set up
// ---------------------------------------------------------------------------
import { POST } from '@/app/api/documents/v2/upload/route';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
const SESSION_WITH_SUB = { sub: 'user-abc', user: { id: 'user-abc', email: 'test@example.com' } };

/** Create a minimal fake File suitable for formData.append */
function makeFakeFile(name: string, type: string, sizeBytes = 1024): File {
  const bytes = new Uint8Array(sizeBytes).fill(0x20);
  // Minimal stream stub so route can call file.stream() without crashing
  const file = new File([bytes], name, { type });
  return file;
}

/** Build a NextRequest with a multipart FormData body */
function buildUploadRequest(file: File, extra?: Record<string, string>): NextRequest {
  const formData = new FormData();
  formData.append('file', file);
  // Only append the default purpose if the caller hasn't overridden it — FormData.get()
  // returns the first value, so appending a default before the override would shadow it.
  if (!extra?.purpose) {
    formData.append('purpose', 'chat');
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      formData.append(k, v);
    }
  }

  // NextRequest needs a real Request-like body — use a stub that returns our FormData
  const req = {
    formData: async () => formData,
    headers: new Headers({ 'x-forwarded-for': '127.0.0.1' }),
  } as unknown as NextRequest;

  return req;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
const originalEnv = process.env;

beforeEach(() => {
  process.env = {
    ...originalEnv,
    NODE_ENV: 'test',
    DOCUMENTS_BUCKET_NAME: 'test-bucket',
  };
});

afterEach(() => {
  process.env = originalEnv;
  jest.clearAllMocks();
  mockS3Send.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/documents/v2/upload', () => {
  // -----------------------------------------------------------------------
  // Authentication guard — regression tests for issue #1017
  // -----------------------------------------------------------------------
  describe('authentication', () => {
    it('returns 401 when there is no session (unauthenticated user)', async () => {
      const { getServerSession } = require('@/lib/auth/server-session');
      getServerSession.mockResolvedValue(null);

      const req = buildUploadRequest(makeFakeFile('test.pdf', 'application/pdf'));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when session exists but sub is missing or falsy', async () => {
      // This can happen mid-OAuth when Cognito hasn't yet issued the JWT sub claim
      const { getServerSession } = require('@/lib/auth/server-session');
      getServerSession.mockResolvedValue({ user: { email: 'pending@example.com' } });

      const req = buildUploadRequest(makeFakeFile('test.pdf', 'application/pdf'));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when session.sub is an empty string', async () => {
      const { getServerSession } = require('@/lib/auth/server-session');
      getServerSession.mockResolvedValue({ sub: '', user: {} });

      const req = buildUploadRequest(makeFakeFile('doc.pdf', 'application/pdf'));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('does NOT call createDocumentJob when auth fails', async () => {
      const { getServerSession } = require('@/lib/auth/server-session');
      const { createDocumentJob } = require('@/lib/services/document-job-service');
      getServerSession.mockResolvedValue(null);

      const req = buildUploadRequest(makeFakeFile('test.pdf', 'application/pdf'));
      await POST(req);

      expect(createDocumentJob).not.toHaveBeenCalled();
    });

    it('does NOT call uploadToS3 when auth fails', async () => {
      const { getServerSession } = require('@/lib/auth/server-session');
      const { uploadToS3 } = require('@/lib/aws/document-upload');
      getServerSession.mockResolvedValue(null);

      const req = buildUploadRequest(makeFakeFile('test.pdf', 'application/pdf'));
      await POST(req);

      expect(uploadToS3).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Request validation
  // -----------------------------------------------------------------------
  describe('validation', () => {
    it('returns 400 when no file is provided', async () => {
      const { getServerSession } = require('@/lib/auth/server-session');
      getServerSession.mockResolvedValue(SESSION_WITH_SUB);

      const formData = new FormData();
      formData.append('purpose', 'chat');
      const req = { formData: async () => formData } as unknown as NextRequest;

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.code).toBe('NO_FILE');
    });

    it('returns 400 for an unsupported purpose value', async () => {
      const { getServerSession } = require('@/lib/auth/server-session');
      getServerSession.mockResolvedValue(SESSION_WITH_SUB);

      // The Zod schema only allows 'chat' | 'repository' | 'assistant'
      const file = makeFakeFile('report.pdf', 'application/pdf', 100);
      const req = buildUploadRequest(file, { purpose: 'invalid-purpose' });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Successful upload path
  // -----------------------------------------------------------------------
  describe('successful upload', () => {
    beforeEach(() => {
      const { getServerSession } = require('@/lib/auth/server-session');
      const { createDocumentJob, confirmDocumentUpload } = require('@/lib/services/document-job-service');
      const { uploadToS3 } = require('@/lib/aws/document-upload');
      const { sendToProcessingQueue } = require('@/lib/aws/lambda-trigger');

      getServerSession.mockResolvedValue(SESSION_WITH_SUB);
      createDocumentJob.mockResolvedValue({ id: 'job-xyz' });
      uploadToS3.mockResolvedValue({
        s3Key: 'uploads/job-xyz/test.pdf',
        sanitizedFileName: 'test.pdf',
      });
      confirmDocumentUpload.mockResolvedValue(undefined);
      sendToProcessingQueue.mockResolvedValue(undefined);
    });

    it('returns 200 with jobId when upload succeeds', async () => {
      const req = buildUploadRequest(makeFakeFile('test.pdf', 'application/pdf'));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.jobId).toBe('job-xyz');
      expect(body.status).toBe('processing');
    });

    it('creates a document job with the authenticated user id', async () => {
      const { createDocumentJob } = require('@/lib/services/document-job-service');
      const req = buildUploadRequest(makeFakeFile('report.pdf', 'application/pdf', 2048));
      await POST(req);

      expect(createDocumentJob).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-abc' })
      );
    });

    it('calls uploadToS3 with the job id', async () => {
      const { uploadToS3 } = require('@/lib/aws/document-upload');
      const req = buildUploadRequest(makeFakeFile('slides.pdf', 'application/pdf'));
      await POST(req);

      expect(uploadToS3).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-xyz' })
      );
    });

    it('calls confirmDocumentUpload after the S3 upload', async () => {
      const { confirmDocumentUpload } = require('@/lib/services/document-job-service');
      const req = buildUploadRequest(makeFakeFile('doc.pdf', 'application/pdf'));
      await POST(req);

      expect(confirmDocumentUpload).toHaveBeenCalledWith('job-xyz', 'job-xyz');
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe('error handling', () => {
    beforeEach(() => {
      const { getServerSession } = require('@/lib/auth/server-session');
      getServerSession.mockResolvedValue(SESSION_WITH_SUB);
    });

    it('returns 503 when S3 upload fails with storage error', async () => {
      const { createDocumentJob } = require('@/lib/services/document-job-service');
      const { uploadToS3 } = require('@/lib/aws/document-upload');
      createDocumentJob.mockResolvedValue({ id: 'job-err' });
      uploadToS3.mockRejectedValue(new Error('S3 upload to bucket failed'));

      const req = buildUploadRequest(makeFakeFile('big.pdf', 'application/pdf'));
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.code).toBe('STORAGE_UNAVAILABLE');
    });

    it('returns 503 (JOB_SERVICE_UNAVAILABLE) when createDocumentJob throws a DynamoDB error', async () => {
      const { createDocumentJob } = require('@/lib/services/document-job-service');
      const { uploadToS3 } = require('@/lib/aws/document-upload');
      createDocumentJob.mockRejectedValue(new Error('DynamoDB connection failed'));
      uploadToS3.mockResolvedValue({
        s3Key: 'uploads/job-err/test.pdf',
        sanitizedFileName: 'test.pdf',
      });

      const req = buildUploadRequest(makeFakeFile('doc.pdf', 'application/pdf'));
      const res = await POST(req);
      const dynBody = await res.json();

      // 'DynamoDB connection failed' matches the 'dynamodb' ERROR_PATTERN → JOB_SERVICE_UNAVAILABLE (503)
      expect(res.status).toBe(503);
      expect(dynBody.code).toBe('JOB_SERVICE_UNAVAILABLE');
    });
  });
});
