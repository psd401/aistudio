/**
 * Security and bounds coverage for the Atrium Artifact Data Service actions
 * (#1517). Database, session, visibility, and rate-limit collaborators are
 * mocked so these tests exercise the action boundary and query inputs without a
 * shared database.
 */

import { NotFoundError } from "@/lib/content/errors";
import type {
  ListArtifactRecordsInput,
  SubmitArtifactRecordInput,
} from "@/actions/db/atrium/artifact-data";

const mockGetServerSession = jest.fn();
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: () => mockGetServerSession(),
}));

const mockGetUserRequester = jest.fn();
jest.mock("@/actions/db/atrium/requester", () => ({
  getUserRequester: (...args: unknown[]) => mockGetUserRequester(...args),
}));

const mockContentGet = jest.fn();
jest.mock("@/lib/content", () => ({
  contentService: {
    get: (...args: unknown[]) => mockContentGet(...args),
  },
}));

const mockConsumeRateLimit = jest.fn();
jest.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: (...args: unknown[]) => mockConsumeRateLimit(...args),
}));

const mockReturning = jest.fn();
const mockValues = jest.fn((_values: Record<string, unknown>) => ({
  returning: mockReturning,
}));
const mockInsert = jest.fn(() => ({ values: mockValues }));

const mockLimit = jest.fn();
const mockOrderBy = jest.fn(() => ({ limit: mockLimit }));
const mockWhere = jest.fn(() => ({ orderBy: mockOrderBy }));
const mockLeftJoin = jest.fn(() => ({ where: mockWhere }));
const mockFrom = jest.fn(() => ({ leftJoin: mockLeftJoin }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));

interface FakeDb {
  insert: typeof mockInsert;
  select: typeof mockSelect;
}

const fakeDb: FakeDb = {
  insert: mockInsert,
  select: mockSelect,
};

type QueryCallback = (db: FakeDb) => unknown;
const mockExecuteQuery = jest.fn(
  async (query: QueryCallback, _operation: string) => query(fakeDb)
);
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (query: QueryCallback, operation: string) =>
    mockExecuteQuery(query, operation),
}));

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "artifact-data-request-id",
  getLogContext: () => ({
    requestId: "artifact-data-request-id",
    userId: undefined,
  }),
  sanitizeForLogging: (value: unknown) => value,
  startTimer: () => jest.fn(),
}));

import {
  listArtifactRecords,
  submitArtifactRecord,
} from "@/actions/db/atrium/artifact-data";

const SESSION = { sub: "cognito-user-7" };
const REQUESTER = {
  kind: "user" as const,
  userId: 7,
  roles: ["student"],
  building: null,
  department: null,
  gradeLevels: null,
  groups: [],
  isAdmin: false,
};
const CONTENT = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "artifact",
};
const CREATED_AT = new Date("2026-08-01T20:00:00.000Z");

const validSubmitInput: SubmitArtifactRecordInput = {
  contentId: "polyatomic-ion-mahjong",
  namespace: "leaderboard",
  payload: { difficulty: "hard", score: 42 },
};

const validListInput: ListArtifactRecordsInput = {
  contentId: "polyatomic-ion-mahjong",
  namespace: "leaderboard",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetServerSession.mockResolvedValue(SESSION);
  mockGetUserRequester.mockResolvedValue(REQUESTER);
  mockContentGet.mockResolvedValue(CONTENT);
  mockConsumeRateLimit.mockReturnValue({
    allowed: true,
    retryAfterSeconds: 0,
    remaining: 119,
    resetTime: Date.now() + 60_000,
  });
  mockReturning.mockResolvedValue([
    { id: "record-1", createdAt: CREATED_AT },
  ]);
  mockLimit.mockResolvedValue([]);
});

