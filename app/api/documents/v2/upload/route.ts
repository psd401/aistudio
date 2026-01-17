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
 * @see https://github.com/psd401/aistudio/issues/632
 */

export const runtime = 'nodejs';
// Increase max execution time to handle large file uploads; body size limits are configured elsewhere
export const maxDuration = 120;

/**
 * Parse and validate processing options from form data
 */
function parseProcessingOptions(processingOptionsRaw: string | null, log: ReturnType<typeof createLogger>) {
  const defaults = {
    extractText: true,
    convertToMarkdown: false,
    extractImages: false,
    generateEmbeddings: false,
    ocrEnabled: true,
  };

  if (!processingOptionsRaw) {
    return defaults;
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
    return defaults;
  }
}

async function uploadHandler(req: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer('api.documents.v2.upload');
  const log = createLogger({ requestId, route: 'api.documents.v2.upload' });

  try {
    // Authentication
    const session = await getServerSession();
    if (!session?.sub) {
      log.warn('Unauthorized request');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse multipart form data
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const purpose = (formData.get('purpose') as string) || 'chat';
    const processingOptionsRaw = formData.get('processingOptions') as string | null;

    if (!file) {
      log.warn('No file provided');
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Parse processing options
    const processingOptions = parseProcessingOptions(processingOptionsRaw, log);

    const fileName = file.name;
    const fileSize = file.size;
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
          details: validationResult.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`)
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

    log.info('Job created', { jobId: job.id });

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
      return NextResponse.json({ error: 'Service configuration error' }, { status: 500 });
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
    log.error(`Server-side upload failed: ${errorMessage}`, { name: errorName });
    timer({ status: 'error' });

    return NextResponse.json(
      { error: 'Failed to upload file' },
      { status: 500 }
    );
  }
}

// Export rate-limited handler (5 uploads per minute per user)
export const POST = apiRateLimit.upload(uploadHandler);
