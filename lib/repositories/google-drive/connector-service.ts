import { randomUUID } from "node:crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { encryptToken } from "@/lib/crypto/token-encryption";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryConnectorCredentials,
  repositoryConnectorSelections,
  repositoryConnectorSources,
  repositoryConnectorSyncRuns,
  repositoryConnectors,
  repositoryItems,
  type RepositoryConnectorAuthMode,
  type RepositoryConnectorSelectionKind,
  type RepositoryConnectorStatus,
  type RepositoryConnectorSyncStatus,
  type RepositoryConnectorSyncTrigger,
} from "@/lib/db/schema";
import { getContentPlatformConfig } from "@/lib/repositories/content-platform";
import { GOOGLE_DRIVE_SCOPE } from "./formats";

const sqs = new SQSClient({});

export interface GoogleDriveSelectionInput {
  externalId: string;
  selectionKind: RepositoryConnectorSelectionKind;
  displayName: string;
  includeDescendants?: boolean;
}

export interface GoogleDriveConnectorView {
  id: string;
  repositoryId: number;
  authMode: RepositoryConnectorAuthMode;
  ownedByViewer: boolean;
  displayName: string;
  sharedDriveId: string | null;
  status: RepositoryConnectorStatus;
  nextSyncAt: Date;
  lastSyncAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
  watchExpiresAt: Date | null;
  selections: Array<{
    id: string;
    externalId: string;
    selectionKind: RepositoryConnectorSelectionKind;
    displayName: string;
    includeDescendants: boolean;
    active: boolean;
  }>;
  sourceCounts: Record<string, number>;
  latestRun: {
    id: string;
    trigger: RepositoryConnectorSyncTrigger;
    status: RepositoryConnectorSyncStatus;
    discoveredCount: number;
    createdCount: number;
    updatedCount: number;
    missingCount: number;
    failedCount: number;
    startedAt: Date;
    finishedAt: Date | null;
  } | null;
}

function validateRepositoryId(repositoryId: number): void {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error("A positive repository id is required");
  }
}

function validateConnectorId(connectorId: string): void {
  if (
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
      connectorId,
    )
  ) {
    throw new Error("A valid connector id is required");
  }
}

export async function assertGoogleContentSyncEnabled(): Promise<void> {
  const config = await getContentPlatformConfig();
  if (!config.enabled || !config.googleSyncEnabled) {
    throw new Error("Google Workspace synchronization is not enabled");
  }
}

export async function upsertPersonalGoogleDriveConnector(input: {
  repositoryId: number;
  userId: number;
  refreshToken: string;
  grantedScopes: string[];
  displayName?: string;
}): Promise<string> {
  validateRepositoryId(input.repositoryId);
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new Error("A positive user id is required");
  }
  if (
    input.grantedScopes.length !== 1 ||
    input.grantedScopes[0] !== GOOGLE_DRIVE_SCOPE
  ) {
    throw new Error("Google Drive connector requires exactly drive.readonly");
  }
  const encryptedRefreshToken = await encryptToken(input.refreshToken);

  return executeTransaction(async (tx) => {
    const [repository] = await tx
      .select({ id: knowledgeRepositories.id })
      .from(knowledgeRepositories)
      .where(eq(knowledgeRepositories.id, input.repositoryId))
      .limit(1)
      .for("update");
    if (!repository) throw new Error("Repository not found");

    const [existing] = await tx
      .select({
        connectorId: repositoryConnectors.id,
        credentialId: repositoryConnectors.credentialId,
      })
      .from(repositoryConnectors)
      .where(
        and(
          eq(repositoryConnectors.repositoryId, input.repositoryId),
          eq(repositoryConnectors.provider, "google_drive"),
          eq(repositoryConnectors.authMode, "personal_oauth"),
          eq(repositoryConnectors.createdBy, input.userId),
        ),
      )
      .limit(1);

    if (existing?.credentialId) {
      const [selection] = await tx
        .select({ id: repositoryConnectorSelections.id })
        .from(repositoryConnectorSelections)
        .where(
          and(
            eq(repositoryConnectorSelections.connectorId, existing.connectorId),
            eq(repositoryConnectorSelections.active, true),
          ),
        )
        .limit(1);
      await tx
        .update(repositoryConnectorCredentials)
        .set({
          encryptedRefreshToken,
          grantedScopes: input.grantedScopes,
          revokedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(repositoryConnectorCredentials.id, existing.credentialId));
      await tx
        .update(repositoryConnectors)
        .set({
          displayName: input.displayName?.trim() || "Google Drive",
          status: selection ? "pending" : "paused",
          nextSyncAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
          consecutiveFailures: 0,
          updatedAt: new Date(),
        })
        .where(eq(repositoryConnectors.id, existing.connectorId));
      return existing.connectorId;
    }

    const [credential] = await tx
      .insert(repositoryConnectorCredentials)
      .values({
        repositoryId: input.repositoryId,
        userId: input.userId,
        provider: "google_drive",
        encryptedRefreshToken,
        grantedScopes: input.grantedScopes,
      })
      .returning({ id: repositoryConnectorCredentials.id });
    if (!credential) throw new Error("Failed to create connector credential");

    const [connector] = await tx
      .insert(repositoryConnectors)
      .values({
        repositoryId: input.repositoryId,
        provider: "google_drive",
        authMode: "personal_oauth",
        createdBy: input.userId,
        credentialId: credential.id,
        displayName: input.displayName?.trim() || "Google Drive",
        status: "paused",
      })
      .returning({ id: repositoryConnectors.id });
    if (!connector) throw new Error("Failed to create Google Drive connector");
    return connector.id;
  }, "googleDrive.upsertPersonalConnector");
}

