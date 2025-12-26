/**
 * Drizzle AI Streaming Jobs Operations
 *
 * AI streaming job CRUD operations migrated from RDS Data API to Drizzle ORM.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * **IMPORTANT - Authorization**: These are infrastructure-layer data access functions.
 * They do NOT perform authorization checks. Authorization MUST be handled at the
 * API route or server action layer before calling these functions.
 *
 * **Authorization Requirements**:
 * - Verify user owns the job (job.userId matches session.userId)
 * - Verify user has conversation access if conversationId is present
 * - Use @/lib/auth/server-session helpers: getServerSession(), validateJobOwnership()
 * - See app/api/nexus/chat/jobs/[jobId]/route.ts for reference implementation
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #535 - Migrate Nexus Streaming Jobs to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, desc, sql, lt, inArray } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { aiStreamingJobs, aiModels } from "@/lib/db/schema";
import type { SelectAiStreamingJob } from "@/lib/db/types";
import type { UIMessage } from "ai";
import { createLogger } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";

// ============================================
// Constants
// ============================================

/**
 * Maximum number of pending jobs to return in a single query
 * Prevents excessive memory usage and query timeouts
 * Based on typical worker pool size (10-20 workers) with 5x headroom
 */
export const MAX_PENDING_JOBS_LIMIT = 100;

/**
 * Retention period for completed jobs (in days)
 * Balance between audit trail availability and storage costs
 * 7 days provides sufficient time for debugging while minimizing storage
 */
export const COMPLETED_JOBS_RETENTION_DAYS = 7;

/**
 * Retention period for failed jobs (in days)
 * Shorter retention than completed jobs since failures are typically investigated quickly
 * 3 days provides adequate time for debugging while reducing clutter
 */
export const FAILED_JOBS_RETENTION_DAYS = 3;

/**
 * Threshold for marking stale running jobs as failed (in minutes)
 * Jobs stuck in "running" status beyond this threshold are assumed crashed
 * 60 minutes accounts for longest reasonable AI streaming request (GPT-4 Pro with large context)
 */
export const STALE_JOB_THRESHOLD_MINUTES = 60;

/**
 * Maximum length for partial content field (characters)
 * Prevents database bloat from extremely long streaming responses
 * 100KB in UTF-8 (assuming ~1 byte per char on average)
 */
export const MAX_PARTIAL_CONTENT_LENGTH = 100000;

/**
 * Maximum length for error message field (characters)
 * Prevents database bloat from verbose error stack traces
 * 10KB in UTF-8 provides sufficient detail for debugging
 */
export const MAX_ERROR_MESSAGE_LENGTH = 10000;

/**
 * UUID validation regex (RFC 4122 compliant)
 * Matches standard UUID format: xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx
 * Where M is version (1-5) and N is variant (8, 9, a, b)
 */
export const UUID_REGEX =
  /^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

// ============================================
// Types
// ============================================

/**
 * Job status enum values
 * Maps to job_status enum: pending, running, completed, failed
 */
export type JobStatus = "pending" | "running" | "completed" | "failed";

/**
 * Universal polling status used by clients
 * More granular status for UI display
 */
export type UniversalPollingStatus =
  | "pending"
  | "processing"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Request data stored in JSONB column
 */
export interface JobRequestData {
  messages: UIMessage[];
  modelId: string;
  provider: string;
  systemPrompt?: string;
  options?: {
    reasoningEffort?: "minimal" | "low" | "medium" | "high";
    responseMode?: "standard" | "flex" | "priority";
    backgroundMode?: boolean;
    thinkingBudget?: number;
    imageGeneration?: {
      prompt: string;
      size?: "1024x1024" | "1792x1024" | "1024x1792" | "1536x1024" | "1024x1536";
      style?: "natural" | "vivid";
    };
  };
  maxTokens?: number;
  temperature?: number;
  tools?: unknown;
  source?: string;
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
 * Response data stored in JSONB column
 */
export interface JobResponseData {
  text: string;
  type?: "text" | "image";
  image?: string;
  mediaType?: string;
  prompt?: string;
  size?: string;
  style?: string;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    totalCost?: number;
  };
  finishReason: string;
  metadata?: Record<string, unknown>;
}

/**
 * Progress info for job updates
 */
