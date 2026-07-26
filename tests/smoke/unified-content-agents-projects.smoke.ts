/**
 * Real PostgreSQL smoke for Epic #1261 workstream #1266.
 *
 * Proves project/member/repository/chat transactions and immediate ACL
 * revocation. OAuth protocol behavior is covered by unit/route tests; this
 * smoke verifies the client and nonce schema created by migration 139.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { closeDatabase, executeQuery } from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  nexusConversations,
  nexusProjectMembers,
  nexusProjects,
  oauthClients,
  psdAgentWorkspaceConsentNonces,
  users,
} from "@/lib/db/schema";
import { getAccessibleRepositoryIds } from "@/lib/db/drizzle";
import {
  NexusProjectAccessError,
  addNexusProjectMember,
  connectNexusProjectRepository,
  createNexusProject,
  createNexusProjectConversation,
  getNexusProject,
  removeNexusProjectMember,
  resolveNexusProjectChatContext,
} from "@/lib/nexus/projects/project-service";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "infra/database/schema/139-unified-content-agents-projects.sql"
  ),
  "utf8"
);
for (const [index, statement] of migration
  .split(/;\s*(?:\r?\n|$)/)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .entries()) {
  await executeQuery(
    (db) => db.execute(sql.raw(statement)),
    `smoke.agentsProjects.ensureSchema.${index + 1}`
  );
}

const fixture = randomUUID();
const [owner] = await executeQuery(
  (db) =>
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.cognitoSub, "e2e-test-user"))
      .limit(1),
  "smoke.agentsProjects.owner"
);
assert.ok(owner, "standard local seed is missing e2e-test-user");

const [member] = await executeQuery(
  (db) =>
    db
      .insert(users)
      .values({
        cognitoSub: `agents-projects-member-${fixture}`,
        email: `agents-projects-member-${fixture}@example.invalid`,
      })
      .returning({ id: users.id, email: users.email }),
  "smoke.agentsProjects.member"
);
assert.ok(member?.email);
const memberEmail = member.email;

const [connectedRepository] = await executeQuery(
  (db) =>
    db
      .insert(knowledgeRepositories)
      .values({
        name: `Connected repository ${fixture}`,
        ownerId: owner.id,
        isPublic: false,
        repositoryKind: "durable",
      })
      .returning({ id: knowledgeRepositories.id }),
  "smoke.agentsProjects.connectedRepository"
);
assert.ok(connectedRepository);

const [ephemeralRepository] = await executeQuery(
  (db) =>
    db
      .insert(knowledgeRepositories)
      .values({
        name: `Ephemeral repository ${fixture}`,
        ownerId: owner.id,
        isPublic: false,
        repositoryKind: "ephemeral",
        retentionDays: 30,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: knowledgeRepositories.id }),
  "smoke.agentsProjects.ephemeralRepository"
);
assert.ok(ephemeralRepository);

let projectId: string | null = null;
let projectRepositoryId: number | null = null;
let consentNonce: string | null = null;
try {
  const project = await createNexusProject({
    ownerId: owner.id,
    name: `Project smoke ${fixture}`,
    instructions: "Use the current approved policy.",
  });
  projectId = project.id;
  projectRepositoryId = project.projectRepositoryId;

  const [ownerMembership] = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusProjectMembers)
        .where(
          and(
            eq(nexusProjectMembers.projectId, project.id),
            eq(nexusProjectMembers.userId, owner.id)
          )
        ),
    "smoke.agentsProjects.ownerMembership"
  );
  assert.equal(ownerMembership?.role, "owner");

  await addNexusProjectMember({
    projectId: project.id,
    actorUserId: owner.id,
    email: memberEmail,
    role: "editor",
  });
  assert.deepEqual(
    await getAccessibleRepositoryIds([project.projectRepositoryId], member.id),
    [project.projectRepositoryId],
    "project membership must grant the dedicated repository"
  );

  await assert.rejects(
    connectNexusProjectRepository({
      projectId: project.id,
      userId: owner.id,
      repositoryId: ephemeralRepository.id,
    }),
    /Only durable repositories/
  );

  await connectNexusProjectRepository({
    projectId: project.id,
    userId: owner.id,
    repositoryId: connectedRepository.id,
  });
  const ownerContext = await resolveNexusProjectChatContext({
    projectId: project.id,
    userId: owner.id,
  });
  assert.deepEqual(ownerContext.repositoryIds.sort((a, b) => a - b), [
    connectedRepository.id,
    project.projectRepositoryId,
  ].sort((a, b) => a - b));

  const memberContext = await resolveNexusProjectChatContext({
    projectId: project.id,
    userId: member.id,
  });
  assert.deepEqual(
    memberContext.repositoryIds,
    [project.projectRepositoryId],
    "a connected repository must not widen access for a project member"
  );

  const conversation = await createNexusProjectConversation({
    projectId: project.id,
    userId: member.id,
  });
  const [persistedConversation] = await executeQuery(
    (db) =>
      db
        .select({
          userId: nexusConversations.userId,
          projectId: nexusConversations.projectId,
        })
        .from(nexusConversations)
        .where(eq(nexusConversations.id, conversation.id)),
    "smoke.agentsProjects.conversation"
  );
  assert.deepEqual(persistedConversation, {
    userId: member.id,
    projectId: project.id,
  });

  await removeNexusProjectMember({
    projectId: project.id,
    actorUserId: owner.id,
    memberUserId: member.id,
  });
  assert.deepEqual(
    await getAccessibleRepositoryIds([project.projectRepositoryId], member.id),
    [],
    "membership removal must revoke the exact project repository grant"
  );
  await assert.rejects(
    getNexusProject(project.id, member.id),
    NexusProjectAccessError
  );

  const [oauthClient] = await executeQuery(
    (db) =>
      db
        .select({
          applicationType: oauthClients.applicationType,
          requirePkce: oauthClients.requirePkce,
          isFirstParty: oauthClients.isFirstParty,
        })
        .from(oauthClients)
        .where(
          eq(
            oauthClients.clientId,
            "7e8646f4-4091-4a34-a6b9-0d3721e8a126"
          )
        ),
    "smoke.agentsProjects.oauthClient"
  );
  assert.deepEqual(oauthClient, {
    applicationType: "native",
    requirePkce: true,
    isFirstParty: true,
  });

  const createdConsentNonce =
    randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  consentNonce = createdConsentNonce;
  await executeQuery(
    (db) =>
      db.insert(psdAgentWorkspaceConsentNonces).values({
        nonce: createdConsentNonce,
        ownerEmail: memberEmail,
        agentEmail: `agnt_${memberEmail}`,
        tokenKind: "aistudio",
        codeVerifier: "a".repeat(43),
      }),
    "smoke.agentsProjects.aistudioNonce"
  );
} finally {
  if (projectId) {
    const cleanupProjectId = projectId;
    await executeQuery(
      (db) =>
        db.delete(nexusProjects).where(eq(nexusProjects.id, cleanupProjectId)),
      "smoke.agentsProjects.cleanupProject"
    );
  }
  if (projectRepositoryId) {
    const cleanupRepositoryId = projectRepositoryId;
    await executeQuery(
      (db) =>
        db
          .delete(knowledgeRepositories)
          .where(eq(knowledgeRepositories.id, cleanupRepositoryId)),
      "smoke.agentsProjects.cleanupProjectRepository"
    );
  }
  if (consentNonce) {
    const cleanupNonce = consentNonce;
    await executeQuery(
      (db) =>
        db
          .delete(psdAgentWorkspaceConsentNonces)
          .where(eq(psdAgentWorkspaceConsentNonces.nonce, cleanupNonce)),
      "smoke.agentsProjects.cleanupNonce"
    );
  }
  await executeQuery(
    (db) =>
      db
        .delete(knowledgeRepositories)
        .where(eq(knowledgeRepositories.id, connectedRepository.id)),
    "smoke.agentsProjects.cleanupConnectedRepository"
  );
  await executeQuery(
    (db) =>
      db
        .delete(knowledgeRepositories)
        .where(eq(knowledgeRepositories.id, ephemeralRepository.id)),
    "smoke.agentsProjects.cleanupEphemeralRepository"
  );
  await executeQuery(
    (db) => db.delete(users).where(eq(users.id, member.id)),
    "smoke.agentsProjects.cleanupMember"
  );
  await closeDatabase();
}

process.stdout.write("Unified content agents/projects smoke passed.\n");
