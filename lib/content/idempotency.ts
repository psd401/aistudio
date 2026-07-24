/**
 * Durable, principal-scoped idempotency for Atrium REST mutations (#1287).
 *
 * The coordinator is intentionally separated from the PostgreSQL store so the
 * concurrency and interruption behavior can be tested deterministically. A
 * pending record is never taken over: if a worker disappears after a mutation
 * commits but before the response is persisted, retries receive a typed,
 * retryable response instead of risking a duplicate write/event/audit.
 */

import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { ApiAuthContext } from "@/lib/api/auth-middleware";
import { createErrorResponse } from "@/lib/api/auth-middleware";
import { decryptToken, encryptToken } from "@/lib/crypto/token-encryption";
import {
  executeQuery,
  executeTransaction,
} from "@/lib/db/drizzle-client";
import {
  contentIdempotencyRecords,
  type ContentIdempotencyHeaders,
} from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import {
  cleanupExpiredContentIdempotencyRecords,
  CONTENT_IDEMPOTENCY_CLEANUP_BATCH_SIZE,
} from "./idempotency-cleanup";

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const SAFE_RESPONSE_HEADERS = [
  "cache-control",
  "content-type",
  "etag",
  "location",
] as const;

const log = createLogger({ action: "content-idempotency" });
let lastCleanupStartedAt = 0;

export interface IdempotencyScope {
  environment: string;
  principal: string;
  client: string;
  method: string;
  route: string;
  keyHash: string;
}

export interface StoredIdempotentResponse {
  status: number;
  headers: ContentIdempotencyHeaders;
  ciphertext: string;
}

export type IdempotencyAcquireResult =
  | { kind: "execute"; reservationId: string }
  | { kind: "replay"; response: StoredIdempotentResponse }
  | { kind: "mismatch" }
  | { kind: "pending" };

export interface IdempotencyStore {
  acquire(
    scope: IdempotencyScope,
    requestHash: string,
    expiresAt: Date
  ): Promise<IdempotencyAcquireResult>;
  complete(
    reservationId: string,
    response: StoredIdempotentResponse
  ): Promise<void>;
  release(reservationId: string): Promise<void>;
  cleanupExpired(limit: number): Promise<number>;
}

