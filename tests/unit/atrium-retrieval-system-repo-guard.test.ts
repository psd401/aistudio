/**
 * Security regression: the generic repository actions must refuse to read a
 * SYSTEM-MANAGED repository (the Atrium retrieval index, Issue #1056).
 *
 * Atrium content is stored in the shared `repository_items` table but governed
 * by a finer-grained permission model (per-hit `visibilityService.canView`,
 * §16.2). The generic `searchRepository` action enforces NO repository-level
 * authorization, so without this guard any authenticated user could pass the
 * Atrium repo's (guessable, sequential) integer id and vector-search every
 * indexed chunk — retrieving `content` for objects they cannot `canView`,
 * bypassing the entire safety boundary this feature builds. (Round-2 PR review
 * finding on #1108.)
 *
 * Exercises the REAL `isSystemManagedRepository` (via requireActual) while
 * mocking only `getRepositoryById` + the auth/search IO boundaries.
 */

let repoResult: unknown = null;

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "user-123" })),
}));

// Mocks are created INSIDE the factories (retrieved via the imported module
// below) so the hoisted jest.mock calls don't dereference an outer `const`
// before its declaration line runs (TDZ).
jest.mock("@/lib/repositories/search-service", () => {
  const hit = { chunkId: 1, itemId: 1, itemName: "x", content: "secret", similarity: 0.9, chunkIndex: 0, metadata: {} };
  return {
    vectorSearch: jest.fn(async () => [hit]),
    keywordSearch: jest.fn(async () => []),
    hybridSearch: jest.fn(async () => [hit]),
  };
});

// Keep the REAL isSystemManagedRepository (pure); override only getRepositoryById.
jest.mock("@/lib/db/drizzle/knowledge-repositories", () => {
  const actual = jest.requireActual("@/lib/db/drizzle/knowledge-repositories");
  return {
    __esModule: true,
    ...actual,
    getRepositoryById: jest.fn(async () => repoResult),
  };
});

import { searchRepository } from "@/actions/repositories/search.actions";
import { isSystemManagedRepository } from "@/lib/db/drizzle/knowledge-repositories";
import {
  vectorSearch,
  keywordSearch,
  hybridSearch,
} from "@/lib/repositories/search-service";

const vectorSearchMock = vectorSearch as jest.Mock;
const keywordSearchMock = keywordSearch as jest.Mock;
const hybridSearchMock = hybridSearch as jest.Mock;

beforeEach(() => {
  repoResult = null;
  vectorSearchMock.mockClear();
  keywordSearchMock.mockClear();
  hybridSearchMock.mockClear();
});

describe("isSystemManagedRepository (pure)", () => {
  it("is true only when metadata.systemManaged === true", () => {
    expect(isSystemManagedRepository({ metadata: { systemManaged: true } })).toBe(true);
    expect(isSystemManagedRepository({ metadata: { systemManaged: false } })).toBe(false);
    expect(isSystemManagedRepository({ metadata: {} })).toBe(false);
    expect(isSystemManagedRepository({ metadata: null })).toBe(false);
    expect(isSystemManagedRepository(null)).toBe(false);
    expect(isSystemManagedRepository(undefined)).toBe(false);
  });
});

describe("searchRepository — system-managed repository guard", () => {
  it("REFUSES a system-managed (Atrium) repository without searching", async () => {
    repoResult = { id: 7, name: "Atrium Content Index", metadata: { systemManaged: true } };

    const result = await searchRepository({ query: "secret", repositoryId: 7 });

    expect(result.isSuccess).toBe(false);
    // Masked as not-found so the id is not enumerable.
    expect(result.message).toMatch(/not found/i);
    // The safety boundary: no search ran, so no chunk content leaked.
    expect(vectorSearchMock).not.toHaveBeenCalled();
    expect(keywordSearchMock).not.toHaveBeenCalled();
    expect(hybridSearchMock).not.toHaveBeenCalled();
  });

  it("REFUSES a non-existent repository", async () => {
    repoResult = null;
    const result = await searchRepository({ query: "secret", repositoryId: 999 });
    expect(result.isSuccess).toBe(false);
    expect(hybridSearchMock).not.toHaveBeenCalled();
  });

  it("ALLOWS a normal (non-system) repository to be searched", async () => {
    repoResult = { id: 3, name: "My Docs", metadata: null };

    const result = await searchRepository({ query: "secret", repositoryId: 3 });

    expect(result.isSuccess).toBe(true);
    // Default searchType is hybrid.
    expect(hybridSearchMock).toHaveBeenCalledWith(
      "secret",
      expect.objectContaining({ repositoryId: 3 })
    );
  });
});
