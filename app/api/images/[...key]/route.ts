import { NextRequest } from 'next/server';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getServerSession } from '@/lib/auth/server-session';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { getJob } from '@/lib/db/drizzle';

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.NEXT_PUBLIC_AWS_REGION || process.env.AWS_REGION || 'us-east-1'
});

/**
 * Secure Image Proxy API
 * GET /api/images/[...key] - Serve images from S3 with authentication
 * 
 * This endpoint provides secure access to AI-generated images stored in S3
 * by generating short-lived presigned URLs after authentication checks.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer('api.images.get');
  const log = createLogger({ requestId, route: 'api.images.get' });
  
  const { key: keyParts } = await params;
  const s3Key = keyParts.join('/');
  
  log.info('Image request received', { s3Key });
  
  try {
    // 1. Authenticate user
    const session = await getServerSession();
    if (!session) {
      log.warn('Unauthorized request - no session', { s3Key });
      timer({ status: 'error', reason: 'unauthorized' });
      return new Response('Unauthorized', { status: 401 });
    }
    
    // 2. Get current user
    const currentUser = await getCurrentUserAction();
    if (!currentUser.isSuccess) {
      log.error('Failed to get current user', { s3Key });
      return new Response('Unauthorized', { status: 401 });
    }
    
    // 3. Validate that this is an AI-generated image path
    if (!s3Key.startsWith('ai-generated-images/')) {
      log.warn('Invalid image path - not AI generated', { s3Key, userId: currentUser.data.user.id });
      return new Response('Not Found', { status: 404 });
    }
    
    // 4. Extract job ID from path for ownership validation
    // Path format: ai-generated-images/{jobId}/{timestamp}.{ext}
    const pathParts = s3Key.split('/');
    if (pathParts.length < 3) {
      log.warn('Invalid image path format', { s3Key, pathParts });
      return new Response('Not Found', { status: 404 });
    }
    
    const jobId = pathParts[1];
    
    // 5. Verify job ownership (user can only access their own generated images)
    // Note: This could be optimized with caching if needed
    const job = await getJob(jobId);

    if (!job) {
      log.warn('Job not found for image access', { jobId, s3Key, userId: currentUser.data.user.id });
      return new Response('Not Found', { status: 404 });
    }

    if (job.userId !== currentUser.data.user.id) {
      log.warn('Image access denied - wrong user', {
        jobId,
        s3Key,
        jobUserId: job.userId,
        requestUserId: currentUser.data.user.id
      });
      return new Response('Forbidden', { status: 403 });
    }
    
    // 6. Generate presigned URL for the image (valid for 1 hour)
    const bucketName = process.env.DOCUMENTS_BUCKET_NAME;
    if (!bucketName) {
      log.error('S3 bucket name not configured - missing DOCUMENTS_BUCKET_NAME');
      return new Response('Internal Server Error', { status: 500 });
    }
    
    const getObjectCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key
    });
    
    const presignedUrl = await getSignedUrl(s3Client, getObjectCommand, {
      expiresIn: 60 * 60 // 1 hour in seconds
    });
    
    log.info('Image access granted, redirecting to presigned URL', { 
      jobId,
      s3Key,
      userId: currentUser.data.user.id 
    });
    
    timer({ status: 'success' });
    
    // 7. Redirect to the presigned URL
    return Response.redirect(presignedUrl, 302);
    
  } catch (error) {
    log.error('Image proxy error', { 
      s3Key,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });
    
    timer({ status: 'error' });
    
    return new Response('Internal Server Error', { status: 500 });
  }
}