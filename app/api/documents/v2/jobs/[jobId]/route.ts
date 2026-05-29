import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth/server-session';
import { getJobStatus, fetchResultFromS3 } from '@/lib/services/document-job-service';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

// Map internal Lambda error messages to user-facing strings so that
// implementation details are not exposed in the API response.
const JOB_ERROR_MAP: Array<{ pattern: string; message: string }> = [
  { pattern: 'scanned pdf detected', message: 'This PDF appears to be scanned (image-only) and cannot be read. Please upload a text-based PDF.' },
];

function sanitizeJobError(errorMessage: string | undefined | null): string | undefined {
  if (!errorMessage) return undefined;
  const lower = errorMessage.toLowerCase();
  for (const { pattern, message } of JOB_ERROR_MAP) {
    if (lower.includes(pattern)) return message;
  }
  return errorMessage;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer('api.documents.v2.jobs.get');
  const log = createLogger({ requestId, route: 'api.documents.v2.jobs' });
  
  
  try {
    // Authentication
    const session = await getServerSession();
    if (!session?.sub) {
      log.warn('Unauthorized request');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    const resolvedParams = await params;
    const jobId = resolvedParams.jobId;
    
    // Get job with user ID for security
    const job = await getJobStatus(jobId, session.sub);
    
    if (!job) {
      log.warn('Job not found', { jobId, userId: session.sub });
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    
    // Check if results are in S3 (for large results)
    let result = job.result;
    if (job.resultLocation === 's3' && job.resultS3Key) {
      try {
        result = await fetchResultFromS3(job.resultS3Key);
      } catch (error) {
        log.error('Failed to fetch result from S3', { error, jobId, s3Key: job.resultS3Key });
        // Continue with undefined result rather than failing the request
        result = undefined;
      }
    }
    
    timer({ status: 'success' });

    // Return job status with results if available
    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      progress: job.progress || 0,
      processingStage: job.processingStage,
      result: job.status === 'completed' ? result : null,
      error: sanitizeJobError(job.errorMessage),
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      fileName: job.fileName,
      fileSize: job.fileSize,
      fileType: job.fileType,
      purpose: job.purpose,
      processingOptions: job.processingOptions,
    });
    
  } catch (error) {
    log.error('Failed to get job status', error);
    timer({ status: 'error' });
    return NextResponse.json(
      { error: 'Failed to get job status' },
      { status: 500 }
    );
  }
}