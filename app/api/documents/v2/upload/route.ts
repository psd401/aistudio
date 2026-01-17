import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { createDocumentJob, confirmDocumentUpload } from '@/lib/services/document-job-service';
import { uploadToS3 } from '@/lib/aws/document-upload';
import { sendToProcessingQueue } from '@/lib/aws/lambda-trigger';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

/**
 * Server-side upload endpoint that proxies file uploads through the application server to S3.
 *
 * This endpoint bypasses school network restrictions that block direct S3 presigned URL uploads.
 * The flow is: Client → aistudio.psd401.ai/api/upload → S3
 *
 * @see https://github.com/psd401/aistudio/issues/632
 */

// Size limits based on purpose - matching initiate-upload limits
const LIMITS = {
  chat: 100 * 1024 * 1024,      // 100MB for chat
  repository: 500 * 1024 * 1024, // 500MB for repositories
  assistant: 50 * 1024 * 1024    // 50MB for assistant building
} as const;

// Supported file types - matching initiate-upload
const SUPPORTED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/msword', // .doc
  'application/vnd.ms-excel', // .xls
  'application/vnd.ms-powerpoint', // .ppt
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
  'application/x-yaml',
  'text/yaml',
  'text/x-yaml',
];

export const runtime = 'nodejs';
// Increase body size limit for file uploads (100MB max)
export const maxDuration = 120;

export async function POST(req: NextRequest) {
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

    // Validate purpose
    if (!['chat', 'repository', 'assistant'].includes(purpose)) {
      log.warn('Invalid purpose', { purpose });
      return NextResponse.json({ error: 'Invalid purpose' }, { status: 400 });
    }

    const validPurpose = purpose as 'chat' | 'repository' | 'assistant';

    // Parse processing options with defaults
    let processingOptions = {
      extractText: true,
      convertToMarkdown: false,
      extractImages: false,
      generateEmbeddings: false,
      ocrEnabled: true,
    };

    if (processingOptionsRaw) {
      try {
        const parsed = JSON.parse(processingOptionsRaw);
        processingOptions = {
          extractText: parsed.extractText ?? true,
          convertToMarkdown: parsed.convertToMarkdown ?? false,
          extractImages: parsed.extractImages ?? false,
          generateEmbeddings: parsed.generateEmbeddings ?? false,
          ocrEnabled: parsed.ocrEnabled ?? true,
        };
      } catch {
        log.warn('Invalid processingOptions JSON, using defaults');
      }
    }

    const fileName = file.name;
    const fileSize = file.size;
    const fileType = file.type;

    log.info('Server-side upload request', {
      fileName,
      fileSize,
      fileType,
      purpose: validPurpose,
      userId: session.userId
    });

    // Validate file size
    const maxSize = LIMITS[validPurpose];
    if (fileSize > maxSize) {
      log.warn('File size exceeds limit', {
        fileSize,
        limit: maxSize,
        purpose: validPurpose
      });
      return NextResponse.json(
        { error: `File exceeds ${validPurpose} limit of ${maxSize / (1024*1024)}MB` },
        { status: 400 }
      );
    }

    // Validate file type
    if (!SUPPORTED_TYPES.includes(fileType)) {
      log.warn('Unsupported file type', { fileType });
      return NextResponse.json(
        { error: `Unsupported file type: ${fileType}` },
        { status: 400 }
      );
    }

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

    // Step 2: Upload file to S3 using SDK (bypasses presigned URL)
    const s3Result = await uploadToS3({
      jobId: job.id,
      fileName,
      fileBuffer: Buffer.from(await file.arrayBuffer()),
      contentType: fileType,
    });

    log.info('File uploaded to S3', { jobId: job.id, s3Key: s3Result.s3Key });

    // Step 3: Confirm upload
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