export interface JobProgressInfo {
  tokensStreamed?: number;
  completionPercentage?: number;
  currentPhase?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Full streaming job type with JSONB fields typed
 */
export interface StreamingJob {
  id: string;
  conversationId: string | null;
  /** Nexus-specific conversation ID for UUID-based conversations */
  nexusConversationId?: string;
  userId: number;
  modelId: number;
  status: UniversalPollingStatus;
  requestData: JobRequestData;
  responseData?: JobResponseData;
  partialContent?: string;
  progressInfo?: JobProgressInfo;
  errorMessage?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  expiresAt?: Date;
  source?: string;
  sessionId?: string;
  requestId?: string;
  messagePersisted: boolean;
}

/**
 * Data for creating a new streaming job
 */
export interface CreateJobData {
  id?: string; // Optional - uses defaultRandom() if not provided
  conversationId?: string;
  userId: number;
  modelId: number;
  requestData: JobRequestData;
}

/**
 * Data for updating job status
 */
export interface UpdateJobStatusData {
  status: JobStatus;
  partialContent?: string;
  errorMessage?: string;
  /**
   * Expected current status for optimistic locking
   * When provided, update will only succeed if job is in this status
   * Prevents race conditions when multiple processes update same job
   */
  expectedCurrentStatus?: JobStatus;
}

/**
 * Data for completing a job
 */
export interface CompleteJobData {
  responseData: JobResponseData;
  finalContent?: string;
}

// ============================================
// Status Mapping Utilities
// ============================================

/**
 * Map universal polling status to database enum value
 */
export function mapToDatabaseStatus(status: UniversalPollingStatus): JobStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "processing":
    case "streaming":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "failed";
  }
}

/**
 * Map database status to universal polling status
 */
export function mapFromDatabaseStatus(
  dbStatus: JobStatus,
  errorMessage?: string | null
): UniversalPollingStatus {
  switch (dbStatus) {
    case "pending":
      return "pending";
    case "running":
      return "processing";
    case "completed":
      return "completed";
    case "failed":
      if (
        errorMessage?.includes("cancelled") ||
        errorMessage?.includes("cancel")
      ) {
        return "cancelled";
      }
      return "failed";
    default:
      return "failed";
  }
}

// ============================================
// Validation Utilities
// ============================================

/**
 * Validate if a string is a valid UUID (RFC 4122 compliant)
 * Exported for reuse in service layer and other modules
 *
 * @param value - String to validate
 * @returns true if valid UUID, false otherwise
 *
 * @example
 * isValidUUID("550e8400-e29b-41d4-a716-446655440000") // true
 * isValidUUID("not-a-uuid") // false
 */
export function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Validate and truncate string to maximum length
 * Used for partialContent and errorMessage fields
 *
 * @param value - String to validate
 * @param maxLength - Maximum allowed length
 * @param fieldName - Field name for error messages
 * @returns Truncated string
 */
function validateStringLength(
  value: string,
  maxLength: number,
  fieldName: string
): string {
  if (value.length > maxLength) {
    const log = createLogger({ module: "ai-streaming-jobs" });
    log.warn(`${fieldName} exceeds max length, truncating`, {
      originalLength: value.length,
      maxLength,
      truncated: true,
    });
    return value.substring(0, maxLength);
  }
  return value;
}

// ============================================
// Row Transformation Helpers
// ============================================

/**
 * Transform a database row to StreamingJob format
 */
