/**
 * Unit tests for the Nexus conversation retention policy + sweep (Issue #1330).
 *
 * Runner: bun test (this Lambda is an isolated bundle, not part of the app jest
 * suite — jest.config.js ignores /infra/ outright).
 * Run: `cd infra/lambdas/nexus-conversation-retention && bun test`.
 *
 * These cover the invariants that make an irreversible hard delete safe:
 *   - disabled-by-default really is a no-op (no candidate scan at all)
 *   - the eligibility predicate is exactly is_saved=false AND is_pinned=false
 *     AND last_message_at < cutoff (archived rows included)
 *   - ephemeral repository IDs are resolved BEFORE the conversation row is
 *     deleted, and no knowledge_repositories row is left orphaned
 */

import { test, expect, describe } from "bun:test";
import {
  parseRetentionDays,
  isEligibleForDeletion,
  retentionCutoff,
  CANDIDATE_WHERE_CLAUSE,
  type ConversationEligibilityRow,
} from "./retention-policy";
import {
  runRetentionSweep,
  type CandidateConversation,
  type LegacyDocument,
  type SweepPorts,
  type SweepLogger,
} from "./sweep";
import { documentUrlToObjectKey, toObjectKey } from "./index";

const silentLog: SweepLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// parseRetentionDays — disabled-by-default enforcement
// ---------------------------------------------------------------------------

describe("parseRetentionDays", () => {
  test("missing setting disables the sweep", () => {
    expect(parseRetentionDays(null)).toEqual({ enabled: false, reason: "missing" });
    expect(parseRetentionDays(undefined)).toEqual({ enabled: false, reason: "missing" });
  });

  test("empty or whitespace-only value disables the sweep (the seeded default)", () => {
    expect(parseRetentionDays("")).toEqual({ enabled: false, reason: "empty" });
    expect(parseRetentionDays("   ")).toEqual({ enabled: false, reason: "empty" });
  });

  test("zero disables the sweep", () => {
    expect(parseRetentionDays("0")).toEqual({ enabled: false, reason: "zero" });
    expect(parseRetentionDays(" 0 ")).toEqual({ enabled: false, reason: "zero" });
  });

  test("negative values disable the sweep", () => {
    expect(parseRetentionDays("-1")).toEqual({ enabled: false, reason: "negative" });
    expect(parseRetentionDays("-365")).toEqual({ enabled: false, reason: "negative" });
  });

  test("non-numeric values disable the sweep instead of being coerced", () => {
    for (const raw of ["abc", "30 days", "30d", "1.5", "1e3", "0x10", "Infinity", "NaN", "true"]) {
      const parsed = parseRetentionDays(raw);
      expect(parsed.enabled).toBe(false);
    }
  });

  test("a positive whole number enables the sweep", () => {
    expect(parseRetentionDays("30")).toEqual({ enabled: true, retentionDays: 30 });
    expect(parseRetentionDays(" 365 ")).toEqual({ enabled: true, retentionDays: 365 });
    expect(parseRetentionDays("1")).toEqual({ enabled: true, retentionDays: 1 });
  });
});

// ---------------------------------------------------------------------------
// isEligibleForDeletion — the exact predicate
// ---------------------------------------------------------------------------

