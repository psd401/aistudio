/**
 * Drizzle Jobs Operations
 *
 * Generic job queue operations for background tasks (PDF processing, etc).
 * Separate from ai_streaming_jobs which handles AI chat streaming.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #541 - Remove Legacy RDS Data API Code
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { jobs } from "@/lib/db/schema";

// ============================================
// Types
// ============================================

export type GenericJobStatus = "pending" | "running" | "completed" | "failed";

export interface GenericJob {
  id: number;
  userId: number;
  status: GenericJobStatus;
  type: string;
  input: string;
  output: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateGenericJobData {
  userId: number;
  type: string;
  input: string;
  status?: GenericJobStatus;
  output?: string;
  error?: string;
}

export interface UpdateGenericJobData {
  status?: GenericJobStatus;
  type?: string;
  input?: string;
  output?: string | null;
  error?: string | null;
}

// ============================================
// Job Query Operations
// ============================================

/**
 * Get job by ID
 * Returns null if not found
 */
export async function getGenericJobById(jobId: number): Promise<GenericJob | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1),
    "getGenericJobById"
  );

  return result[0] || null;
}

/**
 * Get job by ID for specific user (access control)
 * Returns null if not found or user doesn't own it
 */
export async function getGenericJobByIdForUser(
  jobId: number,
  userId: number
): Promise<GenericJob | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
        .limit(1),
    "getGenericJobByIdForUser"
  );

  return result[0] || null;
}

/**
 * Get jobs for a user
 */
export async function getGenericJobsByUserId(
  userId: number,
  limit: number = 50
): Promise<GenericJob[]> {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(jobs)
        .where(eq(jobs.userId, userId))
        .orderBy(jobs.createdAt)
        .limit(limit),
    "getGenericJobsByUserId"
  );
}

// ============================================
// Job CRUD Operations
// ============================================

/**
 * Create a new job
 */
export async function createGenericJob(data: CreateGenericJobData): Promise<GenericJob> {
  const result = await executeQuery(
    (db) =>
      db
        .insert(jobs)
        .values({
          userId: data.userId,
          type: data.type,
          input: data.input,
          status: data.status || "pending",
          output: data.output || null,
          error: data.error || null,
        })
        .returning(),
    "createGenericJob"
  );

  return result[0];
}

/**
 * Update job status and optional output/error
 */
export async function updateGenericJobStatus(
  jobId: number,
  status: GenericJobStatus,
  output?: string,
  error?: string
): Promise<GenericJob | null> {
  const updates: {
    status: GenericJobStatus;
    output?: string;
    error?: string;
  } = { status };

  if (output !== undefined) {
    updates.output = output;
  }
  if (error !== undefined) {
    updates.error = error;
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(jobs)
        .set(updates)
        .where(eq(jobs.id, jobId))
        .returning(),
    "updateGenericJobStatus"
  );

  return result[0] || null;
}

/**
 * Update job with flexible field updates
 * Supports updating any combination of status, type, input, output, error
 */
export async function updateGenericJob(
  jobId: number,
  data: UpdateGenericJobData
): Promise<GenericJob | null> {
  // Filter out undefined values to only update provided fields
  const updates: Record<string, unknown> = {};

  if (data.status !== undefined) updates.status = data.status;
  if (data.type !== undefined) updates.type = data.type;
  if (data.input !== undefined) updates.input = data.input;
  if (data.output !== undefined) updates.output = data.output;
  if (data.error !== undefined) updates.error = data.error;

  // Return early if no updates provided
  if (Object.keys(updates).length === 0) {
    return getGenericJobById(jobId);
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(jobs)
        .set(updates)
        .where(eq(jobs.id, jobId))
        .returning(),
    "updateGenericJob"
  );

  return result[0] || null;
}

/**
 * Delete job by ID
 */
export async function deleteGenericJob(jobId: number): Promise<boolean> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(jobs)
        .where(eq(jobs.id, jobId))
        .returning(),
    "deleteGenericJob"
  );

  return result.length > 0;
}