function transformToStreamingJob(row: SelectAiStreamingJob): StreamingJob {
  // Handle requestData parsing - must be valid JSON with proper structure
  let parsedRequestData: JobRequestData;
  if (typeof row.requestData === "string") {
    try {
      parsedRequestData = JSON.parse(row.requestData);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw ErrorFactories.invalidFormat(
        "requestData",
        row.requestData,
        "Valid JSON",
        {
          details: { jobId: row.id, parseError: errorMessage },
          technicalMessage: `Failed to parse requestData JSON for job ${row.id}: ${errorMessage}`,
        }
      );
    }
  } else {
    parsedRequestData = row.requestData as unknown as JobRequestData;
  }

  // Validate requestData structure and types
  if (!Array.isArray(parsedRequestData.messages)) {
    throw ErrorFactories.invalidInput(
      "requestData.messages",
      parsedRequestData.messages,
      "must be an array",
      {
        details: { jobId: row.id },
        technicalMessage: `Invalid requestData for job ${row.id}: messages must be an array`,
      }
    );
  }
  if (typeof parsedRequestData.provider !== "string") {
    throw ErrorFactories.invalidInput(
      "requestData.provider",
      parsedRequestData.provider,
      "must be a string",
      {
        details: { jobId: row.id },
        technicalMessage: `Invalid requestData for job ${row.id}: provider must be a string`,
      }
    );
  }
  if (
    typeof parsedRequestData.modelId !== "string" ||
    !parsedRequestData.modelId
  ) {
    throw ErrorFactories.invalidInput(
      "requestData.modelId",
      parsedRequestData.modelId,
      "must be a non-empty string",
      {
        details: { jobId: row.id },
        technicalMessage: `Invalid requestData for job ${row.id}: modelId must be a non-empty string`,
      }
    );
  }

  // Handle responseData parsing - optional field
  let parsedResponseData: JobResponseData | undefined;
  if (row.responseData) {
    if (typeof row.responseData === "string") {
      try {
        parsedResponseData = JSON.parse(row.responseData);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        throw ErrorFactories.invalidFormat(
          "responseData",
          row.responseData,
          "Valid JSON",
          {
            details: { jobId: row.id, parseError: errorMessage },
            technicalMessage: `Failed to parse responseData for job ${row.id}: ${errorMessage}`,
          }
        );
      }
    } else {
      parsedResponseData = row.responseData as unknown as JobResponseData;
    }
  }

  // Determine nexusConversationId - UUID-formatted conversation IDs are Nexus conversations
  const conversationId = row.conversationId;
  const isUuid = conversationId ? isValidUUID(conversationId) : false;

  return {
    id: row.id,
    conversationId: row.conversationId,
    nexusConversationId: isUuid && conversationId ? conversationId : undefined,
    userId: row.userId,
    modelId: row.modelId,
    status: mapFromDatabaseStatus(row.status as JobStatus, row.errorMessage),
    requestData: parsedRequestData,
    responseData: parsedResponseData,
    partialContent: row.partialContent ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: row.createdAt ?? new Date(),
    completedAt: row.completedAt ?? undefined,
    messagePersisted: row.messagePersisted ?? false,
  };
}

// ============================================
// Query Operations
// ============================================

/**
 * Get a streaming job by ID
 */
export async function getJob(jobId: string): Promise<StreamingJob | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(aiStreamingJobs)
        .where(eq(aiStreamingJobs.id, jobId))
        .limit(1),
    "getJob"
  );

  if (!result || result.length === 0) {
    return null;
  }

  return transformToStreamingJob(result[0]);
}

/**
 * Get jobs for a user with pagination
 * Returns jobs ordered by created_at DESC (newest first)
 */
export async function getUserJobs(
  userId: number,
  limit: number = 10
): Promise<StreamingJob[]> {
  // Clamp limit to reasonable max
  const clampedLimit = Math.min(Math.max(limit, 1), 100);

  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(aiStreamingJobs)
        .where(eq(aiStreamingJobs.userId, userId))
        .orderBy(desc(aiStreamingJobs.createdAt))
        .limit(clampedLimit),
    "getUserJobs"
  );

  return result.map(transformToStreamingJob);
}

/**
 * Get jobs for a specific conversation
 */
export async function getConversationJobs(
  conversationId: string
): Promise<StreamingJob[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(aiStreamingJobs)
        .where(eq(aiStreamingJobs.conversationId, conversationId))
        .orderBy(desc(aiStreamingJobs.createdAt)),
    "getConversationJobs"
  );

  return result.map(transformToStreamingJob);
}

/**
 * Get pending jobs for worker processing
 * Uses FOR UPDATE SKIP LOCKED to safely handle concurrent workers
 *
 * Note: FOR UPDATE SKIP LOCKED requires raw SQL in Drizzle
 */
export async function getPendingJobs(
  limit: number = 10
): Promise<StreamingJob[]> {
  const clampedLimit = Math.min(Math.max(limit, 1), MAX_PENDING_JOBS_LIMIT);

  // FOR UPDATE SKIP LOCKED requires raw SQL since Drizzle doesn't support it natively
  // Use explicit column selection to ensure type safety
  // Use sql.raw with proper parameter binding to prevent SQL injection
  const result = await executeQuery(
    (db) =>
      db.execute(
        sql`SELECT
              id,
              conversation_id,
              user_id,
              model_id,
              status,
              request_data,
              response_data,
              partial_content,
              error_message,
              created_at,
              completed_at,
              message_persisted
            FROM ai_streaming_jobs
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT ${sql.raw(clampedLimit.toString())}
            FOR UPDATE SKIP LOCKED`
      ),
    "getPendingJobs"
  );

  // Cast rows to expected type - columns match SelectAiStreamingJob exactly
  const rows = result.rows as unknown as SelectAiStreamingJob[];
  return rows.map(transformToStreamingJob);
}

