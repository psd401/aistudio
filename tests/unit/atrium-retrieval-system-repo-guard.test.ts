/**
 * Security regression: the generic `searchRepository` action must enforce
 * per-repository authorization before searching a repo's chunks.
 *
 * Historically it checked ONLY `getServerSession()` — any authenticated user
 * could pass an arbitrary (sequential, guessable) `repositoryId` and vector/
 * keyword search a private repository they don't own and have no
 * `repository_access` grant for, retrieving raw chunk `content` (a generic
 * IDOR). Worse, once Atrium content was indexed into the shared tables (Issue
 * #1056), the same hole exposed restricted Atrium content, bypassing the §16.2
 * `canView` boundary. The fix requires access via
 * `getAccessibleRepositoriesByCognitoSub` (public / owner / grant), which also
 * EXCLUDES system-managed repos — so one check closes both the IDOR and Atrium
 * isolation.
 *
 * Exercises the REAL `assertRepositoryReadAccess` guard while mocking only the
 * access query + auth/search IO boundaries.
 */

// Whether the requested repo resolves as accessible for the caller.
let accessible = false;

jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({ sub: "user-123" })),
}));

jest.mock("@/lib/repositories/search-service", () => {
  const hit = { chunkId: 1, itemId: 1, itemName: "x", content: "secret", similarity: 0.9, chunkIndex: 0, metadata: {} };
  return {
    vectorSearch: jest.fn(async () => [hit]),
    keywordSearch: jest.fn(async () => []),
    hybridSearch: jest.fn(async () => [hit]),
  };
});

// The access guard resolves accessibility via getAccessibleRepositoriesByCognitoSub.
// A system-managed / private-unowned repo resolves isAccessible:false (the SQL
// EXCLUDE_SYSTEM_MANAGED + access predicate handle both — modeled here by `accessible`).
jest.mock("@/lib/db/drizzle", () => ({
  getAccessibleRepositoriesByCognitoSub: jest.fn(async (ids: number[]) =>
    ids.map((id) => ({ id, name: "r", isAccessible: accessible }))
  ),
  // imported by the guard module but not exercised on the read path
  getRepositoryById: jest.fn(),
  getRepositoryItemById: jest.fn(),
  isSystemManagedRepository: jest.fn(() => false),
}));

import { searchRepository } from "@/actions/repositories/search.actions";
import {
  vectorSearch,
  keywordSearch,
  hybridSearch,
} from "@/lib/repositories/search-service";

const vectorSearchMock = vectorSearch as jest.Mock;
const keywordSearchMock = keywordSearch as jest.Mock;
const hybridSearchMock = hybridSearch as jest.Mock;

beforeEach(() => {
  accessible = false;
  vectorSearchMock.mockClear();
  keywordSearchMock.mockClear();
  hybridSearchMock.mockClear();
});

describe("searchRepository — per-repository authorization", () => {
  it("REFUSES an inaccessible / system-managed repository without searching", async () => {
    accessible = false;

    const result = await searchRepository({ query: "secret", repositoryId: 7 });

    expect(result.isSuccess).toBe(false);
    // The safety boundary: no search ran, so no chunk content leaked.
    expect(vectorSearchMock).not.toHaveBeenCalled();
    expect(keywordSearchMock).not.toHaveBeenCalled();
    expect(hybridSearchMock).not.toHaveBeenCalled();
  });

  it("ALLOWS a repository the caller can access", async () => {
    accessible = true;

    const result = await searchRepository({ query: "secret", repositoryId: 3 });

    expect(result.isSuccess).toBe(true);
    // Default searchType is hybrid.
    expect(hybridSearchMock).toHaveBeenCalledWith(
      "secret",
      expect.objectContaining({ repositoryId: 3 })
    );
  });
});
