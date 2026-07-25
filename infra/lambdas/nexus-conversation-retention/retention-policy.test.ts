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
 *   - the guarded row DELETE is the FIRST destructive act and re-asserts the
 *     full predicate including age, so a user who Keeps, pins, or sends a new
 *     message mid-sweep loses nothing — including bound repository storage
 *   - only repository_kind='ephemeral' repositories are ever swept
 */

import { test, expect, describe } from "bun:test";
import {
  parseRetentionDays,
  isEligibleForDeletion,
  retentionCutoff,
  CANDIDATE_WHERE_CLAUSE,
  NO_COMMITTED_MESSAGE_INSIDE_WINDOW_SQL,
  type ConversationEligibilityRow,
} from "./retention-policy";
import {
  runRetentionSweep,
  type CandidateConversation,
  type LegacyDocument,
  type SweepPorts,
  type SweepLogger,
} from "./sweep";
import {
  documentUrlToObjectKey,
  toObjectKey,
  BOUND_EPHEMERAL_REPOSITORIES_SQL,
  extractOutOfPrefixKeys,
} from "./index";

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
    // them from the sweep AND from the partial index in migration 137.
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
  /** Conversation ids that the late re-check reports as no longer eligible. */
  becameIneligible?: string[];
  /**
   * Conversation ids that pass the late re-check but are protected by the
   * guarded DELETE — i.e. the user won the race in the window between the two.
   */
  racedAtDelete?: string[];
  /** Repository ids promoted to 'durable' between resolution and the claim. */
  promotedMidSweep?: number[];
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
  /** retentionDays value the guarded row DELETE was invoked with. */
  gateRetentionDays: number[];
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
    gateRetentionDays: [],
  };

  const ports: SweepPorts = {
    getRetentionSetting: async () => state.setting,
    findCandidates: async (_days, limit) => {
      rec.findCandidatesCalls++;
      rec.calls.push("findCandidates");
      return state.candidates.slice(0, limit);
    },
    isStillEligible: async (id) => {
      rec.calls.push(`isStillEligible:${id}`);
      return !(state.becameIneligible ?? []).includes(id);
    },
    getBoundRepositoryIds: async (id) => {
      rec.calls.push(`getBoundRepositoryIds:${id}`);
      return state.repositoriesByConversation[id] ?? [];
    },
    getLegacyDocuments: async (id) => state.documentsByConversation[id] ?? [],
    getMessageObjectKeys: async (id) => state.messageKeysByConversation[id] ?? [],
    deleteConversationStorage: async (id) => {
      rec.calls.push(`deleteConversationStorage:${id}`);
      if (state.failConversationStorage === id) {
        throw new Error("Throttled");
      }
      rec.deletedConversationPrefixes.push(id);
      return 2;
    },
    deleteRepositoryStorage: async (repositoryId) => {
      rec.calls.push(`deleteRepositoryStorage:${repositoryId}`);
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
    claimRepositoryRows: async (ids) => {
      rec.calls.push(`claimRepositoryRows:${ids.join(",")}`);
      // Models the guarded DELETE: a repository promoted to 'durable' since
      // resolution matches nothing and is not returned.
      const claimed = ids.filter((id) => !(state.promotedMidSweep ?? []).includes(id));
      rec.deletedRepositoryRows.push(...claimed);
      return claimed;
    },
    deleteDocumentRows: async (ids) => {
      rec.deletedDocumentRows.push(...ids);
      return ids.length;
    },
    deleteConversationRow: async (id, retentionDays) => {
      rec.calls.push(`deleteConversationRow:${id}`);
      rec.gateRetentionDays.push(retentionDays);
      // Models the guarded DELETE: its WHERE re-asserts the FULL predicate
      // (Keep, pin, age), so a raced row matches nothing and reports 0 deleted.
      if ((state.racedAtDelete ?? []).includes(id)) return 0;
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

describe("runRetentionSweep — Keep wins races against the sweep", () => {
  // findCandidates snapshots the batch at the top of the run, then the loop
  // works through it sequentially over what can be minutes. A user clicking
  // Keep inside that window must not lose the conversation.

  test("a conversation that becomes ineligible after selection is not touched at all", async () => {
    const { ports, rec } = makeFakePorts(baseState({ becameIneligible: ["conv-1"] }));
    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    expect(result.conversationsDeleted).toBe(0);
    expect(result.conversationsSkipped).toBe(1);
    expect(result.conversations[0]!.skippedReason).toBe("no_longer_eligible");
    // Nothing destroyed — not even S3, which is why the re-check runs before
    // any storage deletion rather than just before the row delete.
    expect(rec.deletedConversations).toEqual([]);
    expect(rec.deletedStoragePrefixes).toEqual([]);
    expect(rec.deletedConversationPrefixes).toEqual([]);
    expect(rec.deletedObjectKeys).toEqual([]);
    expect(rec.deletedRepositoryRows).toEqual([]);
    expect(rec.deletedDocumentRows).toEqual([]);
  });

  test("the re-check happens BEFORE any storage deletion", async () => {
    const { ports, rec } = makeFakePorts(baseState());
    await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    const recheckIdx = rec.calls.indexOf("isStillEligible:conv-1");
    const deleteIdx = rec.calls.indexOf("deleteConversationRow:conv-1");
    expect(recheckIdx).toBeGreaterThanOrEqual(0);
    expect(recheckIdx).toBeLessThan(deleteIdx);
  });

  test("the guarded DELETE is the atomic claim: 0 rows means the user won and NOTHING was removed", async () => {
    // Models Keep (or a new message — the gate re-asserts age too) landing in
    // the window between the re-check and the DELETE.
    const { ports, rec } = makeFakePorts(baseState({ racedAtDelete: ["conv-1"] }));
    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    expect(result.conversationsDeleted).toBe(0);
    expect(result.conversationsSkipped).toBe(1);
    expect(result.conversations[0]!.skippedReason).toBe("keep_race_detected");
    expect(rec.deletedConversations).toEqual([]);
    // EVERYTHING survives — including bound repository storage. The claim is
    // the first destructive act, so winning the race costs the user nothing.
    expect(rec.deletedRepositoryRows).toEqual([]);
    expect(rec.deletedDocumentRows).toEqual([]);
    expect(rec.deletedConversationPrefixes).toEqual([]);
    expect(rec.deletedObjectKeys).toEqual([]);
    expect(rec.deletedStoragePrefixes).toEqual([]);
  });

  test("the claim precedes ALL storage deletion, repository storage included", async () => {
    const { ports, rec } = makeFakePorts(baseState());
    await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    const claimIdx = rec.calls.indexOf("deleteConversationRow:conv-1");
    const repoStorageIdx = rec.calls.indexOf("deleteRepositoryStorage:101");
    const convStorageIdx = rec.calls.indexOf("deleteConversationStorage:conv-1");
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    expect(repoStorageIdx).toBeGreaterThan(claimIdx);
    expect(convStorageIdx).toBeGreaterThan(claimIdx);
  });

  test("the claim re-asserts the age cutoff: retentionDays reaches the DELETE itself", async () => {
    // A user who sends a new message after the late re-check bumps
    // last_message_at; only the age predicate inside the DELETE's own WHERE
    // makes that save the conversation atomically.
    const { ports, rec } = makeFakePorts(baseState());
    await runRetentionSweep(ports, silentLog, { batchLimit: 100 });
    expect(rec.gateRetentionDays).toEqual([30]);
  });

  test("a raced conversation does not stop the rest of the batch", async () => {
    const { ports, rec } = makeFakePorts(
      baseState({
        candidates: [
          { id: "conv-1", userId: 1, lastMessageAt: new Date("2026-01-01"), isArchived: false },
          { id: "conv-2", userId: 1, lastMessageAt: new Date("2026-01-02"), isArchived: false },
        ],
        repositoriesByConversation: {},
        documentsByConversation: {},
        messageKeysByConversation: {},
        becameIneligible: ["conv-1"],
      })
    );

    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });
    expect(result.conversationsDeleted).toBe(1);
    expect(rec.deletedConversations).toEqual(["conv-2"]);
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
  test("a failed repository prefix delete orphans objects but does not stop the sweep", async () => {
    // The claim (row DELETE, guarded on repository_kind='ephemeral') is what
    // authorises touching storage, so it necessarily precedes any failure.
    // Repository 101's storage delete then fails: its objects are orphaned and
    // ERROR-logged. That is the deliberate trade-off — the inverse ordering
    // (storage first, claim second) is exactly what allowed a repository
    // promoted mid-sweep to lose its data irreversibly.
    const { ports, rec } = makeFakePorts(baseState({ failRepositoryStorage: 101 }));
    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    expect(result.conversationsDeleted).toBe(1);
    expect(rec.deletedConversations).toEqual(["conv-1"]);
    expect(result.conversations[0]!.storageFailures).toBe(1);
    expect(rec.deletedStoragePrefixes).toEqual([102]);
    expect(rec.deletedRepositoryRows).toEqual([101, 102]);
  });

  test("a repository promoted mid-sweep keeps BOTH its row and its storage", async () => {
    // The P1 this ordering exists for: resolution saw 101 as ephemeral, the
    // user promoted it to 'durable' before the claim, so the guarded row
    // DELETE matches nothing and its storage is never touched.
    const { ports, rec } = makeFakePorts(baseState({ promotedMidSweep: [101] }));
    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    expect(result.conversationsDeleted).toBe(1);
    expect(rec.deletedRepositoryRows).toEqual([102]);
    expect(rec.deletedStoragePrefixes).toEqual([102]);
    expect(rec.deletedStoragePrefixes).not.toContain(101);
    expect(result.repositoryRowsDeleted).toBe(1);
  });

  test("a failed single-object delete is best-effort — the conversation still goes", async () => {
    const { ports, rec } = makeFakePorts(baseState({ failObjectKey: "7/1700000000-a.pdf" }));
    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    expect(result.conversationsDeleted).toBe(1);
    expect(rec.deletedConversations).toEqual(["conv-1"]);
    expect(result.conversations[0]!.storageFailures).toBe(1);
  });

  test("a storage failure in one conversation does not stop the rest of the batch", async () => {
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
    expect(result.conversationsDeleted).toBe(2);
    expect(rec.deletedConversations).toEqual(["conv-1", "conv-2"]);
    // Both rows are claimed: the claim is what authorises touching storage, so
    // it necessarily precedes the failure. A failed prefix delete therefore
    // orphans objects (ERROR-logged) rather than stranding a row — the inverse
    // trade-off is what let a promoted repository lose its data.
    expect(rec.deletedRepositoryRows).toEqual([101, 201]);
  });
});

// ---------------------------------------------------------------------------
// Ephemeral-only repository scope
// ---------------------------------------------------------------------------

describe("BOUND_EPHEMERAL_REPOSITORIES_SQL", () => {
  test("filters to repository_kind = 'ephemeral' via the knowledge_repositories join", () => {
    // promoteNexusRepository flips a repository to 'durable' but keeps its
    // conversation binding. Without this filter the sweep would permanently
    // destroy a repository the user explicitly saved — and 'system'
    // repositories bound for retrieval context along with it.
    expect(BOUND_EPHEMERAL_REPOSITORIES_SQL).toContain("JOIN knowledge_repositories");
    expect(BOUND_EPHEMERAL_REPOSITORIES_SQL).toContain("repository_kind = 'ephemeral'");
  });

  test("uses exactly one bound parameter, $1 (the conversation id)", () => {
    const placeholders = BOUND_EPHEMERAL_REPOSITORIES_SQL.match(/\$\d+/g) ?? [];
    expect(placeholders).toEqual(["$1"]);
  });
});

// ---------------------------------------------------------------------------
// Per-conversation error isolation
// ---------------------------------------------------------------------------

describe("runRetentionSweep — unexpected error isolation", () => {
  test("a database error on one conversation does not abandon the rest of the batch", async () => {
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

    // findCandidates is ordered oldest-first, so without isolation this
    // conversation would be selected first every single night and stall the
    // entire retention feature indefinitely.
    const originalDelete = ports.deleteConversationRow;
    ports.deleteConversationRow = async (id, retentionDays) => {
      if (id === "conv-1") throw new Error("deadlock detected");
      return originalDelete(id, retentionDays);
    };

    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    expect(result.conversationsFailed).toBe(1);
    expect(result.conversationsDeleted).toBe(2);
    expect(rec.deletedConversations).toEqual(["conv-2", "conv-3"]);
  });

  test("row counters report what the database actually deleted, not what was planned", async () => {
    const { ports } = makeFakePorts(baseState());

    // Simulates a partially-completed previous run: the IDs still resolve, but
    // the rows are already gone, so the delete affects fewer rows than planned.
    ports.claimRepositoryRows = async () => [101]; // 2 ids resolved, 1 row actually claimed
    ports.deleteDocumentRows = async () => 0; // 1 id resolved, 0 rows actually deleted

    const result = await runRetentionSweep(ports, silentLog, { batchLimit: 100 });

    expect(result.conversationsDeleted).toBe(1);
    expect(result.repositoryRowsDeleted).toBe(1);
    expect(result.documentRowsDeleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Legacy message-part key ownership
// ---------------------------------------------------------------------------

describe("extractOutOfPrefixKeys — ownership, not just syntax", () => {
  const CONV = "11111111-1111-4111-8111-111111111111";
  const OWNER = 7;

  const rowsWith = (...s3Keys: string[]) => [
    { parts: s3Keys.map((s3Key) => ({ type: "image", s3Key })) },
  ];

  test("keys inside the conversation prefixes are skipped (the prefix sweep covers them)", () => {
    expect(
      extractOutOfPrefixKeys(
        rowsWith(`conversations/${CONV}/attachments/1-0-a.png`, `v2/generated-images/${CONV}/x.png`),
        CONV,
        OWNER
      )
    ).toEqual([]);
  });

  test("accepts an out-of-prefix key inside the OWNER's legacy namespace", () => {
    expect(extractOutOfPrefixKeys(rowsWith("7/1700000000-a.png"), CONV, OWNER)).toEqual([
      "7/1700000000-a.png",
    ]);
  });

  test("refuses an out-of-prefix key belonging to a DIFFERENT user", () => {
    // The Lambda's IAM grant is bucket-wide and these deletes remove every
    // version, so a legacy row carrying a key copied from elsewhere must never
    // be trusted on syntax alone.
    expect(extractOutOfPrefixKeys(rowsWith("8/1700000000-a.png"), CONV, OWNER)).toEqual([]);
    expect(extractOutOfPrefixKeys(rowsWith("conversations/other-conv/x.png"), CONV, OWNER)).toEqual(
      []
    );
    expect(extractOutOfPrefixKeys(rowsWith("atrium/pending-assets/x.png"), CONV, OWNER)).toEqual([]);
  });

  test("a userId prefix must match on the whole segment, not as a string prefix", () => {
    // user 7 must not reach user 70's namespace
    expect(extractOutOfPrefixKeys(rowsWith("70/1700000000-a.png"), CONV, OWNER)).toEqual([]);
  });

  test("ignores malformed parts without throwing", () => {
    expect(extractOutOfPrefixKeys([{ parts: null }, { parts: "nope" }], CONV, OWNER)).toEqual([]);
    expect(extractOutOfPrefixKeys([{ parts: [null, 3, { type: "text" }] }], CONV, OWNER)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Committed-message gate
// ---------------------------------------------------------------------------

describe("NO_COMMITTED_MESSAGE_INSIDE_WINDOW_SQL", () => {
  test("derives age from committed nexus_messages rows, not the denormalized clock", () => {
    // upsertMessageWithStats inserts the message and updates the conversation
    // stats as two separate statements ("Not atomic" per its own docstring), so
    // last_message_at can read stale while a message is already committed —
    // transiently, or permanently if the stats update failed.
    expect(NO_COMMITTED_MESSAGE_INSIDE_WINDOW_SQL).toContain("NOT EXISTS");
    expect(NO_COMMITTED_MESSAGE_INSIDE_WINDOW_SQL).toContain("FROM nexus_messages m");
    expect(NO_COMMITTED_MESSAGE_INSIDE_WINDOW_SQL).toContain("m.created_at >=");
    expect(NO_COMMITTED_MESSAGE_INSIDE_WINDOW_SQL).toContain(
      "m.conversation_id = nexus_conversations.id"
    );
  });

  test("compares against UTC and reuses $1 so it composes with the candidate clause", () => {
    expect(NO_COMMITTED_MESSAGE_INSIDE_WINDOW_SQL).toContain("now() AT TIME ZONE 'UTC'");
    const placeholders = NO_COMMITTED_MESSAGE_INSIDE_WINDOW_SQL.match(/\$\d+/g) ?? [];
    expect(placeholders).toEqual(["$1"]);
  });

  test("is NOT part of the bulk candidate scan — that stays a cheap indexed range read", () => {
    expect(CANDIDATE_WHERE_CLAUSE).not.toContain("NOT EXISTS");
    expect(CANDIDATE_WHERE_CLAUSE).not.toContain("nexus_messages");
  });
});
