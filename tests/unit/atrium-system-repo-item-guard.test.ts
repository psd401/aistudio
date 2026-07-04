/**
 * Security regression (round-5 review): `getItemChunks(itemId)` returned raw
 * `repository_item_chunks.content` after only a generic capability check — and
 * it is keyed by ITEM id, so the repositoryId-based guards did not cover it.
 * Since Atrium chunks live in the shared table, that was a direct read of
 * restricted Atrium text (Issue #1056, spec §16.2).
 *
 * Covers the shared guards (`assertNotSystemManagedRepository`,
 * `assertItemNotInSystemManagedRepository`) directly, plus the `getItemChunks`
 * wiring (no chunk read occurs for a system-managed item).
 */

let repoById: Record<number, unknown> = {};
let itemById: Record<number, unknown> = {};

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "user-1" })),
}));
jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: jest.fn(async () => true),
  hasRole: jest.fn(async () => true),
}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
// Heavy side-effect modules repository-items.actions.ts imports — stub them so
// the suite doesn't drag in the AWS SDK / processing pipeline.
jest.mock("@/lib/aws/s3-client", () => ({
  uploadDocument: jest.fn(), deleteDocument: jest.fn(),
}));
jest.mock("@/lib/services/file-processing-service", () => ({
  queueFileForProcessing: jest.fn(), processUrl: jest.fn(),
}));
jest.mock("./../../actions/repositories/repository-permissions", () => ({
  canModifyRepository: jest.fn(async () => true),
  getUserIdFromSession: jest.fn(async () => 1),
}));

jest.mock("@/lib/db/drizzle", () => ({
  getRepositoryById: jest.fn(async (id: number) => repoById[id] ?? null),
  getRepositoryItemById: jest.fn(async (id: number) => itemById[id] ?? null),
  getRepositoryItemChunks: jest.fn(async () => [
    { id: 1, itemId: 5, content: "restricted staff text", embedding: null, metadata: {}, chunkIndex: 0, tokens: null, createdAt: new Date(0) },
  ]),
  isSystemManagedRepository: (repo: { metadata?: unknown } | null | undefined) =>
    (repo?.metadata as Record<string, unknown> | null | undefined)?.systemManaged === true,
  // other barrel exports repository-items.actions imports
  createRepositoryItem: jest.fn(),
  getRepositoryItems: jest.fn(async () => []),
  deleteRepositoryItem: jest.fn(),
  updateRepositoryItemStatus: jest.fn(),
}));

import {
  assertNotSystemManagedRepository,
  assertItemNotInSystemManagedRepository,
} from "@/lib/repositories/system-repo-guard";
import { getItemChunks } from "@/actions/repositories/repository-items.actions";
import { getRepositoryItemChunks } from "@/lib/db/drizzle";

const getChunksMock = getRepositoryItemChunks as jest.Mock;

const SYSTEM_REPO = { id: 9, metadata: { systemManaged: true } };
const NORMAL_REPO = { id: 3, metadata: null };

beforeEach(() => {
  repoById = { 9: SYSTEM_REPO, 3: NORMAL_REPO };
  itemById = {
    5: { id: 5, repositoryId: 9, name: "atrium chunk" }, // in system repo
    6: { id: 6, repositoryId: 3, name: "normal doc" },    // in normal repo
  };
  getChunksMock.mockClear();
});

describe("shared system-managed guards", () => {
  it("assertNotSystemManagedRepository throws for a system repo, resolves for a normal one", async () => {
    await expect(assertNotSystemManagedRepository(9)).rejects.toBeDefined();
    await expect(assertNotSystemManagedRepository(3)).resolves.toBeUndefined();
    await expect(assertNotSystemManagedRepository(404)).rejects.toBeDefined(); // missing
  });

  it("assertItemNotInSystemManagedRepository throws for an item in a system repo", async () => {
    await expect(assertItemNotInSystemManagedRepository(5)).rejects.toBeDefined(); // system
    await expect(assertItemNotInSystemManagedRepository(6)).resolves.toBeUndefined(); // normal
    await expect(assertItemNotInSystemManagedRepository(404)).rejects.toBeDefined(); // missing item
  });
});

describe("getItemChunks — no raw chunk read for a system-managed item", () => {
  it("REFUSES to return chunks for an item in the Atrium system repo", async () => {
    const result = await getItemChunks(5);
    expect(result.isSuccess).toBe(false);
    // The safety guarantee: the chunk content query never ran.
    expect(getChunksMock).not.toHaveBeenCalled();
  });

  it("ALLOWS reading chunks for an item in a normal repository", async () => {
    const result = await getItemChunks(6);
    expect(result.isSuccess).toBe(true);
    expect(getChunksMock).toHaveBeenCalledWith(6);
  });
});