describe("isEligibleForDeletion", () => {
  const now = new Date("2026-07-01T00:00:00.000Z");
  const cutoff = retentionCutoff(now, 30); // 2026-06-01

  function row(overrides: Partial<ConversationEligibilityRow> = {}): ConversationEligibilityRow {
    return {
      id: "c1",
      isSaved: false,
      isPinned: false,
      isArchived: false,
      lastMessageAt: new Date("2026-01-01T00:00:00.000Z"), // well past the cutoff
      ...overrides,
    };
  }

  test("a stale, unkept, unpinned conversation is eligible", () => {
    expect(isEligibleForDeletion(row(), cutoff)).toBe(true);
  });

  test("Keep excludes a conversation regardless of age", () => {
    expect(isEligibleForDeletion(row({ isSaved: true }), cutoff)).toBe(false);
    expect(
      isEligibleForDeletion(
        row({ isSaved: true, lastMessageAt: new Date("2020-01-01T00:00:00.000Z") }),
        cutoff
      )
    ).toBe(false);
  });

  test("pinned excludes a conversation regardless of age", () => {
    expect(isEligibleForDeletion(row({ isPinned: true }), cutoff)).toBe(false);
  });

  test("Keep and pin still protect an ARCHIVED conversation", () => {
    expect(isEligibleForDeletion(row({ isArchived: true, isSaved: true }), cutoff)).toBe(false);
    expect(isEligibleForDeletion(row({ isArchived: true, isPinned: true }), cutoff)).toBe(false);
  });

  test("archived is NOT protection — a stale archived conversation is eligible", () => {
    expect(isEligibleForDeletion(row({ isArchived: true }), cutoff)).toBe(true);
  });

  test("a conversation newer than the cutoff is not eligible", () => {
    expect(
      isEligibleForDeletion(row({ lastMessageAt: new Date("2026-06-15T00:00:00.000Z") }), cutoff)
    ).toBe(false);
  });

  test("the cutoff boundary is exclusive — exactly at the cutoff is not eligible", () => {
    expect(isEligibleForDeletion(row({ lastMessageAt: new Date(cutoff) }), cutoff)).toBe(false);
    expect(
      isEligibleForDeletion(row({ lastMessageAt: new Date(cutoff.getTime() - 1) }), cutoff)
    ).toBe(true);
  });

  test("NULL last_message_at is never eligible — there is no inactivity clock", () => {
    expect(isEligibleForDeletion(row({ lastMessageAt: null }), cutoff)).toBe(false);
  });

  test("NULL is_saved / is_pinned count as not-flagged", () => {
    expect(isEligibleForDeletion(row({ isSaved: null, isPinned: null }), cutoff)).toBe(true);
  });
});

describe("CANDIDATE_WHERE_CLAUSE", () => {
  test("uses IS NOT TRUE for the nullable is_pinned column", () => {
    // `is_pinned = false` is NULL for NULL rows, which would silently exempt
    // them from the sweep AND from the partial index in migration 136.
    expect(CANDIDATE_WHERE_CLAUSE).toContain("is_pinned IS NOT TRUE");
    expect(CANDIDATE_WHERE_CLAUSE).not.toContain("is_pinned = false");
  });

  test("compares against UTC, not the session time zone", () => {
    expect(CANDIDATE_WHERE_CLAUSE).toContain("now() AT TIME ZONE 'UTC'");
  });

  test("does not filter on is_archived — archived conversations are eligible", () => {
    expect(CANDIDATE_WHERE_CLAUSE).not.toContain("is_archived");
  });

  test("uses exactly one bound parameter, $1, and never interpolates the window", () => {
    // index.ts composes this into a single sql.unsafe statement where the
    // retention window is $1 and the batch limit is $2. A second $1-numbered
    // placeholder here, or a literal window, would break that contract.
    const placeholders = CANDIDATE_WHERE_CLAUSE.match(/\$\d+/g) ?? [];
    expect(placeholders).toEqual(["$1"]);
  });
});

// ---------------------------------------------------------------------------
// documents.url → S3 object key
// ---------------------------------------------------------------------------

