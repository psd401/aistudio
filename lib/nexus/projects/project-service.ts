import "server-only";

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { getAccessibleRepositoryIds } from "@/lib/db/drizzle";
import {
  executeQuery,
  executeTransaction,
} from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  nexusConversations,
  nexusProjectMembers,
  nexusProjectRepositories,
  nexusProjects,
  repositoryAccess,
  users,
  type NexusProjectMemberRole,
} from "@/lib/db/schema";

export class NexusProjectAccessError extends Error {
  constructor(message = "Project not found") {
    super(message);
    this.name = "NexusProjectAccessError";
  }
}

async function requireMembership(projectId: string, userId: number) {
  const [membership] = await executeQuery(
    (db) =>
      db
        .select({
          projectId: nexusProjects.id,
          ownerId: nexusProjects.ownerId,
          projectRepositoryId: nexusProjects.projectRepositoryId,
          role: nexusProjectMembers.role,
          name: nexusProjects.name,
          instructions: nexusProjects.instructions,
        })
        .from(nexusProjects)
        .innerJoin(
          nexusProjectMembers,
          and(
            eq(nexusProjectMembers.projectId, nexusProjects.id),
            eq(nexusProjectMembers.userId, userId)
          )
        )
        .where(eq(nexusProjects.id, projectId))
        .limit(1),
    "requireNexusProjectMembership"
  );
  if (!membership) throw new NexusProjectAccessError();
  return membership;
}

function assertCanEdit(role: NexusProjectMemberRole) {
  if (role !== "owner" && role !== "editor") {
    throw new NexusProjectAccessError();
  }
}

function assertOwner(role: NexusProjectMemberRole) {
  if (role !== "owner") throw new NexusProjectAccessError();
}

export async function createNexusProject(input: {
  ownerId: number;
  name: string;
  instructions?: string;
}) {
  const name = input.name.trim();
  const instructions = input.instructions?.trim() ?? "";
  return executeTransaction(
    async (tx) => {
      const [repository] = await tx
        .insert(knowledgeRepositories)
        .values({
          name: `${name} — Project files`,
          description: `Private working repository for the Nexus project "${name}".`,
          ownerId: input.ownerId,
          isPublic: false,
          repositoryKind: "durable",
          lifecycleStatus: "active",
          metadata: {
            nexusProjectManaged: true,
          },
        })
        .returning({ id: knowledgeRepositories.id });
      if (!repository) throw new Error("Failed to create project repository");
      const [project] = await tx
        .insert(nexusProjects)
        .values({
          ownerId: input.ownerId,
          name,
          instructions,
          projectRepositoryId: repository.id,
        })
        .returning();
      if (!project) throw new Error("Failed to create Nexus project");
      await tx.insert(nexusProjectMembers).values({
        projectId: project.id,
        userId: input.ownerId,
        role: "owner",
      });
      return project;
    },
    "createNexusProject"
  );
}

export async function listNexusProjects(userId: number) {
  return executeQuery(
    (db) =>
      db
        .select({
          id: nexusProjects.id,
          name: nexusProjects.name,
          instructions: nexusProjects.instructions,
          ownerId: nexusProjects.ownerId,
          ownerEmail: users.email,
          role: nexusProjectMembers.role,
          projectRepositoryId: nexusProjects.projectRepositoryId,
          updatedAt: nexusProjects.updatedAt,
          conversationCount: sql<number>`(
            SELECT count(*)::int
            FROM nexus_conversations conversation
            WHERE conversation.project_id = ${nexusProjects.id}
              AND conversation.user_id = ${userId}
          )`,
        })
        .from(nexusProjects)
        .innerJoin(
          nexusProjectMembers,
          and(
            eq(nexusProjectMembers.projectId, nexusProjects.id),
            eq(nexusProjectMembers.userId, userId)
          )
        )
        .innerJoin(users, eq(users.id, nexusProjects.ownerId))
        .orderBy(desc(nexusProjects.updatedAt)),
    "listNexusProjects"
  );
}

