/**
 * Real-PostgreSQL safety contract for superseded generation retention (#1527).
 * Runs after migrations and the local seed in CI's unified-content lifecycle job.
 */

import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import {
  closeDatabase,
  executeQuery,
  executeTransaction,
} from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryIndexGenerations,
  repositoryItemChunks,
  repositoryItems,
  users,
} from "@/lib/db/schema";
import { collectSupersededRepositoryGenerations } from "@/lib/repositories/content-platform/generation-retention";

const HOUR_MS = 60 * 60_000;
const now = new Date();
const [owner] = await executeQuery(
  (db) =>
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.cognitoSub, "e2e-test-user"))
      .limit(1),
  "smoke.generationRetention.owner",
);
assert.ok(owner, "standard local seed is missing e2e-test-user");

const [repository] = await executeQuery(
  (db) =>
    db
      .insert(knowledgeRepositories)
      .values({
        name: `Generation retention smoke ${now.getTime()}`,
        ownerId: owner.id,
        repositoryKind: "durable",
      })
      .returning({ id: knowledgeRepositories.id }),
  "smoke.generationRetention.createRepository",
);
assert.ok(repository);

try {
  const [item] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "document",
          name: "Generation retention fixture",
          source: "smoke",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.generationRetention.createItem",
  );
  assert.ok(item);

  const [longLived, serving, ...oldGenerations] = await executeQuery(
    (db) =>
      db
        .insert(repositoryIndexGenerations)
        .values([
          {
            repositoryId: repository.id,
            status: "active" as const,
            processorVersion: "generation-retention-long-lived",
            createdAt: new Date(now.getTime() - 90 * 24 * HOUR_MS),
          },
          {
            repositoryId: repository.id,
            status: "building" as const,
            processorVersion: "generation-retention-serving",
          },
          ...[1, 2, 3, 4].map((daysOld) => ({
            repositoryId: repository.id,
            status: "superseded" as const,
            processorVersion: `generation-retention-old-${daysOld}`,
            createdAt: new Date(
              now.getTime() - (10 + daysOld) * 24 * HOUR_MS,
            ),
          })),
        ])
        .returning({ id: repositoryIndexGenerations.id }),
    "smoke.generationRetention.createGenerations",
  );
  assert.ok(longLived);
  assert.ok(serving);
  assert.equal(oldGenerations.length, 4);

  await executeQuery(
    (db) =>
      db
        .update(knowledgeRepositories)
        .set({ activeIndexGenerationId: longLived.id })
        .where(eq(knowledgeRepositories.id, repository.id)),
    "smoke.generationRetention.setInitialServingPointer",
  );
  const supersessionTransition = await executeTransaction(
    async (tx) => {
      const [transactionClock] = await tx.execute<{
        transaction_started_at: Date | string;
      }>(sql`SELECT transaction_timestamp() AS transaction_started_at`);
      assert.ok(transactionClock);
      await tx.execute(sql`SELECT pg_sleep(0.02)`);
      await tx
        .update(repositoryIndexGenerations)
        .set({ status: "superseded" })
        .where(eq(repositoryIndexGenerations.id, longLived.id));
      const [transitioned] = await tx
        .select({ supersededAt: repositoryIndexGenerations.supersededAt })
        .from(repositoryIndexGenerations)
        .where(eq(repositoryIndexGenerations.id, longLived.id));
      assert.ok(transitioned?.supersededAt);
      return {
        supersededAt: transitioned.supersededAt,
        transactionStartedAt:
          transactionClock.transaction_started_at instanceof Date
            ? transactionClock.transaction_started_at
            : new Date(transactionClock.transaction_started_at),
      };
    },
    "smoke.generationRetention.supersedeLongLived",
  );
  assert.ok(
    supersessionTransition.supersededAt.getTime() >
      supersessionTransition.transactionStartedAt.getTime(),
    "superseded_at must use the transition clock, not transaction start",
  );
  await executeQuery(
    (db) =>
      db
        .update(repositoryIndexGenerations)
        .set({ status: "active" })
        .where(eq(repositoryIndexGenerations.id, serving.id)),
    "smoke.generationRetention.activateServing",
  );
  await executeQuery(
    (db) =>
      db
        .update(knowledgeRepositories)
        .set({ activeIndexGenerationId: serving.id })
        .where(eq(knowledgeRepositories.id, repository.id)),
    "smoke.generationRetention.setServingPointer",
  );

  for (const [index, generation] of oldGenerations.entries()) {
    assert.ok(generation);
    await executeQuery(
      (db) =>
        db
          .update(repositoryIndexGenerations)
          .set({
            // Migration 173 gives the historical backlog one shared timestamp.
            // created_at must deterministically break that deployment-time tie.
            supersededAt: new Date(now.getTime() - 4 * 24 * HOUR_MS),
          })
          .where(eq(repositoryIndexGenerations.id, generation.id)),
      `smoke.generationRetention.ageGeneration.${index}`,
    );
    await executeQuery(
      (db) =>
        db.insert(repositoryItemChunks).values({
          itemId: item.id,
          indexGenerationId: generation.id,
          content: `generation retention chunk ${index}`,
          chunkIndex: index,
        }),
      `smoke.generationRetention.createChunk.${index}`,
    );
  }

  const [freshlySuperseded] = await executeQuery(
    (db) =>
      db
        .select({
          createdAt: repositoryIndexGenerations.createdAt,
          supersededAt: repositoryIndexGenerations.supersededAt,
        })
        .from(repositoryIndexGenerations)
        .where(eq(repositoryIndexGenerations.id, longLived.id)),
    "smoke.generationRetention.readSupersessionTime",
  );
  assert.ok(freshlySuperseded?.createdAt);
  assert.ok(freshlySuperseded?.supersededAt);
  assert.ok(freshlySuperseded.createdAt < new Date(now.getTime() - 89 * 24 * HOUR_MS));
  assert.ok(freshlySuperseded.supersededAt >= new Date(now.getTime() - HOUR_MS));

  await assert.doesNotReject(async () =>
    assert.deepEqual(
      await collectSupersededRepositoryGenerations({ now }),
      { chunksDeleted: 2, generationsDeleted: 2 },
    ),
  );

  const remaining = await executeQuery(
    (db) =>
      db
        .select({ id: repositoryIndexGenerations.id })
        .from(repositoryIndexGenerations)
        .where(
          inArray(repositoryIndexGenerations.id, [
            longLived.id,
            serving.id,
            ...oldGenerations.map((generation) => generation.id),
          ]),
        ),
    "smoke.generationRetention.readRemaining",
  );
  const remainingIds = new Set(remaining.map((generation) => generation.id));
  assert.ok(remainingIds.has(longLived.id));
  assert.ok(remainingIds.has(serving.id));
  assert.ok(remainingIds.has(oldGenerations[0]!.id));
  assert.ok(remainingIds.has(oldGenerations[1]!.id));
  assert.equal(remainingIds.has(oldGenerations[2]!.id), false);
  assert.equal(remainingIds.has(oldGenerations[3]!.id), false);

  const remainingChunks = await executeQuery(
    (db) =>
      db
        .select({ id: repositoryItemChunks.id })
        .from(repositoryItemChunks)
        .where(eq(repositoryItemChunks.itemId, item.id)),
    "smoke.generationRetention.readRemainingChunks",
  );
  assert.equal(remainingChunks.length, 2);

  process.stdout.write(
    "repository-generation-retention smoke: transition window, keep floor, and bounded deletion passed\n",
  );
} finally {
  await executeQuery(
    (db) =>
      db
        .delete(knowledgeRepositories)
        .where(eq(knowledgeRepositories.id, repository.id)),
    "smoke.generationRetention.cleanup",
  );
  await closeDatabase();
}
