import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from '@/lib/auth/server-session'
import { executeSQL } from '@/lib/db/data-api-adapter'
import { getCurrentUserAction } from '@/actions/db/get-current-user-action'
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

export async function GET(req: NextRequest) {
  const requestId = generateRequestId();
  const timer = startTimer("api.assistant-architect.pdf-status");
  const log = createLogger({ requestId, route: "api.assistant-architect.pdf-status" });
  
  log.info("GET /api/assistant-architect/pdf-to-markdown/status - Checking job status");
  
  const headers = {
    'Content-Type': 'application/json',
    'X-Request-Id': requestId,
  };

  const session = await getServerSession();
  if (!session || !session.sub) {
    log.warn("Unauthorized - No session");
    timer({ status: "error", reason: "unauthorized" });
    return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
  }
  
  // Get the current user's database ID
  const currentUser = await getCurrentUserAction();
  if (!currentUser.isSuccess || !currentUser.data) {
    log.warn("User not found");
    timer({ status: "error", reason: "user_not_found" });
    return new NextResponse(JSON.stringify({ error: 'User not found' }), { status: 401, headers });
  }

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId');
  if (!jobId) {
    log.warn("Job ID is required");
    timer({ status: "error", reason: "missing_job_id" });
    return new NextResponse(JSON.stringify({ error: 'Job ID is required' }), { status: 400, headers });
  }

  log.debug("Checking job status", { userId: currentUser.data.user.id, jobId });

  try {
    const jobResult = await executeSQL(`
      SELECT id, user_id, type, status, input, output, error, created_at, updated_at
      FROM jobs
      WHERE id = :jobId AND user_id = :userId
    `, [
      { name: 'jobId', value: { longValue: Number.parseInt(jobId, 10) } },
      { name: 'userId', value: { longValue: currentUser.data.user.id } }
    ]);

    const job = jobResult[0];

    if (!job) {
      // To handle potential replication lag, we can check if the job exists at all
      const anyJobResult = await executeSQL('SELECT status FROM jobs WHERE id = :jobId', [{ name: 'jobId', value: { longValue: Number.parseInt(jobId, 10) } }]);
      if (anyJobResult[0]) {
        log.info("Job found with replication lag", { jobId, status: anyJobResult[0].status });
        timer({ status: "success", jobStatus: anyJobResult[0].status });
        return new NextResponse(JSON.stringify({ jobId, status: anyJobResult[0].status || 'processing' }), { status: 200, headers });
      }
      log.warn("Job not found", { jobId });
      timer({ status: "error", reason: "job_not_found" });
      return new NextResponse(JSON.stringify({ error: 'Job not found' }), { status: 404, headers });
    }

    interface JobResult {
      jobId: number;
      status: string;
      createdAt: string;
      updatedAt: string;
      error?: string;
      markdown?: string;
      fileName?: string;
      processingTime?: number;
    }

    let result: JobResult = {
      jobId: job.id as number,
      status: job.status as string,
      createdAt: job.created_at as string,
      updatedAt: job.updated_at as string
    };

    if (job.status === 'completed' && job.output) {
      try {
        const output = JSON.parse(job.output as string);
        result = { ...result, ...output };
      } catch (e) {
        log.error('Failed to parse job output', e);
        timer({ status: "error", reason: "parse_error" });
        return new NextResponse(JSON.stringify({ error: 'Failed to parse job result' }), { status: 500, headers });
      }
    } else if (job.status === 'failed') {
      result.error = (job.error as string) || 'Processing failed';
    }

    log.info("Job status retrieved", { jobId, status: result.status });
    timer({ status: "success", jobStatus: result.status });
    return new NextResponse(JSON.stringify(result), { status: 200, headers });

  } catch (error) {
    timer({ status: "error" });
    log.error('Error checking job status', error);
    return new NextResponse(JSON.stringify({ error: 'Failed to check job status' }), { status: 500, headers });
  }
} 