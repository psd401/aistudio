import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { generatePresignedUrl, generateMultipartUrls } from '@/lib/aws/document-upload';
import { createDocumentJob } from '@/lib/services/document-job-service';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { z } from 'zod';
import { UploadRequestSchema } from '@/lib/validation/document-upload.validation';
import { legacyContentRetirementResponse } from '@/lib/repositories/content-platform/legacy-retirement-response';

const FILE_SIZE_LIMITS = {
  chat: 100 * 1024 * 1024,
  repository: 500 * 1024 * 1024,
  assistant: 50 * 1024 * 1024,
} as const;

const SUPPORTED_FILE_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
  'application/x-yaml',
  'text/yaml',
  'text/x-yaml',
] as const;

type UploadRequest = z.infer<typeof UploadRequestSchema>;
type UploadLogger = ReturnType<typeof createLogger>;

function validateUploadRequest(
  request: UploadRequest,
  log: UploadLogger,
): NextResponse | null {
  const limit = FILE_SIZE_LIMITS[request.purpose];
  if (request.fileSize > limit) {
    log.warn('File size exceeds limit', {
      fileSize: request.fileSize,
      limit,
      purpose: request.purpose,
    });
    return NextResponse.json(
      { error: `File exceeds ${request.purpose} limit of ${limit / (1024 * 1024)}MB` },
      { status: 400 },
    );
  }
  if (!SUPPORTED_FILE_TYPES.includes(
    request.fileType as (typeof SUPPORTED_FILE_TYPES)[number],
  )) {
    log.warn('Unsupported file type', { fileType: request.fileType });
    return NextResponse.json(
      { error: `Unsupported file type: ${request.fileType}` },
      { status: 400 },
    );
  }
  return null;
}

async function createUploadConfiguration(
  jobId: string,
  request: UploadRequest,
  log: UploadLogger,
) {
  if (request.fileSize < 10 * 1024 * 1024) {
    const uploadConfig = await generatePresignedUrl(jobId, request.fileName);
    log.info('Generated single presigned URL', { jobId });
    return uploadConfig;
  }
  const partSize = 5 * 1024 * 1024;
  const partCount = Math.ceil(request.fileSize / partSize);
  const uploadConfig = await generateMultipartUrls(
    jobId,
    request.fileName,
    partCount,
  );
  log.info('Generated multipart upload URLs', { jobId, partCount });
  return uploadConfig;
}

function uploadInitiationErrorResponse(
  error: unknown,
  log: UploadLogger,
  timer: ReturnType<typeof startTimer>,
): NextResponse {
  log.error('Failed to initiate upload', error);
  timer({ status: 'error' });
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: 'Invalid request data',
        details: error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`,
        ),
      },
      { status: 400 },
    );
  }
  return NextResponse.json(
    { error: 'Failed to initiate upload' },
    { status: 500 },
  );
}

async function authorizeUploadInitiation(
  log: UploadLogger,
): Promise<{ userId: string } | { response: NextResponse }> {
  const session = await getServerSession();
  if (!session?.sub) {
    log.warn('Unauthorized request');
    return {
      response: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      ),
    };
  }
  const retired = await legacyContentRetirementResponse();
  return retired
    ? { response: retired }
    : { userId: session.sub };
}

export async function POST(req: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer('api.documents.v2.initiate-upload');
  const log = createLogger({ requestId, route: 'api.documents.v2.initiate-upload' });
  
  try {
    const authorization = await authorizeUploadInitiation(log);
    if ('response' in authorization) return authorization.response;

    const body = await req.json();
    const validatedData = UploadRequestSchema.parse(body);
    
    const { fileName, fileSize, fileType, purpose, processingOptions } = validatedData;
    
    log.info('Upload initiation request', {
      fileName,
      fileSize,
      fileType,
      purpose,
      userId: authorization.userId
    });
    
    const validationResponse = validateUploadRequest(validatedData, log);
    if (validationResponse) {
      return validationResponse;
    }
    
    // Create job in DynamoDB for fast polling
    const job = await createDocumentJob({
      fileName,
      fileSize,
      fileType,
      purpose,
      userId: authorization.userId,
      processingOptions: {
        extractText: processingOptions?.extractText ?? true,
        convertToMarkdown: processingOptions?.convertToMarkdown ?? false,
        extractImages: processingOptions?.extractImages ?? false,
        generateEmbeddings: processingOptions?.generateEmbeddings ?? false,
        ocrEnabled: processingOptions?.ocrEnabled ?? true
      }
    });
    
    log.info('Job created', { jobId: job.id });
    
    // Generate presigned URL(s) based on file size
    const uploadConfig = await createUploadConfiguration(
      job.id,
      validatedData,
      log,
    );
    
    timer({ status: 'success' });
    
    return NextResponse.json({
      jobId: job.id,
      uploadId: uploadConfig.uploadId,
      uploadUrl: uploadConfig.url,
      uploadMethod: uploadConfig.method,
      partUrls: uploadConfig.partUrls,
      maxFileSize: FILE_SIZE_LIMITS[purpose],
      supportedTypes: SUPPORTED_FILE_TYPES,
    });
    
  } catch (error) {
    return uploadInitiationErrorResponse(error, log, timer);
  }
}
