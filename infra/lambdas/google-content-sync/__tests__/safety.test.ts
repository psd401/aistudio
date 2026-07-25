import { Readable } from "node:stream";
import {
  assertGoogleSourceMetadataSize,
  assertGoogleSourceResponseSize,
  createBoundedHashingStream,
  GoogleDriveSnapshotBudget,
  GoogleDriveSnapshotLimitError,
  GoogleDriveSourceTooLargeError,
  maximumGoogleSourceBytes,
  MAX_GOOGLE_SNAPSHOT_FILES,
  MAX_GOOGLE_SNAPSHOT_FOLDERS,
} from "../safety";

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe("Google content synchronization safety", () => {
  test("converts the configured GiB limit exactly", () => {
    expect(maximumGoogleSourceBytes(10)).toBe(10 * 1024 ** 3);
    expect(() => maximumGoogleSourceBytes(0)).toThrow("limit is invalid");
  });

  test("rejects oversized metadata and response lengths before upload", () => {
    expect(() => assertGoogleSourceMetadataSize("101", 100)).toThrow(
      GoogleDriveSourceTooLargeError,
    );
    const response = {
      headers: new Headers({ "content-length": "101" }),
    } as Response;
    expect(() => assertGoogleSourceResponseSize(response, 100)).toThrow(
      GoogleDriveSourceTooLargeError,
    );
  });

  test("enforces the limit while streaming and hashes accepted bytes", async () => {
    const accepted = createBoundedHashingStream(6);
    await expect(
      drain(
        Readable.from([Buffer.from("abc"), Buffer.from("def")]).pipe(
          accepted.stream,
        ),
      ),
    ).resolves.toEqual(Buffer.from("abcdef"));
    expect(accepted.getByteSize()).toBe(6);
    expect(accepted.digestSha256()).toBe(
      "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
    );

    const rejected = createBoundedHashingStream(5);
    await expect(
      drain(
        Readable.from([Buffer.from("abc"), Buffer.from("def")]).pipe(
          rejected.stream,
        ),
      ),
    ).rejects.toThrow(GoogleDriveSourceTooLargeError);
  });

  test("caps aggregate snapshot file and folder work", () => {
    const files = new GoogleDriveSnapshotBudget();
    for (let index = 0; index < MAX_GOOGLE_SNAPSHOT_FILES; index += 1) {
      files.recordFile(`file-${index}`);
    }
    files.recordFile("file-0");
    expect(() => files.recordFile("file-over-limit")).toThrow(
      GoogleDriveSnapshotLimitError,
    );

    const folders = new GoogleDriveSnapshotBudget();
    for (let index = 0; index < MAX_GOOGLE_SNAPSHOT_FOLDERS; index += 1) {
      folders.recordFolderVisit();
    }
    expect(() => folders.recordFolderVisit()).toThrow(
      GoogleDriveSnapshotLimitError,
    );
  });
});
