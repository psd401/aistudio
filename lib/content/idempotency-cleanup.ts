/**
 * Bounded cleanup for expired Atrium idempotency records (#1287).
 *
 * Kept separate from the request coordinator so the scheduled maintenance
 * Lambda can import it without pulling NextResponse, auth middleware, or the
 * response-encryption runtime into its bundle.
 */

import { inArray, lt } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentIdempotencyRecords } from "@/lib/db/schema";

export const CONTENT_IDEMPOTENCY_CLEANUP_BATCH_SIZE = 500;

export async function cleanupExpiredContentIdempotencyRecords(
  limit = CONTENT_IDEMPOTENCY_CLEANUP_BATCH_SIZE
): Promise<number> {
  const boundedLimit = Math.max(
    1,
    Math.min(limit, CONTENT_IDEMPOTENCY_CLEANUP_BATCH_SIZE)
  );
  const ids = await executeQuery(
    (db) =>
      db
        .select({ id: contentIdempotencyRecords.id })
        .from(contentIdempotencyRecords)
        .where(lt(contentIdempotencyRecords.expiresAt, new Date()))
        .orderBy(contentIdempotencyRecords.expiresAt)
        .limit(boundedLimit),
    "content.idempotency.cleanup.select"
  );
  if (ids.length === 0) return 0;
  const deleted = await executeQuery(
    (db) =>
      db
        .delete(contentIdempotencyRecords)
        .where(
          inArray(
            contentIdempotencyRecords.id,
            ids.map((row) => row.id)
          )
        )
        .returning({ id: contentIdempotencyRecords.id }),
    "content.idempotency.cleanup.delete"
  );
  return deleted.length;
}
