import { z } from "zod";
import {
  GOOGLE_FOLDER_MIME_TYPE,
  GOOGLE_VIDS_MIME_TYPE,
  type GoogleDriveExportFormat,
} from "./formats";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const FILE_FIELDS = [
  "id",
  "name",
  "mimeType",
  "parents",
  "driveId",
  "modifiedTime",
  "md5Checksum",
  "version",
  "headRevisionId",
  "size",
  "trashed",
  "webViewLink",
  "iconLink",
  "owners(displayName)",
  "shortcutDetails(targetId,targetMimeType,targetResourceKey)",
].join(",");

/**
 * Google omits absent fields far more often than it nulls them, but an
 * explicit `null` must never fail a whole page. `nullish` + a normalizing
 * transform keeps the parsed shape identical to the previous `optional()`
 * output while tolerating both encodings.
 */
const optionalString = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined)
  .optional();

/**
 * Link fields are stored as source metadata and are candidates for rendering
 * as an href. They are deliberately NOT validated with a strict URL parser —
 * a link Google formats unexpectedly must not stall the connector — but a
 * non-http(s) scheme (`javascript:`, `data:`) is dropped rather than
 * persisted, so loosening the validator cannot open an injection path.
 */
const optionalWebUrl = z
  .string()
  .nullish()
  .transform((value) =>
    value && /^https?:\/\//i.test(value) ? value : undefined,
  )
  .optional();

/**
 * Timestamps are consumed with `new Date(...)` and land in a `timestamp`
 * column. Neither extreme is safe on its own: a strict `.datetime()` would
 * turn one malformed value into a rejected entry (the poison-page class this
 * client exists to prevent), while passing an unparseable string straight
 * through is worse than dropping it — `new Date("not-a-date")` is an Invalid
 * Date, the import transaction fails on the timestamp column, and because the
 * entry *validated* the snapshot never counts it as skipped. The cursor
 * advances, the unseen-source sweep is not suppressed, and the file stays
 * unimported indefinitely. So: accept anything Google sends, keep only what
 * actually parses, and let the field fall back to its absent behaviour.
 */
const optionalTimestamp = z
  .string()
  .nullish()
  .transform((value) =>
    value && !Number.isNaN(Date.parse(value)) ? value : undefined,
  )
  .optional();

const optionalBoolean = (fallback: boolean) =>
  z
    .boolean()
    .nullish()
    .transform((value) => value ?? fallback);

const driveUserSchema = z.object({ displayName: optionalString });

/**
 * Only `targetId` is consumed. `resolveShortcut` dereferences it and, when it
 * is absent, throws a typed {@link GoogleDriveUnreadableFileError} that both
 * of its call sites already classify as a per-entry skip — making the field
 * optional here therefore costs one entry, never the page. `targetMimeType` has no
 * reader anywhere in the codebase, so requiring it could only ever turn a
 * complete page into a poison message — it is optional and unused.
 */
const shortcutDetailsSchema = z.object({
  targetId: optionalString,
  targetMimeType: optionalString,
  targetResourceKey: optionalString,
});

export const googleDriveFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  parents: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
  driveId: optionalString,
  // Lenient, but not blindly so: an unparseable value is dropped rather than
  // handed to `new Date(...)` on the way into a timestamp column. See
  // `optionalTimestamp`.
  modifiedTime: optionalTimestamp,
  md5Checksum: optionalString,
  version: optionalString,
  headRevisionId: optionalString,
  // The numeric shape is re-checked by `assertGoogleSourceMetadataSize`, and
  // the streaming byte bound is authoritative regardless of what Drive
  // reports here.
  size: optionalString,
  trashed: optionalBoolean(false),
  webViewLink: optionalWebUrl,
  iconLink: optionalWebUrl,
  owners: z
    .array(driveUserSchema)
    .nullish()
    .transform((value) => value ?? []),
  shortcutDetails: shortcutDetailsSchema.nullish(),
});

export type GoogleDriveFile = z.infer<typeof googleDriveFileSchema>;

/**
 * List envelopes are parsed with UNVALIDATED entries so a single malformed
 * member cannot reject the page. Each entry is validated on its own by
 * {@link parseDriveEntries}.
 */