/**
 * Get active jobs (pending or running) for a user
 */
export async function getActiveJobsForUser(
  userId: number
): Promise<StreamingJob[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(aiStreamingJobs)
        .where(
          and(
            eq(aiStreamingJobs.userId, userId),
            inArray(aiStreamingJobs.status, ["pending", "running"])
          )
        )
        .orderBy(desc(aiStreamingJobs.createdAt)),
    "getActiveJobsForUser"
  );

  return result.map(transformToStreamingJob);
}

// ============================================
// CRUD Operations
// ============================================

/**
 * Create a new streaming job
 */
export async function createJob(data: CreateJobData): Promise<StreamingJob> {
  // Validate required fields
  if (!data.userId) {
    throw ErrorFactories.missingRequiredField("userId");
  }
  if (!data.modelId) {
    throw ErrorFactories.missingRequiredField("modelId");
  }
  if (!data.requestData) {
    throw ErrorFactories.missingRequiredField("requestData");
  }

  // Cast requestData to the schema's expected type (Record<string, unknown>)
  const requestDataForDb = data.requestData as unknown as Record<
    string,
    unknown
  >;

  const result = await executeQuery(
    (db) =>
      db
        .insert(aiStreamingJobs)
        .values({
          id: data.id, // Will use default UUID if undefined
          conversationId: data.conversationId || null,
          userId: data.userId,
          modelId: data.modelId,
          status: "pending",
          requestData: requestDataForDb,
        })
        .returning(),
    "createJob"
  );

  return transformToStreamingJob(result[0]);
}

/**
 * Update job status with optimistic locking support
 *
 * @param jobId - Job ID to update
 * @param data - Update data including optional expectedCurrentStatus for optimistic locking
 * @returns Updated job or null if not found / status mismatch
 *
 * @example
 * // Without optimistic locking (legacy behavior)
 * await updateJobStatus(jobId, { status: 'running' })
 *
 * @example
 * // With optimistic locking (prevents race conditions)
 * await updateJobStatus(jobId, {
 *   status: 'running',
 *   expectedCurrentStatus: 'pending'
 * })
 */
export async function updateJobStatus(
  jobId: string,
  data: UpdateJobStatusData
): Promise<StreamingJob | null> {
  const updateData: Record<string, unknown> = {
    status: data.status,
  };

  // Validate and truncate string fields
  if (data.partialContent !== undefined) {
    updateData.partialContent = validateStringLength(
      data.partialContent,
      MAX_PARTIAL_CONTENT_LENGTH,
      "partialContent"
    );
  }

  if (data.errorMessage !== undefined) {
    updateData.errorMessage = validateStringLength(
      data.errorMessage,
      MAX_ERROR_MESSAGE_LENGTH,
      "errorMessage"
    );
  }

  // Set completedAt for terminal statuses
  if (data.status === "completed" || data.status === "failed") {
    updateData.completedAt = new Date();
  }

  // Build WHERE clause with optimistic locking if expectedCurrentStatus provided
  const whereConditions = [eq(aiStreamingJobs.id, jobId)];
  if (data.expectedCurrentStatus !== undefined) {
    whereConditions.push(eq(aiStreamingJobs.status, data.expectedCurrentStatus));
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(aiStreamingJobs)
        .set(updateData)
        .where(and(...whereConditions))
        .returning(),
    "updateJobStatus"
  );

  if (!result || result.length === 0) {
    // If expectedCurrentStatus was provided and update failed, log potential race condition
    if (data.expectedCurrentStatus !== undefined) {
      const log = createLogger({ module: "ai-streaming-jobs" });
      log.warn("Optimistic lock failed - job status may have changed", {
        jobId,
        expectedStatus: data.expectedCurrentStatus,
        attemptedStatus: data.status,
      });
    }
    return null;
  }

  return transformToStreamingJob(result[0]);
}

/**
 * Complete a job with response data
 */
