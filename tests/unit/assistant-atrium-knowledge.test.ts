/**
 * Unit tests for the Atrium content-as-context helper wired into assistant
 * execution (Epic #1059 completion, Phase 6 / Issue #1056):
 * `retrieveAtriumKnowledgeForPrompt` + `formatAtriumKnowledgeContext` in
 * lib/assistant-architect/knowledge-retrieval.ts.
 *
 * The contract under test:
 *  - DEFAULT OFF: a null/unset `assistant_architects.retrieval_scope` returns []
 *    WITHOUT calling `retrievalService.searchForAssistant` — pre-Phase-6
 *    assistants behave exactly as before.
 *  - FAIL CLOSED: a null requester (no derivable caller identity) skips
 *    retrieval entirely — not even the scope-gate query runs.
 *  - Permission boundary: the EXACT caller requester is passed through to
 *    `searchForAssistant` (which enforces per-hit canView).
 *  - Size caps: the same token budget as the repository path (whole chunks
 *    until the cap; one truncated tail when ≥100 tokens remain).
 *  - Failure posture: any error logs and returns [] (never fails an execution).
 */

let scopeRows: Array<{ retrievalScope: unknown }> = [];
const executeQueryMock = jest.fn(async (_cb: unknown, _label: string) => scopeRows);
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) =>
    executeQueryMock(...(args as [unknown, string])),
}));
jest.mock("@/lib/db/schema", () => ({
  assistantArchitects: { id: "aa.id", retrievalScope: "aa.retrievalScope" },
}));
jest.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), {}),
}));
const retrieveRepositoryContentMock = jest.fn(
  async (..._args: unknown[]): Promise<{
    results: Array<Record<string, unknown>>;
    diagnostics: Record<string, unknown>;
  }> => ({
    results: [],
    diagnostics: {},
  }),
);
jest.mock("@/lib/repositories/retrieval-v2/service", () => ({
  retrieveRepositoryContent: (...args: unknown[]) =>
    retrieveRepositoryContentMock(...args),
}));
const contentReadV2ActiveMock = jest.fn((_config: unknown) => true);
jest.mock("@/lib/repositories/content-platform/config", () => ({
  getContentPlatformConfig: jest.fn(async () => ({
    enabled: true,
    readV2Enabled: true,
  })),
  isContentReadV2Active: (config: unknown) => contentReadV2ActiveMock(config),
}));
const accessibleRepositoriesMock = jest.fn(
  async (..._args: unknown[]): Promise<
    Array<{ id: number; name: string; isAccessible: boolean }>
  > => []
);
jest.mock("@/lib/db/drizzle", () => ({
  getAccessibleRepositoriesByCognitoSub: (...args: unknown[]) =>
    accessibleRepositoriesMock(...args),
}));
const hybridSearchMock = jest.fn(
  async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => []
);
const vectorSearchMock = jest.fn(
  async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => []
);
jest.mock("@/lib/repositories/search-service", () => ({
  hybridSearch: (...args: unknown[]) => hybridSearchMock(...args),
  vectorSearch: (...args: unknown[]) => vectorSearchMock(...args),
}));
// Deterministic ~4-chars-per-token tokenizer (mirrors countTokens' fallback).
jest.mock("js-tiktoken", () => ({
  encodingForModel: () => ({
    encode: (text: string) => new Array(Math.ceil(text.length / 4)).fill(0),
  }),
}));

// retrieval-service is imported LAZILY by the helper; jest intercepts the
// dynamic import through the module registry.
const searchForAssistantMock = jest.fn(
  async (..._args: unknown[]): Promise<unknown[]> => []
);
jest.mock("@/lib/content/retrieval-service", () => ({
  retrievalService: {
    searchForAssistant: (...args: unknown[]) => searchForAssistantMock(...args),
  },
}));

// requesterForUserId backs the scheduled-run owner fallback (Fix #2). The helper
// under test statically imports it from this concrete module (not the barrel).
const requesterForUserIdMock = jest.fn(
  async (..._args: unknown[]): Promise<unknown> => null
);
jest.mock("@/lib/content/requester-from-auth", () => ({
  requesterForUserId: (...args: unknown[]) => requesterForUserIdMock(...args),
}));

import {
  retrieveAtriumKnowledgeForPrompt,
  retrieveKnowledgeForPrompt,
  formatAtriumKnowledgeContext,
  resolveScheduledAtriumRetrievalRequester,
} from "@/lib/assistant-architect/knowledge-retrieval";
import type { Requester } from "@/lib/content/types";
import type { RetrievalHit } from "@/lib/content/retrieval-service";

const staffUser: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};

function hit(overrides: Partial<RetrievalHit> = {}): RetrievalHit {
  return {
    objectId: "obj-1",
    title: "Handbook",
    slug: "handbook",
    chunkId: 1,
    content: "chunk content",
    similarity: 0.91,
    chunkIndex: 0,
    ...overrides,
  };
}