export interface IdempotencyCodec {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

function environmentName(): string {
  return process.env.ENVIRONMENT || process.env.DEPLOYMENT_ENV || "local";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = stableValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Stable semantic request digest; only this digest is persisted. */
export function hashIdempotencyRequest(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

/**
 * Accept an opaque visible-ASCII key. Whitespace/control characters are
 * rejected rather than normalized, because normalization can alias two client
 * keys. The raw key is immediately hashed and is never logged or stored.
 */
export function validateIdempotencyKey(value: string): boolean {
  if (value.length === 0 || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7E) return false;
  }
  return true;
}

export function contentHeadEtag(currentVersionId: string | null): string {
  return `"${currentVersionId ?? "none"}"`;
}

/** Parse the single strong If-Match form supported by version creation. */
export function parseContentIfMatch(value: string | null):
  | { ok: true; expectedVersionId: string | null | undefined }
  | { ok: false } {
  if (value === null) return { ok: true, expectedVersionId: undefined };
  if (value === '"none"') return { ok: true, expectedVersionId: null };
  const match = /^"([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"$/i.exec(
    value
  );
  return match?.[1]
    ? { ok: true, expectedVersionId: match[1] }
    : { ok: false };
}

export function idempotencyScope(
  auth: ApiAuthContext,
  request: Request,
  canonicalRoute: string,
  rawKey: string
): IdempotencyScope {
  const principalId = auth.delegatedForUserId ?? auth.userId;
  const client =
    auth.apiKeyId !== undefined
      ? `api-key:${auth.apiKeyId}`
      : auth.oauthClientId
        ? `oauth:${auth.oauthClientId}`
        : "none";
  return {
    environment: environmentName(),
    principal: `user:${principalId}`,
    client,
    method: request.method.toUpperCase(),
    route: canonicalRoute,
    keyHash: sha256(rawKey),
  };
}

const postgresStore: IdempotencyStore = {
  async acquire(scope, requestHash, expiresAt) {
    return executeTransaction(async (tx) => {
      const scopeWhere = and(
        eq(contentIdempotencyRecords.environment, scope.environment),
        eq(contentIdempotencyRecords.principal, scope.principal),
        eq(contentIdempotencyRecords.client, scope.client),
        eq(contentIdempotencyRecords.method, scope.method),
        eq(contentIdempotencyRecords.route, scope.route),
        eq(contentIdempotencyRecords.keyHash, scope.keyHash)
      );

      // Permit reuse only after the complete seven-day retention window. This
      // exact-scope delete also prevents an expired row from blocking its unique
      // key before the bounded cleanup sweep runs.
      await tx
        .delete(contentIdempotencyRecords)
        .where(and(scopeWhere, lt(contentIdempotencyRecords.expiresAt, new Date())));

      const inserted = await tx
        .insert(contentIdempotencyRecords)
        .values({ ...scope, requestHash, expiresAt })
        .onConflictDoNothing()
        .returning({ id: contentIdempotencyRecords.id });
      if (inserted[0]) {
        return { kind: "execute", reservationId: inserted[0].id } as const;
      }

      const rows = await tx
        .select({
          requestHash: contentIdempotencyRecords.requestHash,
          state: contentIdempotencyRecords.state,
          responseStatus: contentIdempotencyRecords.responseStatus,
          responseHeaders: contentIdempotencyRecords.responseHeaders,
          responseCiphertext: contentIdempotencyRecords.responseCiphertext,
        })
        .from(contentIdempotencyRecords)
        .where(scopeWhere)
        .limit(1);
      const row = rows[0];
      if (!row) {
        // A concurrent expiry cleanup can remove the row between conflict and
        // select. Do not execute without a reservation; ask the client to retry.
        return { kind: "pending" } as const;
      }
      if (row.requestHash !== requestHash) return { kind: "mismatch" } as const;
      if (
        row.state === "completed" &&
        row.responseStatus !== null &&
        row.responseHeaders !== null &&
        row.responseCiphertext !== null
      ) {
        return {
          kind: "replay",
          response: {
            status: row.responseStatus,
            headers: row.responseHeaders,
            ciphertext: row.responseCiphertext,
          },
        } as const;
      }
      return { kind: "pending" } as const;
    }, "content.idempotency.acquire");
  },

  async complete(reservationId, response) {
    await executeQuery(
      (db) =>
        db
          .update(contentIdempotencyRecords)
          .set({
            state: "completed",
            responseStatus: response.status,
            responseHeaders: response.headers,
            responseCiphertext: response.ciphertext,
          })
          .where(
            and(
              eq(contentIdempotencyRecords.id, reservationId),
              eq(contentIdempotencyRecords.state, "pending")
            )
          ),
      "content.idempotency.complete"
    );
  },

  async release(reservationId) {
    await executeQuery(
      (db) =>
        db
          .delete(contentIdempotencyRecords)
          .where(
            and(
              eq(contentIdempotencyRecords.id, reservationId),
              eq(contentIdempotencyRecords.state, "pending")
            )
          ),
      "content.idempotency.release"
    );
  },

  async cleanupExpired(limit) {
    return cleanupExpiredContentIdempotencyRecords(limit);
  },
};

const productionCodec: IdempotencyCodec = {
  encrypt: encryptToken,
  decrypt: decryptToken,
};

function responseHeaders(response: Response): ContentIdempotencyHeaders {
  const result: ContentIdempotencyHeaders = Object.create(null) as ContentIdempotencyHeaders;
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

function maybeCleanup(store: IdempotencyStore): void {
  const now = Date.now();
  if (now - lastCleanupStartedAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupStartedAt = now;
  void store
    .cleanupExpired(CONTENT_IDEMPOTENCY_CLEANUP_BATCH_SIZE)
    .then((deleted) => {
      if (deleted > 0) log.info("Removed expired idempotency records", { deleted });
    })
    .catch((error: unknown) => {
      log.warn("Idempotency cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export interface IdempotentMutationInput {
  request: Request;
  auth: ApiAuthContext;
  requestId: string;
  canonicalRoute: string;
  requestValue: unknown;
}

export interface IdempotencyDependencies {
  store: IdempotencyStore;
  codec: IdempotencyCodec;
  now: () => Date;
}

/**
 * Execute a mutation once and replay its exact status/body/safe headers.
 *
 * An unhandled interruption leaves the reservation pending. Subsequent requests
 * receive IDEMPOTENCY_IN_PROGRESS rather than risking a duplicate mutation.
 */
export async function runIdempotentMutation(
  input: IdempotentMutationInput,
  execute: () => Promise<NextResponse>,
  dependencies: IdempotencyDependencies = {
    store: postgresStore,
    codec: productionCodec,
    now: () => new Date(),
  }
): Promise<NextResponse> {
  const rawKey = input.request.headers.get("idempotency-key");
  if (rawKey === null) return execute();
  if (!validateIdempotencyKey(rawKey)) {
    return createErrorResponse(
      input.requestId,
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 1-255 visible ASCII characters"
    );
  }

  maybeCleanup(dependencies.store);
  const scope = idempotencyScope(
    input.auth,
    input.request,
    input.canonicalRoute,
    rawKey
  );
  const requestHash = hashIdempotencyRequest(input.requestValue);
  const acquired = await dependencies.store.acquire(
    scope,
    requestHash,
    new Date(dependencies.now().getTime() + IDEMPOTENCY_TTL_MS)
  );

  if (acquired.kind === "mismatch") {
    return createErrorResponse(
      input.requestId,
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency-Key was already used with a different request"
    );
  }
  if (acquired.kind === "pending") {
    const response = createErrorResponse(
      input.requestId,
      409,
      "IDEMPOTENCY_IN_PROGRESS",
      "An operation with this Idempotency-Key is still in progress"
    );
    response.headers.set("Retry-After", "1");
    return response;
  }
  if (acquired.kind === "replay") {
    const plaintext = await dependencies.codec.decrypt(
      acquired.response.ciphertext
    );
    const replay = NextResponse.json(JSON.parse(plaintext) as unknown, {
      status: acquired.response.status,
      headers: acquired.response.headers,
    });
    for (const [name, value] of Object.entries(acquired.response.headers)) {
      replay.headers.set(name, value);
    }
    replay.headers.set("Idempotency-Replayed", "true");
    return replay;
  }

  // Do not delete a reservation when execution throws. The mutation may have
  // committed immediately before an interruption; keeping it pending is the
  // only safe cross-process behavior that cannot duplicate side effects.
  const response = await execute();
  if (response.status >= 500) {
    // A returned 5xx is not a terminal result. Route handlers use returned 5xx
    // responses for known failures, so retaining one for seven days would make
    // the correct same-key retry replay a stale outage forever. Thrown/unknown
    // interruptions still leave the reservation pending because commit state is
    // ambiguous; only an explicit response takes this release path.
    await dependencies.store.release(acquired.reservationId);
    return response;
  }
  const body = await response.clone().text();
  const ciphertext = await dependencies.codec.encrypt(body);
  await dependencies.store.complete(acquired.reservationId, {
    status: response.status,
    headers: responseHeaders(response),
    ciphertext,
  });
  return response;
}

export { cleanupExpiredContentIdempotencyRecords };