describe("submitArtifactRecord", () => {
  it("persists a viewable record with canonical content and session user ids", async () => {
    const forgedInput = {
      ...validSubmitInput,
      userId: 999,
    } as SubmitArtifactRecordInput;

    const result = await submitArtifactRecord(forgedInput);

    expect(result).toEqual({
      isSuccess: true,
      message: "Artifact record submitted",
      data: {
        id: "record-1",
        createdAt: CREATED_AT.toISOString(),
      },
    });
    expect(mockContentGet).toHaveBeenCalledWith(
      REQUESTER,
      "polyatomic-ion-mahjong"
    );
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        contentId: CONTENT.id,
        namespace: "leaderboard",
        userId: REQUESTER.userId,
      })
    );
    expect(mockValues.mock.calls[0][0]).not.toHaveProperty("userId", 999);
    expect(mockConsumeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: "user-sub:cognito-user-7" })
    );
  });

  it.each(["userId", "user_id"])(
    "rejects reserved payload identity key %s",
    async (key) => {
      const result = await submitArtifactRecord({
        ...validSubmitInput,
        payload: { score: 42, [key]: 999 },
      });

      expect(result.isSuccess).toBe(false);
      expect(mockContentGet).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    }
  );

  it("rejects a payload over 8 KiB before persistence", async () => {
    const result = await submitArtifactRecord({
      ...validSubmitInput,
      payload: { value: "x".repeat(8 * 1024) },
    });

    expect(result.isSuccess).toBe(false);
    expect(mockContentGet).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects an object that serializes to a JSON scalar", async () => {
    const result = await submitArtifactRecord({
      ...validSubmitInput,
      payload: new Date("2026-08-01T20:00:00.000Z") as unknown as Record<
        string,
        unknown
      >,
    });

    expect(result.isSuccess).toBe(false);
    expect(mockContentGet).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects an empty content id before visibility or persistence", async () => {
    const result = await submitArtifactRecord({
      ...validSubmitInput,
      contentId: "   ",
    });

    expect(result.isSuccess).toBe(false);
    expect(mockContentGet).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it.each(["Leaderboard", "two words", "", "a".repeat(65)])(
    "rejects invalid namespace %p",
    async (namespace) => {
      const result = await submitArtifactRecord({
        ...validSubmitInput,
        namespace,
      });

      expect(result.isSuccess).toBe(false);
      expect(mockInsert).not.toHaveBeenCalled();
    }
  );

  it("rejects an unauthenticated call before visibility or database access", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const result = await submitArtifactRecord(validSubmitInput);

    expect(result.isSuccess).toBe(false);
    expect(result.message).toMatch(/sign in|authenticated|session/i);
    expect(mockGetUserRequester).not.toHaveBeenCalled();
    expect(mockContentGet).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns a 404-style failure for content the user cannot view", async () => {
    mockContentGet.mockRejectedValueOnce(
      new NotFoundError("Content not found", {
        idOrSlug: validSubmitInput.contentId,
      })
    );

    const result = await submitArtifactRecord(validSubmitInput);

    expect(result.isSuccess).toBe(false);
    expect(result.message).not.toMatch(/forbidden|permission/i);
    expect(mockConsumeRateLimit).toHaveBeenCalledTimes(1);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects a viewable document before persistence", async () => {
    mockContentGet.mockResolvedValueOnce({ ...CONTENT, kind: "document" });

    const result = await submitArtifactRecord(validSubmitInput);

    expect(result.isSuccess).toBe(false);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("refuses an over-limit caller before visibility or persistence", async () => {
    mockConsumeRateLimit.mockReturnValueOnce({
      allowed: false,
      retryAfterSeconds: 30,
      remaining: 0,
      resetTime: Date.now() + 30_000,
    });
    const circularPayload: Record<string, unknown> = {};
    circularPayload.self = circularPayload;

    const result = await submitArtifactRecord({
      ...validSubmitInput,
      payload: circularPayload,
    });

    expect(result.isSuccess).toBe(false);
    if (result.isSuccess) return;
    expect(result.error).toEqual(
      expect.objectContaining({ code: "BIZ_RATE_LIMIT_EXCEEDED" })
    );
    expect(result.message).toMatch(/too many requests/i);
    expect(mockGetUserRequester).not.toHaveBeenCalled();
    expect(mockContentGet).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("listArtifactRecords", () => {
  it("returns newest records with server-resolved display names", async () => {
    mockLimit.mockResolvedValueOnce([
      {
        id: "record-2",
        userId: 7,
        payload: { score: 84 },
        createdAt: new Date("2026-08-01T20:05:00.000Z"),
        userFirstName: "Ada",
        userLastName: "Lovelace",
        userEmail: "ada@example.com",
      },
      {
        id: "record-1",
        userId: 8,
        payload: { score: 42 },
        createdAt: CREATED_AT,
        userFirstName: null,
        userLastName: null,
        userEmail: "student@example.com",
      },
    ]);

    const result = await listArtifactRecords(validListInput);

    expect(result.isSuccess).toBe(true);
    if (!result.isSuccess) return;
    expect(result.data.records).toEqual([
      {
        id: "record-2",
        userId: 7,
        displayName: "Ada Lovelace",
        payload: { score: 84 },
        createdAt: "2026-08-01T20:05:00.000Z",
      },
      {
        id: "record-1",
        userId: 8,
        displayName: "student",
        payload: { score: 42 },
        createdAt: CREATED_AT.toISOString(),
      },
    ]);
    expect(mockContentGet).toHaveBeenCalledWith(
      REQUESTER,
      "polyatomic-ion-mahjong"
    );
    expect(mockLimit).toHaveBeenCalledWith(50);
  });

  it("clamps a requested limit above 200", async () => {
    const result = await listArtifactRecords({
      ...validListInput,
      limit: 1000,
    });

    expect(result.isSuccess).toBe(true);
    expect(mockLimit).toHaveBeenCalledWith(200);
  });

  it("supports the caller-only mine scope", async () => {
    const result = await listArtifactRecords({
      ...validListInput,
      scope: "mine",
    });

    expect(result.isSuccess).toBe(true);
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid scope before visibility or database access", async () => {
    const result = await listArtifactRecords({
      ...validListInput,
      scope: "someone-else" as "mine",
    });

    expect(result.isSuccess).toBe(false);
    expect(mockContentGet).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated call", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const result = await listArtifactRecords(validListInput);

    expect(result.isSuccess).toBe(false);
    expect(result.message).toMatch(/sign in|authenticated|session/i);
    expect(mockContentGet).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("returns a 404-style failure for content the user cannot view", async () => {
    mockContentGet.mockRejectedValueOnce(
      new NotFoundError("Content not found", {
        idOrSlug: validListInput.contentId,
      })
    );

    const result = await listArtifactRecords(validListInput);

    expect(result.isSuccess).toBe(false);
    expect(result.message).not.toMatch(/forbidden|permission/i);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("rejects listing records for a viewable document", async () => {
    mockContentGet.mockResolvedValueOnce({ ...CONTENT, kind: "document" });

    const result = await listArtifactRecords(validListInput);

    expect(result.isSuccess).toBe(false);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
