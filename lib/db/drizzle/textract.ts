/**
 * Drizzle Textract Operations
 *
 * AWS Textract job tracking and usage monitoring operations migrated from
 * RDS Data API to Drizzle ORM. All functions use executeQuery() wrapper
 * with circuit breaker and retry logic.
 *
 * **Note**: The textract_jobs table is used to track pending Textract jobs
 * and link them to repository items. Jobs are deleted upon completion.
 * The textract_usage table tracks monthly page counts for cost monitoring.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #536 - Migrate Knowledge & Document queries to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, desc, sql } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { textractJobs, textractUsage } from "@/lib/db/schema";
import type { SelectTextractJob, SelectTextractUsage } from "@/lib/db/types";
import { createLogger, sanitizeForLogging } from "@/lib/logger";

// ============================================
// Types
// ============================================

/**
 * Data for creating a new Textract job
 */
export interface CreateTextractJobData {
  jobId: string;
  itemId: number;
  fileName: string;
}

/**
 * Textract job metadata returned from database
 */
export interface TextractJobMetadata {
  itemId: number;
  fileName: string;
}

/**
 * Data for updating Textract usage
 */
export interface UpdateTextractUsageData {
  month: string; // Format: YYYY-MM-DD (first day of month)
  pageCount: number;
}

// ============================================
// Constants
// ============================================

/**
 * AWS Textract pricing per page for text detection
 * @see https://aws.amazon.com/textract/pricing/
 */
const TEXTRACT_COST_PER_PAGE = 0.0015;

// ============================================
// Textract Job Operations
// ============================================

/**
 * Get a Textract job by job ID
 */
export async function getTextractJob(
  jobId: string
): Promise<SelectTextractJob | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(textractJobs)
        .where(eq(textractJobs.jobId, jobId))
        .limit(1),
    "getTextractJob"
  );

  return result[0] || null;
}

/**
 * Get Textract job metadata by job ID
 * Returns only the itemId and fileName needed for processing
 */
export async function getTextractJobMetadata(
  jobId: string
): Promise<TextractJobMetadata | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          itemId: textractJobs.itemId,
          fileName: textractJobs.fileName,
        })
        .from(textractJobs)
        .where(eq(textractJobs.jobId, jobId))
        .limit(1),
    "getTextractJobMetadata"
  );

  return result[0] || null;
}

/**
 * Get Textract jobs by item ID
 */
export async function getTextractJobsByItemId(
  itemId: number
): Promise<SelectTextractJob[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(textractJobs)
        .where(eq(textractJobs.itemId, itemId)),
    "getTextractJobsByItemId"
  );

  return result;
}

/**
 * Create a new Textract job record
 * Called when starting a Textract job to track it
 */
export async function createTextractJob(
  data: CreateTextractJobData
): Promise<SelectTextractJob> {
  const log = createLogger({ module: "drizzle-textract" });

  const result = await executeQuery(
    (db) =>
      db
        .insert(textractJobs)
        .values({
          jobId: data.jobId,
          itemId: data.itemId,
          fileName: data.fileName,
        })
        .returning(),
    "createTextractJob"
  );

  if (!result[0]) {
    log.error("Failed to create Textract job", { data: sanitizeForLogging(data) });
    throw new Error("Failed to create Textract job");
  }

  return result[0];
}

/**
 * Delete a Textract job record
 * Called when job completes (success or failure) to clean up
 */
export async function deleteTextractJob(
  jobId: string
): Promise<{ jobId: string } | null> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(textractJobs)
        .where(eq(textractJobs.jobId, jobId))
        .returning({ jobId: textractJobs.jobId }),
    "deleteTextractJob"
  );

  return result[0] || null;
}

// ============================================
// Textract Usage Operations
// ============================================

/**
 * Get Textract usage for a specific month
 * @param month - First day of month in YYYY-MM-DD format
 */
export async function getTextractUsage(
  month: string
): Promise<SelectTextractUsage | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(textractUsage)
        .where(eq(textractUsage.month, month))
        .limit(1),
    "getTextractUsage"
  );

  return result[0] || null;
}

/**
 * Get Textract usage for all months
 * Ordered by month descending (most recent first)
 */
export async function getAllTextractUsage(): Promise<SelectTextractUsage[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(textractUsage)
        .orderBy(desc(textractUsage.month)),
    "getAllTextractUsage"
  );

  return result;
}

/**
 * Track Textract usage by incrementing page count for the current month
 * Uses UPSERT to create or update the monthly record
 *
 * @param pageCount - Number of pages processed
 * @returns Updated usage record
 */
export async function trackTextractUsage(
  pageCount: number
): Promise<SelectTextractUsage> {
  const log = createLogger({ module: "drizzle-textract" });

  // Get first day of current month in YYYY-MM-DD format (UTC)
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const month = monthStart.toISOString().split("T")[0];

  log.debug("Tracking Textract usage", { month, pageCount });

  // Use ON CONFLICT to upsert
  const result = await executeQuery(
    (db) =>
      db
        .insert(textractUsage)
        .values({
          month,
          pageCount,
        })
        .onConflictDoUpdate({
          target: textractUsage.month,
          set: {
            pageCount: sql`${textractUsage.pageCount} + EXCLUDED.page_count`,
            updatedAt: new Date(),
          },
        })
        .returning(),
    "trackTextractUsage"
  );

  if (!result[0]) {
    log.error("Failed to track Textract usage", { month, pageCount });
    throw new Error("Failed to track Textract usage");
  }

  log.debug("Textract usage tracked", {
    month,
    addedPages: pageCount,
    totalPages: result[0].pageCount,
  });

  return result[0];
}

/**
 * Get total Textract usage across all months
 */
export async function getTotalTextractUsage(): Promise<number> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          total: sql<number>`COALESCE(SUM(${textractUsage.pageCount}), 0)`,
        })
        .from(textractUsage),
    "getTotalTextractUsage"
  );

  return result[0]?.total ?? 0;
}

/**
 * Get estimated Textract cost based on page count
 *
 * @param pageCount - Number of pages
 * @returns Estimated cost in USD
 */
export function estimateTextractCost(pageCount: number): number {
  return pageCount * TEXTRACT_COST_PER_PAGE;
}

/**
 * Get Textract usage with cost estimate for a specific month
 */
export async function getTextractUsageWithCost(month: string): Promise<{
  usage: SelectTextractUsage | null;
  estimatedCost: number;
}> {
  const usage = await getTextractUsage(month);

  return {
    usage,
    estimatedCost: usage ? estimateTextractCost(usage.pageCount) : 0,
  };
}
