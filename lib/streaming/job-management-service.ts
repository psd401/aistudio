/**
 * Job Management Service
 *
 * Service layer for managing AI streaming jobs in the database.
 * Handles job lifecycle from creation to completion/cleanup.
 *
 * Uses Drizzle ORM operations from @/lib/db/drizzle for data access.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #535 - Migrate Nexus Streaming Jobs to Drizzle ORM
 */

import { createLogger, generateRequestId } from "@/lib/logger";
import {
  // Types
  type StreamingJob,
  type UniversalPollingStatus,
  // Status utilities
  mapToDatabaseStatus,
  mapFromDatabaseStatus,
  // Operations
  getJob as drizzleGetJob,
  getUserJobs as drizzleGetUserJobs,
  getPendingJobs as drizzleGetPendingJobs,
  createJob as drizzleCreateJob,
  updateJobStatus as drizzleUpdateJobStatus,
  completeJob as drizzleCompleteJob,
  failJob as drizzleFailJob,
  cancelJob as drizzleCancelJob,
  cleanupCompletedJobs,
  cleanupFailedJobs,
  cleanupStaleRunningJobs,
  getOptimalPollingInterval as drizzleGetOptimalPollingInterval,
} from "@/lib/db/drizzle";
import type { UIMessage } from "ai";

const log = createLogger({ module: "job-management-service" });

// Re-export types for backwards compatibility
export type { StreamingJob, UniversalPollingStatus };
export type JobStatus = "pending" | "running" | "completed" | "failed";
export { mapToDatabaseStatus, mapFromDatabaseStatus };

/**
 * Request to create a streaming job
 */
export interface CreateJobRequest {
  conversationId: string | number; // Support both legacy (number) and nexus (UUID string)
  userId: number;
  modelId: number;
  messages: UIMessage[]; // Lightweight messages (attachments stored in S3)
  provider: string;
  modelIdString: string;
  systemPrompt?: string;
  options?: StreamingJob["requestData"]["options"];
  maxTokens?: number;
  temperature?: number;
  tools?: unknown;
  source?: string;
  sessionId?: string;
  toolMetadata?: {
    toolId: number;
    executionId: number;
    prompts: Array<{
      id: number;
      name: string;
      content: string;
      systemContext?: string | null;
      modelId: number;
      position: number;
      inputMapping?: Record<string, unknown>;
      repositoryIds?: number[];
    }>;
    inputMapping: Record<string, unknown>;
  };
}

/**
 * Progress update for a job
 */
export interface JobProgressUpdate {
  partialContent?: string;
  progressInfo?: Partial<StreamingJob["progressInfo"]>;
  metadata?: Record<string, unknown>;
}

/**
 * Service for managing AI streaming jobs in the database
 * Handles job lifecycle from creation to completion/cleanup
 */
export class JobManagementService {
  /**
   * Create a new streaming job
   */
  async createJob(request: CreateJobRequest): Promise<string> {
    const requestId = generateRequestId();

    // Determine conversation type
    const conversationIdStr = String(request.conversationId);
    const isUuid =
      conversationIdStr.length === 36 && conversationIdStr.includes("-");
    const isNexus = request.source === "nexus" || isUuid;

    log.info("Creating streaming job", {
      userId: request.userId,
      conversationId: request.conversationId,
      conversationIdStr,
      isNexus,
      isUuid,
      provider: request.provider,
      modelId: request.modelId,
      messageCount: request.messages.length,
      source: request.source || "chat",
      requestId,
    });

    try {
      // Prepare request data for database (lightweight messages only - NO attachments)
      const requestData = {
        messages: request.messages, // These should be lightweight messages (attachments already in S3)
        modelId: request.modelIdString,
        provider: request.provider,
        systemPrompt: request.systemPrompt,
        options: request.options,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        tools: request.tools,
        source: request.source || "chat", // CRITICAL: Include source for Nexus message persistence
        toolMetadata: request.toolMetadata, // Include toolMetadata for Assistant Architect jobs
      };

      const job = await drizzleCreateJob({
        conversationId: conversationIdStr,
        userId: request.userId,
        modelId: request.modelId,
        requestData,
      });

      log.info("Streaming job created successfully", {
        jobId: job.id,
        userId: request.userId,
        conversationId: request.conversationId,
        requestId,
      });

      return job.id;
    } catch (error) {
      log.error("Failed to create streaming job", {
        error,
        userId: request.userId,
        conversationId: request.conversationId,
        requestId,
      });
      throw error;
    }
  }

  /**
   * Get job by ID
   */
  async getJob(jobId: string): Promise<StreamingJob | null> {
    try {
      return await drizzleGetJob(jobId);
    } catch (error) {
      log.error("Failed to get job", { jobId, error });
      throw error;
    }
  }