beforeEach(() => {
  scopeRows = [{ retrievalScope: { collectionId: "col-1" } }];
  executeQueryMock.mockClear();
  searchForAssistantMock.mockReset();
  searchForAssistantMock.mockResolvedValue([]);
  retrieveRepositoryContentMock.mockReset();
  retrieveRepositoryContentMock.mockResolvedValue({ results: [], diagnostics: {} });
  contentReadV2ActiveMock.mockReset();
  contentReadV2ActiveMock.mockReturnValue(true);
  accessibleRepositoriesMock.mockReset();
  accessibleRepositoriesMock.mockResolvedValue([]);
  hybridSearchMock.mockReset();
  hybridSearchMock.mockResolvedValue([]);
  vectorSearchMock.mockReset();
  vectorSearchMock.mockResolvedValue([]);
});

describe("retrieveKnowledgeForPrompt — shared repository retrieval", () => {
  it("uses the executing user rather than the assistant owner and includes expanded context", async () => {
    retrieveRepositoryContentMock.mockResolvedValue({
      results: [
        {
          chunkId: 8,
          itemId: 9,
          itemName: "Handbook",
          content: "primary",
          similarity: 0.9,
          repositoryId: 10,
          repositoryName: "Policies",
          context: [
            {
              contextPrefix: "Page 4",
              content: "expanded policy context",
            },
          ],
        },
      ],
      diagnostics: {},
    });

    const chunks = await retrieveKnowledgeForPrompt(
      "what is the policy?",
      [10],
      "executing-user",
      "assistant-owner",
      { maxChunks: 4, maxTokens: 1200, vectorWeight: 0.65 },
    );

    expect(retrieveRepositoryContentMock).toHaveBeenCalledWith({
      query: "what is the policy?",
      repositoryIds: [10],
      userCognitoSub: "executing-user",
      mode: "hybrid",
      limit: 4,
      threshold: 0.7,
      tokenBudget: 1200,
      denseWeight: 0.65,
    });
    expect(chunks[0]?.content).toBe("Page 4\nexpanded policy context");
  });

  it("keeps legacy retrieval available behind the rollout flag without owner elevation", async () => {
    contentReadV2ActiveMock.mockReturnValue(false);
    accessibleRepositoriesMock.mockResolvedValue([
      { id: 10, name: "Policies", isAccessible: true },
      { id: 11, name: "Private", isAccessible: false },
    ]);
    hybridSearchMock.mockResolvedValue([
      {
        chunkId: 8,
        itemId: 9,
        itemName: "Handbook",
        content: "legacy policy",
        similarity: 0.8,
        chunkIndex: 0,
        metadata: {},
      },
    ]);

    const chunks = await retrieveKnowledgeForPrompt(
      "what is the policy?",
      [10, 11],
      "executing-user",
      "assistant-owner",
      { maxChunks: 4, maxTokens: 1200, vectorWeight: 0.65 },
    );

    expect(accessibleRepositoriesMock).toHaveBeenCalledWith(
      [10, 11],
      "executing-user",
    );
    expect(hybridSearchMock).toHaveBeenCalledWith("what is the policy?", {
      repositoryId: 10,
      limit: 4,
      threshold: 0.7,
      vectorWeight: 0.65,
    });
    expect(retrieveRepositoryContentMock).not.toHaveBeenCalled();
    expect(chunks).toEqual([
      expect.objectContaining({
        content: "legacy policy",
        repositoryId: 10,
        repositoryName: "Policies",
      }),
    ]);
  });
});

describe("retrieveAtriumKnowledgeForPrompt — gating", () => {
  it("returns [] without ANY query when no requester is derivable (fail closed)", async () => {
    const hits = await retrieveAtriumKnowledgeForPrompt(null, 5, "prompt");
    expect(hits).toEqual([]);
    expect(executeQueryMock).not.toHaveBeenCalled();
    expect(searchForAssistantMock).not.toHaveBeenCalled();
  });

  it("returns [] WITHOUT searching when retrieval_scope is null (default off)", async () => {
    scopeRows = [{ retrievalScope: null }];
    const hits = await retrieveAtriumKnowledgeForPrompt(staffUser, 5, "prompt");
    expect(hits).toEqual([]);
    expect(searchForAssistantMock).not.toHaveBeenCalled();
  });

  it("returns [] WITHOUT searching for an unknown assistant id", async () => {
    scopeRows = [];
    const hits = await retrieveAtriumKnowledgeForPrompt(staffUser, 999, "prompt");
    expect(hits).toEqual([]);
    expect(searchForAssistantMock).not.toHaveBeenCalled();
  });

  it("searches with the EXACT caller requester when a scope is set (permission boundary)", async () => {
    searchForAssistantMock.mockResolvedValue([hit()]);
    const hits = await retrieveAtriumKnowledgeForPrompt(
      staffUser,
      5,
      "what is the policy?",
      { maxChunks: 10, maxTokens: 4000 },
      "req-1"
    );
    expect(hits).toHaveLength(1);
    expect(searchForAssistantMock).toHaveBeenCalledTimes(1);
    const [reqArg, assistantIdArg, queryArg, optsArg] =
      searchForAssistantMock.mock.calls[0];
    // Same reference: the caller's identity IS the permission boundary — no
    // substitute/elevated requester may ever be passed through.
    expect(reqArg).toBe(staffUser);
    expect(assistantIdArg).toBe(5);
    expect(queryArg).toBe("what is the policy?");
    expect(optsArg).toEqual({ limit: 10, threshold: undefined });
  });

  it("returns [] when the search throws (retrieval never fails an execution)", async () => {
    searchForAssistantMock.mockRejectedValue(new Error("vector store down"));
    const hits = await retrieveAtriumKnowledgeForPrompt(staffUser, 5, "prompt");
    expect(hits).toEqual([]);
  });
});