describe("documentUrlToObjectKey", () => {
  const BUCKET = "aistudio-documents-dev";

  test("passes a bare object key through (the current storage format)", () => {
    expect(documentUrlToObjectKey("7/1700000000-report.pdf", BUCKET)).toBe("7/1700000000-report.pdf");
    expect(documentUrlToObjectKey("repositories/42/abc/file.docx", BUCKET)).toBe(
      "repositories/42/abc/file.docx"
    );
  });

  test("extracts the key from a legacy virtual-hosted presigned URL", () => {
    // Rows written before the mid-2025 change stored the presigned URL. If we
    // rejected these, the oldest conversations — precisely the ones retention
    // targets — would leave their objects behind forever.
    expect(
      documentUrlToObjectKey(
        `https://${BUCKET}.s3.us-east-1.amazonaws.com/7/1700000000-report.pdf?X-Amz-Signature=abc`,
        BUCKET
      )
    ).toBe("7/1700000000-report.pdf");
  });

  test("extracts the key from a legacy path-style URL", () => {
    expect(
      documentUrlToObjectKey(`https://s3.us-east-1.amazonaws.com/${BUCKET}/7/a.pdf`, BUCKET)
    ).toBe("7/a.pdf");
  });

  test("url-decodes the key", () => {
    expect(
      documentUrlToObjectKey(`https://${BUCKET}.s3.amazonaws.com/7/my%20file.pdf`, BUCKET)
    ).toBe("7/my file.pdf");
  });

  test("refuses a URL for a DIFFERENT bucket", () => {
    expect(
      documentUrlToObjectKey("https://some-other-bucket.s3.amazonaws.com/7/a.pdf", BUCKET)
    ).toBeNull();
    expect(
      documentUrlToObjectKey(`https://s3.amazonaws.com/some-other-bucket/7/a.pdf`, BUCKET)
    ).toBeNull();
  });

  test("refuses non-S3 hosts (Supabase-era rows, CDNs) rather than guessing", () => {
    expect(documentUrlToObjectKey("https://xyz.supabase.co/storage/v1/a.pdf", BUCKET)).toBeNull();
    expect(documentUrlToObjectKey("https://cdn.example.com/7/a.pdf", BUCKET)).toBeNull();
  });

  test("refuses traversal, absolute and empty values", () => {
    expect(documentUrlToObjectKey("../../etc/passwd", BUCKET)).toBeNull();
    expect(documentUrlToObjectKey("/7/a.pdf", BUCKET)).toBeNull();
    expect(documentUrlToObjectKey("", BUCKET)).toBeNull();
    expect(documentUrlToObjectKey(null, BUCKET)).toBeNull();
    expect(documentUrlToObjectKey(`https://${BUCKET}.s3.amazonaws.com/`, BUCKET)).toBeNull();
    expect(
      documentUrlToObjectKey(`https://${BUCKET}.s3.amazonaws.com/a/../../b`, BUCKET)
    ).toBeNull();
  });

  test("refuses non-http schemes outright", () => {
    expect(documentUrlToObjectKey("s3://bucket/key", BUCKET)).toBeNull();
    expect(documentUrlToObjectKey("file:///etc/passwd", BUCKET)).toBeNull();
  });
});

