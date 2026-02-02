/**
 * Job Management Endpoints
 * GET    /api/v1/jobs/:jobId — Poll job status and get results
 * DELETE /api/v1/jobs/:jobId — Cancel a running job
 * Part of Issue #685 - Assistant Execution API (Phase 2)
 */

import { NextRequest } from "next/server"
import { withApiAuth, createApiResponse, createErrorResponse } from "@/lib/api"
import { jobManagementService } from "@/lib/streaming/job-management-service"
import type { UniversalPollingStatus } from "@/lib/streaming/job-management-service"
import { createLogger } from "@/lib/logger"

// ============================================
// GET — Poll Job Status
// ============================================

export const GET = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const log = createLogger({ requestId, route: "api.v1.jobs.poll" })

  const jobId = extractJobId(request.url)
  if (!jobId) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid job ID")
  }

  try {
    const job = await jobManagementService.getJob(jobId)
    if (!job) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Job not found: ${jobId}`)
    }

    // Verify ownership
    if (job.userId !== auth.userId) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Job not found: ${jobId}`)
    }

    const pollingInterval = await jobManagementService.getOptimalPollingInterval(
      job.modelId,
      job.status
    )

    const isTerminal = ["completed", "failed", "cancelled"].includes(job.status)

    log.info("Job status polled", { jobId, status: job.status })

    return createApiResponse(
      {
        data: {
          jobId: job.id,
          status: job.status,
          createdAt: job.createdAt.toISOString(),
          completedAt: job.completedAt?.toISOString() ?? null,
          partialContent: job.partialContent || "",
          responseData: job.status === "completed" ? job.responseData : undefined,
          errorMessage: job.status === "failed" ? job.errorMessage : undefined,
          pollingInterval,
          shouldContinuePolling: !isTerminal,
        },
        meta: { requestId },
      },
      requestId
    )
  } catch (error) {
    log.error("Failed to poll job", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to poll job status")
  }
})

// ============================================
// DELETE — Cancel Job
// ============================================

export const DELETE = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const log = createLogger({ requestId, route: "api.v1.jobs.cancel" })

  const jobId = extractJobId(request.url)
  if (!jobId) {
    return createErrorResponse(requestId, 400, "VALIDATION_ERROR", "Invalid job ID")
  }

  try {
    const job = await jobManagementService.getJob(jobId)
    if (!job) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Job not found: ${jobId}`)
    }

    // Verify ownership
    if (job.userId !== auth.userId) {
      return createErrorResponse(requestId, 404, "NOT_FOUND", `Job not found: ${jobId}`)
    }

    // Check if job can be cancelled
    const cancellableStates: UniversalPollingStatus[] = ["pending", "processing", "streaming"]
    if (!cancellableStates.includes(job.status)) {
      return createErrorResponse(
        requestId,
        409,
        "CONFLICT",
        `Job cannot be cancelled — current status: ${job.status}`
      )
    }

    const cancelled = await jobManagementService.cancelJob(jobId)
    if (!cancelled) {
      return createErrorResponse(
        requestId,
        409,
        "CONFLICT",
        "Job cancellation failed — job may have already completed"
      )
    }

    log.info("Job cancelled", { jobId })

    return createApiResponse(
      {
        data: {
          jobId,
          status: "cancelled",
          message: "Job cancelled successfully",
        },
        meta: { requestId },
      },
      requestId
    )
  } catch (error) {
    log.error("Failed to cancel job", {
      error: error instanceof Error ? error.message : String(error),
    })
    return createErrorResponse(requestId, 500, "INTERNAL_ERROR", "Failed to cancel job")
  }
})

// ============================================
// URL Helper
// ============================================

function extractJobId(url: string): string | null {
  const segments = new URL(url).pathname.split("/")
  const jobsIdx = segments.indexOf("jobs")
  const jobId = segments[jobsIdx + 1]
  return jobId || null
}
