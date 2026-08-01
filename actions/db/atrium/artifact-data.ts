"use server"

/**
 * Session-authenticated persistence for sandboxed Atrium artifacts (#1517).
 *
 * These actions are the sole human write/read boundary for
 * `content_data_records`. The sandbox bridge supplies only artifact-defined
 * data; content identity and user identity are resolved by this parent-side,
 * authenticated boundary. Both operations call `contentService.get`, preserving
 * the shared 404 mask for missing and non-viewable content.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import {
  createLogger,
  generateRequestId,
  sanitizeForLogging,
  startTimer,
} from "@/lib/logger";
import { createSuccess, ErrorFactories, handleError } from "@/lib/error-utils";
import { getServerSession } from "@/lib/auth/server-session";
import { contentService } from "@/lib/content";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentDataRecords, users } from "@/lib/db/schema";
import { safeJsonbStringify } from "@/lib/db/json-utils";
import type { ArtifactDataPayload } from "@/lib/db/types/jsonb";
import { consumeRateLimit } from "@/lib/rate-limit";
import type { ActionState } from "@/types";
import { getUserRequester } from "./requester";

const NAMESPACE_RE = /^[a-z0-9_-]{1,64}$/;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const SUBMIT_RATE_LIMIT = 120;
const SUBMIT_RATE_WINDOW_MS = 60 * 1000;
const SUBMIT_RATE_NAMESPACE = "atrium-artifact-record-submit";
const RESERVED_IDENTITY_KEYS = new Set(["userId", "user_id"]);

export interface SubmitArtifactRecordInput {
  contentId: string;
  namespace: string;
  payload: ArtifactDataPayload;
}

export interface SubmitArtifactRecordResult {
  id: string;
  createdAt: string;
}

export type ArtifactRecordScope = "all" | "mine";

export interface ListArtifactRecordsInput {
  contentId: string;
  namespace: string;
  limit?: number;
  scope?: ArtifactRecordScope;
}

export interface ArtifactRecordDTO {
  id: string;
  userId: number | null;
  displayName: string;
  payload: ArtifactDataPayload;
  createdAt: string;
}

export interface ListArtifactRecordsResult {
  records: ArtifactRecordDTO[];
}

interface ValidatedPayload {
  serialized: string;
  bytes: number;
}

interface ArtifactRecordRow {
  id: string;
  userId: number | null;
  payload: ArtifactDataPayload;
  createdAt: Date;
  userFirstName: string | null;
  userLastName: string | null;
  userEmail: string | null;
}

function validateContentId(contentId: unknown): string {
  if (typeof contentId !== "string" || !contentId.trim()) {
    throw ErrorFactories.missingRequiredField("contentId");
  }
  return contentId.trim();
}

function validateNamespace(namespace: unknown): string {
  if (typeof namespace !== "string" || !NAMESPACE_RE.test(namespace)) {
    throw ErrorFactories.invalidFormat(
      "namespace",
      namespace,
      "1-64 lowercase letters, numbers, underscores, or hyphens"
    );
  }
  return namespace;
}

function validatePayload(payload: unknown): ValidatedPayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw ErrorFactories.invalidInput(
      "payload",
      null,
      "payload must be a JSON object"
    );
  }

  for (const key of RESERVED_IDENTITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      throw ErrorFactories.invalidInput(
        "payload",
        key,
        `payload must not contain reserved identity key '${key}'`
      );
    }
  }

  let serialized: string;
  try {
    serialized = safeJsonbStringify(payload);
  } catch {
    throw ErrorFactories.invalidInput(
      "payload",
      null,
      "payload must be JSON serializable"
    );
  }

  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw ErrorFactories.fileTooLarge(
      "payload",
      bytes,
      MAX_PAYLOAD_BYTES
    );
  }

  return {
    serialized,
    bytes,
  };
}

function normalizeScope(scope: unknown): ArtifactRecordScope {
  if (scope === undefined) return "all";
  if (scope !== "all" && scope !== "mine") {
    throw ErrorFactories.invalidInput(
      "scope",
      scope,
      "scope must be 'all' or 'mine'"
    );
  }
  return scope;
}

function normalizeLimit(limit: unknown): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    throw ErrorFactories.valueOutOfRange(
      "limit",
      typeof limit === "number" ? limit : 0,
      1,
      MAX_LIST_LIMIT
    );
  }
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT);
}

function displayNameFor(row: ArtifactRecordRow): string {
  const fullName = [row.userFirstName, row.userLastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .trim();
  return fullName || row.userEmail?.split("@")[0] || "Unknown user";
}

function toArtifactRecordDTO(row: ArtifactRecordRow): ArtifactRecordDTO {
  return {
    id: row.id,
    userId: row.userId,
    displayName: displayNameFor(row),
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function submitArtifactRecord(
  input: SubmitArtifactRecordInput
): Promise<ActionState<SubmitArtifactRecordResult>> {
  const requestId = generateRequestId();
  const timer = startTimer("submitArtifactRecord");
  const log = createLogger({ requestId, action: "submitArtifactRecord" });

  try {
    const session = await getServerSession();
    if (!session?.sub) throw ErrorFactories.authNoSession();
    const requester = await getUserRequester(requestId, session);
    if (requester.kind !== "user" || requester.userId == null) {
      throw ErrorFactories.authNoSession();
    }
    const userId = requester.userId;

    const contentId = validateContentId(input?.contentId);
    const namespace = validateNamespace(input?.namespace);
    const payload = validatePayload(input?.payload);
    log.info("Action started: submit artifact record", {
      contentId: sanitizeForLogging(contentId),
      namespace,
      payloadBytes: payload.bytes,
    });

    const rateLimit = consumeRateLimit({
      interval: SUBMIT_RATE_WINDOW_MS,
      uniqueTokenPerInterval: SUBMIT_RATE_LIMIT,
      namespace: SUBMIT_RATE_NAMESPACE,
      identifier: `user:${userId}`,
    });
    if (!rateLimit.allowed) {
      throw ErrorFactories.bizRateLimitExceeded(
        "submit artifact records",
        rateLimit.retryAfterSeconds,
        new Date(rateLimit.resetTime).toISOString()
      );
    }

    // Resolves the canonical object id and preserves the shared 404 mask for a
    // missing or non-viewable target. The per-user guard runs first so a caller
    // over budget cannot keep generating database-backed visibility lookups.
    const content = await contentService.get(requester, contentId);

    const [created] = await executeQuery(
      (db) =>
        db
          .insert(contentDataRecords)
          .values({
            contentId: content.id,
            namespace,
            userId,
            payload: sql`${payload.serialized}::jsonb`,
          })
          .returning({
            id: contentDataRecords.id,
            createdAt: contentDataRecords.createdAt,
          }),
      "atrium.submitArtifactRecord"
    );
    if (!created) {
      throw ErrorFactories.dbQueryFailed("insert content_data_records");
    }

    const result = {
      id: created.id,
      createdAt: created.createdAt.toISOString(),
    };
    timer({ status: "success" });
    log.info("Artifact record submitted", {
      contentId: content.id,
      recordId: created.id,
      userId,
    });
    return createSuccess(result, "Artifact record submitted");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to submit artifact record", {
      context: "submitArtifactRecord",
      requestId,
      operation: "submitArtifactRecord",
    });
  }
}

export async function listArtifactRecords(
  input: ListArtifactRecordsInput
): Promise<ActionState<ListArtifactRecordsResult>> {
  const requestId = generateRequestId();
  const timer = startTimer("listArtifactRecords");
  const log = createLogger({ requestId, action: "listArtifactRecords" });

  try {
    const session = await getServerSession();
    if (!session?.sub) throw ErrorFactories.authNoSession();
    const requester = await getUserRequester(requestId, session);
    if (requester.kind !== "user" || requester.userId == null) {
      throw ErrorFactories.authNoSession();
    }
    const userId = requester.userId;

    const contentId = validateContentId(input?.contentId);
    const namespace = validateNamespace(input?.namespace);
    const scope = normalizeScope(input?.scope);
    const limit = normalizeLimit(input?.limit);
    log.info("Action started: list artifact records", {
      contentId: sanitizeForLogging(contentId),
      namespace,
      scope,
      limit,
    });

    const content = await contentService.get(requester, contentId);
    const rows = await executeQuery(
      (db) =>
        db
          .select({
            id: contentDataRecords.id,
            userId: contentDataRecords.userId,
            payload: contentDataRecords.payload,
            createdAt: contentDataRecords.createdAt,
            userFirstName: users.firstName,
            userLastName: users.lastName,
            userEmail: users.email,
          })
          .from(contentDataRecords)
          .leftJoin(users, eq(contentDataRecords.userId, users.id))
          .where(
            and(
              eq(contentDataRecords.contentId, content.id),
              eq(contentDataRecords.namespace, namespace),
              scope === "mine"
                ? eq(contentDataRecords.userId, userId)
                : undefined
            )
          )
          .orderBy(
            desc(contentDataRecords.createdAt),
            desc(contentDataRecords.id)
          )
          .limit(limit),
      "atrium.listArtifactRecords"
    );

    const records = (rows as ArtifactRecordRow[]).map(toArtifactRecordDTO);
    timer({ status: "success" });
    log.info("Artifact records listed", {
      contentId: content.id,
      namespace,
      scope,
      count: records.length,
    });
    return createSuccess({ records }, "Artifact records loaded");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to list artifact records", {
      context: "listArtifactRecords",
      requestId,
      operation: "listArtifactRecords",
    });
  }
}
