import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { createDocumentJob, confirmDocumentUpload } from '@/lib/services/document-job-service';
import { uploadToS3 } from '@/lib/aws/document-upload';
import { sendToProcessingQueue } from '@/lib/aws/lambda-trigger';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { UploadRequestSchema } from '@/lib/validation/document-upload.validation';
import { apiRateLimit } from '@/lib/rate-limit';

/**
 * Server-side upload endpoint that proxies file uploads through the application server to S3.
 *
 * This endpoint bypasses school network restrictions that block direct S3 presigned URL uploads.
 * The flow is: Client → aistudio.psd401.ai/api/upload → S3
 *
 * ## Body Size Limits
 * - Validation allows up to 500MB (see UploadRequestSchema)
 * - IMPORTANT: Actual upload limit depends on infrastructure configuration:
 *   - ECS task memory allocation
 *   - ALB request timeout/size limits
 *   - Next.js formData() loads entire file into memory before streaming to S3
 *
 * ## Memory Considerations
 * - req.formData() loads the file into memory (Next.js limitation)
 * - 500MB file = 500MB+ memory per concurrent upload
 * - Rate limit: 5 uploads/min/user helps control concurrent memory usage
 * - ECS task memory should be ≥2GB for production deployments
 * - Monitor CloudWatch ECS memory metrics after deployment
 *
 * ## Security Note
 * - MIME type validation is string-based; actual file content validated by Lambda processor
 * - Magic bytes validation could be added here for defense-in-depth
 *
 * @see https://github.com/psd401/aistudio/issues/632
 */

export const runtime = 'nodejs';
export const maxDuration = 120; // 2 minutes for large file uploads

const DEFAULT_PROCESSING_OPTIONS = {
  extractText: true,
  convertToMarkdown: false,
  extractImages: false,
  generateEmbeddings: false,
  ocrEnabled: true,
};

/**
 * Parse and validate processing options from form data
 */
function parseProcessingOptions(processingOptionsRaw: string | null, log: ReturnType<typeof createLogger>) {
  if (!processingOptionsRaw) {
    return DEFAULT_PROCESSING_OPTIONS;
  }

  try {
    const parsed = JSON.parse(processingOptionsRaw);
    return {
      extractText: parsed.extractText ?? true,
      convertToMarkdown: parsed.convertToMarkdown ?? false,
      extractImages: parsed.extractImages ?? false,
      generateEmbeddings: parsed.generateEmbeddings ?? false,
      ocrEnabled: parsed.ocrEnabled ?? true,
    };
  } catch {
    log.warn('Invalid processingOptions JSON, using defaults');
    return DEFAULT_PROCESSING_OPTIONS;
  }
}

/** Error classification patterns with user-friendly messages */
const ERROR_PATTERNS: Array<{ patterns: string[]; message: string; status: number }> = [
  {
    patterns: ['file size', 'exceeds'],
    message: 'File size exceeds maximum allowed',
    status: 413
  },
  {
    patterns: ['file format', 'file type', 'unsupported format', 'invalid mime'],
    message: 'Invalid file format',
    status: 415
  },
  {
    patterns: ['request timeout', 'upload timeout', 'timed out', 'etimedout'],
    message: 'Upload timed out - please try again',
    status: 408
  },
  {
    patterns: ['s3', 'storage service', 'bucket'],
    message: 'Storage service temporarily unavailable',
    status: 503
  }
];

/**
 * Classify error and return user-friendly message with status code.
 * Uses specific patterns to avoid misclassifying unrelated errors.
 */
function classifyUploadError(errorMessage: string): { message: string; status: number } {
  const lowerMessage = errorMessage.toLowerCase();

  for (const { patterns, message, status } of ERROR_PATTERNS) {
    if (patterns.some(pattern => lowerMessage.includes(pattern))) {
      return { message, status };
    }
  }

  return { message: 'Failed to upload file', status: 500 };
}

