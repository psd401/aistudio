import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { generatePresignedUrl, generateMultipartUrls } from '@/lib/aws/document-upload';
import { createDocumentJob } from '@/lib/services/document-job-service';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { z } from 'zod';
import { UploadRequestSchema } from '@/lib/validation/document-upload.validation';

export async function POST(req: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer('api.documents.v2.initiate-upload');
  const log = createLogger({ requestId, route: 'api.documents.v2.initiate-upload' });
  
  try {
    // Authentication
    const session = await getServerSession();
    if (!session?.sub) {
      log.warn('Unauthorized request');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const validatedData = UploadRequestSchema.parse(body);
    
    const { fileName, fileSize, fileType, purpose, processingOptions } = validatedData;
    
    log.info('Upload initiation request', {
      fileName,
      fileSize,
      fileType,
      purpose,
      userId: session.sub
    });
    
    // Validate file size limits based on purpose
    const limits = {
      chat: 100 * 1024 * 1024,      // 100MB for chat
      repository: 500 * 1024 * 1024, // 500MB for repositories
      assistant: 50 * 1024 * 1024    // 50MB for assistant building
    };
    
    if (fileSize > limits[purpose]) {
      log.warn('File size exceeds limit', {
        fileSize,
        limit: limits[purpose],
        purpose
      });
      return NextResponse.json(
        { error: `File exceeds ${purpose} limit of ${limits[purpose] / (1024*1024)}MB` },
        { status: 400 }
      );
    }

    // Validate file type
    const supportedTypes = [
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

    if (!supportedTypes.includes(fileType)) {
      log.warn('Unsupported file type', { fileType });
      return NextResponse.json(
        { error: `Unsupported file type: ${fileType}` },
        { status: 400 }
      );
    }
    
    // Create job in DynamoDB for fast polling
    const job = await createDocumentJob({
      fileName,
      fileSize,
      fileType,
      purpose,
      userId: session.sub,
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
    let uploadConfig;
    if (fileSize < 10 * 1024 * 1024) {
      // Single presigned URL for files under 10MB
      uploadConfig = await generatePresignedUrl(job.id, fileName);
      log.info('Generated single presigned URL', { jobId: job.id });
    } else {
      // Multipart upload for large files
      const partSize = 5 * 1024 * 1024; // 5MB chunks
      const partCount = Math.ceil(fileSize / partSize);
      uploadConfig = await generateMultipartUrls(job.id, fileName, partCount);
      log.info('Generated multipart upload URLs', {
        jobId: job.id,
        partCount
      });
    }
    
    timer({ status: 'success' });
    
    return NextResponse.json({
      jobId: job.id,
      uploadId: uploadConfig.uploadId,
      uploadUrl: uploadConfig.url,
      uploadMethod: uploadConfig.method,
      partUrls: uploadConfig.partUrls,
      maxFileSize: limits[purpose],
      supportedTypes,
    });
    
  } catch (error) {
    log.error('Failed to initiate upload', error);
    timer({ status: 'error' });
    
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { 
          error: 'Invalid request data',
          details: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`)
        },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to initiate upload' },
      { status: 500 }
    );
  }
}