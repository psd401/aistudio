import type {
  Context,
  EventBridgeEvent,
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lte,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  executeQuery,
  executeTransaction,
} from "../../../lib/db/drizzle-client";
import {
  repositoryConnectorCredentials,
  repositoryConnectorSelections,
  repositoryConnectorSources,
  repositoryConnectorSyncRuns,
  repositoryConnectors,
  repositoryItems,
  repositoryItemVersions,
  repositoryProcessingJobs,
  type RepositoryConnectorRow,
  type RepositoryConnectorSelectionRow,
  type RepositoryConnectorSourceMetadata,
  type RepositoryConnectorSourceRow,
  type RepositoryConnectorSyncTrigger,
} from "../../../lib/db/schema";
import {
  getContentPlatformConfig,
  type ContentPlatformConfig,
} from "../../../lib/repositories/content-platform/config";
import { dispatchContentProcessingJob } from "../../../lib/repositories/content-platform/dispatch-service";
import {
  buildProcessingIdempotencyKey,
  CONTENT_PROCESSING_MAX_ATTEMPTS,
  CONTENT_PROCESSOR_CONTRACT_VERSION,
} from "../../../lib/repositories/content-platform/job-state";
import { buildRepositorySourceObjectKey } from "../../../lib/repositories/content-platform/object-key";
import {
  GoogleDriveApiError,
  GoogleDriveClient,
  GoogleDriveDownloadPendingError,
  type GoogleDriveFile,
} from "../../../lib/repositories/google-drive/drive-client";
import {
  exportedGoogleDriveFileName,
  GOOGLE_FOLDER_MIME_TYPE,
  GOOGLE_SHORTCUT_MIME_TYPE,
  resolveGoogleDriveExportFormat,
} from "../../../lib/repositories/google-drive/formats";
import { refreshGoogleAccessToken } from "../../../lib/repositories/google-drive/oauth";
import { getGoogleContentWifAccessToken } from "../../../lib/repositories/google-drive/wif";

const syncMessageSchema = z.object({
  connectorId: z.string().uuid(),
  trigger: z.enum([
    "initial",
    "schedule",
    "notification",
    "manual",
    "recovery",
  ]),
  requestId: z.string().optional(),
});

interface SyncMessage {
  connectorId: string;
  trigger: RepositoryConnectorSyncTrigger;
  requestId?: string;
}

interface ConnectorContext {
  connector: RepositoryConnectorRow;
  selections: RepositoryConnectorSelectionRow[];
  sources: RepositoryConnectorSourceRow[];
  encryptedRefreshToken: string | null;
}

interface SyncCounters {
  discovered: number;
  created: number;
  updated: number;
  unchanged: number;
  missing: number;
  failed: number;
  deferred: number;
}

type ImportOutcome = "created" | "updated" | "unchanged" | "deferred";

const log = {
  info(message: string, metadata: Record<string, unknown> = {}) {
    process.stdout.write(
      `${JSON.stringify({ level: "INFO", message, ...metadata })}\n`,
    );
  },
  error(message: string, metadata: Record<string, unknown> = {}) {
    process.stderr.write(
      `${JSON.stringify({ level: "ERROR", message, ...metadata })}\n`,
    );
  },
};

const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});
const documentsBucket = requiredEnvironment("DOCUMENTS_BUCKET_NAME");
const databaseHost = requiredEnvironment("DATABASE_HOST");
const databaseSecretArn = requiredEnvironment("DATABASE_SECRET_ARN");
const appBaseUrl = process.env.APP_BASE_URL?.replace(/\/+$/, "") ?? "";
const MAX_SCHEDULED_CONNECTORS = 25;
const WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const WATCH_LIFETIME_MS = 6 * 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_MINUTES = 5;
const SYNC_LEASE_MS = 12 * 60 * 1000;

class ConnectorRevokedError extends Error {
  constructor() {
    super("Google Drive connector was revoked during synchronization");
    this.name = "ConnectorRevokedError";
  }
}

let databaseReady: Promise<void> | null = null;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

async function ensureDatabaseCredentials(): Promise<void> {
  if (!databaseReady) {
    databaseReady = (async () => {
      const result = await secrets.send(
        new GetSecretValueCommand({ SecretId: databaseSecretArn }),
      );
      if (!result.SecretString) {
        throw new Error("Database secret has no SecretString");
      }
      const parsed = JSON.parse(result.SecretString) as Record<string, unknown>;
      if (
        typeof parsed.username !== "string" ||
        typeof parsed.password !== "string"
      ) {
        throw new Error("Database secret is missing username or password");
      }
      process.env.DB_HOST = databaseHost;
      process.env.DB_PORT = process.env.DATABASE_PORT ?? "5432";
      process.env.DB_NAME = process.env.DATABASE_NAME ?? "aistudio";
      process.env.DB_USER = parsed.username;
      process.env.DB_PASSWORD = parsed.password;
      process.env.DB_SSL = "true";
      process.env.DB_MAX_CONNECTIONS = "2";
    })();
  }
  await databaseReady;
}

function parseMessage(record: SQSRecord): SyncMessage {
  return syncMessageSchema.parse(JSON.parse(record.body) as unknown);
}

function sourceRevision(file: GoogleDriveFile): string {
  const revision =
    file.headRevisionId ??
    file.version ??
    file.md5Checksum ??
    file.modifiedTime ??
    "unknown";
  return `google-drive:${file.id}:${revision}`;
}

