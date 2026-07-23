/**
 * Unit tests for `syncEmbedBacklinksInTx` (Epic #1059 Meridian slice D).
 *
 * On every DOCUMENT version write, the backlink maintainer REPLACES this document's
 * `content_embed_links` rows to match the new body: it parses the embedded artifact
 * ids from the canonical markdown (fence-aware), keeps only those that are EXISTING
 * artifacts, then delete-then-inserts inside the transaction. These tests exercise:
 *  - add      — new embeds become backlink rows
 *  - remove   — a body with no embeds clears the rows (delete, no insert)
 *  - nonexistent / non-artifact id — filtered out (never inserted; can't abort on FK)
 *  - fenced example — a directive inside a code fence is NOT a backlink
 *
 * Heavy collaborators (drizzle schema/client, S3, renderer, visibility) are mocked so
 * this stays a pure-logic unit test; the REAL fence-aware `parseEmbeddedArtifactIds`
 * runs. A hand-built transaction stub records the delete/insert calls. Uses the
 * GLOBAL `jest` (repo convention), never an `@jest/globals` import.
 */

// --- mocks (hoisted above imports by jest) ---

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: () => {
    throw new Error("syncEmbedBacklinksInTx must use the passed tx, not executeQuery");
  },
  executeTransaction: () => {
    throw new Error("syncEmbedBacklinksInTx must use the passed tx, not executeTransaction");
  },
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: { id: "content_objects.id", kind: "content_objects.kind" },
  contentVersions: {},
  contentEmbedLinks: {
    documentObjectId: "content_embed_links.document_object_id",
    artifactObjectId: "content_embed_links.artifact_object_id",
  },
}));
jest.mock("@/lib/db/drizzle-helpers", () => ({
  pgTimestampAsText: (c: unknown) => c,
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => ({ eq: a }),
  inArray: (...a: unknown[]) => ({ inArray: a }),
  sql: Object.assign((..._a: unknown[]) => ({}), {}),
}));
jest.mock("@/lib/content/render/markdown-render", () => ({
  renderMarkdownToHtml: () => "<p>unused</p>",
}));
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: { key: () => "k", putText: () => Promise.resolve() },
}));
jest.mock("@/lib/content/visibility-service", () => ({ visibilityService: {} }));

import { syncEmbedBacklinksInTx } from "@/lib/content/version-service";
import type { DbTransaction } from "@/lib/db/drizzle-client";

const UUID_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const UUID_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const DOC_ID = "11111111-1111-1111-1111-111111111111";

/**
 * A transaction stub that models the DB: `existingArtifactIds` is the set of the
 * referenced ids that actually resolve to an artifact row (drives the SELECT filter).
 * It records every delete and the flattened inserted rows so tests can assert them.
 */
function makeTx(existingArtifactIds: string[]): {
  tx: DbTransaction;
  calls: { deletes: number; inserted: Array<{ documentObjectId: string; artifactObjectId: string }> };
} {
  const calls = { deletes: 0, inserted: [] as Array<{ documentObjectId: string; artifactObjectId: string }> };
  const selectBuilder = {
    from: () => selectBuilder,
    // The keep-only-existing-artifacts filter resolves to id rows.
    where: () => Promise.resolve(existingArtifactIds.map((id) => ({ id }))),
  };
  const tx = {
    select: () => selectBuilder,
    delete: () => ({
      where: () => {
        calls.deletes += 1;
        return Promise.resolve();
      },
    }),
    insert: () => ({
      values: (rows: Array<{ documentObjectId: string; artifactObjectId: string }>) => {
        calls.inserted.push(...rows);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
  };
  return { tx: tx as unknown as DbTransaction, calls };
}

const embed = (id: string) => `::atrium-artifact{id="${id}"}`;

describe("syncEmbedBacklinksInTx", () => {
  it("add: inserts a backlink row for each embedded, existing artifact", async () => {
    const { tx, calls } = makeTx([UUID_A, UUID_B]);
    await syncEmbedBacklinksInTx(tx, DOC_ID, `intro\n\n${embed(UUID_A)}\n\nmid\n\n${embed(UUID_B)}`);
    expect(calls.deletes).toBe(1); // always replace-in-place
    expect(calls.inserted).toEqual([
      { documentObjectId: DOC_ID, artifactObjectId: UUID_A },
      { documentObjectId: DOC_ID, artifactObjectId: UUID_B },
    ]);
  });

  it("remove: a body with no embeds clears the rows (delete, no insert)", async () => {
    const { tx, calls } = makeTx([]);
    await syncEmbedBacklinksInTx(tx, DOC_ID, "just prose, no embeds at all");
    expect(calls.deletes).toBe(1);
    expect(calls.inserted).toEqual([]);
  });

  it("nonexistent / non-artifact id: referenced but unresolved ids are NOT inserted", async () => {
    // Body references A and B, but only A resolves to an existing artifact row.
    const { tx, calls } = makeTx([UUID_A]);
    await syncEmbedBacklinksInTx(tx, DOC_ID, `${embed(UUID_A)}\n\n${embed(UUID_B)}`);
    expect(calls.inserted).toEqual([{ documentObjectId: DOC_ID, artifactObjectId: UUID_A }]);
  });

  it("fenced example: a directive inside a code fence is not a backlink", async () => {
    // Even though the artifact 'exists', a directive that only documents the syntax
    // inside a ``` block must not be parsed as a real embed → no insert.
    const { tx, calls } = makeTx([UUID_A]);
    await syncEmbedBacklinksInTx(tx, DOC_ID, `Docs:\n\n\`\`\`\n${embed(UUID_A)}\n\`\`\`\n\nend`);
    expect(calls.deletes).toBe(1);
    expect(calls.inserted).toEqual([]);
  });

  it("dedupes a repeated embed to a single backlink row", async () => {
    const { tx, calls } = makeTx([UUID_A]);
    await syncEmbedBacklinksInTx(tx, DOC_ID, `${embed(UUID_A)}\n\ntext\n\n${embed(UUID_A)}`);
    expect(calls.inserted).toEqual([{ documentObjectId: DOC_ID, artifactObjectId: UUID_A }]);
  });
});
