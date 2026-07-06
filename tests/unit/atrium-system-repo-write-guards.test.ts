/**
 * Security regression: the generic repository WRITE actions must not touch a
 * system-managed repository (the Atrium retrieval index, Issue #1056), and
 * item-keyed writes must enforce per-repository ownership.
 *
 * Epic #1059 completion. Two gaps closed here:
 *  - The four add-item actions (`addDocumentItem`, `addDocumentWithPresignedUrl`,
 *    `addUrlItem`, `addTextItem`) gated only on `canModifyRepository`; a repo
 *    owner match (or a permissive ownership model change) could insert foreign
 *    items into the shared Atrium index, polluting retrieval. They now run
 *    `assertNotSystemManagedRepository` first.
 *  - `updateItemProcessingStatus` was capability-only and keyed by itemId — any
 *    capability holder could flip processing status on an arbitrary item
 *    (cross-repo IDOR), including Atrium index rows. It now mirrors
 *    `removeRepositoryItem`: resolve item (404), reject system-managed repos
 *    (404-mask), then require ownership (403).
 */

let itemById: Record<number, unknown> = {};
let repoById: Record<number, unknown> = {};
let canModifyResult = true;

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "user-1" })),
}));
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: jest.fn(async () => true),
  hasRole: jest.fn(async () => true),
}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@/lib/aws/s3-client", () => ({
  uploadDocument: jest.fn(async () => ({ key: "k", url: "u" })),
  deleteDocument: jest.fn(),
}));
jest.mock("@/lib/services/file-processing-service", () => ({
  queueFileForProcessing: jest.fn(),
  processUrl: jest.fn(),
}));
jest.mock("./../../actions/repositories/repository-permissions", () => ({
  canModifyRepository: jest.fn(async () => canModifyResult),
  getUserIdFromSession: jest.fn(async () => 1),
}));

jest.mock("@/lib/db/drizzle", () => ({
  getAccessibleRepositoriesByCognitoSub: jest.fn(async (ids: number[]) =>
    ids.map((id) => ({ id, name: "r", isAccessible: true }))
  ),
  getRepositoryItemById: jest.fn(async (id: number) => itemById[id] ?? null),
  getRepositoryById: jest.fn(async (id: number) => repoById[id] ?? null),
  isSystemManagedRepository: (repo: { metadata?: unknown } | null | undefined) =>
    (repo?.metadata as Record<string, unknown> | null | undefined)?.systemManaged === true,
  getRepositoryItemChunks: jest.fn(async () => []),
  createRepositoryItem: jest.fn(async (input: Record<string, unknown>) => ({
    id: 10,
    repositoryId: input.repositoryId,
    type: input.type,
    name: input.name,
    source: input.source,
    metadata: input.metadata ?? {},
    processingStatus: input.processingStatus ?? "pending",
    processingError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  })),
  getRepositoryItems: jest.fn(async () => []),
  deleteRepositoryItem: jest.fn(async () => 1),
  updateRepositoryItemStatus: jest.fn(async () => undefined),
}));

// addTextItem writes item + chunk directly through drizzle-client.
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => []),
  executeTransaction: jest.fn(async () => {
    throw new Error("addTextItem transaction should not run for a guarded repo");
  }),
  repositoryItems: {},
  repositoryItemChunks: {},
}));

import {
  addDocumentItem,
  addDocumentWithPresignedUrl,
  addUrlItem,
  addTextItem,
  updateItemProcessingStatus,
} from "@/actions/repositories/repository-items.actions";
import {
  createRepositoryItem,
  updateRepositoryItemStatus,
} from "@/lib/db/drizzle";
import { executeTransaction } from "@/lib/db/drizzle-client";

const createItemMock = createRepositoryItem as jest.Mock;
const updateStatusMock = updateRepositoryItemStatus as jest.Mock;
const txMock = executeTransaction as jest.Mock;

const SYSTEM_REPO = 9;
const NORMAL_REPO = 3;

beforeEach(() => {
  canModifyResult = true;
  repoById = {
    [SYSTEM_REPO]: { id: SYSTEM_REPO, metadata: { systemManaged: true } },
    [NORMAL_REPO]: { id: NORMAL_REPO, metadata: null },
  };
  itemById = {
    5: { id: 5, repositoryId: SYSTEM_REPO }, // an Atrium-index item
    6: { id: 6, repositoryId: NORMAL_REPO }, // a normal item
  };
  createItemMock.mockClear();
  updateStatusMock.mockClear();
  txMock.mockClear();
});

describe("add-item actions refuse a system-managed repository", () => {
  it("addDocumentItem fails and writes nothing", async () => {
    const result = await addDocumentItem({
      repository_id: SYSTEM_REPO,
      name: "doc",
      file: { content: "aGVsbG8=", contentType: "text/plain", size: 5 },
    });
    expect(result.isSuccess).toBe(false);
    expect(createItemMock).not.toHaveBeenCalled();
  });

  it("addDocumentWithPresignedUrl fails and writes nothing", async () => {
    const result = await addDocumentWithPresignedUrl({
      repository_id: SYSTEM_REPO,
      name: "doc",
      s3Key: "k",
      metadata: { contentType: "text/plain", size: 5, originalFileName: "a.txt" },
    });
    expect(result.isSuccess).toBe(false);
    expect(createItemMock).not.toHaveBeenCalled();
  });

  it("addUrlItem fails and writes nothing", async () => {
    const result = await addUrlItem({
      repository_id: SYSTEM_REPO,
      name: "url",
      url: "https://example.com",
    });
    expect(result.isSuccess).toBe(false);
    expect(createItemMock).not.toHaveBeenCalled();
  });

  it("addTextItem fails before its insert transaction", async () => {
    const result = await addTextItem({
      repository_id: SYSTEM_REPO,
      name: "text",
      content: "hello",
    });
    expect(result.isSuccess).toBe(false);
    expect(txMock).not.toHaveBeenCalled();
  });

  it("addUrlItem still works against a normal repository the caller owns", async () => {
    const result = await addUrlItem({
      repository_id: NORMAL_REPO,
      name: "url",
      url: "https://example.com",
    });
    expect(result.isSuccess).toBe(true);
    expect(createItemMock).toHaveBeenCalledTimes(1);
  });
});

describe("updateItemProcessingStatus item-level guard", () => {
  it("fails for an item in a system-managed repo and never writes", async () => {
    const result = await updateItemProcessingStatus(5, "completed");
    expect(result.isSuccess).toBe(false);
    expect(updateStatusMock).not.toHaveBeenCalled();
  });

  it("fails for a missing item (404-mask) and never writes", async () => {
    const result = await updateItemProcessingStatus(999, "completed");
    expect(result.isSuccess).toBe(false);
    expect(updateStatusMock).not.toHaveBeenCalled();
  });

  it("fails for a non-owner (cross-repo IDOR closed) and never writes", async () => {
    canModifyResult = false;
    const result = await updateItemProcessingStatus(6, "completed");
    expect(result.isSuccess).toBe(false);
    expect(updateStatusMock).not.toHaveBeenCalled();
  });

  it("succeeds for the owner of a normal repository", async () => {
    const result = await updateItemProcessingStatus(6, "completed");
    expect(result.isSuccess).toBe(true);
    expect(updateStatusMock).toHaveBeenCalledWith(6, "completed", null);
  });
});