  /**
   * Get jobs for a user (for polling)
   */
  async getUserJobs(
    userId: number,
    limit: number = 10
  ): Promise<StreamingJob[]> {
    try {
      return await drizzleGetUserJobs(userId, limit);
    } catch (error) {
      log.error("Failed to get user jobs", { userId, error });
      throw error;
    }
  }

  /**
   * Update job status
   */
  async updateJobStatus(
    jobId: string,
    status: UniversalPollingStatus,
    progressUpdate?: JobProgressUpdate,
    errorMessage?: string
  ): Promise<boolean> {
    log.debug("Updating job status", {
      jobId,
      status,
      hasProgressUpdate: !!progressUpdate,
      hasError: !!errorMessage,
    });

    try {
      const dbStatus = mapToDatabaseStatus(status);
      const finalErrorMessage =
        status === "cancelled"
          ? `Job cancelled by user${errorMessage ? ": " + errorMessage : ""}`
          : errorMessage;

      const result = await drizzleUpdateJobStatus(jobId, {
        status: dbStatus,
        partialContent: progressUpdate?.partialContent,
        errorMessage: finalErrorMessage,
      });

      const success = result !== null;

      if (success) {
        log.debug("Job status updated successfully", { jobId, status });
      } else {
        log.warn("Job status update returned null", { jobId, status });
      }

      return success;
    } catch (error) {
      log.error("Failed to update job status", { jobId, status, error });
      throw error;
    }
  }

  /**
   * Complete job with final response data
   */
  async completeJob(
    jobId: string,
    responseData: StreamingJob["responseData"],
    finalContent?: string
  ): Promise<boolean> {
    log.info("Completing job", { jobId, hasResponseData: !!responseData });

    try {
      if (!responseData) {
        log.error("No response data provided for job completion", { jobId });
        return false;
      }

      const result = await drizzleCompleteJob(jobId, {
        responseData,
        finalContent,
      });

      const success = result !== null;

      if (success) {
        log.info("Job completed successfully", { jobId });
      } else {
        log.error("Job completion failed - no rows updated", { jobId });
      }

      return success;
    } catch (error) {
      log.error("Failed to complete job", { jobId, error });
      throw error;
    }
  }

  /**
   * Mark job as failed
   */
  async failJob(jobId: string, errorMessage: string): Promise<boolean> {
    log.warn("Marking job as failed", { jobId, errorMessage });

    try {
      const result = await drizzleFailJob(jobId, errorMessage);

      const success = result !== null;

      if (success) {
        log.info("Job marked as failed", { jobId });
      } else {
        log.error("Failed to mark job as failed - no rows updated", { jobId });
      }

      return success;
    } catch (error) {
      log.error("Failed to mark job as failed", { jobId, error });
      throw error;
    }
  }

  /**
   * Cancel job
   */
  async cancelJob(jobId: string): Promise<boolean> {
    log.info("Cancelling job", { jobId });

    try {
      const result = await drizzleCancelJob(jobId);

      const success = result !== null;

      if (success) {
        log.info("Job cancelled successfully", { jobId });
      } else {
        log.warn(
          "Job cancellation failed or job not in cancellable state",
          { jobId }
        );
      }

      return success;
    } catch (error) {
      log.error("Failed to cancel job", { jobId, error });
      throw error;
    }
  }

  /**
   * Get pending jobs for worker processing
   */
  async getPendingJobs(limit: number = 10): Promise<StreamingJob[]> {
    try {
      return await drizzleGetPendingJobs(limit);
    } catch (error) {
      log.error("Failed to get pending jobs", { error });
      throw error;
    }
  }

  /**
   * Cleanup expired jobs
   * Returns the total number of jobs cleaned up
   */
  async cleanupExpiredJobs(): Promise<number> {
    log.info("Running job cleanup");

    try {
      // Cleanup completed jobs older than 7 days
      const completedDeleted = await cleanupCompletedJobs(7);

      // Cleanup failed jobs older than 3 days
      const failedDeleted = await cleanupFailedJobs(3);

      // Cleanup stale running jobs older than 60 minutes
      const staleMarkedFailed = await cleanupStaleRunningJobs(60);

      const totalCleaned = completedDeleted + failedDeleted + staleMarkedFailed;

      if (totalCleaned > 0) {
        log.info("Cleaned up jobs", {
          completedDeleted,
          failedDeleted,
          staleMarkedFailed,
          totalCleaned,
        });
      } else {
        log.debug("No jobs to clean up");
      }

      return totalCleaned;
    } catch (error) {
      log.error("Failed to cleanup expired jobs", { error });
      throw error;
    }
  }

  /**
   * Get optimal polling interval for a model based on database metadata
   */
  async getOptimalPollingInterval(
    modelId: number,
    status: UniversalPollingStatus
  ): Promise<number> {
    try {
      return await drizzleGetOptimalPollingInterval(modelId, status);
    } catch (error) {
      log.error("Failed to get optimal polling interval", { modelId, error });
      return 1000; // Default fallback
    }
  }
}

// Singleton instance
export const jobManagementService = new JobManagementService();
