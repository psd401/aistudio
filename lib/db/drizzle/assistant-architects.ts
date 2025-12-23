/**
 * Drizzle Assistant Architect Operations
 *
 * Assistant Architect CRUD operations migrated from RDS Data API to Drizzle ORM.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #532 - Migrate AI Models & Configuration queries to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, desc, sql } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  assistantArchitects,
  chainPrompts,
  toolInputFields,
  toolExecutions,
  promptResults,
  tools,
  users,
} from "@/lib/db/schema";
import { createLogger, generateRequestId } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";

// ============================================
// Types
// ============================================

/** Tool status values from the database enum */
export type ToolStatus = "draft" | "pending_approval" | "approved" | "rejected" | "disabled";

export interface AssistantArchitectData {
  name: string;
  description?: string | null;
  userId: number;
  status?: ToolStatus;
  isParallel?: boolean;
  timeoutSeconds?: number | null;
  imagePath?: string | null;
}

export interface AssistantArchitectUpdateData {
  name?: string;
  description?: string | null;
  status?: ToolStatus;
  isParallel?: boolean;
  timeoutSeconds?: number | null;
  imagePath?: string | null;
}

export interface AssistantArchitectWithCreator {
  id: number;
  name: string;
  description: string | null;
  status: ToolStatus;
  isParallel: boolean;
  timeoutSeconds: number | null;
  imagePath: string | null;
  userId: number | null;
  createdAt: Date;
  updatedAt: Date;
  creator: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null;
}

// ============================================
// Assistant Architect Query Operations
// ============================================

/**
 * Get all assistant architects with creator info
 */
export async function getAssistantArchitects(): Promise<
  AssistantArchitectWithCreator[]
> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: assistantArchitects.id,
          name: assistantArchitects.name,
          description: assistantArchitects.description,
          status: assistantArchitects.status,
          isParallel: assistantArchitects.isParallel,
          timeoutSeconds: assistantArchitects.timeoutSeconds,
          imagePath: assistantArchitects.imagePath,
          userId: assistantArchitects.userId,
          createdAt: assistantArchitects.createdAt,
          updatedAt: assistantArchitects.updatedAt,
          creatorId: users.id,
          creatorFirstName: users.firstName,
          creatorLastName: users.lastName,
          creatorEmail: users.email,
        })
        .from(assistantArchitects)
        .leftJoin(users, eq(assistantArchitects.userId, users.id))
        .orderBy(desc(assistantArchitects.createdAt)),
    "getAssistantArchitects"
  );

  // Transform to match expected format with nested creator object
  return result.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    isParallel: row.isParallel,
    timeoutSeconds: row.timeoutSeconds,
    imagePath: row.imagePath,
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    creator:
      row.creatorId && row.creatorEmail
        ? {
            id: row.creatorId,
            firstName: row.creatorFirstName,
            lastName: row.creatorLastName,
            email: row.creatorEmail,
          }
        : null,
  }));
}

/**
 * Get assistant architect by ID
 */
export async function getAssistantArchitectById(id: number) {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(assistantArchitects)
        .where(eq(assistantArchitects.id, id))
        .limit(1),
    "getAssistantArchitectById"
  );

  return result[0] || null;
}

/**
 * Get assistant architect with creator info by ID
 */
export async function getAssistantArchitectWithCreator(
  id: number
): Promise<AssistantArchitectWithCreator | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: assistantArchitects.id,
          name: assistantArchitects.name,
          description: assistantArchitects.description,
          status: assistantArchitects.status,
          isParallel: assistantArchitects.isParallel,
          timeoutSeconds: assistantArchitects.timeoutSeconds,
          imagePath: assistantArchitects.imagePath,
          userId: assistantArchitects.userId,
          createdAt: assistantArchitects.createdAt,
          updatedAt: assistantArchitects.updatedAt,
          creatorId: users.id,
          creatorFirstName: users.firstName,
          creatorLastName: users.lastName,
          creatorEmail: users.email,
        })
        .from(assistantArchitects)
        .leftJoin(users, eq(assistantArchitects.userId, users.id))
        .where(eq(assistantArchitects.id, id))
        .limit(1),
    "getAssistantArchitectWithCreator"
  );

  if (!result[0]) return null;

  const row = result[0];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    isParallel: row.isParallel,
    timeoutSeconds: row.timeoutSeconds,
    imagePath: row.imagePath,
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    creator:
      row.creatorId && row.creatorEmail
        ? {
            id: row.creatorId,
            firstName: row.creatorFirstName,
            lastName: row.creatorLastName,
            email: row.creatorEmail,
          }
        : null,
  };
}

/**
 * Get assistant architects by user ID
 */
export async function getAssistantArchitectsByUserId(userId: number) {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(assistantArchitects)
        .where(eq(assistantArchitects.userId, userId))
        .orderBy(desc(assistantArchitects.createdAt)),
    "getAssistantArchitectsByUserId"
  );
}

/**
 * Get assistant architects by status
 */
export async function getAssistantArchitectsByStatus(
  status: "draft" | "pending_approval" | "approved" | "rejected"
) {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(assistantArchitects)
        .where(eq(assistantArchitects.status, status))
        .orderBy(desc(assistantArchitects.createdAt)),
    "getAssistantArchitectsByStatus"
  );
}

/**
 * Get pending assistant architects for approval
 */
