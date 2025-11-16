import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { confirmDocumentUpload, getJobStatus } from '@/lib/services/document-job-service';
import { sendToProcessingQueue } from '@/lib/aws/lambda-trigger';
import { sanitizeFileName } from '@/lib/aws/document-upload';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { z } from 'zod';

const ConfirmUploadSchema = z.object({
  uploadId: z.string().min(1),
  jobId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer('api.documents.v2.confirm-upload');
  const log = createLogger({ requestId, route: 'api.documents.v2.confirm-upload' });
  
  try {
    const session = await getServerSession();
    if (!session?.sub) {
      log.warn('Unauthorized request');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    const body = await req.json();
    const { uploadId, jobId } = ConfirmUploadSchema.parse(body);
    
    log.info('Confirming upload', { uploadId, jobId, userId: session.userId });
    
    // Get job details to verify ownership and get processing info
    const job = await getJobStatus(jobId, session.sub);
    if (!job) {
      log.warn('Job not found for confirmation', { jobId, userId: session.sub });
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    
    // Confirm upload in job tracking
    await confirmDocumentUpload(jobId, uploadId);
    
    // Generate S3 key using the same sanitization as upload - ensure consistency
    const sanitizedFileName = sanitizeFileName(job.fileName);
    const s3Key = `v2/uploads/${jobId}/${sanitizedFileName}`;
    
    // Environment validation (skip in test environment)
    if (process.env.NODE_ENV !== 'test' && !process.env.DOCUMENTS_BUCKET_NAME) {
      log.error('DOCUMENTS_BUCKET_NAME environment variable not configured');
      return NextResponse.json({ error: 'Service configuration error' }, { status: 500 });
    }
    
    // Send processing job to NEW DocumentProcessingStack queue
    await sendToProcessingQueue({
      jobId,
      bucket: process.env.DOCUMENTS_BUCKET_NAME || 'test-documents-bucket',
      key: s3Key,
      fileName: sanitizedFileName, // Use sanitized filename for consistency
      fileSize: job.fileSize,
      fileType: job.fileType,
      userId: session.sub,
      processingOptions: job.processingOptions,
    });
    
    log.info('Upload confirmed and processing queued', { jobId, uploadId });
    timer({ status: 'success' });
    
    return NextResponse.json({ 
      success: true,
      jobId,
      status: 'processing',
      message: 'Upload confirmed and processing started'
    });
    
  } catch (error) {
    // Safe error logging to avoid circular reference issues
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : 'Unknown';
    log.error(`Failed to confirm upload ${errorMessage}`, { name: errorName });
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
      { error: 'Failed to confirm upload' },
      { status: 500 }
    );
  }
}