export async function completeJob(
  jobId: string,
  data: CompleteJobData
): Promise<StreamingJob | null> {
  // Cast responseData to the schema's expected type (Record<string, unknown>)
  const responseDataForDb = data.responseData as unknown as Record<
    string,
    unknown
  >;

  const updateData: {
    status: "completed";
    responseData: Record<string, unknown>;
    completedAt: Date;
    partialContent?: string;
  } = {
    status: "completed",
    responseData: responseDataForDb,
    completedAt: new Date(),
  };

  if (data.finalContent !== undefined) {
    updateData.partialContent = data.finalContent;
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(aiStreamingJobs)
        .set(updateData)
        .where(eq(aiStreamingJobs.id, jobId))
        .returning(),
    "completeJob"
  );

  if (!result || result.length === 0) {
    return null;
  }

  return transformToStreamingJob(result[0]);
}

/**
 * Mark a job as failed
 */
export async function failJob(
  jobId: string,
  errorMessage: string
): Promise<StreamingJob | null> {
  // Validate and truncate error message
  const truncatedErrorMessage = validateStringLength(
    errorMessage,
    MAX_ERROR_MESSAGE_LENGTH,
    "errorMessage"
  );

  const result = await executeQuery(
    (db) =>
      db
        .update(aiStreamingJobs)
        .set({
          status: "failed",
          errorMessage: truncatedErrorMessage,
          completedAt: new Date(),
        })
        .where(eq(aiStreamingJobs.id, jobId))
        .returning(),
    "failJob"
  );

  if (!result || result.length === 0) {
    return null;
  }

  return transformToStreamingJob(result[0]);
}

/**
 * Cancel a job (only if pending or running)
 */
export async function cancelJob(jobId: string): Promise<StreamingJob | null> {
  const result = await executeQuery(
    (db) =>
      db
        .update(aiStreamingJobs)
        .set({
          status: "failed",
          errorMessage: "Job cancelled by user",
          completedAt: new Date(),
        })
        .where(
          and(
            eq(aiStreamingJobs.id, jobId),
            inArray(aiStreamingJobs.status, ["pending", "running"])
          )
        )
        .returning(),
    "cancelJob"
  );

  if (!result || result.length === 0) {
    return null;
  }

  return transformToStreamingJob(result[0]);
}

/**
 * Mark message as persisted
 */
export async function markMessagePersisted(
  jobId: string
): Promise<StreamingJob | null> {
  const result = await executeQuery(
    (db) =>
      db
        .update(aiStreamingJobs)
        .set({
          messagePersisted: true,
        })
        .where(eq(aiStreamingJobs.id, jobId))
        .returning(),
    "markMessagePersisted"
  );

  if (!result || result.length === 0) {
    return null;
  }

  return transformToStreamingJob(result[0]);
}

/**
 * Delete a job by ID
 * @returns Number of jobs deleted (0 or 1)
 */
export async function deleteJob(jobId: string): Promise<number> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(aiStreamingJobs)
        .where(eq(aiStreamingJobs.id, jobId))
        .returning({ id: aiStreamingJobs.id }),
    "deleteJob"
  );

  return result.length;
}

// ============================================
// Cleanup Operations
// ============================================

/**
 * Cleanup completed jobs older than the specified age
 * Returns the number of jobs deleted
 */
export async function cleanupCompletedJobs(
  olderThanDays: number = COMPLETED_JOBS_RETENTION_DAYS
): Promise<number> {
  const log = createLogger({
    module: "ai-streaming-jobs",
    operation: "cleanupCompletedJobs",
  });

  const cutoffDate = new Date(
    Date.now() - olderThanDays * 24 * 60 * 60 * 1000
  );

  log.info("Starting cleanup of completed jobs", {
    olderThanDays,
    cutoffDate: cutoffDate.toISOString(),
  });

  try {
    const result = await executeQuery(
      (db) =>
        db
          .delete(aiStreamingJobs)
          .where(
            and(
              eq(aiStreamingJobs.status, "completed"),
              sql`${aiStreamingJobs.completedAt} IS NOT NULL`,
              lt(aiStreamingJobs.completedAt, cutoffDate)
            )
          )
          .returning({ id: aiStreamingJobs.id }),
      "cleanupCompletedJobs"
    );

    log.info("Cleanup of completed jobs finished", {
      deletedCount: result.length,
    });

    return result.length;
  } catch (error) {
    log.error("Failed to cleanup completed jobs", { error });
    throw error;
  }
}

