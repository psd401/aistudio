import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, desc } from "drizzle-orm"
import { assistantArchitects, users, toolInputFields, chainPrompts, tools, navigationItems } from "@/lib/db/schema"
import { parseRepositoryIds } from "@/lib/utils/repository-utils"

/**
 * Get all assistant architects with their related data
 */
export async function getAssistantArchitectsWithRelations() {
  const architectsRaw = await executeQuery(
    (db) => db.select({
      id: assistantArchitects.id,
      name: assistantArchitects.name,
      description: assistantArchitects.description,
      status: assistantArchitects.status,
      imagePath: assistantArchitects.imagePath,
      userId: assistantArchitects.userId,
      createdAt: assistantArchitects.createdAt,
      updatedAt: assistantArchitects.updatedAt,
      creatorFirstName: users.firstName,
      creatorLastName: users.lastName,
      creatorEmail: users.email,
      cognitoSub: users.cognitoSub
    })
    .from(assistantArchitects)
    .leftJoin(users, eq(assistantArchitects.userId, users.id)),
    "getAssistantArchitectsWithRelations"
  )

  return Promise.all(
    architectsRaw.map(async (architect) => {
      const [inputFieldsRaw, promptsRaw] = await Promise.all([
        getToolInputFields(architect.id),
        getChainPrompts(architect.id)
      ]);

      const inputFields = inputFieldsRaw;
      const prompts = promptsRaw.map((prompt) => {
        const transformed = { ...prompt };
        transformed.repositoryIds = parseRepositoryIds(transformed.repositoryIds);
        // Ensure enabledTools is an array
        if (!Array.isArray(transformed.enabledTools)) {
          transformed.enabledTools = [];
        }
        return transformed;
      });

      return {
        ...architect,
        inputFields,
        prompts,
        creator: architect.creatorFirstName && architect.creatorLastName && architect.creatorEmail
          ? {
              firstName: architect.creatorFirstName,
              lastName: architect.creatorLastName,
              email: architect.creatorEmail
            }
          : null,
        cognito_sub: architect.cognitoSub
      };
    })
  );
}

/**
 * Get assistant architect by ID
 */
export async function getAssistantArchitectById(id: number) {
  const architectResult = await executeQuery(
    (db) => db.select({
      id: assistantArchitects.id,
      name: assistantArchitects.name,
      description: assistantArchitects.description,
      status: assistantArchitects.status,
      imagePath: assistantArchitects.imagePath,
      userId: assistantArchitects.userId,
      createdAt: assistantArchitects.createdAt,
      updatedAt: assistantArchitects.updatedAt
    })
    .from(assistantArchitects)
    .where(eq(assistantArchitects.id, id))
    .limit(1),
    "getAssistantArchitectById"
  )

  return architectResult[0] || null;
}

/**
 * Get tool input fields for an assistant architect
 */
export async function getToolInputFields(architectId: number) {
  return executeQuery(
    (db) => db.select({
      id: toolInputFields.id,
      assistantArchitectId: toolInputFields.assistantArchitectId,
      name: toolInputFields.name,
      label: toolInputFields.label,
      fieldType: toolInputFields.fieldType,
      position: toolInputFields.position,
      options: toolInputFields.options,
      createdAt: toolInputFields.createdAt,
      updatedAt: toolInputFields.updatedAt
    })
    .from(toolInputFields)
    .where(eq(toolInputFields.assistantArchitectId, architectId))
    .orderBy(toolInputFields.position),
    "getToolInputFields"
  )
}

/**
 * Get chain prompts for an assistant architect
 */
export async function getChainPrompts(architectId: number) {
  return executeQuery(
    (db) => db.select({
      id: chainPrompts.id,
      assistantArchitectId: chainPrompts.assistantArchitectId,
      name: chainPrompts.name,
      content: chainPrompts.content,
      systemContext: chainPrompts.systemContext,
      modelId: chainPrompts.modelId,
      position: chainPrompts.position,
      inputMapping: chainPrompts.inputMapping,
      repositoryIds: chainPrompts.repositoryIds,
      enabledTools: chainPrompts.enabledTools,
      createdAt: chainPrompts.createdAt,
      updatedAt: chainPrompts.updatedAt
    })
    .from(chainPrompts)
    .where(eq(chainPrompts.assistantArchitectId, architectId))
    .orderBy(chainPrompts.position),
    "getChainPrompts"
  )
}

/**
 * Get pending assistant architects
 */
export async function getPendingAssistantArchitects() {
  return executeQuery(
    (db) => db.select({
      id: assistantArchitects.id,
      name: assistantArchitects.name,
      description: assistantArchitects.description,
      status: assistantArchitects.status,
      imagePath: assistantArchitects.imagePath,
      userId: assistantArchitects.userId,
      createdAt: assistantArchitects.createdAt,
      updatedAt: assistantArchitects.updatedAt
    })
    .from(assistantArchitects)
    .where(eq(assistantArchitects.status, 'pending_approval'))
    .orderBy(desc(assistantArchitects.createdAt)),
    "getPendingAssistantArchitects"
  )
}

/**
 * Update assistant architect status to pending and deactivate in tools table
 */
export async function updateAssistantArchitectToPending(id: number) {
  await executeQuery(
    (db) => db.update(tools)
      .set({ isActive: false })
      .where(eq(tools.promptChainToolId, id)),
    "updateAssistantArchitectToPending"
  )
}

/**
 * Delete assistant architect from tools table
 */
export async function deleteAssistantArchitectFromTools(id: number) {
  await executeQuery(
    (db) => db.delete(tools)
      .where(eq(tools.promptChainToolId, id)),
    "deleteAssistantArchitectFromTools"
  )
}

/**
 * Delete assistant architect from navigation items
 */
export async function deleteAssistantArchitectFromNavigation(id: number) {
  await executeQuery(
    (db) => db.delete(navigationItems)
      .where(eq(navigationItems.link, `/tools/assistant-architect/${id}`)),
    "deleteAssistantArchitectFromNavigation"
  )
}