function sourceMetadata(
  file: GoogleDriveFile,
  selectedVia: string[],
  pendingDownloadOperation?: string,
): RepositoryConnectorSourceMetadata {
  return {
    webViewLink: file.webViewLink,
    iconLink: file.iconLink,
    originalMimeType: file.mimeType,
    ownerNames: file.owners.flatMap(({ displayName }) =>
      displayName ? [displayName] : [],
    ),
    selectedVia,
    pendingDownloadOperation,
  };
}

async function loadConnectorContext(
  connectorId: string,
): Promise<ConnectorContext | null> {
  const [connector] = await executeQuery(
    (db) =>
      db
        .select()
        .from(repositoryConnectors)
        .where(eq(repositoryConnectors.id, connectorId))
        .limit(1),
    "googleContent.loadConnector",
  );
  if (!connector || connector.status === "revoked") return null;

  const [selections, sources, credentials] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select()
          .from(repositoryConnectorSelections)
          .where(
            and(
              eq(repositoryConnectorSelections.connectorId, connectorId),
              eq(repositoryConnectorSelections.active, true),
            ),
          )
          .orderBy(asc(repositoryConnectorSelections.createdAt)),
      "googleContent.loadSelections",
    ),
    executeQuery(
      (db) =>
        db
          .select()
          .from(repositoryConnectorSources)
          .where(eq(repositoryConnectorSources.connectorId, connectorId)),
      "googleContent.loadSources",
    ),
    connector.credentialId
      ? executeQuery(
          (db) =>
            db
              .select({
                encryptedRefreshToken:
                  repositoryConnectorCredentials.encryptedRefreshToken,
                revokedAt: repositoryConnectorCredentials.revokedAt,
              })
              .from(repositoryConnectorCredentials)
              .where(
                eq(repositoryConnectorCredentials.id, connector.credentialId!),
              )
              .limit(1),
          "googleContent.loadCredential",
        )
      : Promise.resolve([]),
  ]);

  const credential = credentials[0];
  if (
    connector.authMode === "personal_oauth" &&
    (!credential || credential.revokedAt)
  ) {
    throw new Error("Google Drive authorization has been revoked");
  }
  return {
    connector,
    selections,
    sources,
    encryptedRefreshToken: credential?.encryptedRefreshToken ?? null,
  };
}

async function accessTokenFor(context: ConnectorContext): Promise<string> {
  if (context.connector.authMode === "shared_drive_wif") {
    return getGoogleContentWifAccessToken();
  }
  if (!context.encryptedRefreshToken) {
    throw new Error("Google Drive connector credential is unavailable");
  }
  const token = await refreshGoogleAccessToken({
    encryptedRefreshToken: context.encryptedRefreshToken,
  });
  return token.accessToken;
}

async function claimSync(
  connectorId: string,
  trigger: RepositoryConnectorSyncTrigger,
  traceId: string,
): Promise<string | null> {
  return executeTransaction(async (tx) => {
    const now = new Date();
    const [connector] = await tx
      .select({
        id: repositoryConnectors.id,
        cursor: repositoryConnectors.cursor,
        status: repositoryConnectors.status,
        syncIntervalMinutes: repositoryConnectors.syncIntervalMinutes,
        nextSyncAt: repositoryConnectors.nextSyncAt,
      })
      .from(repositoryConnectors)
      .where(eq(repositoryConnectors.id, connectorId))
      .limit(1)
      .for("update");
    if (
      !connector ||
      connector.status === "revoked" ||
      connector.status === "paused"
    ) {
      return null;
    }
    if (
      trigger === "schedule" &&
      connector.nextSyncAt.getTime() > now.getTime()
    ) {
      return null;
    }

    const [running] = await tx
      .select({
        id: repositoryConnectorSyncRuns.id,
        startedAt: repositoryConnectorSyncRuns.startedAt,
      })
      .from(repositoryConnectorSyncRuns)
      .where(
        and(
          eq(repositoryConnectorSyncRuns.connectorId, connectorId),
          eq(repositoryConnectorSyncRuns.status, "running"),
        ),
      )
      .orderBy(desc(repositoryConnectorSyncRuns.startedAt))
      .limit(1)
      .for("update");
    if (
      running &&
      running.startedAt.getTime() > now.getTime() - SYNC_LEASE_MS
    ) {
      return null;
    }
    if (running) {
      await tx
        .update(repositoryConnectorSyncRuns)
        .set({
          status: "failed",
          errorCode: "STALE_SYNC_LEASE",
          errorMessage: "A stale synchronization lease was recovered",
          finishedAt: now,
        })
        .where(eq(repositoryConnectorSyncRuns.id, running.id));
    }

    const claimedUntil = new Date(
      now.getTime() +
        Math.max(SYNC_LEASE_MS, connector.syncIntervalMinutes * 60_000),
    );
    await tx
      .update(repositoryConnectors)
      .set({
        nextSyncAt: claimedUntil,
        lastSyncAt: now,
        updatedAt: now,
      })
      .where(eq(repositoryConnectors.id, connectorId));
    const [run] = await tx
      .insert(repositoryConnectorSyncRuns)
      .values({
        connectorId,
        trigger: running ? "recovery" : connector.cursor ? trigger : "initial",
        cursorBefore: connector.cursor,
        traceId,
      })
      .returning({ id: repositoryConnectorSyncRuns.id });
    if (!run) throw new Error("Failed to create connector sync run");
    return run.id;
  }, "googleContent.claimSync");
}

