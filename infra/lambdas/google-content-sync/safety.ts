import { createHash } from "node:crypto";
import { Transform } from "node:stream";

const BYTES_PER_GIBIBYTE = 1024 ** 3;

/**
 * Snapshot traversal is intentionally finite. A later scale workstream may
 * replace these limits with durable, page-level continuation state.
 */
export const MAX_GOOGLE_SNAPSHOT_FILES = 10_000;
export const MAX_GOOGLE_SNAPSHOT_FOLDERS = 10_000;

export class GoogleDriveSourceTooLargeError extends Error {
  constructor(maximumBytes: number) {
    super(
      `Google Drive source exceeds the configured ${maximumBytes}-byte limit`,
    );
    this.name = "GOOGLE_DRIVE_SOURCE_SIZE_LIMIT_EXCEEDED";
  }
}

export class GoogleDriveSnapshotLimitError extends Error {
  constructor(kind: "files" | "folders", limit: number) {
    super(`Google Drive snapshot exceeds the ${limit}-${kind} work limit`);
    this.name = "GOOGLE_DRIVE_SNAPSHOT_LIMIT_EXCEEDED";
  }
}

export function maximumGoogleSourceBytes(maxFileSizeGb: number): number {
  if (
    !Number.isSafeInteger(maxFileSizeGb) ||
    maxFileSizeGb <= 0 ||
    maxFileSizeGb > Number.MAX_SAFE_INTEGER / BYTES_PER_GIBIBYTE
  ) {
    throw new Error("Google Drive source size limit is invalid");
  }
  return maxFileSizeGb * BYTES_PER_GIBIBYTE;
}

function assertSizeWithinLimit(
  size: string | null | undefined,
  maximumBytes: number,
): void {
  if (!size || !/^\d+$/.test(size)) return;
  if (BigInt(size) > BigInt(maximumBytes)) {
    throw new GoogleDriveSourceTooLargeError(maximumBytes);
  }
}

export function assertGoogleSourceMetadataSize(
  size: string | null | undefined,
  maximumBytes: number,
): void {
  assertSizeWithinLimit(size, maximumBytes);
}

export function assertGoogleSourceResponseSize(
  response: Response,
  maximumBytes: number,
): void {
  assertSizeWithinLimit(response.headers.get("content-length"), maximumBytes);
}

export interface BoundedHashingStream {
  stream: Transform;
  getByteSize(): number;
  digestSha256(): string;
}

/**
 * Enforce the source limit while bytes are in flight. Metadata and
 * Content-Length are useful early exits, but neither is authoritative for all
 * Drive exports.
 */
export function createBoundedHashingStream(
  maximumBytes: number,
): BoundedHashingStream {
  let byteSize = 0;
  let digested = false;
  const hash = createHash("sha256");
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const nextByteSize = byteSize + chunk.length;
      if (nextByteSize > maximumBytes) {
        callback(new GoogleDriveSourceTooLargeError(maximumBytes));
        return;
      }
      byteSize = nextByteSize;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return {
    stream,
    getByteSize: () => byteSize,
    digestSha256: () => {
      if (digested) {
        throw new Error("Google Drive source digest was already consumed");
      }
      digested = true;
      return hash.digest("hex");
    },
  };
}

export class GoogleDriveSnapshotBudget {
  private readonly files = new Set<string>();
  private folderVisits = 0;

  recordFile(fileId: string): void {
    if (this.files.has(fileId)) return;
    if (this.files.size >= MAX_GOOGLE_SNAPSHOT_FILES) {
      throw new GoogleDriveSnapshotLimitError(
        "files",
        MAX_GOOGLE_SNAPSHOT_FILES,
      );
    }
    this.files.add(fileId);
  }

  recordFolderVisit(): void {
    if (this.folderVisits >= MAX_GOOGLE_SNAPSHOT_FOLDERS) {
      throw new GoogleDriveSnapshotLimitError(
        "folders",
        MAX_GOOGLE_SNAPSHOT_FOLDERS,
      );
    }
    this.folderVisits += 1;
  }
}
