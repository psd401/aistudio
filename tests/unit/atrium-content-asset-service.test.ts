/** @jest-environment node */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const mockExecuteQuery = jest.fn();
const mockExecuteTransaction = jest.fn();
const mockLoadForEdit = jest.fn();
const mockGetContent = jest.fn();
const mockSignedAssetUploadUrl = jest.fn();
const mockGetBytesBounded = jest.fn();
const mockPutBytes = jest.fn();
const mockDeleteKey = jest.fn();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  executeTransaction: (...args: unknown[]) => mockExecuteTransaction(...args),
}));
jest.mock("@/lib/db/schema", () => ({
  contentAssets: {
    id: "contentAssets.id",
    objectId: "contentAssets.objectId",
    state: "contentAssets.state",
    uploadExpiresAt: "contentAssets.uploadExpiresAt",
    createdAt: "contentAssets.createdAt",
    uploadKey: "contentAssets.uploadKey",
  },
  contentObjects: {
    id: "contentObjects.id",
    visibilityLevel: "contentObjects.visibilityLevel",
  },
  contentPublications: {
    id: "contentPublications.id",
    objectId: "contentPublications.objectId",
    destination: "contentPublications.destination",
    status: "contentPublications.status",
    publishedVersionId: "contentPublications.publishedVersionId",
  },
  contentVersionAssets: {
    assetId: "contentVersionAssets.assetId",
    versionId: "contentVersionAssets.versionId",
  },
}));
jest.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  lt: (...args: unknown[]) => args,
}));
jest.mock("@/lib/content/content-service", () => ({
  contentService: {
    loadForEdit: (...args: unknown[]) => mockLoadForEdit(...args),
    get: (...args: unknown[]) => mockGetContent(...args),
  },
}));
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: {
    assetKey: (objectId: string, assetId: string) =>
      `atrium/objects/${objectId}/assets/${assetId}`,
    assetUploadKey: (objectId: string, assetId: string) =>
      `atrium/pending-assets/${objectId}/${assetId}`,
    signedAssetUploadUrl: (...args: unknown[]) =>
      mockSignedAssetUploadUrl(...args),
    getBytesBounded: (...args: unknown[]) => mockGetBytesBounded(...args),
    putBytes: (...args: unknown[]) => mockPutBytes(...args),
    deleteKey: (...args: unknown[]) => mockDeleteKey(...args),
  },
}));

import {
  cleanupExpiredContentAssets,
  contentAssetService,
} from "@/lib/content/asset-service";
import { ConflictError, NotFoundError } from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const OBJECT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ASSET_ID = "11111111-2222-4333-8444-555555555555";
const now = new Date("2026-07-24T12:00:00.000Z");
const readyRow = {
  id: ASSET_ID,
  objectId: OBJECT_ID,
  uploaderActor: "human" as const,
  uploaderUserId: 7,
  uploaderAgentId: null,
  filename: "diagram.png",
  objectKey: `atrium/objects/${OBJECT_ID}/assets/${ASSET_ID}`,
  uploadKey: `atrium/pending-assets/${OBJECT_ID}/${ASSET_ID}`,
  contentType: "image/png",
  byteLength: 3,
  sha256: "A".repeat(43),
  width: 4,
  height: 3,
  purpose: "document_image" as const,
  state: "ready" as const,
  inspection: {
    processorVersion: "atrium-image-normalize-v1",
    normalizedByteLength: 3,
    normalizedSha256: "normalized-hash",
    metadataStripped: true,
  },
  uploadExpiresAt: new Date(now.getTime() + 60_000),
  readyAt: now,
  rejectedAt: null,
  createdAt: now,
};
const human: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
const guest: Requester = {
  kind: "user",
  userId: null,
  roles: [],
  isAdmin: false,
};
const goldenPng = Buffer.from(
  fs
    .readFileSync(
      path.join(
        process.cwd(),
        "tests/fixtures/unified-content/images/red-pixel.png.base64"
      ),
      "utf8"
    )
    .trim(),
  "base64"
);

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadForEdit.mockResolvedValue({ id: OBJECT_ID });
  mockGetContent.mockResolvedValue({ id: OBJECT_ID, visibilityLevel: "public" });
  mockSignedAssetUploadUrl.mockResolvedValue("https://s3.test/presigned");
  mockGetBytesBounded.mockResolvedValue(Buffer.from([1, 2, 3]));
  mockDeleteKey.mockResolvedValue(undefined);
});