async function ensureSourceIdentity(input: {
  context: ConnectorContext;
  file: GoogleDriveFile;
  selectedVia: string[];
}): Promise<{
  itemId: number;
  sourceId: string;
  created: boolean;
  sourceRevision: string | null;
  pendingDownloadOperation: string | undefined;
}> {
  const format = resolveGoogleDriveExportFormat(input.file.mimeType);
  return executeTransaction(async (tx) => {
    const [connector] = await tx
      .select({ status: repositoryConnectors.status })
      .from(repositoryConnectors)
      .where(eq(repositoryConnectors.id, input.context.connector.id))
      .limit(1)
      .for("update");
    if (!connector || connector.status === "revoked") {
      throw new ConnectorRevokedError();
    }
    const [existing] = await tx
      .select({
        sourceId: repositoryConnectorSources.id,
        itemId: repositoryConnectorSources.repositoryItemId,
        sourceRevision: repositoryConnectorSources.sourceRevision,
        metadata: repositoryConnectorSources.metadata,
      })
      .from(repositoryConnectorSources)
      .where(
        and(
          eq(
            repositoryConnectorSources.connectorId,
            input.context.connector.id,
          ),
          eq(repositoryConnectorSources.externalId, input.file.id),
        ),
      )
      .limit(1)
      .for("update");
    const now = new Date();
    if (existing) {
      await tx
        .update(repositoryConnectorSources)
        .set({
          driveId: input.file.driveId ?? null,
          name: input.file.name,
          mimeType: input.file.mimeType,
          parentIds: input.file.parents,
          modifiedTime: input.file.modifiedTime
            ? new Date(input.file.modifiedTime)
            : null,
          checksum: input.file.md5Checksum ?? null,
          status: format ? "active" : "unsupported",
          missingSince: null,
          removedAt: null,
          lastSeenAt: now,
          metadata: sourceMetadata(
            input.file,
            input.selectedVia,
            existing.metadata.pendingDownloadOperation,
          ),
          updatedAt: now,
        })
        .where(eq(repositoryConnectorSources.id, existing.sourceId));
      await tx
        .update(repositoryItems)
        .set({
          name: input.file.name,
          type: format?.repositoryItemType ?? "document",
          lifecycleStatus: "active",
          updatedAt: now,
        })
        .where(eq(repositoryItems.id, existing.itemId));
      return {
        itemId: existing.itemId,
        sourceId: existing.sourceId,
        created: false,
        sourceRevision: existing.sourceRevision,
        pendingDownloadOperation: existing.metadata.pendingDownloadOperation,
      };
    }

    const [item] = await tx
      .insert(repositoryItems)
      .values({
        repositoryId: input.context.connector.repositoryId,
        type: format?.repositoryItemType ?? "document",
        name: input.file.name,
        source: "google_drive",
        sourceExternalId: input.file.id,
        lifecycleStatus: "active",
        processingStatus: format ? "pending" : "completed",
        metadata: {
          connectorId: input.context.connector.id,
          webViewLink: input.file.webViewLink,
        },
      })
      .returning({ id: repositoryItems.id });
    if (!item) throw new Error("Failed to create synchronized item");
    const [source] = await tx
      .insert(repositoryConnectorSources)
      .values({
        connectorId: input.context.connector.id,
        repositoryItemId: item.id,
        externalId: input.file.id,
        driveId: input.file.driveId ?? null,
        name: input.file.name,
        mimeType: input.file.mimeType,
        parentIds: input.file.parents,
        modifiedTime: input.file.modifiedTime
          ? new Date(input.file.modifiedTime)
          : null,
        checksum: input.file.md5Checksum ?? null,
        status: format ? "active" : "unsupported",
        metadata: sourceMetadata(input.file, input.selectedVia),
      })
      .returning({ id: repositoryConnectorSources.id });
    if (!source) throw new Error("Failed to create synchronized source");
    return {
      itemId: item.id,
      sourceId: source.id,
      created: true,
      sourceRevision: null,
      pendingDownloadOperation: undefined,
    };
  }, "googleContent.ensureSourceIdentity");
}