export async function replaceGoogleDriveSelections(input: {
  connectorId: string;
  selections: GoogleDriveSelectionInput[];
}): Promise<void> {
  validateConnectorId(input.connectorId);
  if (input.selections.length === 0 || input.selections.length > 100) {
    throw new Error("Select between 1 and 100 Drive sources");
  }
  const deduplicated = new Map<string, GoogleDriveSelectionInput>();
  for (const selection of input.selections) {
    const externalId = selection.externalId.trim();
    const displayName = selection.displayName.trim();
    if (!externalId || externalId.length > 512) {
      throw new Error("Drive selection id is invalid");
    }
    if (!displayName || displayName.length > 512) {
      throw new Error("Drive selection name is invalid");
    }
    deduplicated.set(externalId, {
      ...selection,
      externalId,
      displayName,
    });
  }

  await executeTransaction(async (tx) => {
    const [connector] = await tx
      .select({ id: repositoryConnectors.id })
      .from(repositoryConnectors)
      .where(eq(repositoryConnectors.id, input.connectorId))
      .limit(1)
      .for("update");
    if (!connector) throw new Error("Connector not found");

    await tx
      .update(repositoryConnectorSelections)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(repositoryConnectorSelections.connectorId, input.connectorId));

    for (const selection of deduplicated.values()) {
      await tx
        .insert(repositoryConnectorSelections)
        .values({
          connectorId: input.connectorId,
          externalId: selection.externalId,
          selectionKind: selection.selectionKind,
          displayName: selection.displayName,
          includeDescendants: selection.includeDescendants ?? true,
          active: true,
        })
        .onConflictDoUpdate({
          target: [
            repositoryConnectorSelections.connectorId,
            repositoryConnectorSelections.externalId,
          ],
          set: {
            selectionKind: selection.selectionKind,
            displayName: selection.displayName,
            includeDescendants: selection.includeDescendants ?? true,
            active: true,
            updatedAt: new Date(),
          },
        });
    }
    await tx
      .update(repositoryConnectors)
      .set({
        status: "pending",
        selectionRevision: sql`${repositoryConnectors.selectionRevision} + 1`,
        cursor: null,
        nextSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(repositoryConnectors.id, input.connectorId));
  }, "googleDrive.replaceSelections");
}

