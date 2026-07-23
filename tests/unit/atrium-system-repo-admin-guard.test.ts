/**
 * Security regression: the admin repository actions must treat the SYSTEM-MANAGED
 * Atrium retrieval index (Issue #1056) as immutable / not-browsable.
 *
 * `adminUpdateRepository` is the blocking case from round-3 review: an admin
 * flipping `isPublic` to true (or stripping the `systemManaged` flag) on the
 * shared Atrium repo would reopen the generic-search bypass that the
 * system-managed guards close — with NO `canView` anywhere in the generic chain.
 * `adminGetRepositoryItems` must likewise not expose the raw indexed chunks.
 */

let repoResult: unknown = null;

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "admin-1" })),
}));
jest.mock("@/utils/roles", () => ({
  hasRole: jest.fn(async () => true), // administrator
}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));

// Mock the drizzle barrel the admin action imports from. `isSystemManagedRepository`
// is reimplemented faithfully (its real behavior is covered by the pure-helper
// test in atrium-retrieval-system-repo-guard.test.ts); the point here is the
// action WIRING — that a system-managed repo is refused before any write/read.
jest.mock("@/lib/db/drizzle", () => ({
  getRepositoryById: jest.fn(async () => repoResult),
  updateRepository: jest.fn(async (id: number) => ({
    id, name: "x", description: null, ownerId: 1, isPublic: true, metadata: {},
    repositoryKind: "durable", lifecycleStatus: "active",
    retentionDays: null, expiresAt: null, activeIndexGenerationId: null,
    createdAt: new Date(0), updatedAt: new Date(0),
  })),
  getAllRepositoriesWithOwner: jest.fn(async () => []),
  getRepositoryItems: jest.fn(async () => [
    { id: 1, repositoryId: 9, type: "text", name: "secret chunk", source: "atrium:x", metadata: {}, processingStatus: "completed", processingError: null, createdAt: new Date(0), updatedAt: new Date(0) },
  ]),
  getRepositoryItemById: jest.fn(async () => null),
  deleteRepository: jest.fn(async () => undefined),
  deleteRepositoryItem: jest.fn(async () => undefined),
  isSystemManagedRepository: (repo: { metadata?: unknown } | null | undefined) =>
    (repo?.metadata as Record<string, unknown> | null | undefined)?.systemManaged === true,
}));

import {
  adminUpdateRepository,
  adminGetRepositoryItems,
} from "@/actions/admin/repositories.actions";
import { updateRepository, getRepositoryItems } from "@/lib/db/drizzle";

const updateRepositoryMock = updateRepository as jest.Mock;
const getRepositoryItemsMock = getRepositoryItems as jest.Mock;

const SYSTEM_REPO = { id: 9, name: "Atrium Content Index", metadata: { systemManaged: true } };
const NORMAL_REPO = {
  id: 3,
  name: "My Docs",
  repositoryKind: "durable",
  lifecycleStatus: "active",
  expiresAt: null,
  metadata: null,
};

beforeEach(() => {
  repoResult = null;
  updateRepositoryMock.mockClear();
  getRepositoryItemsMock.mockClear();
});

describe("adminUpdateRepository — system-managed repo is immutable", () => {
  it("REFUSES to update the Atrium system repo and performs NO write", async () => {
    repoResult = SYSTEM_REPO;
    const result = await adminUpdateRepository({ id: 9, isPublic: true });
    expect(result.isSuccess).toBe(false);
    // The blocking guarantee: isPublic can never be flipped on the shared index.
    expect(updateRepositoryMock).not.toHaveBeenCalled();
  });

  it("ALLOWS updating a normal repository", async () => {
    repoResult = NORMAL_REPO;
    const result = await adminUpdateRepository({ id: 3, isPublic: true });
    expect(result.isSuccess).toBe(true);
    expect(updateRepositoryMock).toHaveBeenCalled();
  });
});

describe("adminGetRepositoryItems — system-managed repo is not browsable", () => {
  it("REFUSES to return items for the Atrium system repo (no raw chunk read)", async () => {
    repoResult = SYSTEM_REPO;
    const result = await adminGetRepositoryItems(9);
    expect(result.isSuccess).toBe(false);
    expect(getRepositoryItemsMock).not.toHaveBeenCalled();
  });

  it("ALLOWS listing items for a normal repository", async () => {
    repoResult = NORMAL_REPO;
    const result = await adminGetRepositoryItems(3);
    expect(result.isSuccess).toBe(true);
    expect(getRepositoryItemsMock).toHaveBeenCalledWith(3);
  });
});
