/**
 * Wiring tests for §28.3 agent screening on the content write paths (Epic #1059
 * completion): `contentService.create` and `versionService.snapshot` must run
 * the shared screening core BEFORE their write transaction — agent-authored
 * bodies only, humans untouched.
 *
 * Technique (mirrors atrium-version-snapshot.test.ts): `executeTransaction` is a
 * sentinel-throwing trap. A path that PASSES screening reaches the trap and
 * rejects with the sentinel; a path that screening blocks rejects with
 * `ValidationError` and never reaches the trap. This proves both the ordering
 * (screen-before-tx) and the fail-closed behavior without stubbing the
 * screening module itself — only the lazily-imported `@/lib/safety` boundary
 * and the DB/IO collaborators are mocked.
 */

const TX_SENTINEL = "reached executeTransaction (screening passed)";

let checkResult: { allowed: boolean; degraded?: boolean; blockedMessage?: string } = {
  allowed: true,
};
const checkInputSafetyMock = jest.fn(async (..._args: unknown[]) => checkResult);

jest.mock("@/lib/safety", () => ({
  getContentSafetyService: () => ({
    checkInputSafety: (...args: unknown[]) => checkInputSafetyMock(...args),
  }),
  getPIITokenizationService: () => ({
    detectPII: jest.fn(async () => []),
  }),
}));

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async () => []),
  executeTransaction: jest.fn(async () => {
    throw new Error(TX_SENTINEL);
  }),
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: {},
  contentCollections: {},
  contentVersions: {},
}));
jest.mock("@/lib/db/json-utils", () => ({
  safeJsonbStringify: (v: unknown) => JSON.stringify(v),
}));
jest.mock("@/lib/db/drizzle-helpers", () => ({
  pgTimestampAsText: (c: unknown) => c,
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  like: (...a: unknown[]) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), { join: () => ({}) }),
}));
jest.mock("@/lib/content/mappers", () => ({
  objectSelectFields: {},
  rowToObjectDTO: (row: Record<string, unknown>) => row,
}));
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {
    canView: jest.fn(async () => true),
    assertWritableLevel: jest.fn(),
    applyGrantsForLevel: jest.fn(),
  },
}));
jest.mock("@/lib/content/events", () => ({
  contentEvents: { emit: jest.fn(async () => undefined) },
}));
jest.mock("@/lib/content/render/markdown-render", () => ({
  renderMarkdownToHtml: () => "<p>unused</p>",
}));
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: { key: () => "k", putText: jest.fn(), getText: jest.fn() },
}));

import { contentService } from "@/lib/content/content-service";
import { versionService } from "@/lib/content/version-service";
import { ValidationError } from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const humanUser: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
const autonomousAgent: Requester = {
  kind: "agent-autonomous",
  agentId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  roleId: null,
  roles: ["staff"],
  scopes: ["content:create", "content:update"],
  agentLabel: "ship-reporter",
};

beforeAll(() => {
  // ownerFor(agent-autonomous) resolves the configured system user (§26.5).
  process.env.ATRIUM_SYSTEM_USER_ID = "42";
});

beforeEach(() => {
  checkResult = { allowed: true };
  checkInputSafetyMock.mockClear();
});

describe("contentService.create screening wiring", () => {
  const docInput = { kind: "document" as const, title: "T", body: "# hi" };

  it("screens an agent-authored body and blocks BEFORE any transaction", async () => {
    checkResult = { allowed: false, blockedMessage: "Nope." };
    await expect(
      contentService.create(autonomousAgent, docInput)
    ).rejects.toBeInstanceOf(ValidationError);
    expect(checkInputSafetyMock).toHaveBeenCalledTimes(1);
  });

  it("proceeds to the transaction when an agent body passes screening", async () => {
    await expect(
      contentService.create(autonomousAgent, docInput)
    ).rejects.toThrow(TX_SENTINEL);
    expect(checkInputSafetyMock).toHaveBeenCalledTimes(1);
  });

  it("screens artifact code the same as document markdown", async () => {
    checkResult = { allowed: false };
    await expect(
      contentService.create(autonomousAgent, {
        kind: "artifact",
        title: "Widget",
        body: "<script>evil()</script>",
        bodyFormat: "html",
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(checkInputSafetyMock).toHaveBeenCalledWith(
      "<script>evil()</script>",
      undefined
    );
  });

  it("never screens a human author (reaches the transaction untouched)", async () => {
    checkResult = { allowed: false }; // would block IF screened
    await expect(contentService.create(humanUser, docInput)).rejects.toThrow(
      TX_SENTINEL
    );
    expect(checkInputSafetyMock).not.toHaveBeenCalled();
  });

  it("skips screening for a bodyless agent create", async () => {
    await expect(
      contentService.create(autonomousAgent, { kind: "document", title: "T" })
    ).rejects.toThrow(TX_SENTINEL);
    expect(checkInputSafetyMock).not.toHaveBeenCalled();
  });
});

describe("versionService.snapshot screening wiring", () => {
  const doc = { id: "obj-1", kind: "document" as const };

  it("screens an agent-authored snapshot body and blocks BEFORE the transaction", async () => {
    checkResult = { allowed: false, blockedMessage: "Nope." };
    await expect(
      versionService.snapshot(autonomousAgent, doc, { body: "# bad" })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(checkInputSafetyMock).toHaveBeenCalledWith("# bad", "obj-1");
  });

  it("fails OPEN (proceeds to the transaction) when screening is degraded", async () => {
    // A degraded evaluation must not block a write — it reaches the transaction
    // like a passing screen (here surfaced via the TX sentinel).
    checkResult = { allowed: true, degraded: true };
    await expect(
      versionService.snapshot(autonomousAgent, doc, { body: "# any" })
    ).rejects.toThrow(TX_SENTINEL);
    expect(checkInputSafetyMock).toHaveBeenCalledWith("# any", "obj-1");
  });

  it("proceeds to the transaction when an agent body passes screening", async () => {
    await expect(
      versionService.snapshot(autonomousAgent, doc, { body: "# ok" })
    ).rejects.toThrow(TX_SENTINEL);
    expect(checkInputSafetyMock).toHaveBeenCalledTimes(1);
  });

  it("never screens a human snapshot (reaches the transaction untouched)", async () => {
    checkResult = { allowed: false };
    await expect(
      versionService.snapshot(humanUser, doc, { body: "# hi" })
    ).rejects.toThrow(TX_SENTINEL);
    expect(checkInputSafetyMock).not.toHaveBeenCalled();
  });
});