export async function listGoogleDriveConnectors(
  repositoryId: number,
  viewerUserId?: number,
): Promise<GoogleDriveConnectorView[]> {
  validateRepositoryId(repositoryId);
  const connectors = await executeQuery(
    (db) =>
      db
        .select()
        .from(repositoryConnectors)
        .where(
          and(
            eq(repositoryConnectors.repositoryId, repositoryId),
            eq(repositoryConnectors.provider, "google_drive"),
          ),
        )
        .orderBy(repositoryConnectors.createdAt),
    "googleDrive.listConnectors",
  );
  if (connectors.length === 0) return [];

  const connectorIds = connectors.map(({ id }) => id);
  const [selections, sourceCounts, latestRuns] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select()
          .from(repositoryConnectorSelections)
          .where(
            inArray(repositoryConnectorSelections.connectorId, connectorIds),
          )
          .orderBy(repositoryConnectorSelections.createdAt),
      "googleDrive.listSelections",
    ),
    executeQuery(
      (db) =>
        db
          .select({
            connectorId: repositoryConnectorSources.connectorId,
            status: repositoryConnectorSources.status,
            count: sql<number>`count(*)::int`,
          })
          .from(repositoryConnectorSources)
          .where(inArray(repositoryConnectorSources.connectorId, connectorIds))
          .groupBy(
            repositoryConnectorSources.connectorId,
            repositoryConnectorSources.status,
          ),
      "googleDrive.countSources",
    ),
    executeQuery(
      (db) =>
        db
          .selectDistinctOn([repositoryConnectorSyncRuns.connectorId])
          .from(repositoryConnectorSyncRuns)
          .where(inArray(repositoryConnectorSyncRuns.connectorId, connectorIds))
          .orderBy(
            repositoryConnectorSyncRuns.connectorId,
            desc(repositoryConnectorSyncRuns.startedAt),
          ),
      "googleDrive.latestRuns",
    ),
  ]);

  return connectors.map((connector) => ({
    id: connector.id,
    repositoryId: connector.repositoryId,
    authMode: connector.authMode,
    ownedByViewer:
      viewerUserId !== undefined && connector.createdBy === viewerUserId,
    displayName: connector.displayName,
    sharedDriveId: connector.sharedDriveId,
    status: connector.status,
    nextSyncAt: connector.nextSyncAt,
    lastSyncAt: connector.lastSyncAt,
    lastSuccessAt: connector.lastSuccessAt,
    lastErrorCode: connector.lastErrorCode,
    lastErrorMessage: connector.lastErrorMessage,
    consecutiveFailures: connector.consecutiveFailures,
    watchExpiresAt: connector.watchExpiresAt,
    selections: selections
      .filter(({ connectorId }) => connectorId === connector.id)
      .map((selection) => ({
        id: selection.id,
        externalId: selection.externalId,
        selectionKind: selection.selectionKind,
        displayName: selection.displayName,
        includeDescendants: selection.includeDescendants,
        active: selection.active,
      })),
    sourceCounts: Object.fromEntries(
      sourceCounts
        .filter(({ connectorId }) => connectorId === connector.id)
        .map(({ status, count }) => [status, count]),
    ),
    latestRun: (() => {
      const run = latestRuns.find(
        ({ connectorId }) => connectorId === connector.id,
      );
      return run
        ? {
            id: run.id,
            trigger: run.trigger,
            status: run.status,
            discoveredCount: run.discoveredCount,
            createdCount: run.createdCount,
            updatedCount: run.updatedCount,
            missingCount: run.missingCount,
            failedCount: run.failedCount,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          }
        : null;
    })(),
  }));
}

export async function requestGoogleDriveSync(input: {
  connectorId: string;
  trigger: RepositoryConnectorSyncTrigger;
}): Promise<void> {
  validateConnectorId(input.connectorId);
  await executeQuery(
    (db) =>
      db
        .update(repositoryConnectors)
        .set({
          status: sql`CASE
            WHEN ${repositoryConnectors.status} = 'paused' THEN 'paused'
            ELSE 'pending'
          END`,
          nextSyncAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(repositoryConnectors.id, input.connectorId)),
    "googleDrive.requestSync",
  );

  const queueUrl = process.env.GOOGLE_CONTENT_SYNC_QUEUE_URL;
  if (!queueUrl) return;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        connectorId: input.connectorId,
        trigger: input.trigger,
        requestId: randomUUID(),
      }),
      MessageAttributes: {
        connectorId: {
          DataType: "String",
          StringValue: input.connectorId,
        },
      },
    }),
  );
}