describe("toObjectKey (message-part s3Key)", () => {
  test("accepts a bare key and rejects anything URL-shaped or traversing", () => {
    expect(toObjectKey("conversations/abc/attachments/1-0-x.png")).toBe(
      "conversations/abc/attachments/1-0-x.png"
    );
    expect(toObjectKey("s3://bucket/key")).toBeNull();
    expect(toObjectKey("https://example.com/key")).toBeNull();
    expect(toObjectKey("/leading")).toBeNull();
    expect(toObjectKey("a/../../b")).toBeNull();
    expect(toObjectKey("  ")).toBeNull();
    expect(toObjectKey(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runRetentionSweep — fake-port integration
// ---------------------------------------------------------------------------

interface FakeState {
  setting: string | null;
  candidates: CandidateConversation[];
  repositoriesByConversation: Record<string, number[]>;
  documentsByConversation: Record<string, LegacyDocument[]>;
  messageKeysByConversation: Record<string, string[]>;
  failRepositoryStorage?: number;
  failObjectKey?: string;
  failConversationStorage?: string;
}

interface FakeRecorder {
  calls: string[];
  deletedConversations: string[];
  deletedRepositoryRows: number[];
  deletedDocumentRows: number[];
  deletedStoragePrefixes: number[];
  deletedConversationPrefixes: string[];
  deletedObjectKeys: string[];
  findCandidatesCalls: number;
}

function makeFakePorts(state: FakeState): { ports: SweepPorts; rec: FakeRecorder } {
  const rec: FakeRecorder = {
    calls: [],
    deletedConversations: [],
    deletedRepositoryRows: [],
    deletedDocumentRows: [],
    deletedStoragePrefixes: [],
    deletedConversationPrefixes: [],
    deletedObjectKeys: [],
    findCandidatesCalls: 0,
  };

  const ports: SweepPorts = {
    getRetentionSetting: async () => state.setting,
    findCandidates: async (_days, limit) => {
      rec.findCandidatesCalls++;
      rec.calls.push("findCandidates");
      return state.candidates.slice(0, limit);
    },
    getBoundRepositoryIds: async (id) => {
      rec.calls.push(`getBoundRepositoryIds:${id}`);
      return state.repositoriesByConversation[id] ?? [];
    },
    getLegacyDocuments: async (id) => state.documentsByConversation[id] ?? [],
    getMessageObjectKeys: async (id) => state.messageKeysByConversation[id] ?? [],
    deleteConversationStorage: async (id) => {
      if (state.failConversationStorage === id) {
        throw new Error("Throttled");
      }
      rec.deletedConversationPrefixes.push(id);
      return 2;
    },
    deleteRepositoryStorage: async (repositoryId) => {
      if (state.failRepositoryStorage === repositoryId) {
        throw new Error("AccessDenied");
      }
      rec.deletedStoragePrefixes.push(repositoryId);
      return 3;
    },
    deleteObjectStorage: async (key) => {
      if (state.failObjectKey === key) {
        throw new Error("NoSuchKey");
      }
      rec.deletedObjectKeys.push(key);
      return 1;
    },
    deleteRepositoryRows: async (ids) => {
      rec.calls.push(`deleteRepositoryRows:${ids.join(",")}`);
      rec.deletedRepositoryRows.push(...ids);
      return ids.length;
    },
    deleteDocumentRows: async (ids) => {
      rec.deletedDocumentRows.push(...ids);
      return ids.length;
    },
    deleteConversationRow: async (id) => {
      rec.calls.push(`deleteConversationRow:${id}`);
      rec.deletedConversations.push(id);
      return 1;
    },
  };

  return { ports, rec };
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    setting: "30",
    candidates: [
      { id: "conv-1", userId: 7, lastMessageAt: new Date("2026-01-01T00:00:00.000Z"), isArchived: false },
    ],
    repositoriesByConversation: { "conv-1": [101, 102] },
    documentsByConversation: { "conv-1": [{ id: 5001, objectKey: "7/1700000000-a.pdf" }] },
    messageKeysByConversation: { "conv-1": ["nexus/att-1.png"] },
    ...overrides,
  };
}

describe("runRetentionSweep — disabled config", () => {
  for (const [label, setting] of [
    ["missing", null],
    ["empty (the seeded default)", ""],
    ["zero", "0"],
    ["negative", "-5"],
    ["non-numeric", "thirty"],
  ] as const) {
    test(`${label} → no-op, and no candidate scan is even issued`, async () => {
      const { ports, rec } = makeFakePorts(baseState({ setting }));
      const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

      expect(result.enabled).toBe(false);
      expect(result.conversationsDeleted).toBe(0);
      expect(result.candidates).toBe(0);
      expect(rec.findCandidatesCalls).toBe(0);
      expect(rec.deletedConversations).toEqual([]);
      expect(rec.deletedRepositoryRows).toEqual([]);
      expect(rec.deletedStoragePrefixes).toEqual([]);
      expect(rec.deletedObjectKeys).toEqual([]);
    });
  }
});

describe("runRetentionSweep — deletion ordering and completeness", () => {
  test("resolves repository IDs BEFORE deleting the conversation row", async () => {
    const { ports, rec } = makeFakePorts(baseState());
    await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    const resolveIdx = rec.calls.indexOf("getBoundRepositoryIds:conv-1");
    const deleteIdx = rec.calls.indexOf("deleteConversationRow:conv-1");
    expect(resolveIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    // nexus_repository_bindings cascades from the conversation; resolving after
    // the delete would orphan the knowledge_repositories rows permanently.
    expect(resolveIdx).toBeLessThan(deleteIdx);
  });

  test("leaves no orphaned knowledge_repositories rows", async () => {
    const { ports, rec } = makeFakePorts(baseState());
    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    expect(rec.deletedConversations).toEqual(["conv-1"]);
    // Every repository bound to the deleted conversation had both its storage
    // and its row removed.
    expect(rec.deletedRepositoryRows.sort()).toEqual([101, 102]);
    expect(rec.deletedStoragePrefixes.sort()).toEqual([101, 102]);
    expect(result.repositoryRowsDeleted).toBe(2);
  });

  test("deletes legacy documents rows and objects instead of leaving SET NULL orphans", async () => {
    const { ports, rec } = makeFakePorts(baseState());
    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    expect(rec.deletedDocumentRows).toEqual([5001]);
    expect(rec.deletedObjectKeys).toContain("7/1700000000-a.pdf");
    expect(result.documentRowsDeleted).toBe(1);
  });

  test("deletes out-of-prefix message-part object keys", async () => {
    const { ports, rec } = makeFakePorts(baseState());
    await runRetentionSweep(ports, silentLog, { batchLimit: 100 });
    expect(rec.deletedObjectKeys).toContain("nexus/att-1.png");
  });

  test("sweeps the conversation-scoped storage prefixes", async () => {
    // The persist path downgrades user image parts to { hasImage: true }, so
    // those objects have no s3Key left in the row — only a prefix sweep
    // reclaims them.
    const { ports, rec } = makeFakePorts(baseState());
    await runRetentionSweep(ports, silentLog, { batchLimit: 100 });
    expect(rec.deletedConversationPrefixes).toEqual(["conv-1"]);
  });

  test("a document whose url could not be resolved to a key still loses its row", async () => {
    const { ports, rec } = makeFakePorts(
      baseState({
        documentsByConversation: { "conv-1": [{ id: 5001, objectKey: null }] },
      })
    );
    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    // A dangling documents row pointing at a conversation that no longer
    // exists is worse than one unreferenced object.
    expect(rec.deletedDocumentRows).toEqual([5001]);
    expect(result.conversationsDeleted).toBe(1);
  });

  test("a failed conversation-prefix sweep is best-effort — the conversation still goes", async () => {
    // Unlike repository storage, these prefixes have no database row that a
    // failure would orphan, so they must not block deletion forever.
    const { ports, rec } = makeFakePorts(baseState({ failConversationStorage: "conv-1" }));
    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    expect(result.conversationsDeleted).toBe(1);
    expect(rec.deletedConversations).toEqual(["conv-1"]);
    expect(result.conversations[0]!.storageFailures).toBe(1);
  });

  test("honours the per-run batch cap", async () => {
    const { ports, rec } = makeFakePorts(
      baseState({
        candidates: [
          { id: "conv-1", userId: 1, lastMessageAt: new Date("2026-01-01"), isArchived: false },
          { id: "conv-2", userId: 1, lastMessageAt: new Date("2026-01-02"), isArchived: false },
          { id: "conv-3", userId: 1, lastMessageAt: new Date("2026-01-03"), isArchived: false },
        ],
        repositoriesByConversation: {},
        documentsByConversation: {},
        messageKeysByConversation: {},
      })
    );

    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 2 });
    expect(result.candidates).toBe(2);
    expect(rec.deletedConversations).toEqual(["conv-1", "conv-2"]);
  });
});

describe("runRetentionSweep — dry run", () => {
  test("reports candidates without deleting anything", async () => {
    const { ports, rec } = makeFakePorts(baseState());
    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.candidates).toBe(1);
    expect(result.conversations[0]!.conversationId).toBe("conv-1");
    expect(result.conversations[0]!.repositoryIds).toEqual([101, 102]);
    expect(result.conversationsDeleted).toBe(0);
    expect(rec.deletedConversations).toEqual([]);
    expect(rec.deletedRepositoryRows).toEqual([]);
    expect(rec.deletedDocumentRows).toEqual([]);
    expect(rec.deletedStoragePrefixes).toEqual([]);
    expect(rec.deletedObjectKeys).toEqual([]);
  });
});

describe("runRetentionSweep — storage failure policy", () => {
  test("a failed repository prefix delete aborts that conversation, deleting nothing", async () => {
    const { ports, rec } = makeFakePorts(baseState({ failRepositoryStorage: 101 }));
    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    expect(result.conversationsDeleted).toBe(0);
    expect(result.conversationsSkipped).toBe(1);
    expect(result.conversations[0]!.skippedReason).toBe("repository_storage_failed");
    // Critically: the row is still there to retry, and no repository row was
    // deleted out from under its surviving objects.
    expect(rec.deletedConversations).toEqual([]);
    expect(rec.deletedRepositoryRows).toEqual([]);
    expect(rec.deletedDocumentRows).toEqual([]);
  });

  test("a failed single-object delete is best-effort — the conversation still goes", async () => {
    const { ports, rec } = makeFakePorts(baseState({ failObjectKey: "7/1700000000-a.pdf" }));
    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    expect(result.conversationsDeleted).toBe(1);
    expect(rec.deletedConversations).toEqual(["conv-1"]);
    expect(result.conversations[0]!.storageFailures).toBe(1);
  });

  test("one failing conversation does not stop the rest of the batch", async () => {
    const { ports, rec } = makeFakePorts(
      baseState({
        candidates: [
          { id: "conv-1", userId: 1, lastMessageAt: new Date("2026-01-01"), isArchived: false },
          { id: "conv-2", userId: 1, lastMessageAt: new Date("2026-01-02"), isArchived: false },
        ],
        repositoriesByConversation: { "conv-1": [101], "conv-2": [201] },
        documentsByConversation: {},
        messageKeysByConversation: {},
        failRepositoryStorage: 101,
      })
    );

    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });
    expect(result.conversationsDeleted).toBe(1);
    expect(result.conversationsSkipped).toBe(1);
    expect(rec.deletedConversations).toEqual(["conv-2"]);
  });
});
