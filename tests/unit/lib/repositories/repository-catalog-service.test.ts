/** @jest-environment node */

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

jest.mock("server-only", () => ({}));

const mockAccessibleRepositories = jest.fn();
const mockAccessibleIds = jest.fn();
const mockRetrieve = jest.fn();
const mockExecuteQuery = jest.fn();

jest.mock("@/lib/db/drizzle", () => ({
  getUserAccessibleRepositories: (...args: unknown[]) =>
    mockAccessibleRepositories(...args),
  getAccessibleRepositoryIds: (...args: unknown[]) =>
    mockAccessibleIds(...args),
}));
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  toPgRows: (value: unknown) => value,
}));
jest.mock("@/lib/repositories/retrieval-v2/service", () => ({
  retrieveRepositoryContent: (...args: unknown[]) => mockRetrieve(...args),
}));

import {
  describeRepository,
  getRepositorySource,
  listRepositoryCatalog,
  searchRepositoryCatalog,
} from "@/lib/repositories/repository-catalog-service";

const accessibleRows = [
  {
    id: 4,
    name: "District Policies",
    description: "Board and administrative policy",
    ownerId: 2,
    ownerName: "Policy Office",
    isPublic: false,
    repositoryKind: "durable" as const,
    lifecycleStatus: "active" as const,
    retentionDays: null,
    expiresAt: null,
    activeIndexGenerationId: "generation-4",
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-02-01T00:00:00Z"),
    itemCount: 3,
    lastUpdated: new Date("2026-02-02T00:00:00Z"),
  },
  {
    id: 9,
    name: "Curriculum",
    description: null,
    ownerId: 3,
    ownerName: null,
    isPublic: true,
    repositoryKind: "durable" as const,
    lifecycleStatus: "active" as const,
    retentionDays: null,
    expiresAt: null,
    activeIndexGenerationId: null,
    metadata: {},
    createdAt: null,
    updatedAt: null,
    itemCount: 0,
    lastUpdated: null,
  },
];

describe("repository catalog service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccessibleRepositories.mockResolvedValue(accessibleRows);
  });

  it("lists and describes only the repositories returned by the live ACL query", async () => {
    await expect(
      listRepositoryCatalog("caller-sub", { query: "policy" })
    ).resolves.toEqual([
      {
        id: 4,
        name: "District Policies",
        description: "Board and administrative policy",
        ownerName: "Policy Office",
        visibility: "private",
        itemCount: 3,
        activeIndexGenerationId: "generation-4",
        lastUpdated: "2026-02-02T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    await expect(describeRepository("caller-sub", 9)).resolves.toMatchObject({
      id: 9,
      visibility: "public",
    });
    await expect(describeRepository("caller-sub", 99)).resolves.toBeNull();
    expect(mockAccessibleRepositories).toHaveBeenCalledWith("caller-sub");
  });

  it("uses retrieval v2 with current accessible repositories when ids are omitted", async () => {
    mockRetrieve.mockResolvedValue({ results: [], diagnostics: {} });
    await searchRepositoryCatalog({
      cognitoSub: "caller-sub",
      query: "graduation",
      mode: "hybrid",
      limit: 5,
    });
    expect(mockRetrieve).toHaveBeenCalledWith({
      query: "graduation",
      repositoryIds: [4, 9],
      userCognitoSub: "caller-sub",
      mode: "hybrid",
      modalities: undefined,
      limit: 5,
      threshold: undefined,
    });
  });

  it("source disclosure pins the active generation/current version and rechecks both ACL layers", async () => {
    let compiledSql = "";
    mockExecuteQuery.mockImplementation(
      async (
        callback: (db: {
          execute(query: SQL): Array<Record<string, unknown>>;
        }) => unknown
      ) =>
        callback({
          execute(query) {
            compiledSql = new PgDialect().sqlToQuery(query).sql;
            return [
              {
                chunk_id: 12,
                item_id: 8,
                item_stable_id: "stable",
                item_name: "Handbook",
                item_version_id: "version",
                version_number: 3,
                chunk_index: 2,
                modality: "text",
                content: "Allowed content",
                context_prefix: "Page 3",
                source_locator: { page: 3 },
              },
            ];
          },
        })
    );

    await expect(
      getRepositorySource({
        userId: 42,
        repositoryId: 4,
        itemId: 8,
        chunkId: 12,
      })
    ).resolves.toEqual([
      {
        chunkId: 12,
        itemId: 8,
        itemStableId: "stable",
        itemName: "Handbook",
        itemVersionId: "version",
        versionNumber: 3,
        chunkIndex: 2,
        modality: "text",
        content: "Allowed content",
        contextPrefix: "Page 3",
        sourceLocator: { page: 3 },
      },
    ]);
    expect(compiledSql).toContain(
      "chunk.index_generation_id = repository.active_index_generation_id"
    );
    expect(compiledSql).toContain("version.id = item.current_version_id");
    expect(compiledSql).toContain("repository.metadata ->> 'systemManaged'");
    expect(compiledSql).toContain("FROM repository_access repository_acl");
    expect(compiledSql).toContain("chunk.access_scope");
    expect(compiledSql).toContain("FROM user_roles membership");
  });
});