export async function getGoogleDriveConnectorCredential(input: {
  connectorId: string;
  userId: number;
}): Promise<{
  connectorId: string;
  encryptedRefreshToken: string;
}> {
  validateConnectorId(input.connectorId);
  const [row] = await executeQuery(
    (db) =>
      db
        .select({
          connectorId: repositoryConnectors.id,
          createdBy: repositoryConnectors.createdBy,
          encryptedRefreshToken:
            repositoryConnectorCredentials.encryptedRefreshToken,
          revokedAt: repositoryConnectorCredentials.revokedAt,
        })
        .from(repositoryConnectors)
        .innerJoin(
          repositoryConnectorCredentials,
          eq(
            repositoryConnectorCredentials.id,
            repositoryConnectors.credentialId,
          ),
        )
        .where(
          and(
            eq(repositoryConnectors.id, input.connectorId),
            eq(repositoryConnectors.authMode, "personal_oauth"),
            eq(repositoryConnectors.createdBy, input.userId),
          ),
        )
        .limit(1),
    "googleDrive.getConnectorCredential",
  );
  if (!row || row.revokedAt) throw new Error("Connector not found");
  return {
    connectorId: row.connectorId,
    encryptedRefreshToken: row.encryptedRefreshToken,
  };
}

export async function disconnectGoogleDriveConnector(input: {
  connectorId: string;
}): Promise<{ encryptedRefreshToken: string | null }> {
  validateConnectorId(input.connectorId);
  return executeTransaction(async (tx) => {
    const [connector] = await tx
      .select({
        credentialId: repositoryConnectors.credentialId,
      })
      .from(repositoryConnectors)
      .where(eq(repositoryConnectors.id, input.connectorId))
      .limit(1)
      .for("update");
    if (!connector) throw new Error("Connector not found");

    let encryptedRefreshToken: string | null = null;
    if (connector.credentialId) {
      const [credential] = await tx
        .select({
          encryptedRefreshToken:
            repositoryConnectorCredentials.encryptedRefreshToken,
        })
        .from(repositoryConnectorCredentials)
        .where(eq(repositoryConnectorCredentials.id, connector.credentialId))
        .limit(1);
      encryptedRefreshToken = credential?.encryptedRefreshToken ?? null;
      await tx
        .update(repositoryConnectorCredentials)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(repositoryConnectorCredentials.id, connector.credentialId));
    }
    const sourceItems = await tx
      .select({ itemId: repositoryConnectorSources.repositoryItemId })
      .from(repositoryConnectorSources)
      .where(eq(repositoryConnectorSources.connectorId, input.connectorId));
    const disconnectedAt = new Date();
    await tx
      .update(repositoryConnectorSources)
      .set({
        status: "access_lost",
        missingSince: disconnectedAt,
        removedAt: disconnectedAt,
        updatedAt: disconnectedAt,
      })
      .where(eq(repositoryConnectorSources.connectorId, input.connectorId));
    if (sourceItems.length > 0) {
      await tx
        .update(repositoryItems)
        .set({
          lifecycleStatus: "unavailable",
          updatedAt: disconnectedAt,
        })
        .where(
          inArray(
            repositoryItems.id,
            sourceItems.map(({ itemId }) => itemId),
          ),
        );
    }
    await tx
      .update(repositoryConnectors)
      .set({
        status: "revoked",
        cursor: null,
        watchChannelId: null,
        watchResourceId: null,
        watchTokenHash: null,
        watchExpiresAt: null,
        nextSyncAt: new Date("9999-12-31T23:59:59.999Z"),
        updatedAt: new Date(),
      })
      .where(eq(repositoryConnectors.id, input.connectorId));
    return { encryptedRefreshToken };
  }, "googleDrive.disconnectConnector");
}

export async function connectorBelongsToRepository(
  connectorId: string,
  repositoryId: number,
): Promise<boolean> {
  validateConnectorId(connectorId);
  validateRepositoryId(repositoryId);
  const [row] = await executeQuery(
    (db) =>
      db
        .select({ id: repositoryConnectors.id })
        .from(repositoryConnectors)
        .where(
          and(
            eq(repositoryConnectors.id, connectorId),
            eq(repositoryConnectors.repositoryId, repositoryId),
          ),
        )
        .limit(1),
    "googleDrive.connectorBelongsToRepository",
  );
  return Boolean(row);
}
