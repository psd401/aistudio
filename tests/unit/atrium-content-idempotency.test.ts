import { NextResponse } from "next/server";
import {
  hashIdempotencyRequest,
  parseContentIfMatch,
  runIdempotentMutation,
  validateIdempotencyKey,
  type IdempotencyAcquireResult,
  type IdempotencyCodec,
  type IdempotencyScope,
  type IdempotencyStore,
  type StoredIdempotentResponse,
} from "@/lib/content/idempotency";
import type { ApiAuthContext } from "@/lib/api/auth-middleware";

interface MemoryRecord {
  id: string;
  scope: IdempotencyScope;
  requestHash: string;
  expiresAt: Date;
  response?: StoredIdempotentResponse;
}

class MemoryStore implements IdempotencyStore {
  readonly records = new Map<string, MemoryRecord>();
  cleanupLimits: number[] = [];
  private nextId = 1;

  private scopeKey(scope: IdempotencyScope): string {
    return JSON.stringify(scope);
  }

  async acquire(
    scope: IdempotencyScope,
    requestHash: string,
    expiresAt: Date
  ): Promise<IdempotencyAcquireResult> {
    const key = this.scopeKey(scope);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) return { kind: "mismatch" };
      if (existing.response) {
        return { kind: "replay", response: existing.response };
      }
      return { kind: "pending" };
    }
    const record = {
      id: `reservation-${this.nextId++}`,
      scope,
      requestHash,
      expiresAt,
    };
    this.records.set(key, record);
    return { kind: "execute", reservationId: record.id };
  }

  async complete(
    reservationId: string,
    response: StoredIdempotentResponse
  ): Promise<void> {
    const record = [...this.records.values()].find(
      (candidate) => candidate.id === reservationId
    );
    if (!record) throw new Error("missing reservation");
    record.response = response;
  }

  async cleanupExpired(limit: number): Promise<number> {
    this.cleanupLimits.push(limit);
    return 0;
  }
}

const codec: IdempotencyCodec = {
  encrypt: async (value) => `cipher:${value}`,
  decrypt: async (value) => value.slice("cipher:".length),
};

const auth: ApiAuthContext = {
  userId: 17,
  cognitoSub: "sub-17",
  authType: "api_key",
  scopes: ["content:create"],
  apiKeyId: 91,
};

const now = new Date("2026-07-23T12:00:00.000Z");

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): NextResponse {
  const text = JSON.stringify(body);
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    status,
    headers: {
      get: (name: string) => normalized.get(name.toLowerCase()) ?? null,
    },
    clone: () => ({ text: async () => text }),
  } as unknown as NextResponse;
}

function request(key: string, route = "/api/v1/content"): Request {
  return {
    method: "POST",
    url: `https://app.example${route}`,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "idempotency-key" ? key : null,
    },
  } as unknown as Request;
}

function input(
  store: MemoryStore,
  key: string,
  requestValue: unknown = { title: "Guide" },
  route = "/api/v1/content"
) {
  return {
    args: {
      request: request(key, route),
      auth,
      requestId: "request-1",
      canonicalRoute: route,
      requestValue,
    },
    dependencies: { store, codec, now: () => now },
  };
}

describe("Atrium mutation idempotency", () => {
  it("replays the exact successful response without executing twice", async () => {
    const store = new MemoryStore();
    const testInput = input(store, "capture-123");
    const execute = jest.fn(async () => {
      return jsonResponse(
        { data: { id: "object-1" } },
        201,
        { ETag: '"version-1"' }
      );
    });

    const first = await runIdempotentMutation(
      testInput.args,
      execute,
      testInput.dependencies
    );
    const replay = await runIdempotentMutation(
      testInput.args,
      execute,
      testInput.dependencies
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ data: { id: "object-1" } });
    expect(replay.headers.get("etag")).toBe('"version-1"');
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse with a different semantic request", async () => {
    const store = new MemoryStore();
    const firstInput = input(store, "same-key", { title: "First" });
    const secondInput = input(store, "same-key", { title: "Second" });
    const execute = jest.fn(async () => jsonResponse({ ok: true }));

    await runIdempotentMutation(
      firstInput.args,
      execute,
      firstInput.dependencies
    );
    const response = await runIdempotentMutation(
      secondInput.args,
      execute,
      secondInput.dependencies
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
      })
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns a typed retryable response to an in-flight duplicate", async () => {
    const store = new MemoryStore();
    const testInput = input(store, "concurrent-key");
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const execute = jest.fn(async () => {
      await gate;
      return jsonResponse({ ok: true }, 201);
    });

    const first = runIdempotentMutation(
      testInput.args,
      execute,
      testInput.dependencies
    );
    await Promise.resolve();
    const duplicate = await runIdempotentMutation(
      testInput.args,
      execute,
      testInput.dependencies
    );

    expect(duplicate.status).toBe(409);
    expect(duplicate.headers.get("Retry-After")).toBe("1");
    expect(await duplicate.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "IDEMPOTENCY_IN_PROGRESS" }),
      })
    );
    expect(execute).toHaveBeenCalledTimes(1);
    finish?.();
    await first;
  });

  it("keeps an interrupted operation reserved rather than risking a duplicate", async () => {
    const store = new MemoryStore();
    const testInput = input(store, "interrupted-key");
    const execute = jest.fn(async () => {
      throw new Error("worker terminated");
    });

    await expect(
      runIdempotentMutation(testInput.args, execute, testInput.dependencies)
    ).rejects.toThrow("worker terminated");
    const retry = await runIdempotentMutation(
      testInput.args,
      execute,
      testInput.dependencies
    );

    expect(retry.status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retains reservations for seven days and bounds opportunistic cleanup", async () => {
    const store = new MemoryStore();
    const testInput = input(store, "ttl-key");
    await runIdempotentMutation(
      testInput.args,
      async () => jsonResponse({ ok: true }),
      testInput.dependencies
    );

    const [record] = store.records.values();
    expect(record?.expiresAt.toISOString()).toBe("2026-07-30T12:00:00.000Z");
    expect(store.cleanupLimits.every((limit) => limit <= 500)).toBe(true);
  });
});

describe("Atrium idempotency and ETag parsing", () => {
  it("hashes object keys deterministically without storing source values", () => {
    expect(hashIdempotencyRequest({ b: 2, a: { d: 4, c: 3 } })).toBe(
      hashIdempotencyRequest({ a: { c: 3, d: 4 }, b: 2 })
    );
  });

  it("validates opaque keys and rejects whitespace/control/oversized values", () => {
    expect(validateIdempotencyKey("capture:abc-123")).toBe(true);
    expect(validateIdempotencyKey("contains space")).toBe(false);
    expect(validateIdempotencyKey("x".repeat(256))).toBe(false);
  });

  it("accepts only one strong UUID ETag or the explicit none sentinel", () => {
    expect(parseContentIfMatch(null)).toEqual({
      ok: true,
      expectedVersionId: undefined,
    });
    expect(parseContentIfMatch('"none"')).toEqual({
      ok: true,
      expectedVersionId: null,
    });
    expect(
      parseContentIfMatch('"11111111-1111-4111-8111-111111111111"')
    ).toEqual({
      ok: true,
      expectedVersionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(parseContentIfMatch('W/"11111111-1111-4111-8111-111111111111"')).toEqual({
      ok: false,
    });
    expect(parseContentIfMatch('"one", "two"')).toEqual({ ok: false });
  });
});