export async function getNexusProject(projectId: string, userId: number) {
  const membership = await requireMembership(projectId, userId);
  const repositoryBindings = await executeQuery(
    (db) =>
      db
        .select({ repositoryId: nexusProjectRepositories.repositoryId })
        .from(nexusProjectRepositories)
        .where(eq(nexusProjectRepositories.projectId, projectId)),
    "getNexusProjectRepositoryBindings"
  );
  const accessibleConnectedRepositoryIds = await getAccessibleRepositoryIds(
    repositoryBindings.map((binding) => binding.repositoryId),
    userId
  );
  const [members, connectedRepositories, conversations, projectRepository] =
    await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              userId: nexusProjectMembers.userId,
              role: nexusProjectMembers.role,
              email: users.email,
              firstName: users.firstName,
              lastName: users.lastName,
            })
            .from(nexusProjectMembers)
            .innerJoin(users, eq(users.id, nexusProjectMembers.userId))
            .where(eq(nexusProjectMembers.projectId, projectId))
            .orderBy(users.email),
        "getNexusProjectMembers"
      ),
      executeQuery(
        (db) =>
          db
            .select({
              id: knowledgeRepositories.id,
              name: knowledgeRepositories.name,
              description: knowledgeRepositories.description,
              activeIndexGenerationId:
                knowledgeRepositories.activeIndexGenerationId,
            })
            .from(nexusProjectRepositories)
            .innerJoin(
              knowledgeRepositories,
              eq(
                knowledgeRepositories.id,
                nexusProjectRepositories.repositoryId
              )
            )
            .where(
              and(
                eq(nexusProjectRepositories.projectId, projectId),
                inArray(
                  nexusProjectRepositories.repositoryId,
                  accessibleConnectedRepositoryIds
                )
              )
            )
            .orderBy(knowledgeRepositories.name),
        "getNexusProjectConnectedRepositories"
      ),
      executeQuery(
        (db) =>
          db
            .select({
              id: nexusConversations.id,
              title: nexusConversations.title,
              provider: nexusConversations.provider,
              messageCount: nexusConversations.messageCount,
              updatedAt: nexusConversations.updatedAt,
            })
            .from(nexusConversations)
            .where(
              and(
                eq(nexusConversations.projectId, projectId),
                eq(nexusConversations.userId, userId)
              )
            )
            .orderBy(desc(nexusConversations.updatedAt)),
        "getNexusProjectConversations"
      ),
      executeQuery(
        (db) =>
          db
            .select({
              id: knowledgeRepositories.id,
              name: knowledgeRepositories.name,
              itemCount: sql<number>`(
                SELECT count(*)::int
                FROM repository_items item
                WHERE item.repository_id = ${knowledgeRepositories.id}
              )`,
            })
            .from(knowledgeRepositories)
            .where(
              eq(
                knowledgeRepositories.id,
                membership.projectRepositoryId
              )
            )
            .limit(1),
        "getNexusProjectRepository"
      ),
    ]);
  return {
    ...membership,
    members,
    connectedRepositories,
    conversations,
    projectRepository: projectRepository[0] ?? null,
  };
}

export async function updateNexusProject(input: {
  projectId: string;
  userId: number;
  name: string;
  instructions: string;
}) {
  const membership = await requireMembership(input.projectId, input.userId);
  assertCanEdit(membership.role);
  const [updated] = await executeQuery(
    (db) =>
      db
        .update(nexusProjects)
        .set({
          name: input.name.trim(),
          instructions: input.instructions.trim(),
          updatedAt: new Date(),
        })
        .where(eq(nexusProjects.id, input.projectId))
        .returning(),
    "updateNexusProject"
  );
  return updated;
}

export async function addNexusProjectMember(input: {
  projectId: string;
  actorUserId: number;
  email: string;
  role: Exclude<NexusProjectMemberRole, "owner">;
}) {
  const membership = await requireMembership(input.projectId, input.actorUserId);
  assertOwner(membership.role);
  return executeTransaction(
    async (tx) => {
      const [target] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(sql`lower(${users.email})`, input.email.trim().toLowerCase()))
        .limit(1);
      if (!target) throw new Error("User not found");
      if (target.id === membership.ownerId) {
        throw new Error("The project owner is already a member");
      }
      const [grant] = await tx
        .insert(repositoryAccess)
        .values({
          repositoryId: membership.projectRepositoryId,
          userId: target.id,
        })
        .returning({ id: repositoryAccess.id });
      if (!grant) throw new Error("Failed to grant project repository access");
      await tx.insert(nexusProjectMembers).values({
        projectId: input.projectId,
        userId: target.id,
        role: input.role,
        repositoryAccessId: grant.id,
      });
      return { userId: target.id, role: input.role };
    },
    "addNexusProjectMember"
  );
}

export async function removeNexusProjectMember(input: {
  projectId: string;
  actorUserId: number;
  memberUserId: number;
}) {
  const membership = await requireMembership(input.projectId, input.actorUserId);
  assertOwner(membership.role);
  if (input.memberUserId === membership.ownerId) {
    throw new Error("The project owner cannot be removed");
  }
  return executeTransaction(
    async (tx) => {
      const [removed] = await tx
        .delete(nexusProjectMembers)
        .where(
          and(
            eq(nexusProjectMembers.projectId, input.projectId),
            eq(nexusProjectMembers.userId, input.memberUserId),
            ne(nexusProjectMembers.role, "owner")
          )
        )
        .returning({
          repositoryAccessId: nexusProjectMembers.repositoryAccessId,
        });
      if (!removed) throw new NexusProjectAccessError();
      if (removed.repositoryAccessId) {
        await tx
          .delete(repositoryAccess)
          .where(eq(repositoryAccess.id, removed.repositoryAccessId));
      }
      return true;
    },
    "removeNexusProjectMember"
  );
}

