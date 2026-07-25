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
import { replaceGoogleDriveSelections } from "@/lib/repositories/google-drive/connector-service";
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
let connectorCreatorId: number | null = null;
try {
  const [connectorCreator] = await executeQuery(
    (db) =>
      db
        .insert(users)
        .values({
          cognitoSub: `google-content-creator-${Date.now()}`,
          email: `google-content-creator-${Date.now()}@example.test`,
          firstName: "Disposable",
          lastName: "Connector Creator",
        })
        .returning({ id: users.id }),
    "smoke.googleContent.connectorCreator",
  );
  assert.ok(connectorCreator);
  connectorCreatorId = connectorCreator.id;

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
  await replaceGoogleDriveSelections({
    connectorId: connector.id,
    selections: [
      {
        externalId: "folder-smoke",
        selectionKind: "folder",
        displayName: "Smoke folder",
        includeDescendants: true,
      },
    ],
  });
  const [selectionFence] = await executeQuery(
    (db) =>
      db
        .select({
          cursor: repositoryConnectors.cursor,
          selectionRevision: repositoryConnectors.selectionRevision,
        })
        .from(repositoryConnectors)
        .where(eq(repositoryConnectors.id, connector.id))
        .limit(1),
    "smoke.googleContent.selectionFence",
  );
  assert.deepEqual(selectionFence, {
    cursor: null,
    selectionRevision: 1,
  });
  const staleCompletion = await executeQuery(
    (db) =>
      db
        .update(repositoryConnectors)
        .set({
          status: "active",
          cursor: "stale-cursor-must-not-persist",
        })
        .where(
          and(
            eq(repositoryConnectors.id, connector.id),
            eq(repositoryConnectors.selectionRevision, 0),
          ),
        )
        .returning({ id: repositoryConnectors.id }),
    "smoke.googleContent.staleSelectionCompletion",
  );
  assert.equal(staleCompletion.length, 0);
  const [connectorAfterStaleCompletion] = await executeQuery(
    (db) =>
      db
        .select({
          status: repositoryConnectors.status,
          cursor: repositoryConnectors.cursor,
        })
        .from(repositoryConnectors)
        .where(eq(repositoryConnectors.id, connector.id))
        .limit(1),
    "smoke.googleContent.connectorAfterStaleSelectionCompletion",
  );
  assert.deepEqual(connectorAfterStaleCompletion, {
    status: "pending",
    cursor: null,
  });

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

  const [creatorOwnedCredential] = await executeQuery(
    (db) =>
      db
        .insert(repositoryConnectorCredentials)
        .values({
          repositoryId: repository.id,
          userId: connectorCreator.id,
          provider: "google_drive",
          encryptedRefreshToken: "creator-owned-smoke-placeholder",
          grantedScopes: [GOOGLE_DRIVE_SCOPE],
        })
        .returning({ id: repositoryConnectorCredentials.id }),
    "smoke.googleContent.creatorOwnedCredential",
  );
  assert.ok(creatorOwnedCredential);
  const [creatorOwnedConnector] = await executeQuery(
    (db) =>
      db
        .insert(repositoryConnectors)
        .values({
          repositoryId: repository.id,
          provider: "google_drive",
          authMode: "personal_oauth",
          createdBy: connectorCreator.id,
          credentialId: creatorOwnedCredential.id,
          displayName: "Creator deletion smoke",
          status: "active",
        })
        .returning({ id: repositoryConnectors.id }),
    "smoke.googleContent.creatorOwnedConnector",
  );
  assert.ok(creatorOwnedConnector);
  const [creatorOwnedItem] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "document",
          name: "Creator deletion retained item",
          source: "google_drive",
          sourceExternalId: "creator-deletion-file",
          lifecycleStatus: "active",
          processingStatus: "completed",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.googleContent.creatorOwnedItem",
  );
  assert.ok(creatorOwnedItem);
  await executeQuery(
    (db) =>
      db.insert(repositoryConnectorSources).values({
        connectorId: creatorOwnedConnector.id,
        repositoryItemId: creatorOwnedItem.id,
        externalId: "creator-deletion-file",
        name: "Creator deletion retained item",
        mimeType: "application/pdf",
        status: "active",
      }),
    "smoke.googleContent.creatorOwnedSource",
  );
  await executeQuery(
    (db) => db.delete(users).where(eq(users.id, connectorCreator.id)),
    "smoke.googleContent.deleteConnectorCreator",
  );
  connectorCreatorId = null;
  const [deletedConnector] = await executeQuery(
    (db) =>
      db
        .select({ id: repositoryConnectors.id })
        .from(repositoryConnectors)
        .where(eq(repositoryConnectors.id, creatorOwnedConnector.id))
        .limit(1),
    "smoke.googleContent.deletedCreatorConnector",
  );
  const [retainedItem] = await executeQuery(
    (db) =>
      db
        .select({ lifecycleStatus: repositoryItems.lifecycleStatus })
        .from(repositoryItems)
        .where(eq(repositoryItems.id, creatorOwnedItem.id))
        .limit(1),
    "smoke.googleContent.retainedCreatorItem",
  );
  assert.equal(deletedConnector, undefined);
  assert.equal(retainedItem?.lifecycleStatus, "unavailable");

  process.stdout.write(
    "Google content connector PostgreSQL smoke passed: selection fencing, isolated source failure, cursor, immutable version, sync run, deletion grace, and creator deletion cleanup.\n",
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
  const connectorCreatorIdToDelete = connectorCreatorId;
  if (connectorCreatorIdToDelete) {
    await executeQuery(
      (db) => db.delete(users).where(eq(users.id, connectorCreatorIdToDelete)),
      "smoke.googleContent.cleanupConnectorCreator",
    );
  }
  await closeDatabase();
}