export async function getPendingAssistantArchitects() {
  return getAssistantArchitectsByStatus("pending_approval");
}

// ============================================
// Assistant Architect CRUD Operations
// ============================================

/**
 * Create a new assistant architect
 */
export async function createAssistantArchitect(data: AssistantArchitectData) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(assistantArchitects)
        .values({
          name: data.name,
          description: data.description,
          userId: data.userId,
          status: data.status ?? "draft",
          isParallel: data.isParallel ?? false,
          timeoutSeconds: data.timeoutSeconds,
          imagePath: data.imagePath,
        })
        .returning(),
    "createAssistantArchitect"
  );
  return result[0];
}

/**
 * Create assistant architect from Cognito sub
 * Looks up user ID from cognito_sub before creating
 */
export async function createAssistantArchitectByCognitoSub(data: {
  name: string;
  description?: string | null;
  cognitoSub: string;
  status?: "draft" | "pending_approval" | "approved" | "rejected";
}) {
  // First get the user's database ID from their Cognito sub
  const userResult = await executeQuery(
    (db) =>
      db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.cognitoSub, data.cognitoSub))
        .limit(1),
    "getUserByCognitoSub"
  );

  if (!userResult[0]) {
    throw ErrorFactories.dbRecordNotFound("users", data.cognitoSub);
  }

  return createAssistantArchitect({
    name: data.name,
    description: data.description,
    userId: userResult[0].id,
    status: data.status,
  });
}

/**
 * Update an assistant architect
 */
export async function updateAssistantArchitect(
  id: number,
  updates: AssistantArchitectUpdateData
) {
  const result = await executeQuery(
    (db) =>
      db
        .update(assistantArchitects)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(assistantArchitects.id, id))
        .returning(),
    "updateAssistantArchitect"
  );
  return result[0];
}

/**
 * Delete an assistant architect and all related records
 * Uses cascading deletes through related tables
 */
export async function deleteAssistantArchitect(id: number) {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, function: "deleteAssistantArchitect" });

  log.info("Deleting assistant architect", { id });

  // Delete in correct order to respect foreign key constraints
  return executeQuery(
    (db) => db.transaction(async (tx) => {
      // 1. Delete prompt_results (references chain_prompts via prompt_id)
      await tx
        .delete(promptResults)
        .where(
          sql`${promptResults.promptId} IN (SELECT id FROM chain_prompts WHERE assistant_architect_id = ${id})`
        );

      // 2. Delete chain_prompts
      await tx
        .delete(chainPrompts)
        .where(eq(chainPrompts.assistantArchitectId, id));

      // 3. Delete tool_input_fields
      await tx
        .delete(toolInputFields)
        .where(eq(toolInputFields.assistantArchitectId, id));

      // 4. Delete tool_executions
      await tx
        .delete(toolExecutions)
        .where(eq(toolExecutions.assistantArchitectId, id));

      // 5. Finally delete the assistant architect itself
      const result = await tx
        .delete(assistantArchitects)
        .where(eq(assistantArchitects.id, id))
        .returning();

      log.info("Assistant architect deleted successfully", { id });
      return result[0];
    }),
    "deleteAssistantArchitectTransaction"
  );
}

// ============================================
// Status Management Operations
// ============================================

/**
 * Approve an assistant architect
 * Also creates the corresponding tool entry if it doesn't exist
 */
export async function approveAssistantArchitect(id: number) {
  const requestId = generateRequestId();
  const log = createLogger({
    requestId,
    function: "approveAssistantArchitect",
  });

  log.info("Approving assistant architect", { id });

  return executeQuery(
    (db) => db.transaction(async (tx) => {
      // Update status to approved
      const result = await tx
        .update(assistantArchitects)
        .set({
          status: "approved",
          updatedAt: new Date(),
        })
        .where(eq(assistantArchitects.id, id))
        .returning();

      const assistant = result[0];
      if (!assistant) {
        throw ErrorFactories.dbRecordNotFound("assistant_architects", id);
      }

      // Create tool entry if it doesn't already exist
      // Use INSERT ... ON CONFLICT DO NOTHING pattern
      const toolIdentifier = assistant.name
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^\da-z-]/g, "");

      await tx
        .insert(tools)
        .values({
          identifier: toolIdentifier,
          name: assistant.name,
          description: assistant.description,
          promptChainToolId: assistant.id,
          isActive: true,
        })
        .onConflictDoNothing({
          target: tools.identifier,
        });

      log.info("Assistant architect approved", { id, toolIdentifier });
      return assistant;
    }),
    "approveAssistantArchitectTransaction"
  );
}

/**
 * Reject an assistant architect
 */
export async function rejectAssistantArchitect(id: number) {
  const result = await executeQuery(
    (db) =>
      db
        .update(assistantArchitects)
        .set({
          status: "rejected",
          updatedAt: new Date(),
        })
        .where(eq(assistantArchitects.id, id))
        .returning(),
    "rejectAssistantArchitect"
  );
  return result[0];
}

/**
 * Submit assistant architect for approval
 */
export async function submitForApproval(id: number) {
  const result = await executeQuery(
    (db) =>
      db
        .update(assistantArchitects)
        .set({
          status: "pending_approval",
          updatedAt: new Date(),
        })
        .where(eq(assistantArchitects.id, id))
        .returning(),
    "submitForApproval"
  );
  return result[0];
}