export async function connectNexusProjectRepository(input: {
  projectId: string;
  userId: number;
  repositoryId: number;
}) {
  const membership = await requireMembership(input.projectId, input.userId);
  assertCanEdit(membership.role);
  if (input.repositoryId === membership.projectRepositoryId) {
    throw new Error("The project repository is already connected");
  }
  const accessible = await getAccessibleRepositoryIds(
    [input.repositoryId],
    input.userId
  );
  if (accessible.length !== 1) throw new NexusProjectAccessError();
  const [durableRepository] = await executeQuery(
    (db) =>
      db
        .select({ id: knowledgeRepositories.id })
        .from(knowledgeRepositories)
        .where(
          and(
            eq(knowledgeRepositories.id, input.repositoryId),
            eq(knowledgeRepositories.repositoryKind, "durable")
          )
        )
        .limit(1),
    "validateNexusProjectConnectedRepository"
  );
  if (!durableRepository) {
    throw new Error("Only durable repositories can be connected to a project");
  }
  await executeQuery(
    (db) =>
      db
        .insert(nexusProjectRepositories)
        .values({
          projectId: input.projectId,
          repositoryId: input.repositoryId,
          connectedBy: input.userId,
        })
        .onConflictDoNothing(),
    "connectNexusProjectRepository"
  );
}

export async function disconnectNexusProjectRepository(input: {
  projectId: string;
  userId: number;
  repositoryId: number;
}) {
  const membership = await requireMembership(input.projectId, input.userId);
  assertCanEdit(membership.role);
  await executeQuery(
    (db) =>
      db
        .delete(nexusProjectRepositories)
        .where(
          and(
            eq(nexusProjectRepositories.projectId, input.projectId),
            eq(nexusProjectRepositories.repositoryId, input.repositoryId)
          )
        ),
    "disconnectNexusProjectRepository"
  );
}

export async function createNexusProjectConversation(input: {
  projectId: string;
  userId: number;
  title?: string;
}) {
  await requireMembership(input.projectId, input.userId);
  const [conversation] = await executeQuery(
    (db) =>
      db
        .insert(nexusConversations)
        .values({
          userId: input.userId,
          projectId: input.projectId,
          provider: "nexus",
          title: input.title?.trim() || "New project chat",
          messageCount: 0,
          totalTokens: 0,
          metadata: {},
        })
        .returning({
          id: nexusConversations.id,
          title: nexusConversations.title,
        }),
    "createNexusProjectConversation"
  );
  if (!conversation) throw new Error("Failed to create project conversation");
  return conversation;
}

/**
 * Resolve project instructions and repositories for a chat turn. Connected
 * repositories are filtered against the executing member's current access on
 * every call; membership removal and repository revocation therefore take
 * effect without republishing or recreating the chat.
 */
export async function resolveNexusProjectChatContext(input: {
  projectId: string;
  userId: number;
}) {
  const membership = await requireMembership(input.projectId, input.userId);
  const connected = await executeQuery(
    (db) =>
      db
        .select({ repositoryId: nexusProjectRepositories.repositoryId })
        .from(nexusProjectRepositories)
        .where(eq(nexusProjectRepositories.projectId, input.projectId)),
    "resolveNexusProjectRepositories"
  );
  const connectedIds = await getAccessibleRepositoryIds(
    connected.map((row) => row.repositoryId),
    input.userId
  );
  return {
    name: membership.name,
    instructions: membership.instructions,
    repositoryIds: [
      membership.projectRepositoryId,
      ...connectedIds.filter((id) => id !== membership.projectRepositoryId),
    ],
  };
}

export async function assertConversationProject(input: {
  conversationId: string;
  projectId: string;
  userId: number;
}) {
  const [conversation] = await executeQuery(
    (db) =>
      db
        .select({ projectId: nexusConversations.projectId })
        .from(nexusConversations)
        .where(
          and(
            eq(nexusConversations.id, input.conversationId),
            eq(nexusConversations.userId, input.userId)
          )
        )
        .limit(1),
    "assertConversationProject"
  );
  if (!conversation || conversation.projectId !== input.projectId) {
    throw new NexusProjectAccessError();
  }
}
