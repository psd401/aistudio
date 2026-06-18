/**
 * Drizzle Assistant Architect Operations
 *
 * Assistant Architect CRUD operations migrated from RDS Data API to Drizzle ORM.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * **IMPORTANT - Authorization**: These are infrastructure-layer data access functions.
 * They do NOT perform authorization checks. Authorization MUST be handled at the
 * server action layer before calling these functions.
 *
 * **Expected Authorization Pattern** (implement in server actions):
 * ```typescript
 * // In /actions/db/assistant-architect-actions.ts
 * export async function deleteAssistantArchitectAction(id: number): Promise<ActionState<void>> {
 *   const session = await getServerSession();
 *   if (!session) {
 *     throw ErrorFactories.authNoSession();
 *   }
 *
 *   // Get architect to verify ownership
 *   const architect = await getAssistantArchitectById(id);
 *   if (!architect) {
 *     throw ErrorFactories.dbRecordNotFound("assistant_architects", id);
 *   }
 *
 *   // Check ownership or admin role
 *   const isOwner = architect.userId === session.user.id;
 *   const isAdmin = await checkUserRole(session.user.id, "admin");
 *   if (!isOwner && !isAdmin) {
 *     throw ErrorFactories.authInsufficientPermissions();
 *   }
 *
 *   // Now safe to call infrastructure layer
 *   await deleteAssistantArchitect(id);
 *   return createSuccess(undefined, "Assistant architect deleted");
 * }
 * ```
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #532 - Migrate AI Models & Configuration queries to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, desc, sql } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import {
  assistantArchitects,
  chainPrompts,
  toolInputFields,
  toolExecutions,
  promptResults,
  tools,
  capabilities,
  users,
  toolEdits,
  scheduledExecutions,
} from "@/lib/db/schema";
import { ErrorFactories } from "@/lib/error-utils";
import { CAPABILITY_MANIFEST } from "@/lib/capabilities/manifest";

/**
 * Identifiers owned by the code manifest. An Assistant Architect whose slugified
 * name collides with one of these MUST NOT claim it (the approval upsert would
 * otherwise overwrite the manifest row's source/promptChainToolId, corrupting a
 * code-managed capability). Collisions are disambiguated with an id suffix.
 */
const MANIFEST_IDENTIFIERS: ReadonlySet<string> = new Set(
  CAPABILITY_MANIFEST.map((e) => e.identifier)
);

/**
 * Slugify an Assistant Architect name into a tool/capability identifier.
 * If the slug collides with a code-manifest identifier, append the assistant id
 * to keep the AA's own row distinct from the manifest-managed capability.
 */
function buildAssistantToolIdentifier(name: string, assistantId: number): string {
  const base = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\da-z-]/g, "");
  return MANIFEST_IDENTIFIERS.has(base) ? `${base}-${assistantId}` : base;
}

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
  // Delete in correct order to respect foreign key constraints.
  // Use executeTransaction directly (never nest db.transaction inside
  // executeQuery — the wrapper's retry could replay a partially-committed tx).
  return executeTransaction(
    async (tx) => {
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

      // 5. Delete tool_edits (audit log rows — FK with no onDelete cascade)
      await tx
        .delete(toolEdits)
        .where(eq(toolEdits.assistantArchitectId, id));

      // 6. Delete scheduled_executions (FK with no onDelete cascade)
      await tx
        .delete(scheduledExecutions)
        .where(eq(scheduledExecutions.assistantArchitectId, id));

      // 7. Finally delete the assistant architect itself
      const result = await tx
        .delete(assistantArchitects)
        .where(eq(assistantArchitects.id, id))
        .returning();

      return result[0];
    },
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
  // Use executeTransaction directly (never nest db.transaction inside
  // executeQuery — the wrapper's retry could replay a partially-committed tx).
  return executeTransaction(
    async (tx) => {
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

      // Defensive check for name (should not be null per schema, but handle edge case)
      if (!assistant.name) {
        throw new Error(`Assistant architect ${id} has no name`);
      }

      // Create tool entry if it doesn't already exist
      // Use INSERT ... ON CONFLICT DO NOTHING to handle race conditions
      // If another transaction creates the tool first, this silently succeeds.
      // A name that slugifies to a code-manifest identifier is disambiguated with
      // an id suffix so the approval upsert can never hijack a manifest-owned
      // capability row (which would overwrite its source/promptChainToolId).
      let toolIdentifier = buildAssistantToolIdentifier(
        assistant.name,
        assistant.id
      );

      // Guard against two different assistants whose names slugify to the same
      // identifier (e.g. both "Weekly Report" -> "weekly-report"). Without this,
      // the upsert below would re-stamp the FIRST assistant's capability row with
      // THIS assistant's promptChainToolId, silently stealing its tool mapping
      // (assistant_architects.name is not unique). If the identifier is already
      // owned by a different assistant, disambiguate with this assistant's id.
      const [conflicting] = await tx
        .select({ promptChainToolId: capabilities.promptChainToolId })
        .from(capabilities)
        .where(eq(capabilities.identifier, toolIdentifier))
        .limit(1);
      if (
        conflicting &&
        conflicting.promptChainToolId !== null &&
        conflicting.promptChainToolId !== assistant.id
      ) {
        toolIdentifier = `${toolIdentifier}-${assistant.id}`;
      }

      // Race condition safety: concurrent approvals can't produce duplicate key
      // errors because the tool identifier is unique. On conflict we upsert (not
      // skip) so a re-approved AA — whose tool row was deactivated during an edit
      // — is re-activated and its promptChainToolId is re-stamped. The
      // post-approval code looks the tool up by promptChainToolId, so a skipped
      // insert that left a stale/NULL promptChainToolId would break the lookup.
      await tx
        .insert(tools)
        .values({
          identifier: toolIdentifier,
          name: assistant.name,
          description: assistant.description,
          promptChainToolId: assistant.id,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: tools.identifier,
          set: {
            name: assistant.name,
            description: assistant.description,
            promptChainToolId: assistant.id,
            isActive: true,
            updatedAt: new Date(),
          },
        });

      // Issue #923: dual-write the capability row in the same transaction so the
      // post-approval role grant (which now targets role_capabilities) and the
      // hasToolAccess() read path (which now reads capabilities) stay consistent.
      // AA-generated capabilities are source='manual' (admin-editable, like the
      // legacy tool row).
      //
      // On conflict we MUST upsert, not skip: an AA that was approved, edited
      // (which deactivates this row via updateAssistantArchitectAction), then
      // re-approved would otherwise stay is_active=false forever — the row exists,
      // so the insert is skipped, and hasCapabilityAccess (which filters
      // is_active=true) would deny access permanently. Re-stamp promptChainToolId
      // so the post-approval lookup-by-promptChainToolId always resolves, even if
      // the identifier was first claimed by the manifest sync (which leaves
      // prompt_chain_tool_id NULL). We intentionally re-sync name/description from
      // the assistant so the capability stays in step with the AA on re-approval.
      await tx
        .insert(capabilities)
        .values({
          identifier: toolIdentifier,
          name: assistant.name,
          description: assistant.description,
          promptChainToolId: assistant.id,
          isActive: true,
          source: "manual",
        })
        .onConflictDoUpdate({
          target: capabilities.identifier,
          set: {
            name: assistant.name,
            description: assistant.description,
            promptChainToolId: assistant.id,
            isActive: true,
            source: "manual",
            updatedAt: new Date(),
          },
        });

      return assistant;
    },
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