describe("contentAssetService (#1284)", () => {
  it("returns a constrained presigned upload without exposing storage keys", async () => {
    mockExecuteQuery.mockImplementation(
      async (_query: unknown, operation: string) => {
        if (operation === "content.assets.initiate") {
          return [
            {
              ...readyRow,
              state: "pending",
              readyAt: null,
              inspection: null,
            },
          ];
        }
        throw new Error(`unexpected query ${operation}`);
      }
    );
    const result = await contentAssetService.initiate(human, OBJECT_ID, {
      filename: "diagram.png",
      contentType: "image/png",
      byteLength: 3,
      sha256: "A".repeat(43),
      purpose: "document_image",
      width: 4,
      height: 3,
    });

    expect(mockLoadForEdit).toHaveBeenCalledWith(human, OBJECT_ID);
    expect(mockSignedAssetUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "image/png",
        contentLength: 3,
        checksumSha256: expect.any(String),
        ttlSeconds: 900,
      })
    );
    expect(result.upload).toMatchObject({
      method: "PUT",
      url: "https://s3.test/presigned",
      headers: {
        "content-type": "image/png",
      },
    });
    expect(result).not.toHaveProperty("objectKey");
    expect(result).not.toHaveProperty("uploadKey");
  });

  it("treats completion of an already-ready immutable asset as idempotent", async () => {
    mockExecuteQuery.mockResolvedValue([readyRow]);
    const result = await contentAssetService.complete(
      human,
      OBJECT_ID,
      ASSET_ID,
      { sha256: readyRow.sha256 }
    );

    expect(result.state).toBe("ready");
    expect(mockGetBytesBounded).not.toHaveBeenCalled();
    expect(mockPutBytes).not.toHaveBeenCalled();
  });

  it("verifies and normalizes pending bytes before marking the asset ready", async () => {
    const sourceSha256 = createHash("sha256")
      .update(goldenPng)
      .digest("base64url");
    const pending = {
      ...readyRow,
      state: "pending" as const,
      byteLength: goldenPng.byteLength,
      sha256: sourceSha256,
      inspection: null,
      readyAt: null,
      uploadExpiresAt: new Date(Date.now() + 60_000),
    };
    mockGetBytesBounded.mockResolvedValue(goldenPng);
    mockExecuteQuery.mockImplementation(
      async (_query: unknown, operation: string) => {
        if (operation === "content.assets.get") return [pending];
        if (operation === "content.assets.complete") {
          return [
            {
              ...readyRow,
              byteLength: goldenPng.byteLength,
              sha256: sourceSha256,
            },
          ];
        }
        throw new Error(`unexpected query ${operation}`);
      }
    );

    const result = await contentAssetService.complete(
      human,
      OBJECT_ID,
      ASSET_ID,
      { sha256: sourceSha256 }
    );

    expect(result.state).toBe("ready");
    expect(mockGetBytesBounded).toHaveBeenCalledWith(
      pending.uploadKey,
      20 * 1024 * 1024 + 1
    );
    expect(mockPutBytes).toHaveBeenCalledWith(
      pending.objectKey,
      expect.any(Uint8Array),
      "image/png"
    );
  });

  it("rejects a completion checksum mismatch before reading storage", async () => {
    const pending = {
      ...readyRow,
      state: "pending" as const,
      readyAt: null,
      inspection: null,
      uploadExpiresAt: new Date(Date.now() + 60_000),
    };
    mockExecuteQuery.mockResolvedValue([pending]);
    await expect(
      contentAssetService.complete(human, OBJECT_ID, ASSET_ID, {
        sha256: "B".repeat(43),
      })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockGetBytesBounded).not.toHaveBeenCalled();
  });

  it("masks an unreferenced asset from an anonymous reader", async () => {
    mockExecuteQuery.mockImplementation(
      async (_query: unknown, operation: string) => {
        if (operation === "content.assets.read.resolve") return [readyRow];
        if (operation === "content.assets.read.publicGate") return [];
        throw new Error(`unexpected query ${operation}`);
      }
    );

    await expect(
      contentAssetService.readBytes(guest, ASSET_ID)
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mockGetBytesBounded).not.toHaveBeenCalled();
  });

  it("serves normalized bytes to an authorized object reader", async () => {
    mockExecuteQuery.mockResolvedValue([readyRow]);
    const result = await contentAssetService.readBytes(human, ASSET_ID);

    expect(mockGetContent).toHaveBeenCalledWith(human, OBJECT_ID);
    expect(mockGetBytesBounded).toHaveBeenCalledWith(readyRow.objectKey, 3);
    expect(result).toEqual({
      bytes: Buffer.from([1, 2, 3]),
      contentType: "image/png",
      etag: '"normalized-hash"',
    });
  });

  it("serves a public asset only after the exact version is publication-pinned", async () => {
    mockExecuteQuery.mockImplementation(
      async (_query: unknown, operation: string) => {
        if (operation === "content.assets.read.resolve") return [readyRow];
        if (operation === "content.assets.read.publicGate") {
          return [{ id: "publication-1" }];
        }
        throw new Error(`unexpected query ${operation}`);
      }
    );
    await expect(
      contentAssetService.readBytes(guest, ASSET_ID)
    ).resolves.toMatchObject({
      contentType: "image/png",
      etag: '"normalized-hash"',
    });
    expect(mockGetBytesBounded).toHaveBeenCalledWith(readyRow.objectKey, 3);
  });

  it("bounded cleanup deletes expired pending bytes and rechecks state", async () => {
    mockExecuteQuery.mockImplementation(
      async (_query: unknown, operation: string) => {
        if (operation === "content.assets.cleanup.select") {
          return [{ id: ASSET_ID, uploadKey: readyRow.uploadKey }];
        }
        throw new Error(`unexpected query ${operation}`);
      }
    );
    const returning = jest.fn(async () => [{ id: ASSET_ID }]);
    const where = jest.fn(() => ({ returning }));
    const set = jest.fn(() => ({ where }));
    const update = jest.fn(() => ({ set }));
    mockExecuteTransaction.mockImplementation(
      async (operation: (tx: unknown) => Promise<unknown>) =>
        operation({ update })
    );

    await expect(cleanupExpiredContentAssets(200)).resolves.toBe(1);
    expect(mockDeleteKey).toHaveBeenCalledWith(readyRow.uploadKey);
    expect(set).toHaveBeenCalledWith({ state: "deleted" });
    expect(where).toHaveBeenCalled();
  });
});
