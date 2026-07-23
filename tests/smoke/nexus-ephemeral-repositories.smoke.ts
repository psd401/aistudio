/**
 * Nexus ephemeral repository real-database smoke (Epic #1261, issue #1268).
 *
 * Proves draft idempotency, opaque reference ownership, atomic conversation
 * binding, expiry exclusion, and citation-preserving in-place promotion.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' DB_SSL=false \
 *     bun run test:smoke:nexus-ephemeral
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { closeDatabase, executeQuery } from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  nexusConversations,
  nexusRepositoryBindings,
  repositoryItems,
  users,
} from "@/lib/db/schema";
import {
  getAccessibleRepositoryIds,
  getRepositoriesByOwnerId,
} from "@/lib/db/drizzle/knowledge-repositories";
import {
  bindNexusAttachmentReferencesToConversation,
  getOrCreateNexusEphemeralRepository,
  promoteNexusRepository,
  resolveNexusAttachmentForPromotion,
  resolveNexusAttachmentReference,
  resolveNexusConversationRepositoryIds,
} from "@/lib/nexus/ephemeral-repository-service";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-23T12:00:00.000Z");
const policy = {
  nexusAttachmentRetentionDays: 30,
  deletionGraceDays: 7,
};

const migration = readFileSync(
  resolve(
    process.cwd(),
    "infra/database/schema/125-nexus-ephemeral-repositories.sql"
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
    `smoke.nexusEphemeral.ensureSchema.${index + 1}`
  );
}

const [owner] = await executeQuery(
  (db) =>
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.cognitoSub, "e2e-test-user"))
      .limit(1),
  "smoke.nexusEphemeral.owner"
);
assert.ok(owner, "standard local seed is missing e2e-test-user");

const fixtureKey = randomUUID();
const [foreignOwner] = await executeQuery(
  (db) =>
    db
      .insert(users)
      .values({
        cognitoSub: `nexus-ephemeral-smoke-${fixtureKey}`,
        email: `nexus-ephemeral-smoke-${fixtureKey}@example.invalid`,
      })
      .returning({ id: users.id }),
  "smoke.nexusEphemeral.foreignOwner"
);
assert.ok(foreignOwner);

let repositoryId: number | null = null;
let ownerConversationId: string | null = null;

try {
  await assert.rejects(
    executeQuery(
      (db) =>
        db.insert(knowledgeRepositories).values({
          name: "Invalid public ephemeral smoke",
          ownerId: owner.id,
          isPublic: true,
          repositoryKind: "ephemeral",
          retentionDays: 30,
          expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
        }),
      "smoke.nexusEphemeral.rejectPublicRepository"
    )
  );

  const draftKey = randomUUID();
  const created = await getOrCreateNexusEphemeralRepository({
    ownerId: owner.id,
    draftKey,
    now: NOW,
    policy,
  });
  repositoryId = created.repositoryId;
  const activeRepositoryId = created.repositoryId;
  assert.equal(created.created, true);
  assert.equal(created.repositoryKind, "ephemeral");
  assert.equal(created.lifecycleStatus, "active");
  assert.equal(created.retentionDays, 30);
  assert.equal(
    created.expiresAt?.toISOString(),
    new Date(NOW.getTime() + 30 * DAY_MS).toISOString()
  );

  const replayedAt = new Date(NOW.getTime() + DAY_MS);
  const replayed = await getOrCreateNexusEphemeralRepository({
    ownerId: owner.id,
    draftKey,
    now: replayedAt,
    policy,
  });
  assert.equal(replayed.created, false);
  assert.equal(replayed.repositoryId, activeRepositoryId);
  assert.equal(
    replayed.expiresAt?.toISOString(),
    new Date(replayedAt.getTime() + 30 * DAY_MS).toISOString()
  );

  const genericRepositories = await getRepositoriesByOwnerId(owner.id);
  assert.equal(
    genericRepositories.some((entry) => entry.id === activeRepositoryId),
    false,
    "generic repository lists must not expose ephemeral containers"
  );
  assert.deepEqual(
    await getAccessibleRepositoryIds([activeRepositoryId], owner.id),
    [activeRepositoryId],
    "owner-only retrieval access must include an active ephemeral repository"
  );
  assert.deepEqual(
    await getAccessibleRepositoryIds([activeRepositoryId], foreignOwner.id),
    [],
    "another user must not gain access to a private ephemeral repository"
  );

  const [item] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: activeRepositoryId,
          type: "text",
          name: "Nexus smoke attachment",
          source: "Owner-only Nexus smoke content",
          processingStatus: "completed",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.nexusEphemeral.item"
  );
  assert.ok(item);

  const resolved = await resolveNexusAttachmentReference({
    ownerId: owner.id,
    bindingId: created.bindingId,
    itemId: item.id,
    now: replayedAt,
  });
  assert.deepEqual(resolved, {
    bindingId: created.bindingId,
    draftKey,
    conversationId: null,
    repositoryId: activeRepositoryId,
    itemId: item.id,
    itemType: "text",
    itemName: "Nexus smoke attachment",
    currentVersionId: null,
    processingStatus: "completed",
  });
  assert.equal(
    await resolveNexusAttachmentReference({
      ownerId: foreignOwner.id,
      bindingId: created.bindingId,
      itemId: item.id,
      now: replayedAt,
    }),
    null
  );
  const [ownerConversation] = await executeQuery(
    (db) =>
      db
        .insert(nexusConversations)
        .values({
          userId: owner.id,
          provider: "smoke",
          title: "Nexus ephemeral repository smoke",
        })
        .returning({ id: nexusConversations.id }),
    "smoke.nexusEphemeral.ownerConversation"
  );
  assert.ok(ownerConversation);
  ownerConversationId = ownerConversation.id;
  const [foreignConversation] = await executeQuery(
    (db) =>
      db
        .insert(nexusConversations)
        .values({
          userId: foreignOwner.id,
          provider: "smoke",
          title: "Foreign Nexus ephemeral repository smoke",
        })
        .returning({ id: nexusConversations.id }),
    "smoke.nexusEphemeral.foreignConversation"
  );
  assert.ok(foreignConversation);

  await assert.rejects(
    bindNexusAttachmentReferencesToConversation({
      ownerId: owner.id,
      conversationId: foreignConversation.id,
      references: [{ bindingId: created.bindingId, itemId: item.id }],
      now: replayedAt,
    }),
    /Nexus attachment reference was not found/
  );
  await assert.rejects(
    bindNexusAttachmentReferencesToConversation({
      ownerId: owner.id,
      conversationId: ownerConversation.id,
      references: [
        { bindingId: created.bindingId, itemId: item.id },
        { bindingId: created.bindingId, itemId: 2_147_483_647 },
      ],
      now: replayedAt,
    }),
    /Nexus attachment reference was not found/
  );
  const [stillUnbound] = await executeQuery(
    (db) =>
      db
        .select({ conversationId: nexusRepositoryBindings.conversationId })
        .from(nexusRepositoryBindings)
        .where(eq(nexusRepositoryBindings.id, created.bindingId))
        .limit(1),
    "smoke.nexusEphemeral.verifyAtomicBind"
  );
  assert.equal(stillUnbound?.conversationId, null);

  assert.deepEqual(
    await bindNexusAttachmentReferencesToConversation({
      ownerId: owner.id,
      conversationId: ownerConversation.id,
      references: [
        { bindingId: created.bindingId, itemId: item.id },
        { bindingId: created.bindingId, itemId: item.id },
      ],
      now: replayedAt,
    }),
    [activeRepositoryId]
  );
  assert.deepEqual(
    await resolveNexusConversationRepositoryIds({
      ownerId: owner.id,
      conversationId: ownerConversation.id,
      now: replayedAt,
    }),
    [activeRepositoryId]
  );

  const expiredAt = new Date(replayedAt.getTime() - DAY_MS);
  await executeQuery(
    (db) =>
      db
        .update(knowledgeRepositories)
        .set({
          lifecycleStatus: "expired",
          expiresAt: expiredAt,
        })
        .where(eq(knowledgeRepositories.id, activeRepositoryId)),
    "smoke.nexusEphemeral.expire"
  );
  assert.deepEqual(
    await getAccessibleRepositoryIds([activeRepositoryId], owner.id),
    []
  );
  assert.equal(
    await resolveNexusAttachmentReference({
      ownerId: owner.id,
      bindingId: created.bindingId,
      itemId: item.id,
      now: replayedAt,
    }),
    null
  );
  assert.equal(
    (
      await resolveNexusAttachmentForPromotion({
        ownerId: owner.id,
        bindingId: created.bindingId,
        itemId: item.id,
        now: replayedAt,
        policy,
      })
    )?.repositoryId,
    activeRepositoryId,
    "promotion must resolve an expired attachment during deletion grace"
  );
  assert.equal(
    await resolveNexusAttachmentForPromotion({
      ownerId: foreignOwner.id,
      bindingId: created.bindingId,
      itemId: item.id,
      now: replayedAt,
      policy,
    }),
    null
  );
  assert.deepEqual(
    await resolveNexusConversationRepositoryIds({
      ownerId: owner.id,
      conversationId: ownerConversation.id,
      now: replayedAt,
    }),
    []
  );

  await assert.rejects(
    promoteNexusRepository({
      ownerId: foreignOwner.id,
      repositoryId: activeRepositoryId,
      name: "Stolen repository",
      now: replayedAt,
      policy,
    }),
    /Nexus attachment repository was not found/
  );
  const promoted = await promoteNexusRepository({
    ownerId: owner.id,
    repositoryId: activeRepositoryId,
    name: "Promoted Nexus smoke sources",
    now: replayedAt,
    policy,
  });
  assert.equal(promoted.repositoryKind, "durable");
  assert.equal(promoted.lifecycleStatus, "active");
  assert.equal(promoted.retentionDays, null);
  assert.equal(promoted.expiresAt, null);
  const replayedPromotion = await promoteNexusRepository({
    ownerId: owner.id,
    repositoryId: activeRepositoryId,
    name: "A replay must not rename the durable repository",
    now: replayedAt,
    policy,
  });
  assert.equal(replayedPromotion.repositoryKind, "durable");
  const [durableRepository] = await executeQuery(
    (db) =>
      db
        .select({ name: knowledgeRepositories.name })
        .from(knowledgeRepositories)
        .where(eq(knowledgeRepositories.id, activeRepositoryId))
        .limit(1),
    "smoke.nexusEphemeral.verifyPromotionReplay"
  );
  assert.equal(
    durableRepository?.name,
    "Promoted Nexus smoke sources",
    "promotion replay must be an idempotent no-op rather than a rename"
  );
  await assert.rejects(
    getOrCreateNexusEphemeralRepository({
      ownerId: owner.id,
      draftKey,
      now: replayedAt,
      policy,
    }),
    /Nexus repository binding is unavailable/,
    "a promoted staging key must not make later attachments permanent"
  );
  assert.deepEqual(
    await resolveNexusConversationRepositoryIds({
      ownerId: owner.id,
      conversationId: ownerConversation.id,
      now: replayedAt,
    }),
    [activeRepositoryId]
  );
  assert.equal(
    (await getRepositoriesByOwnerId(owner.id)).some(
      (entry) => entry.id === activeRepositoryId
    ),
    true,
    "promotion must expose the same repository through durable management"
  );

  process.stdout.write(
    "nexus-ephemeral-repositories smoke: owner isolation, atomic binding, expiry, and promotion passed\n"
  );
} finally {
  if (repositoryId != null) {
    const cleanupRepositoryId = repositoryId;
    await executeQuery(
      (db) =>
        db
          .delete(knowledgeRepositories)
          .where(eq(knowledgeRepositories.id, cleanupRepositoryId)),
      "smoke.nexusEphemeral.cleanupRepository"
    );
  }
  if (ownerConversationId != null) {
    const cleanupConversationId = ownerConversationId;
    await executeQuery(
      (db) =>
        db
          .delete(nexusConversations)
          .where(eq(nexusConversations.id, cleanupConversationId)),
      "smoke.nexusEphemeral.cleanupOwnerConversation"
    );
  }
  await executeQuery(
    (db) => db.delete(users).where(eq(users.id, foreignOwner.id)),
    "smoke.nexusEphemeral.cleanupForeignOwner"
  );
  await closeDatabase();
}
