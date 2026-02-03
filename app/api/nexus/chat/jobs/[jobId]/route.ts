import { authenticatePollingRequest, validateJobOwnership } from '@/lib/auth/optimized-polling-auth';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { jobManagementService } from '@/lib/streaming/job-management-service';
import type { UniversalPollingStatus } from '@/lib/streaming/job-management-service';
import { createMessageWithStats } from '@/lib/db/drizzle';
import { executeQuery } from '@/lib/db/drizzle-client';
import { nexusMessages } from '@/lib/db/schema';
import { eq, and, gte } from 'drizzle-orm';

/**
 * Nexus Job Polling API Endpoint
 * GET /api/nexus/chat/jobs/[jobId] - Poll job status and get progressive updates
 * DELETE /api/nexus/chat/jobs/[jobId] - Cancel running job
 * 
 * This endpoint enables universal polling for all Nexus AI requests, overcoming
 * AWS Amplify's 30-second timeout limitation.
 */


export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer('api.nexus.chat.jobs.poll');
  const log = createLogger({ requestId, route: 'api.nexus.chat.jobs.poll' });

  const { jobId } = await params;

  log.info('Polling nexus job status', { jobId });

  try {
    // 1. High-performance authentication with intelligent caching
    const authResult = await authenticatePollingRequest();
    if (!authResult.isAuthorized) {
      log.warn('Unauthorized polling request', {
        jobId,
        authTime: authResult.authTime,
        authMethod: authResult.authMethod
      });
      timer({ status: 'error', reason: 'unauthorized', authTime: authResult.authTime });
      return new Response('Unauthorized', { status: 401 });
    }

    // Log performance improvement
    if (authResult.authMethod === 'cache') {
      log.debug('Fast auth via cache', {
        jobId,
        userId: authResult.userId,
        authTime: authResult.authTime
      });
    }
    
    // 2. Load job from database
    const job = await jobManagementService.getJob(jobId);
    if (!job) {
      log.warn('Nexus job not found', { jobId, userId: authResult.userId });
      timer({ status: 'error', reason: 'job_not_found', authTime: authResult.authTime });
      return new Response(JSON.stringify({
        error: 'Job not found',
        jobId,
        requestId
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId
        }
      });
    }

    // 3. Verify job ownership (optimized - no additional DB calls)
    const ownershipValidation = validateJobOwnership(authResult, job.userId, jobId);
    if (!ownershipValidation.authorized) {
      log.warn('Nexus job access denied', {
        jobId,
        reason: ownershipValidation.reason,
        jobUserId: job.userId,
        requestUserId: authResult.userId
      });
      timer({ status: 'error', reason: 'access_denied', authTime: authResult.authTime });
      return new Response(JSON.stringify({
        error: 'Access denied',
        jobId,
        requestId
      }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId
        }
      });
    }
    
    log.debug('Nexus job found and authorized', {
      jobId,
      status: job.status,
      userId: job.userId,
      conversationId: job.conversationId,
      nexusConversationId: job.nexusConversationId,
      createdAt: job.createdAt.toISOString(),
      hasPartialContent: !!job.partialContent,
      partialContentLength: job.partialContent?.length || 0
    });
    
    // 5. Calculate optimal polling interval based on model and status
    const pollingInterval = await jobManagementService.getOptimalPollingInterval(
      job.modelId, 
      job.status
    );
    
    // 5.5. Save assistant response to nexus_messages if job completed and not already saved
    log.debug('Checking API fallback save conditions', {
      jobId,
      status: job.status,
      hasResponseData: !!job.responseData,
      hasConversationId: !!job.nexusConversationId,
      shouldAttemptSave: job.status === 'completed' && job.responseData && job.nexusConversationId
    });
    
    if (job.status === 'completed' && job.responseData && job.nexusConversationId) {
      try {
        log.debug('Checking for existing assistant messages', {
          hasConversationId: !!job.nexusConversationId,
          jobCreatedAt: job.createdAt.toISOString()
        });

        // Check if we already saved the assistant response (prevent duplicates)
        // job.nexusConversationId is guaranteed to be defined by outer if condition
        const existingAssistantMessages = await executeQuery(
          (db) =>
            db
              .select({ id: nexusMessages.id })
              .from(nexusMessages)
              .where(
                and(
                  eq(nexusMessages.conversationId, job.nexusConversationId!),
                  eq(nexusMessages.role, 'assistant'),
                  gte(nexusMessages.createdAt, job.createdAt)
                )
              )
              .limit(1),
          'checkExistingAssistantMessage'
        );

        log.debug('Existing assistant messages query result', {
          found: existingAssistantMessages.length,
          messageIds: existingAssistantMessages.map((msg) => msg.id)
        });

        if (existingAssistantMessages.length === 0) {
          // Save assistant response to nexus_messages as fallback
          const responseData = job.responseData;
          const assistantText = responseData?.text || 'Response completed.';
          
          log.debug('Attempting API fallback save', {
            hasConversationId: !!job.nexusConversationId,
            textLength: assistantText.length,
            modelId: job.modelId,
            hasUsage: !!responseData?.usage,
            finishReason: responseData?.finishReason
          });

          // Save assistant response and update conversation stats in one operation
          await createMessageWithStats({
            conversationId: job.nexusConversationId,
            role: 'assistant',
            content: assistantText,
            parts: [{ type: 'text', text: assistantText }],
            modelId: job.modelId,
            tokenUsage: responseData?.usage || {},
            finishReason: (responseData?.finishReason as string) || 'stop',
            metadata: { savedVia: 'api-fallback' },
          });

          log.info('Assistant message saved via API fallback successfully', {
            jobId,
            hasConversationId: !!job.nexusConversationId,
            textLength: assistantText.length,
            modelId: job.modelId
          });
        } else {
          log.debug('Assistant message already exists, skipping fallback save', { 
            jobId, 
            existingCount: existingAssistantMessages.length 
          });
        }
      } catch (saveError) {
        log.error('Failed to save assistant message via API fallback', {
          jobId,
          hasConversationId: !!job.nexusConversationId,
          error: saveError instanceof Error ? saveError.message : String(saveError)
        });
        // Don't fail the polling request if fallback save fails
      }
    }
    
    // 6. Prepare response based on job status
    const responseData = {
      jobId: job.id,
      conversationId: job.conversationId, // Keep as string (UUID for nexus)
      nexusConversationId: job.nexusConversationId,
      status: job.status,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString(),
      completedAt: job.completedAt?.toISOString(),
      expiresAt: job.expiresAt?.toISOString(),
      
      // Progressive content (always include for streaming updates)
      partialContent: job.partialContent || '',
      progressInfo: job.progressInfo,
      
      // Final response data (only for completed jobs)
      responseData: job.status === 'completed' ? job.responseData : undefined,
      
      // Error information (only for failed jobs)
      errorMessage: job.status === 'failed' ? job.errorMessage : undefined,
      
      // Polling guidance
      pollingInterval,
      shouldContinuePolling: ['pending', 'processing', 'streaming'].includes(job.status),
      
      // Request metadata
      requestId
    };
    
    // 7. Set response headers based on job status
    const responseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
      'X-Job-Id': jobId,
      'X-Job-Status': job.status,
      'X-Polling-Interval': pollingInterval.toString(),
      'X-Nexus-Conversation-Id': job.nexusConversationId || ''
    };
    
    // Add caching headers based on job status
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      // Final states can be cached briefly
      responseHeaders['Cache-Control'] = 'private, max-age=60';
    } else {
      // Active jobs should not be cached
      responseHeaders['Cache-Control'] = 'private, no-cache, no-store, must-revalidate';
    }
    
    timer({ 
      status: 'success',
      jobStatus: job.status,
      pollingInterval,
      hasPartialContent: !!job.partialContent
    });
    
    log.info('Nexus job status returned successfully', {
      jobId,
      status: job.status,
      pollingInterval,
      hasPartialContent: !!job.partialContent,
      shouldContinuePolling: responseData.shouldContinuePolling,
      nexusConversationId: job.nexusConversationId
    });
    
    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: responseHeaders
    });
    
  } catch (error) {
    log.error('Nexus job polling error', { 
      jobId,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });
    
    timer({ status: 'error' });
    
    return new Response(JSON.stringify({
      error: 'Failed to poll nexus job status',
      jobId,
      requestId
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId
      }
    });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer('api.nexus.chat.jobs.cancel');
  const log = createLogger({ requestId, route: 'api.nexus.chat.jobs.cancel' });

  const { jobId } = await params;

  log.info('Cancelling nexus job', { jobId });

  try {
    // 1. High-performance authentication with intelligent caching
    const authResult = await authenticatePollingRequest();
    if (!authResult.isAuthorized) {
      log.warn('Unauthorized job cancellation request', {
        jobId,
        authTime: authResult.authTime,
        authMethod: authResult.authMethod
      });
      timer({ status: 'error', reason: 'unauthorized', authTime: authResult.authTime });
      return new Response('Unauthorized', { status: 401 });
    }
    
    // 2. Load job to verify ownership
    const job = await jobManagementService.getJob(jobId);
    if (!job) {
      log.warn('Nexus job not found for cancellation', { jobId, userId: authResult.userId });
      timer({ status: 'error', reason: 'job_not_found', authTime: authResult.authTime });
      return new Response(JSON.stringify({
        error: 'Job not found',
        jobId,
        requestId
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId
        }
      });
    }

    // 3. Verify job ownership (optimized)
    const ownershipValidation = validateJobOwnership(authResult, job.userId, jobId);
    if (!ownershipValidation.authorized) {
      log.warn('Nexus job cancellation denied', {
        jobId,
        reason: ownershipValidation.reason,
        jobUserId: job.userId,
        requestUserId: authResult.userId
      });
      timer({ status: 'error', reason: 'access_denied', authTime: authResult.authTime });
      return new Response(JSON.stringify({
        error: 'Access denied',
        jobId,
        requestId
      }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId
        }
      });
    }
    
    // 5. Check if job can be cancelled
    const cancellableStates: UniversalPollingStatus[] = ['pending', 'processing', 'streaming'];
    if (!cancellableStates.includes(job.status)) {
      log.info('Nexus job not in cancellable state', { 
        jobId, 
        status: job.status,
        cancellableStates 
      });
      
      return new Response(JSON.stringify({
        error: `Job cannot be cancelled - current status: ${job.status}`,
        jobId,
        status: job.status,
        cancellableStates,
        requestId
      }), {
        status: 409, // Conflict
        headers: { 
          'Content-Type': 'application/json',
          'X-Request-Id': requestId 
        }
      });
    }
    
    // 6. Cancel the job
    const cancelled = await jobManagementService.cancelJob(jobId);
    
    if (cancelled) {
      log.info('Nexus job cancelled successfully', { jobId });
      
      timer({ 
        status: 'success',
        operation: 'job_cancelled'
      });
      
      return new Response(JSON.stringify({
        success: true,
        jobId,
        status: 'cancelled',
        message: 'Nexus job cancelled successfully',
        requestId
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId,
          'X-Job-Id': jobId,
          'X-Job-Status': 'cancelled'
        }
      });
    } else {
      log.warn('Nexus job cancellation failed - no rows updated', { jobId });
      
      return new Response(JSON.stringify({
        error: 'Job cancellation failed - job may have already completed or been cancelled',
        jobId,
        requestId
      }), {
        status: 409,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId
        }
      });
    }
    
  } catch (error) {
    log.error('Nexus job cancellation error', { 
      jobId,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : String(error)
    });
    
    timer({ status: 'error' });
    
    return new Response(JSON.stringify({
      error: 'Failed to cancel nexus job',
      jobId,
      requestId
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId
      }
    });
  }
}