const rawEntriesSchema = z
  .array(z.unknown())
  .nullish()
  .transform((value) => value ?? []);

const filesListSchema = z.object({
  nextPageToken: optionalString,
  files: rawEntriesSchema,
});

/**
 * Google's Changes feed is not exclusively file-scoped. Entries with
 * `changeType: "drive"` describe the Shared Drive itself (rename, membership,
 * restriction changes) and carry NO `fileId`. Requiring `fileId` here made
 * every such entry a poison message: `listChanges` threw before the cursor
 * advanced, so the Lambda retried the same page forever.
 *
 * `changeType` is deliberately a plain string rather than an enum — a new
 * value Google adds later must not re-poison the queue.
 */
const driveChangeSchema = z.object({
  changeType: optionalString,
  fileId: optionalString,
  removed: optionalBoolean(false),
  time: optionalString,
  driveId: optionalString,
  file: googleDriveFileSchema.nullish(),
});

const changesListSchema = z.object({
  nextPageToken: optionalString,
  newStartPageToken: optionalString,
  changes: rawEntriesSchema,
});

const startPageTokenSchema = z.object({ startPageToken: z.string() });
const watchChannelSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  expiration: z.string().regex(/^\d+$/).optional(),
});
const downloadOperationSchema = z.object({
  name: z.string(),
  done: z.boolean().optional().default(false),
  error: z
    .object({
      code: z.number().optional(),
      message: z.string().optional(),
    })
    .optional(),
  response: z
    .object({
      downloadUri: z.string().url(),
      partialDownloadAllowed: z.boolean().optional(),
    })
    .optional(),
});

export type GoogleDriveChange = z.infer<typeof driveChangeSchema>;

/**
 * A single list entry Google returned that this client could not validate.
 *
 * The entry is DROPPED, never reinterpreted: a parse failure says nothing
 * about whether the underlying Drive file still exists, so treating it as a
 * removal would trade a stalled connector for silent data loss. The cost of
 * dropping it is that the file's latest change is missed until it changes
 * again (or a selection snapshot re-enumerates it) — which is why every
 * skipped entry is reported to the caller for logging.
 */
export interface GoogleDriveSkippedEntry {
  /** Position within the page, so repeat offenders are identifiable. */
  index: number;
  /** `id` / `fileId` / `file.id` when one of them was extractable. */
  id: string | null;
  issues: Array<{ path: string; message: string }>;
}

export interface GoogleDriveListPage<T> {
  values: T[];
  nextPageToken: string | null;
  /** Entries dropped by per-entry validation. Empty on a healthy page. */
  skippedEntries: GoogleDriveSkippedEntry[];
}

export interface GoogleDriveChangesPage extends GoogleDriveListPage<GoogleDriveChange> {
  newStartPageToken: string | null;
}

function extractEntryId(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  if (typeof record.fileId === "string") return record.fileId;
  const file = record.file;
  if (typeof file === "object" && file !== null) {
    const nested = (file as Record<string, unknown>).id;
    if (typeof nested === "string") return nested;
  }
  return null;
}

function formatEntryIssues(
  error: z.ZodError,
): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * Validate list entries one at a time. One malformed member of a 1000-entry
 * page costs that one entry, not the page — and therefore not the cursor.
 */
function parseDriveEntries<T>(
  schema: z.ZodType<T>,
  entries: readonly unknown[],
): { values: T[]; skippedEntries: GoogleDriveSkippedEntry[] } {
  const values: T[] = [];
  const skippedEntries: GoogleDriveSkippedEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const result = schema.safeParse(entry);
    if (result.success) {
      values.push(result.data);
      continue;
    }
    skippedEntries.push({
      index,
      id: extractEntryId(entry),
      issues: formatEntryIssues(result.error),
    });
  }
  return { values, skippedEntries };
}

export interface GoogleDriveWatch {
  channelId: string;
  resourceId: string;
  expiresAt: Date | null;
}

export interface GoogleDriveDownload {
  response: Response;
  operationName: string | null;
}