async function importFile(
  context: ConnectorContext,
  client: GoogleDriveClient,
  file: GoogleDriveFile,
  selectedVia: string[],
): Promise<ImportOutcome> {
  const format = resolveGoogleDriveExportFormat(file.mimeType);
  const identity = await ensureSourceIdentity({ context, file, selectedVia });
  if (!format) return identity.created ? "created" : "unchanged";

  const revision = sourceRevision(file);
  if (
    identity.sourceRevision === revision &&
    !identity.pendingDownloadOperation
  ) {
    return "unchanged";
  }

  let downloaded;
  try {
    downloaded = await client.downloadFile(
      file,
      format,
      identity.pendingDownloadOperation,
    );
  } catch (error) {
    if (!(error instanceof GoogleDriveDownloadPendingError)) throw error;
    await executeQuery(
      (db) =>
        db
          .update(repositoryConnectorSources)
          .set({
            metadata: sourceMetadata(file, selectedVia, error.operationName),
            updatedAt: new Date(),
          })
          .where(eq(repositoryConnectorSources.id, identity.sourceId)),
      "googleContent.deferDownload",
    );
    return "deferred";
  }

  if (!downloaded.response.body) {
    throw new Error("Google Drive download returned no body");
  }
  const fileName = exportedGoogleDriveFileName(file.name, format);
  const objectKey = buildRepositorySourceObjectKey(
    context.connector.repositoryId,
    fileName,
    randomUUID(),
  );
  const hash = createHash("sha256");
  let byteSize = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const body = Readable.from(
    downloaded.response.body as AsyncIterable<Uint8Array>,
  ).pipe(meter);
  await new Upload({
    client: s3,
    params: {
      Bucket: documentsBucket,
      Key: objectKey,
      Body: body,
      ContentType: format.contentType,
      Metadata: {
        "source-provider": "google-drive",
        "source-external-id": file.id,
      },
    },
    queueSize: 2,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  }).done();
  const sha256 = hash.digest("hex");
  if (byteSize <= 0) throw new Error("Google Drive download was empty");

  const registered = await executeTransaction(async (tx) => {
    const [connector] = await tx
      .select({ status: repositoryConnectors.status })
      .from(repositoryConnectors)
      .where(eq(repositoryConnectors.id, context.connector.id))
      .limit(1)
      .for("update");
    if (!connector || connector.status === "revoked") {
      throw new ConnectorRevokedError();
    }
    const [source] = await tx
      .select({
        id: repositoryConnectorSources.id,
        sourceRevision: repositoryConnectorSources.sourceRevision,
      })
      .from(repositoryConnectorSources)
      .where(eq(repositoryConnectorSources.id, identity.sourceId))
      .limit(1)
      .for("update");
    if (!source) throw new Error("Synchronized source disappeared");
    if (source.sourceRevision === revision) return null;

    const [latest] = await tx
      .select({ versionNumber: repositoryItemVersions.versionNumber })
      .from(repositoryItemVersions)
      .where(eq(repositoryItemVersions.itemId, identity.itemId))
      .orderBy(desc(repositoryItemVersions.versionNumber))
      .limit(1);
    const [version] = await tx
      .insert(repositoryItemVersions)
      .values({
        itemId: identity.itemId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        sourceKind: "google_drive",
        sourceRevision: revision,
        objectKey,
        declaredContentType: format.contentType,
        byteSize,
        sha256,
        storageStatus: "quarantined",
        processingStatus: "pending",
        processorVersion: CONTENT_PROCESSOR_CONTRACT_VERSION,
        metadata: {
          originalFileName: fileName,
          googleFileId: file.id,
          googleMimeType: file.mimeType,
          googleModifiedTime: file.modifiedTime,
        },
        createdBy: context.connector.createdBy,
      })
      .returning({ id: repositoryItemVersions.id });
    if (!version) throw new Error("Failed to create synchronized version");
    const [job] = await tx
      .insert(repositoryProcessingJobs)
      .values({
        itemVersionId: version.id,
        stage: "inspect",
        status: "pending",
        idempotencyKey: buildProcessingIdempotencyKey(version.id, "inspect"),
        maxAttempts: CONTENT_PROCESSING_MAX_ATTEMPTS,
      })
      .returning({ id: repositoryProcessingJobs.id });
    if (!job) throw new Error("Failed to create synchronized inspection job");

    const now = new Date();
    await tx
      .update(repositoryItems)
      .set({
        currentVersionId: version.id,
        lifecycleStatus: "active",
        processingStatus: "pending",
        processingError: null,
        updatedAt: now,
      })
      .where(eq(repositoryItems.id, identity.itemId));
    await tx
      .update(repositoryConnectorSources)
      .set({
        sourceRevision: revision,
        currentItemVersionId: version.id,
        status: "active",
        missingSince: null,
        removedAt: null,
        lastSeenAt: now,
        metadata: {
          ...sourceMetadata(file, selectedVia),
          exportMimeType: format.contentType,
        },
        updatedAt: now,
      })
      .where(eq(repositoryConnectorSources.id, identity.sourceId));
    return { jobId: job.id, itemVersionId: version.id };
  }, "googleContent.registerVersion");

  if (!registered) return "unchanged";
  await dispatchContentProcessingJob(registered).catch((error: unknown) => {
    log.error("Google Drive content job remains pending for outbox recovery", {
      connectorId: context.connector.id,
      externalId: file.id,
      itemVersionId: registered.itemVersionId,
      error: error instanceof Error ? error.message : "unknown",
    });
  });
  return identity.created ? "created" : "updated";
}

async function resolveShortcut(
  client: GoogleDriveClient,
  file: GoogleDriveFile,
): Promise<GoogleDriveFile> {
  if (file.mimeType !== GOOGLE_SHORTCUT_MIME_TYPE) return file;
  const targetId = file.shortcutDetails?.targetId;
  if (!targetId) throw new Error(`Drive shortcut ${file.id} has no target`);
  return client.getFile(targetId);
}