describe("retrieveAtriumKnowledgeForPrompt — token budget", () => {
  it("keeps whole hits until the cap and truncates one tail hit (≥100 tokens room)", async () => {
    // ~4 chars/token under the mocked tokenizer: hit A = 400 tokens,
    // hit B = 400 tokens; cap 550 → A whole, B truncated with the marker.
    searchForAssistantMock.mockResolvedValue([
      hit({ chunkId: 1, content: "a".repeat(1600) }),
      hit({ chunkId: 2, content: "b".repeat(1600) }),
    ]);
    const hits = await retrieveAtriumKnowledgeForPrompt(staffUser, 5, "q", {
      maxTokens: 550,
    });
    expect(hits).toHaveLength(2);
    expect(hits[0].content).toBe("a".repeat(1600));
    expect(hits[1].content).toContain("[... truncated for token limit]");
    expect(hits[1].content.length).toBeLessThan(1600);
  });

  it("drops the tail hit entirely when under 100 tokens remain", async () => {
    // Hit A = 400 tokens, cap 450 → only 50 tokens of room: too small to be
    // useful, so hit B is dropped rather than truncated to a fragment.
    searchForAssistantMock.mockResolvedValue([
      hit({ chunkId: 1, content: "a".repeat(1600) }),
      hit({ chunkId: 2, content: "b".repeat(1600) }),
    ]);
    const hits = await retrieveAtriumKnowledgeForPrompt(staffUser, 5, "q", {
      maxTokens: 450,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].chunkId).toBe(1);
  });
});

describe("resolveScheduledAtriumRetrievalRequester — owner fallback (Fix #2)", () => {
  const ownerUser: Requester = {
    kind: "user",
    userId: 42,
    roles: ["staff"],
    isAdmin: false,
  };
  const agentIdentity: Requester = {
    kind: "agent-autonomous",
    agentId: "agent-1",
    roleId: null,
    roles: [],
    scopes: ["content:read"],
    agentLabel: "Scheduler Bot",
  };

  beforeEach(() => {
    requesterForUserIdMock.mockReset();
    requesterForUserIdMock.mockResolvedValue(null);
  });

  it("uses the agent identity requester when one is set (owner fallback NOT consulted)", async () => {
    const result = await resolveScheduledAtriumRetrievalRequester(
      agentIdentity,
      42
    );
    // Same reference passed straight through — the write/execution identity is the
    // retrieval identity when present.
    expect(result).toBe(agentIdentity);
    expect(requesterForUserIdMock).not.toHaveBeenCalled();
  });

  it("falls back to the schedule owner's user requester when no identity is set", async () => {
    requesterForUserIdMock.mockResolvedValue(ownerUser);
    const result = await resolveScheduledAtriumRetrievalRequester(null, 42);
    expect(result).toBe(ownerUser);
    expect(requesterForUserIdMock).toHaveBeenCalledTimes(1);
    expect(requesterForUserIdMock).toHaveBeenCalledWith(42);
  });

  it("returns null (fail closed, no retrieval) when neither identity nor owner resolves", async () => {
    requesterForUserIdMock.mockResolvedValue(null);
    const result = await resolveScheduledAtriumRetrievalRequester(null, 42);
    expect(result).toBeNull();
    expect(requesterForUserIdMock).toHaveBeenCalledWith(42);
  });
});

describe("formatAtriumKnowledgeContext", () => {
  it("labels every hit with its title and an atrium:<slug> source marker", async () => {
    const block = formatAtriumKnowledgeContext([
      hit({ title: "Staff Handbook", slug: "staff-handbook" }),
      hit({ title: "AI Policy", slug: "ai-policy", similarity: 0.8 }),
    ]);
    expect(block).toContain("# Atrium Content Context");
    expect(block).toContain("## Atrium Source 1: Staff Handbook (atrium:staff-handbook)");
    expect(block).toContain("## Atrium Source 2: AI Policy (atrium:ai-policy)");
    expect(block).toContain("Relevance Score: 91.0%");
    expect(block).toContain("Relevance Score: 80.0%");
  });

  it("returns an empty string for no hits (nothing is injected)", () => {
    expect(formatAtriumKnowledgeContext([])).toBe("");
  });
});
