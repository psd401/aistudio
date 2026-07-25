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

const driveUserSchema = z.object({ displayName: z.string().optional() });
const shortcutDetailsSchema = z.object({
  targetId: z.string(),
  targetMimeType: z.string(),
  targetResourceKey: z.string().optional(),
});

export const googleDriveFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  parents: z.array(z.string()).optional().default([]),
  driveId: z.string().optional(),
  modifiedTime: z.string().datetime({ offset: true }).optional(),
  md5Checksum: z.string().optional(),
  version: z.string().optional(),
  headRevisionId: z.string().optional(),
  size: z.string().regex(/^\d+$/).optional(),
  trashed: z.boolean().optional().default(false),
  webViewLink: z.string().url().optional(),
  iconLink: z.string().url().optional(),
  owners: z.array(driveUserSchema).optional().default([]),
  shortcutDetails: shortcutDetailsSchema.optional(),
});

export type GoogleDriveFile = z.infer<typeof googleDriveFileSchema>;

const filesListSchema = z.object({
  nextPageToken: z.string().optional(),
  files: z.array(googleDriveFileSchema).default([]),
});

const driveChangeSchema = z.object({
  fileId: z.string(),
  removed: z.boolean().optional().default(false),
  time: z.string().datetime({ offset: true }).optional(),
  driveId: z.string().optional(),
  file: googleDriveFileSchema.optional(),
});

const changesListSchema = z.object({
  nextPageToken: z.string().optional(),
  newStartPageToken: z.string().optional(),
  changes: z.array(driveChangeSchema).default([]),
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

export interface GoogleDriveListPage<T> {
  values: T[];
  nextPageToken: string | null;
}

export interface GoogleDriveChangesPage extends GoogleDriveListPage<GoogleDriveChange> {
  newStartPageToken: string | null;
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
    return googleDriveFileSchema.parse(await response.json());
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
    return {
      values: page.files,
      nextPageToken: page.nextPageToken ?? null,
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
    return {
      values: page.files,
      nextPageToken: page.nextPageToken ?? null,
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
      `nextPageToken,newStartPageToken,changes(fileId,removed,time,driveId,file(${FILE_FIELDS}))`,
    );
    if (driveId) {
      url.searchParams.set("driveId", driveId);
      url.searchParams.set("includeCorpusRemovals", "true");
    }
    const response = await this.request(url);
    const page = changesListSchema.parse(await response.json());
    return {
      values: page.changes,
      nextPageToken: page.nextPageToken ?? null,
      newStartPageToken: page.newStartPageToken ?? null,
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