/**
 * Cleanup failed jobs older than the specified age
 * Returns the number of jobs deleted
 */
export async function cleanupFailedJobs(
  olderThanDays: number = FAILED_JOBS_RETENTION_DAYS
): Promise<number> {
  const log = createLogger({
    module: "ai-streaming-jobs",
    operation: "cleanupFailedJobs",
  });

  const cutoffDate = new Date(
    Date.now() - olderThanDays * 24 * 60 * 60 * 1000
  );

  log.info("Starting cleanup of failed jobs", {
    olderThanDays,
    cutoffDate: cutoffDate.toISOString(),
  });

  try {
    const result = await executeQuery(
      (db) =>
        db
          .delete(aiStreamingJobs)
          .where(
            and(
              eq(aiStreamingJobs.status, "failed"),
              sql`${aiStreamingJobs.completedAt} IS NOT NULL`,
              lt(aiStreamingJobs.completedAt, cutoffDate)
            )
          )
          .returning({ id: aiStreamingJobs.id }),
      "cleanupFailedJobs"
    );

    log.info("Cleanup of failed jobs finished", { deletedCount: result.length });

    return result.length;
  } catch (error) {
    log.error("Failed to cleanup failed jobs", { error });
    throw error;
  }
}

/**
 * Cleanup stale running jobs (running for too long without update)
 * Marks them as failed and returns count
 */
export async function cleanupStaleRunningJobs(
  olderThanMinutes: number = STALE_JOB_THRESHOLD_MINUTES
): Promise<number> {
  const log = createLogger({
    module: "ai-streaming-jobs",
    operation: "cleanupStaleRunningJobs",
  });

  const cutoffDate = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  log.info("Starting cleanup of stale running jobs", {
    olderThanMinutes,
    cutoffDate: cutoffDate.toISOString(),
  });

  try {
    const result = await executeQuery(
      (db) =>
        db
          .update(aiStreamingJobs)
          .set({
            status: "failed",
            errorMessage: "Job timed out - exceeded maximum run time",
            completedAt: new Date(),
          })
          .where(
            and(
              eq(aiStreamingJobs.status, "running"),
              lt(aiStreamingJobs.createdAt, cutoffDate)
            )
          )
          .returning({ id: aiStreamingJobs.id }),
      "cleanupStaleRunningJobs"
    );

    log.info("Cleanup of stale running jobs finished", {
      markedFailedCount: result.length,
    });

    return result.length;
  } catch (error) {
    log.error("Failed to cleanup stale running jobs", { error });
    throw error;
  }
}

// ============================================
// Model Information Operations
// ============================================

/**
 * Get optimal polling interval for a model based on its capabilities
 * Returns interval in milliseconds
 */
export async function getOptimalPollingInterval(
  modelId: number,
  status: UniversalPollingStatus
): Promise<number> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          nexusCapabilities: aiModels.nexusCapabilities,
          averageLatencyMs: aiModels.averageLatencyMs,
        })
        .from(aiModels)
        .where(eq(aiModels.id, modelId))
        .limit(1),
    "getOptimalPollingInterval"
  );

  if (!result || result.length === 0) {
    // Default interval if model not found
    return 1000;
  }

  const model = result[0];
  // Parse capabilities if it's a string
  let capabilities: Record<string, unknown> = {};
  if (model.nexusCapabilities) {
    if (typeof model.nexusCapabilities === "string") {
      try {
        capabilities = JSON.parse(model.nexusCapabilities);
      } catch {
        // Use empty object
      }
    } else {
      capabilities = model.nexusCapabilities as Record<string, unknown>;
    }
  }
  const averageLatency = model.averageLatencyMs ?? 5000;

  // Base interval based on model characteristics
  let baseInterval = 1000; // 1 second default

  if (capabilities.reasoning) {
    baseInterval = 1500; // Slower polling for reasoning models
  } else if (averageLatency < 3000) {
    baseInterval = 500; // Faster polling for quick models
  }

  // Adjust based on job status
  switch (status) {
    case "pending":
      return baseInterval; // Normal polling while waiting
    case "processing":
      return baseInterval * 2; // Slower while initializing
    case "streaming":
      return baseInterval; // Normal polling during streaming
    case "completed":
    case "failed":
    case "cancelled":
      return baseInterval * 3; // Slower for terminal states
    default:
      return baseInterval;
  }
}
