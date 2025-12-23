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
// Row Transformation Helpers
// ============================================

/**
 * Transform a database row to StreamingJob format
 */
function transformToStreamingJob(row: SelectAiStreamingJob): StreamingJob {
  // Handle requestData parsing - might be string or object
  let parsedRequestData: JobRequestData;
  if (typeof row.requestData === "string") {
    try {
      parsedRequestData = JSON.parse(row.requestData);
    } catch {
      parsedRequestData = { messages: [], modelId: "", provider: "" };
    }
  } else {
    parsedRequestData = row.requestData as unknown as JobRequestData;
  }

  // Handle responseData parsing - might be string or object or null
  let parsedResponseData: JobResponseData | undefined;
  if (row.responseData) {
    if (typeof row.responseData === "string") {
      try {
        parsedResponseData = JSON.parse(row.responseData);
      } catch {
        parsedResponseData = undefined;
      }
    } else {
      parsedResponseData = row.responseData as unknown as JobResponseData;
    }
  }

  // Determine nexusConversationId - UUID-formatted conversation IDs are Nexus conversations
  const conversationId = row.conversationId;
  const isUuid =
    conversationId &&
    conversationId.length === 36 &&
    conversationId.includes("-");

  return {
    id: row.id,
    conversationId: row.conversationId,
    nexusConversationId: isUuid ? conversationId : undefined,
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
  const clampedLimit = Math.min(Math.max(limit, 1), 100);

  // FOR UPDATE SKIP LOCKED requires raw SQL since Drizzle doesn't support it natively
  const result = await executeQuery(
    (db) =>
      db.execute(
        sql`SELECT * FROM ai_streaming_jobs
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT ${clampedLimit}
            FOR UPDATE SKIP LOCKED`
      ),
    "getPendingJobs"
  );

  // Raw query returns rows as array
  const rows = result.rows as SelectAiStreamingJob[];
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
    throw new Error("userId is required");
  }
  if (!data.modelId) {
    throw new Error("modelId is required");
  }
  if (!data.requestData) {
    throw new Error("requestData is required");
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
 * Update job status
 */
export async function updateJobStatus(
  jobId: string,
  data: UpdateJobStatusData
): Promise<StreamingJob | null> {
  const updateData: Record<string, unknown> = {
    status: data.status,
  };

  if (data.partialContent !== undefined) {
    updateData.partialContent = data.partialContent;
  }

  if (data.errorMessage !== undefined) {
    updateData.errorMessage = data.errorMessage;
  }

  // Set completedAt for terminal statuses
  if (data.status === "completed" || data.status === "failed") {
    updateData.completedAt = new Date();
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(aiStreamingJobs)
        .set(updateData)
        .where(eq(aiStreamingJobs.id, jobId))
        .returning(),
    "updateJobStatus"
  );

  if (!result || result.length === 0) {
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
  const result = await executeQuery(
    (db) =>
      db
        .update(aiStreamingJobs)
        .set({
          status: "failed",
          errorMessage,
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
 */
export async function deleteJob(jobId: string): Promise<{ id: string } | null> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(aiStreamingJobs)
        .where(eq(aiStreamingJobs.id, jobId))
        .returning({ id: aiStreamingJobs.id }),
    "deleteJob"
  );

  return result[0] || null;
}

// ============================================
// Cleanup Operations
// ============================================

/**
 * Cleanup completed jobs older than the specified age
 * Returns the number of jobs deleted
 */
export async function cleanupCompletedJobs(
  olderThanDays: number = 7
): Promise<number> {
  const cutoffDate = new Date(
    Date.now() - olderThanDays * 24 * 60 * 60 * 1000
  );

  const result = await executeQuery(
    (db) =>
      db
        .delete(aiStreamingJobs)
        .where(
          and(
            eq(aiStreamingJobs.status, "completed"),
            lt(aiStreamingJobs.completedAt, cutoffDate)
          )
        )
        .returning({ id: aiStreamingJobs.id }),
    "cleanupCompletedJobs"
  );

  return result.length;
}

/**
 * Cleanup failed jobs older than the specified age
 * Returns the number of jobs deleted
 */
export async function cleanupFailedJobs(
  olderThanDays: number = 3
): Promise<number> {
  const cutoffDate = new Date(
    Date.now() - olderThanDays * 24 * 60 * 60 * 1000
  );

  const result = await executeQuery(
    (db) =>
      db
        .delete(aiStreamingJobs)
        .where(
          and(
            eq(aiStreamingJobs.status, "failed"),
            lt(aiStreamingJobs.completedAt, cutoffDate)
          )
        )
        .returning({ id: aiStreamingJobs.id }),
    "cleanupFailedJobs"
  );

  return result.length;
}

/**
 * Cleanup stale running jobs (running for too long without update)
 * Marks them as failed and returns count
 */
export async function cleanupStaleRunningJobs(
  olderThanMinutes: number = 60
): Promise<number> {
  const cutoffDate = new Date(Date.now() - olderThanMinutes * 60 * 1000);

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

  return result.length;
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