async function enumerateInitialFiles(
  context: ConnectorContext,
  client: GoogleDriveClient,
): Promise<{
  files: Array<{ file: GoogleDriveFile; selectedVia: string[] }>;
  inaccessibleSelectionCount: number;
}> {
  const discovered = new Map<
    string,
    { file: GoogleDriveFile; selectedVia: Set<string> }
  >();
  let inaccessibleSelectionCount = 0;
  const add = async (candidate: GoogleDriveFile, selectedVia: string) => {
    const file = await resolveShortcut(client, candidate);
    if (file.trashed || file.mimeType === GOOGLE_FOLDER_MIME_TYPE) return;
    const existing = discovered.get(file.id);
    if (existing) {
      existing.selectedVia.add(selectedVia);
    } else {
      discovered.set(file.id, {
        file,
        selectedVia: new Set([selectedVia]),
      });
    }
  };

  for (const selection of context.selections) {
    try {
      if (selection.selectionKind === "drive") {
        let pageToken: string | null = null;
        do {
          const page = await client.listSharedDriveFiles(
            selection.externalId,
            pageToken,
          );
          for (const file of page.values) {
            await add(file, selection.externalId);
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
        continue;
      }

      const selected = await client.getFile(selection.externalId);
      if (
        selected.mimeType !== GOOGLE_FOLDER_MIME_TYPE ||
        !selection.includeDescendants
      ) {
        await add(selected, selection.externalId);
        continue;
      }
      const pendingFolders = [selected.id];
      const visitedFolders = new Set<string>();
      while (pendingFolders.length > 0) {
        const folderId = pendingFolders.shift();
        if (!folderId || visitedFolders.has(folderId)) continue;
        visitedFolders.add(folderId);
        let pageToken: string | null = null;
        do {
          const page = await client.listChildren(folderId, pageToken);
          for (const child of page.values) {
            if (child.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
              pendingFolders.push(child.id);
            } else {
              await add(child, selection.externalId);
            }
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
      }
    } catch (error) {
      if (
        selection.selectionKind !== "drive" &&
        error instanceof GoogleDriveApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        inaccessibleSelectionCount += 1;
        log.error("Google Drive selection is no longer accessible", {
          connectorId: context.connector.id,
          selectionId: selection.id,
          errorCode: sourceFailureCode(error),
        });
        continue;
      }
      throw error;
    }
  }

  return {
    files: [...discovered.values()].map(({ file, selectedVia }) => ({
      file,
      selectedVia: [...selectedVia],
    })),
    inaccessibleSelectionCount,
  };
}

async function selectedViaForFile(
  context: ConnectorContext,
  client: GoogleDriveClient,
  file: GoogleDriveFile,
): Promise<string[]> {
  const selectedVia = new Set<string>();
  const fileSelections = context.selections.filter(
    ({ selectionKind }) => selectionKind === "file",
  );
  for (const selection of fileSelections) {
    if (selection.externalId === file.id) {
      selectedVia.add(selection.externalId);
    }
  }
  for (const selection of context.selections.filter(
    ({ selectionKind }) => selectionKind === "drive",
  )) {
    if (file.driveId === selection.externalId) {
      selectedVia.add(selection.externalId);
    }
  }

  const folderSelections = new Set(
    context.selections
      .filter(
        ({ selectionKind, includeDescendants }) =>
          selectionKind === "folder" && includeDescendants,
      )
      .map(({ externalId }) => externalId),
  );
  const pendingParents = [...file.parents];
  const visited = new Set<string>();
  while (pendingParents.length > 0 && visited.size < 100) {
    const parentId = pendingParents.shift();
    if (!parentId || visited.has(parentId)) continue;
    visited.add(parentId);
    if (folderSelections.has(parentId)) selectedVia.add(parentId);
    if (selectedVia.size > 0 && fileSelections.length === 0) continue;
    try {
      const parent = await client.getFile(parentId);
      pendingParents.push(...parent.parents);
    } catch (error) {
      if (
        error instanceof GoogleDriveApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        continue;
      }
      throw error;
    }
  }
  return [...selectedVia];
}

async function markSourceMissing(
  connectorId: string,
  externalId: string,
): Promise<boolean> {
  const [updated] = await executeQuery(
    (db) =>
      db
        .update(repositoryConnectorSources)
        .set({
          status: "missing",
          missingSince: sql`COALESCE(${repositoryConnectorSources.missingSince}, NOW())`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(repositoryConnectorSources.connectorId, connectorId),
            eq(repositoryConnectorSources.externalId, externalId),
            inArray(repositoryConnectorSources.status, [
              "active",
              "unsupported",
              "failed",
            ]),
          ),
        )
        .returning({ id: repositoryConnectorSources.id }),
    "googleContent.markMissing",
  );
  return Boolean(updated);
}

async function markUnseenSourcesMissing(
  connectorId: string,
  seenIds: string[],
): Promise<number> {
  const condition =
    seenIds.length > 0
      ? and(
          eq(repositoryConnectorSources.connectorId, connectorId),
          notInArray(repositoryConnectorSources.externalId, seenIds),
          inArray(repositoryConnectorSources.status, [
            "active",
            "unsupported",
            "failed",
          ]),
        )
      : and(
          eq(repositoryConnectorSources.connectorId, connectorId),
          inArray(repositoryConnectorSources.status, [
            "active",
            "unsupported",
            "failed",
          ]),
        );
  const updated = await executeQuery(
    (db) =>
      db
        .update(repositoryConnectorSources)
        .set({
          status: "missing",
          missingSince: sql`COALESCE(${repositoryConnectorSources.missingSince}, NOW())`,
          updatedAt: new Date(),
        })
        .where(condition)
        .returning({ id: repositoryConnectorSources.id }),
    "googleContent.markUnseenMissing",
  );
  return updated.length;
}

async function applyDeletionGrace(
  connectorId: string,
  deletionGraceDays: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - deletionGraceDays * 86_400_000);
  return executeTransaction(async (tx) => {
    const expired = await tx
      .select({
        sourceId: repositoryConnectorSources.id,
        itemId: repositoryConnectorSources.repositoryItemId,
      })
      .from(repositoryConnectorSources)
      .where(
        and(
          eq(repositoryConnectorSources.connectorId, connectorId),
          inArray(repositoryConnectorSources.status, [
            "missing",
            "access_lost",
          ]),
          lte(repositoryConnectorSources.missingSince, cutoff),
        ),
      )
      .for("update");
    if (expired.length === 0) return 0;
    const now = new Date();
    await tx
      .update(repositoryConnectorSources)
      .set({ status: "deleted", removedAt: now, updatedAt: now })
      .where(
        inArray(
          repositoryConnectorSources.id,
          expired.map(({ sourceId }) => sourceId),
        ),
      );
    await tx
      .update(repositoryItems)
      .set({ lifecycleStatus: "unavailable", updatedAt: now })
      .where(
        inArray(
          repositoryItems.id,
          expired.map(({ itemId }) => itemId),
        ),
      );
    return expired.length;
  }, "googleContent.applyDeletionGrace");
}

function incrementCounter(
  counters: SyncCounters,
  outcome: ImportOutcome,
): void {
  counters[outcome] += 1;
}

function sourceFailureCode(error: unknown): string {
  return error instanceof GoogleDriveApiError
    ? `GOOGLE_DRIVE_${error.status}_${error.reason}`.slice(0, 128)
    : error instanceof Error
      ? error.name.slice(0, 128)
      : "UNKNOWN";
}

async function recordSourceFailure(
  context: ConnectorContext,
  externalId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "Unknown sync error";
  await executeQuery(
    (db) =>
      db
        .update(repositoryConnectorSources)
        .set({
          status: "failed",
          metadata: sql`${repositoryConnectorSources.metadata} || ${JSON.stringify(
            {
              lastErrorCode: sourceFailureCode(error),
              lastErrorMessage: message.slice(0, 2000),
            },
          )}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(repositoryConnectorSources.connectorId, context.connector.id),
            eq(repositoryConnectorSources.externalId, externalId),
          ),
        ),
    "googleContent.recordSourceFailure",
  );
  log.error("Google Drive source synchronization failed", {
    connectorId: context.connector.id,
    externalId,
    errorCode: sourceFailureCode(error),
    error: message,
  });
}

async function importFileIsolated(
  context: ConnectorContext,
  client: GoogleDriveClient,
  file: GoogleDriveFile,
  selectedVia: string[],
  counters: SyncCounters,
): Promise<void> {
  try {
    incrementCounter(
      counters,
      await importFile(context, client, file, selectedVia),
    );
  } catch (error) {
    if (error instanceof ConnectorRevokedError) throw error;
    if (
      error instanceof GoogleDriveApiError &&
      (error.status === 403 || error.status === 404)
    ) {
      if (await markSourceMissing(context.connector.id, file.id)) {
        counters.missing += 1;
      } else {
        counters.failed += 1;
      }
      return;
    }
    counters.failed += 1;
    await recordSourceFailure(context, file.id, error);
  }
}

async function reconcileSelectionSnapshot(
  context: ConnectorContext,
  client: GoogleDriveClient,
  counters: SyncCounters,
): Promise<void> {
  const snapshot = await enumerateInitialFiles(context, client);
  counters.discovered += snapshot.files.length;
  counters.failed += snapshot.inaccessibleSelectionCount;
  for (const { file, selectedVia } of snapshot.files) {
    await importFileIsolated(context, client, file, selectedVia, counters);
  }
  counters.missing += await markUnseenSourcesMissing(
    context.connector.id,
    snapshot.files.map(({ file }) => file.id),
  );
}

async function reconcileInitial(
  context: ConnectorContext,
  client: GoogleDriveClient,
  counters: SyncCounters,
): Promise<string> {
  const startPageToken = await client.getStartPageToken(
    context.connector.sharedDriveId,
  );
  await reconcileSelectionSnapshot(context, client, counters);
  return startPageToken;
}

async function retryDeferredDownloads(
  context: ConnectorContext,
  client: GoogleDriveClient,
  counters: SyncCounters,
): Promise<void> {
  for (const source of context.sources) {
    if (
      !source.metadata.pendingDownloadOperation &&
      source.status !== "failed"
    ) {
      continue;
    }
    try {
      const file = await client.getFile(source.externalId);
      await importFileIsolated(
        context,
        client,
        file,
        source.metadata.selectedVia ?? [],
        counters,
      );
    } catch (error) {
      if (error instanceof ConnectorRevokedError) throw error;
      if (
        error instanceof GoogleDriveApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        if (await markSourceMissing(context.connector.id, source.externalId)) {
          counters.missing += 1;
        } else {
          counters.failed += 1;
        }
        continue;
      }
      counters.failed += 1;
      await recordSourceFailure(context, source.externalId, error);
    }
  }
}

async function reconcileChanges(
  context: ConnectorContext,
  client: GoogleDriveClient,
  initialCursor: string,
  counters: SyncCounters,
): Promise<string> {
  let cursor = initialCursor;
  let requiresSelectionSnapshot = false;
  for (;;) {
    const page = await client.listChanges(
      cursor,
      context.connector.sharedDriveId,
    );
    for (const change of page.values) {
      counters.discovered += 1;
      if (change.removed || !change.file || change.file.trashed) {
        if (await markSourceMissing(context.connector.id, change.fileId)) {
          counters.missing += 1;
        }
        continue;
      }
      try {
        const file = await resolveShortcut(client, change.file);
        if (file.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
          // A folder move may add or remove an entire subtree without emitting
          // a child change for every descendant. Rebuild selection membership
          // after the cursor page is durable.
          requiresSelectionSnapshot = true;
          continue;
        }
        const selectedVia = await selectedViaForFile(context, client, file);
        if (selectedVia.length === 0) {
          if (await markSourceMissing(context.connector.id, file.id)) {
            counters.missing += 1;
          }
          continue;
        }
        await importFileIsolated(context, client, file, selectedVia, counters);
      } catch (error) {
        if (error instanceof ConnectorRevokedError) throw error;
        if (
          error instanceof GoogleDriveApiError &&
          (error.status === 403 || error.status === 404)
        ) {
          if (await markSourceMissing(context.connector.id, change.fileId)) {
            counters.missing += 1;
          } else {
            counters.failed += 1;
          }
          continue;
        }
        throw error;
      }
    }
    cursor = page.nextPageToken ?? page.newStartPageToken ?? cursor;
    if (!requiresSelectionSnapshot) {
      await executeQuery(
        (db) =>
          db
            .update(repositoryConnectors)
            .set({ cursor, updatedAt: new Date() })
            .where(eq(repositoryConnectors.id, context.connector.id)),
        "googleContent.persistCursor",
      );
    }
    if (!page.nextPageToken) break;
  }
  if (requiresSelectionSnapshot) {
    await reconcileSelectionSnapshot(context, client, counters);
    await executeQuery(
      (db) =>
        db
          .update(repositoryConnectors)
          .set({ cursor, updatedAt: new Date() })
          .where(eq(repositoryConnectors.id, context.connector.id)),
      "googleContent.persistSnapshotCursor",
    );
  }
  return cursor;
}

async function markConnectorAccessLost(connectorId: string): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(repositoryConnectorSources)
        .set({
          status: "access_lost",
          missingSince: sql`COALESCE(${repositoryConnectorSources.missingSince}, NOW())`,
          updatedAt: new Date(),
        })
        .where(eq(repositoryConnectorSources.connectorId, connectorId)),
    "googleContent.markConnectorAccessLost",
  );
}

async function renewWatch(
  context: ConnectorContext,
  client: GoogleDriveClient,
  cursor: string,
): Promise<void> {
  if (!appBaseUrl) return;
  if (
    context.connector.watchExpiresAt &&
    context.connector.watchExpiresAt.getTime() >
      Date.now() + WATCH_RENEWAL_WINDOW_MS
  ) {
    return;
  }
  const channelId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const requestedExpiry = new Date(Date.now() + WATCH_LIFETIME_MS);
  const watch = await client.watchChanges({
    pageToken: cursor,
    channelId,
    channelToken: token,
    callbackUrl: `${appBaseUrl}/api/repositories/connectors/google/webhook`,
    expiresAt: requestedExpiry,
    driveId: context.connector.sharedDriveId,
  });
  const oldChannelId = context.connector.watchChannelId;
  const oldResourceId = context.connector.watchResourceId;
  await executeQuery(
    (db) =>
      db
        .update(repositoryConnectors)
        .set({
          watchChannelId: watch.channelId,
          watchResourceId: watch.resourceId,
          watchTokenHash: createHash("sha256").update(token).digest("hex"),
          watchExpiresAt: watch.expiresAt ?? requestedExpiry,
          lastNotificationNumber: null,
          updatedAt: new Date(),
        })
        .where(eq(repositoryConnectors.id, context.connector.id)),
    "googleContent.renewWatch",
  );
  if (oldChannelId && oldResourceId) {
    await client
      .stopWatch({ channelId: oldChannelId, resourceId: oldResourceId })
      .catch(() => {});
  }
}

async function completeSync(input: {
  connector: RepositoryConnectorRow;
  runId: string;
  cursor: string;
  counters: SyncCounters;
  config: ContentPlatformConfig;
}): Promise<void> {
  const now = new Date();
  const nextMinutes =
    input.counters.deferred > 0
      ? 1
      : Math.max(
          5,
          input.connector.syncIntervalMinutes ||
            input.config.googleSyncIntervalMinutes,
        );
  await executeTransaction(async (tx) => {
    await tx
      .update(repositoryConnectorSyncRuns)
      .set({
        status: "succeeded",
        cursorAfter: input.cursor,
        discoveredCount: input.counters.discovered,
        createdCount: input.counters.created,
        updatedCount: input.counters.updated,
        unchangedCount: input.counters.unchanged,
        missingCount: input.counters.missing,
        failedCount: input.counters.failed,
        finishedAt: now,
      })
      .where(eq(repositoryConnectorSyncRuns.id, input.runId));
    await tx
      .update(repositoryConnectors)
      .set({
        status: input.counters.failed > 0 ? "degraded" : "active",
        cursor: input.cursor,
        lastSuccessAt: now,
        lastErrorCode: input.counters.failed > 0 ? "SOURCE_FAILURES" : null,
        lastErrorMessage:
          input.counters.failed > 0
            ? `${input.counters.failed} Google Drive source(s) failed; successful sources were synchronized`
            : null,
        consecutiveFailures: 0,
        nextSyncAt: new Date(now.getTime() + nextMinutes * 60_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(repositoryConnectors.id, input.connector.id),
          ne(repositoryConnectors.status, "revoked"),
        ),
      );
  }, "googleContent.completeSync");
}

async function abandonClaimedSync(
  runId: string,
  code: string,
  message: string,
): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(repositoryConnectorSyncRuns)
        .set({
          status: "failed",
          failedCount: 1,
          errorCode: code,
          errorMessage: message,
          finishedAt: new Date(),
        })
        .where(eq(repositoryConnectorSyncRuns.id, runId)),
    "googleContent.abandonClaimedSync",
  );
}

async function failSync(
  connectorId: string,
  runId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "Unknown sync error";
  const code =
    error instanceof GoogleDriveApiError
      ? `GOOGLE_DRIVE_${error.status}_${error.reason}`.slice(0, 128)
      : error instanceof Error
        ? error.name.slice(0, 128)
        : "UNKNOWN";
  await executeTransaction(async (tx) => {
    const [connector] = await tx
      .select({ consecutiveFailures: repositoryConnectors.consecutiveFailures })
      .from(repositoryConnectors)
      .where(eq(repositoryConnectors.id, connectorId))
      .limit(1)
      .for("update");
    const failures = (connector?.consecutiveFailures ?? 0) + 1;
    const retryMinutes = Math.min(
      360,
      DEFAULT_RETRY_MINUTES * 2 ** Math.min(failures - 1, 6),
    );
    const now = new Date();
    await tx
      .update(repositoryConnectorSyncRuns)
      .set({
        status: "failed",
        failedCount: 1,
        errorCode: code,
        errorMessage: message.slice(0, 2000),
        finishedAt: now,
      })
      .where(eq(repositoryConnectorSyncRuns.id, runId));
    await tx
      .update(repositoryConnectors)
      .set({
        status: "degraded",
        lastErrorCode: code,
        lastErrorMessage: message.slice(0, 2000),
        consecutiveFailures: failures,
        nextSyncAt: new Date(now.getTime() + retryMinutes * 60_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(repositoryConnectors.id, connectorId),
          ne(repositoryConnectors.status, "revoked"),
        ),
      );
  }, "googleContent.failSync");
}

async function synchronize(
  message: SyncMessage,
  traceId: string,
): Promise<void> {
  const runId = await claimSync(message.connectorId, message.trigger, traceId);
  if (!runId) return;
  try {
    const config = await getContentPlatformConfig();
    if (!config.enabled || !config.googleSyncEnabled) {
      throw new Error("Google Workspace synchronization is disabled");
    }
    const context = await loadConnectorContext(message.connectorId);
    if (!context) {
      await abandonClaimedSync(
        runId,
        "CONNECTOR_REVOKED",
        "Connector was revoked before synchronization started",
      );
      return;
    }
    if (context.selections.length === 0) {
      throw new Error("Google Drive connector has no active selections");
    }
    const client = new GoogleDriveClient(await accessTokenFor(context));
    const counters: SyncCounters = {
      discovered: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      missing: 0,
      failed: 0,
      deferred: 0,
    };
    await retryDeferredDownloads(context, client, counters);
    let cursor: string;
    if (context.connector.cursor) {
      try {
        cursor = await reconcileChanges(
          context,
          client,
          context.connector.cursor,
          counters,
        );
      } catch (error) {
        if (!(error instanceof GoogleDriveApiError) || error.status !== 410) {
          throw error;
        }
        log.info("Google Drive cursor expired; rebuilding selection snapshot", {
          connectorId: context.connector.id,
          runId,
        });
        cursor = await reconcileInitial(context, client, counters);
      }
    } else {
      cursor = await reconcileInitial(context, client, counters);
    }
    await applyDeletionGrace(context.connector.id, config.deletionGraceDays);
    await renewWatch(context, client, cursor);
    await completeSync({
      connector: context.connector,
      runId,
      cursor,
      counters,
      config,
    });
    log.info("Google Drive synchronization completed", {
      connectorId: context.connector.id,
      runId,
      traceId,
      ...counters,
    });
  } catch (error) {
    if (error instanceof ConnectorRevokedError) {
      await abandonClaimedSync(runId, "CONNECTOR_REVOKED", error.message);
      log.info("Google Drive synchronization stopped after revocation", {
        connectorId: message.connectorId,
        runId,
        traceId,
      });
      return;
    }
    if (
      error instanceof GoogleDriveApiError &&
      (error.status === 403 || error.status === 404)
    ) {
      await markConnectorAccessLost(message.connectorId);
      const config = await getContentPlatformConfig();
      await applyDeletionGrace(message.connectorId, config.deletionGraceDays);
    }
    await failSync(message.connectorId, runId, error);
    log.error("Google Drive synchronization failed", {
      connectorId: message.connectorId,
      runId,
      traceId,
      error: error instanceof Error ? error.message : "unknown",
    });
    throw error;
  }
}

async function dueConnectors(): Promise<string[]> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ id: repositoryConnectors.id })
        .from(repositoryConnectors)
        .where(
          and(
            inArray(repositoryConnectors.status, [
              "pending",
              "active",
              "degraded",
            ]),
            lte(repositoryConnectors.nextSyncAt, new Date()),
          ),
        )
        .orderBy(asc(repositoryConnectors.nextSyncAt))
        .limit(MAX_SCHEDULED_CONNECTORS),
    "googleContent.listDueConnectors",
  );
  return rows.map(({ id }) => id);
}

function isSqsEvent(
  event: SQSEvent | EventBridgeEvent<string, unknown>,
): event is SQSEvent {
  return "Records" in event && Array.isArray(event.Records);
}

export async function handler(
  event: SQSEvent | EventBridgeEvent<string, unknown>,
  context: Context,
): Promise<SQSBatchResponse | void> {
  await ensureDatabaseCredentials();
  if (!isSqsEvent(event)) {
    const connectorIds = await dueConnectors();
    await Promise.allSettled(
      connectorIds.map((connectorId) =>
        synchronize(
          { connectorId, trigger: "schedule" },
          `${context.awsRequestId}:${connectorId}`,
        ),
      ),
    );
    return;
  }

  const failures: SQSBatchItemFailure[] = [];
  for (const record of event.Records) {
    try {
      await synchronize(
        parseMessage(record),
        `${context.awsRequestId}:${record.messageId}`,
      );
    } catch {
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