async function uploadHandler(req: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer('api.documents.v2.upload');
  const log = createLogger({ requestId, route: 'api.documents.v2.upload' });

  // Track context for error reporting
  let fileName: string | undefined;
  let fileSize: number | undefined;
  let userId: string | undefined;
  let jobId: string | undefined;

  try {
    // Authentication
    const session = await getServerSession();
    if (!session?.sub) {
      log.warn('Unauthorized request');
      return NextResponse.json({ error: 'Unauthorized', requestId }, { status: 401 });
    }
    userId = session.sub;

    // Parse multipart form data
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const purpose = (formData.get('purpose') as string) || 'chat';
    const processingOptionsRaw = formData.get('processingOptions') as string | null;

    if (!file) {
      log.warn('No file provided');
      return NextResponse.json({ error: 'No file provided', requestId }, { status: 400 });
    }

    // Parse processing options
    const processingOptions = parseProcessingOptions(processingOptionsRaw, log);

    fileName = file.name;
    fileSize = file.size;
    const fileType = file.type;

    // Validate using shared Zod schema (ensures resource exhaustion protection)
    const validationResult = UploadRequestSchema.safeParse({
      fileName,
      fileSize,
      fileType,
      purpose,
      processingOptions,
    });

    if (!validationResult.success) {
      log.warn('Validation failed', { errors: validationResult.error.issues });
      return NextResponse.json(
        {
          error: 'Invalid request data',
          details: validationResult.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`),
          requestId
        },
        { status: 400 }
      );
    }

    const validPurpose = validationResult.data.purpose;

    log.info('Server-side upload request', {
      fileName,
      fileSize,
      fileType,
      purpose: validPurpose,
      userId: session.sub
    });

    // Step 1: Create job in DynamoDB
    const job = await createDocumentJob({
      fileName,
      fileSize,
      fileType,
      purpose: validPurpose,
      userId: session.sub,
      processingOptions
    });
    jobId = job.id;

    log.info('Job created', { jobId });

    // Step 2: Upload file to S3 using SDK with streaming (memory-efficient)
    // Uses File.stream() to avoid loading entire file into memory
    const s3Result = await uploadToS3({
      jobId: job.id,
      fileName,
      fileStream: file.stream(),
      contentType: fileType,
    });

    log.info('File uploaded to S3', { jobId: job.id, s3Key: s3Result.s3Key });

    // Step 3: Confirm upload
    // In the direct-upload flow there is no separate uploadId like in the presigned URL flow.
    // We intentionally use job.id for both jobId and uploadId here. The confirmDocumentUpload
    // function accepts both parameters to maintain API compatibility with the presigned URL flow,
    // but in this server-side upload pattern, they are the same identifier.
    await confirmDocumentUpload(job.id, job.id);

    // Step 4: Send to processing queue (matching confirm-upload flow)
    if (process.env.NODE_ENV !== 'test' && !process.env.DOCUMENTS_BUCKET_NAME) {
      log.error('DOCUMENTS_BUCKET_NAME environment variable not configured');
      return NextResponse.json({ error: 'Service configuration error', requestId }, { status: 500 });
    }

    await sendToProcessingQueue({
      jobId: job.id,
      bucket: process.env.DOCUMENTS_BUCKET_NAME || 'test-documents-bucket',
      key: s3Result.s3Key,
      fileName: s3Result.sanitizedFileName,
      fileSize,
      fileType,
      userId: session.sub,
      processingOptions,
    });

    log.info('Processing queued', { jobId: job.id });
    timer({ status: 'success' });

    return NextResponse.json({
      success: true,
      jobId: job.id,
      status: 'processing',
      message: 'Upload completed and processing started'
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : 'Unknown';
    const errorStack = error instanceof Error ? error.stack : undefined;

    log.error('Server-side upload failed', {
      error: errorMessage,
      name: errorName,
      stack: errorStack,
      fileName,
      fileSize,
      userId,
      jobId,
      requestId
    });

    timer({ status: 'error' });

    const { message, status } = classifyUploadError(errorMessage);
    return NextResponse.json({ error: message, requestId }, { status });
  }
}

// Export rate-limited handler (5 uploads per minute per user)
export const POST = apiRateLimit.upload(uploadHandler);
