/**
 * Real PostgreSQL smoke for migration 136 and the synchronized-source
 * lifecycle. The network-facing Drive contract is covered by unit tests; this
 * smoke proves cursor/version/source/grace state is transactionally durable.
 */

import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  closeDatabase,
  executeQuery,
  executeTransaction,
} from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryConnectorCredentials,
  repositoryConnectorSelections,
  repositoryConnectorSources,
  repositoryConnectorSyncRuns,
  repositoryConnectors,
  repositoryItems,
  repositoryItemVersions,
  users,
} from "@/lib/db/schema";
import { GOOGLE_DRIVE_SCOPE } from "@/lib/repositories/google-drive/formats";

const [owner] = await executeQuery(
  (db) =>
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.cognitoSub, "e2e-test-user"))
      .limit(1),
  "smoke.googleContent.owner",
);
assert.ok(owner, "standard local seed is missing e2e-test-user");

const [repository] = await executeQuery(
  (db) =>
    db
      .insert(knowledgeRepositories)
      .values({
        name: `Google content smoke ${Date.now()}`,
        ownerId: owner.id,
        repositoryKind: "durable",
      })
      .returning({ id: knowledgeRepositories.id }),
  "smoke.googleContent.repository",
);
assert.ok(repository);

let credentialId: string | null = null;
try {
  const [credential] = await executeQuery(
    (db) =>
      db
        .insert(repositoryConnectorCredentials)
        .values({
          repositoryId: repository.id,
          userId: owner.id,
          provider: "google_drive",
          encryptedRefreshToken: "smoke-encrypted-placeholder",
          grantedScopes: [GOOGLE_DRIVE_SCOPE],
        })
        .returning({ id: repositoryConnectorCredentials.id }),
    "smoke.googleContent.credential",
  );
  assert.ok(credential);
  credentialId = credential.id;

  const [connector] = await executeQuery(
    (db) =>
      db
        .insert(repositoryConnectors)
        .values({
          repositoryId: repository.id,
          provider: "google_drive",
          authMode: "personal_oauth",
          createdBy: owner.id,
          credentialId: credential.id,
          displayName: "Smoke personal Drive",
          status: "pending",
        })
        .returning({ id: repositoryConnectors.id }),
    "smoke.googleContent.connector",
  );
  assert.ok(connector);

  await executeQuery(
    (db) =>
      db.insert(repositoryConnectorSelections).values({
        connectorId: connector.id,
        externalId: "folder-smoke",
        selectionKind: "folder",
        displayName: "Smoke folder",
        includeDescendants: true,
      }),
    "smoke.googleContent.selection",
  );

  const [item] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "document",
          name: "Smoke synchronized document",
          source: "google_drive",
          sourceExternalId: "drive-file-smoke",
          processingStatus: "pending",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.googleContent.item",
  );
  assert.ok(item);

  const [source] = await executeQuery(
    (db) =>
      db
        .insert(repositoryConnectorSources)
        .values({
          connectorId: connector.id,
          repositoryItemId: item.id,
          externalId: "drive-file-smoke",
          name: "Smoke synchronized document",
          mimeType: "application/vnd.google-apps.document",
          parentIds: ["folder-smoke"],
          sourceRevision: "google-drive:drive-file-smoke:1",
          status: "active",
        })
        .returning({ id: repositoryConnectorSources.id }),
    "smoke.googleContent.source",
  );
  assert.ok(source);

  await executeQuery(
    (db) =>
      db
        .update(repositoryConnectorSources)
        .set({
          status: "failed",
          metadata: {
            lastErrorCode: "SMOKE_SOURCE_FAILURE",
            lastErrorMessage: "isolated source failure",
          },
        })
        .where(eq(repositoryConnectorSources.id, source.id)),
    "smoke.googleContent.sourceFailure",
  );
  const [failedSource] = await executeQuery(
    (db) =>
      db
        .select({
          status: repositoryConnectorSources.status,
          metadata: repositoryConnectorSources.metadata,
        })
        .from(repositoryConnectorSources)
        .where(eq(repositoryConnectorSources.id, source.id))
        .limit(1),
    "smoke.googleContent.failedSource",
  );
  assert.equal(failedSource?.status, "failed");
  assert.equal(failedSource?.metadata.lastErrorCode, "SMOKE_SOURCE_FAILURE");
  await executeQuery(
    (db) =>
      db
        .update(repositoryConnectorSources)
        .set({ status: "active", metadata: {} })
        .where(eq(repositoryConnectorSources.id, source.id)),
    "smoke.googleContent.sourceRecovery",
  );

  const firstVersionId = await executeTransaction(async (tx) => {
    const [version] = await tx
      .insert(repositoryItemVersions)
      .values({
        itemId: item.id,
        versionNumber: 1,
        sourceKind: "google_drive",
        sourceRevision: "google-drive:drive-file-smoke:1",
        objectKey:
          `repositories/${repository.id}/11111111-2222-4333-8444-555555555555/` +
          "smoke.docx",
        declaredContentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteSize: 128,
        storageStatus: "quarantined",
        processingStatus: "pending",
        createdBy: owner.id,
      })
      .returning({ id: repositoryItemVersions.id });
    assert.ok(version);
    await tx
      .update(repositoryItems)
      .set({ currentVersionId: version.id })
      .where(eq(repositoryItems.id, item.id));
    await tx
      .update(repositoryConnectorSources)
      .set({ currentItemVersionId: version.id })
      .where(eq(repositoryConnectorSources.id, source.id));
    return version.id;
  }, "smoke.googleContent.firstVersion");

  const [run] = await executeQuery(
    (db) =>
      db
        .insert(repositoryConnectorSyncRuns)
        .values({
          connectorId: connector.id,
          trigger: "initial",
          status: "succeeded",
          cursorAfter: "cursor-1",
          discoveredCount: 1,
          createdCount: 1,
          finishedAt: new Date(),
        })
        .returning({ id: repositoryConnectorSyncRuns.id }),
    "smoke.googleContent.run",
  );
  assert.ok(run);
  await executeQuery(
    (db) =>
      db
        .update(repositoryConnectors)
        .set({ cursor: "cursor-1", status: "active" })
        .where(eq(repositoryConnectors.id, connector.id)),
    "smoke.googleContent.cursor",
  );

  const [persisted] = await executeQuery(
    (db) =>
      db
        .select({
          cursor: repositoryConnectors.cursor,
          sourceRevision: repositoryConnectorSources.sourceRevision,
          currentVersionId: repositoryConnectorSources.currentItemVersionId,
        })
        .from(repositoryConnectors)
        .innerJoin(
          repositoryConnectorSources,
          eq(repositoryConnectorSources.connectorId, repositoryConnectors.id),
        )
        .where(eq(repositoryConnectors.id, connector.id))
        .limit(1),
    "smoke.googleContent.persisted",
  );
  assert.deepEqual(persisted, {
    cursor: "cursor-1",
    sourceRevision: "google-drive:drive-file-smoke:1",
    currentVersionId: firstVersionId,
  });

  const missingSince = new Date(Date.now() - 8 * 86_400_000);
  await executeTransaction(async (tx) => {
    await tx
      .update(repositoryConnectorSources)
      .set({ status: "missing", missingSince })
      .where(eq(repositoryConnectorSources.id, source.id));
    const [stillActive] = await tx
      .select({ lifecycleStatus: repositoryItems.lifecycleStatus })
      .from(repositoryItems)
      .where(eq(repositoryItems.id, item.id))
      .limit(1);
    assert.equal(stillActive?.lifecycleStatus, "active");
  }, "smoke.googleContent.graceStart");
  await executeTransaction(async (tx) => {
    await tx
      .update(repositoryConnectorSources)
      .set({ status: "deleted", removedAt: new Date() })
      .where(
        and(
          eq(repositoryConnectorSources.id, source.id),
          eq(repositoryConnectorSources.status, "missing"),
        ),
      );
    await tx
      .update(repositoryItems)
      .set({ lifecycleStatus: "unavailable" })
      .where(eq(repositoryItems.id, item.id));
  }, "smoke.googleContent.graceExpiry");
  const [expired] = await executeQuery(
    (db) =>
      db
        .select({
          sourceStatus: repositoryConnectorSources.status,
          itemStatus: repositoryItems.lifecycleStatus,
        })
        .from(repositoryConnectorSources)
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.id, repositoryConnectorSources.repositoryItemId),
        )
        .where(eq(repositoryConnectorSources.id, source.id))
        .limit(1),
    "smoke.googleContent.expired",
  );
  assert.deepEqual(expired, {
    sourceStatus: "deleted",
    itemStatus: "unavailable",
  });

  process.stdout.write(
    "Google content connector PostgreSQL smoke passed: isolated source failure, cursor, immutable version, sync run, and deletion grace.\n",
  );
} finally {
  await executeQuery(
    (db) =>
      db
        .delete(knowledgeRepositories)
        .where(eq(knowledgeRepositories.id, repository.id)),
    "smoke.googleContent.cleanupRepository",
  );
  const credentialIdToDelete = credentialId;
  if (credentialIdToDelete) {
    await executeQuery(
      (db) =>
        db
          .delete(repositoryConnectorCredentials)
          .where(eq(repositoryConnectorCredentials.id, credentialIdToDelete)),
      "smoke.googleContent.cleanupCredential",
    );
  }
  await closeDatabase();
}