export class GoogleDriveApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reason: string,
  ) {
    super(message);
    this.name = "GoogleDriveApiError";
  }
}

export class GoogleDriveDownloadPendingError extends Error {
  constructor(public readonly operationName: string) {
    super("Google Drive download is still preparing");
    this.name = "GoogleDriveDownloadPendingError";
  }
}

/**
 * `getFile` returned 200 but the body failed validation — the single-entity
 * sibling of a dropped list entry.
 *
 * Distinct from {@link GoogleDriveApiError} because the correct handling is
 * the opposite of a 403/404: the file very likely still exists, so callers
 * must fail or skip the one record — never mark its source missing, and never
 * let the error escape far enough to stall a change page's cursor.
 */
export class GoogleDriveUnreadableFileError extends Error {
  constructor(
    public readonly fileId: string,
    public readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(`Google Drive returned an unreadable record for file ${fileId}`);
    this.name = "GoogleDriveUnreadableFileError";
  }
}

export interface GoogleDriveClientOptions {
  fetch?: typeof fetch;
}

export class GoogleDriveClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly accessToken: string,
    options: GoogleDriveClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request(
    url: URL | string,
    init: RequestInit = {},
  ): Promise<Response> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(init.headers ?? {}),
      },
    });
    if (response.ok) return response;

    let reason = "google_drive_error";
    let message = `Google Drive request failed (${response.status})`;
    try {
      const payload = z
        .object({
          error: z
            .object({
              message: z.string().optional(),
              errors: z
                .array(z.object({ reason: z.string().optional() }))
                .optional(),
            })
            .optional(),
        })
        .parse(await response.json());
      message = payload.error?.message ?? message;
      reason = payload.error?.errors?.[0]?.reason ?? reason;
    } catch {
      // Google occasionally returns an empty/non-JSON body for transport errors.
    }
    throw new GoogleDriveApiError(message, response.status, reason);
  }

  async getFile(
    fileId: string,
    resourceKey?: string,
  ): Promise<GoogleDriveFile> {
    const url = new URL(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", FILE_FIELDS);
    const response = await this.request(
      url,
      resourceKey
        ? {
            headers: {
              "X-Goog-Drive-Resource-Keys": `${fileId}/${resourceKey}`,
            },
          }
        : undefined,
    );
    const parsed = googleDriveFileSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new GoogleDriveUnreadableFileError(
        fileId,
        formatEntryIssues(parsed.error),
      );
    }
    return parsed.data;
  }

  async listChildren(
    folderId: string,
    pageToken?: string | null,
  ): Promise<GoogleDriveListPage<GoogleDriveFile>> {
    const url = new URL(`${DRIVE_API_BASE}/files`);
    url.searchParams.set(
      "q",
      `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`,
    );
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await this.request(url);
    const page = filesListSchema.parse(await response.json());
    const parsed = parseDriveEntries(googleDriveFileSchema, page.files);
    return {
      values: parsed.values,
      nextPageToken: page.nextPageToken ?? null,
      skippedEntries: parsed.skippedEntries,
    };
  }

  async listSharedDriveFiles(
    driveId: string,
    pageToken?: string | null,
  ): Promise<GoogleDriveListPage<GoogleDriveFile>> {
    const url = new URL(`${DRIVE_API_BASE}/files`);
    url.searchParams.set("corpora", "drive");
    url.searchParams.set("driveId", driveId);
    url.searchParams.set("q", "trashed = false");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await this.request(url);
    const page = filesListSchema.parse(await response.json());
    const parsed = parseDriveEntries(googleDriveFileSchema, page.files);
    return {
      values: parsed.values,
      nextPageToken: page.nextPageToken ?? null,
      skippedEntries: parsed.skippedEntries,
    };
  }

  async getStartPageToken(driveId?: string | null): Promise<string> {
    const url = new URL(`${DRIVE_API_BASE}/changes/startPageToken`);
    url.searchParams.set("supportsAllDrives", "true");
    if (driveId) url.searchParams.set("driveId", driveId);
    const response = await this.request(url);
    return startPageTokenSchema.parse(await response.json()).startPageToken;
  }

  async listChanges(
    pageToken: string,
    driveId?: string | null,
  ): Promise<GoogleDriveChangesPage> {
    const url = new URL(`${DRIVE_API_BASE}/changes`);
    url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set(
      "fields",
      `nextPageToken,newStartPageToken,changes(changeType,fileId,removed,time,driveId,file(${FILE_FIELDS}))`,
    );
    if (driveId) {
      url.searchParams.set("driveId", driveId);
      url.searchParams.set("includeCorpusRemovals", "true");
    }
    const response = await this.request(url);
    const page = changesListSchema.parse(await response.json());
    const parsed = parseDriveEntries(driveChangeSchema, page.changes);
    return {
      values: parsed.values,
      nextPageToken: page.nextPageToken ?? null,
      newStartPageToken: page.newStartPageToken ?? null,
      skippedEntries: parsed.skippedEntries,
    };
  }

  async watchChanges(input: {
    pageToken: string;
    channelId: string;
    channelToken: string;
    callbackUrl: string;
    expiresAt: Date;
    driveId?: string | null;
  }): Promise<GoogleDriveWatch> {
    const url = new URL(`${DRIVE_API_BASE}/changes/watch`);
    url.searchParams.set("pageToken", input.pageToken);
    url.searchParams.set("supportsAllDrives", "true");
    if (input.driveId) url.searchParams.set("driveId", input.driveId);
    const response = await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: input.channelId,
        type: "web_hook",
        address: input.callbackUrl,
        token: input.channelToken,
        expiration: input.expiresAt.getTime().toString(),
      }),
    });
    const channel = watchChannelSchema.parse(await response.json());
    return {
      channelId: channel.id,
      resourceId: channel.resourceId,
      expiresAt: channel.expiration
        ? new Date(Number(channel.expiration))
        : null,
    };
  }

  async stopWatch(input: {
    channelId: string;
    resourceId: string;
  }): Promise<void> {
    await this.request(`${DRIVE_API_BASE}/channels/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: input.channelId,
        resourceId: input.resourceId,
      }),
    });
  }

  async downloadFile(
    file: GoogleDriveFile,
    format: GoogleDriveExportFormat,
    operationName?: string | null,
  ): Promise<GoogleDriveDownload> {
    if (format.method === "blob") {
      const url = new URL(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}`,
      );
      url.searchParams.set("alt", "media");
      url.searchParams.set("supportsAllDrives", "true");
      return { response: await this.request(url), operationName: null };
    }

    if (format.method === "export" && file.mimeType !== GOOGLE_VIDS_MIME_TYPE) {
      const url = new URL(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}/export`,
      );
      url.searchParams.set("mimeType", format.contentType);
      return { response: await this.request(url), operationName: null };
    }

    const operation = operationName
      ? await this.getDownloadOperation(operationName)
      : await this.startDownloadOperation(file.id, format.contentType);
    if (operation.error) {
      throw new GoogleDriveApiError(
        operation.error.message ?? "Google Drive download operation failed",
        operation.error.code ?? 500,
        "download_operation_failed",
      );
    }
    if (!operation.done || !operation.response?.downloadUri) {
      throw new GoogleDriveDownloadPendingError(operation.name);
    }
    return {
      response: await this.request(operation.response.downloadUri),
      operationName: operation.name,
    };
  }

  private async startDownloadOperation(
    fileId: string,
    contentType: string,
  ): Promise<z.infer<typeof downloadOperationSchema>> {
    const url = new URL(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/download`,
    );
    url.searchParams.set("mimeType", contentType);
    const response = await this.request(url, { method: "POST" });
    return downloadOperationSchema.parse(await response.json());
  }

  private async getDownloadOperation(
    operationName: string,
  ): Promise<z.infer<typeof downloadOperationSchema>> {
    const operationId = operationName.replace(/^operations\//, "");
    const response = await this.request(
      `${DRIVE_API_BASE}/operations/${encodeURIComponent(operationId)}`,
    );
    return downloadOperationSchema.parse(await response.json());
  }

  static isFolder(file: GoogleDriveFile): boolean {
    return file.mimeType === GOOGLE_FOLDER_MIME_TYPE;
  }
}
