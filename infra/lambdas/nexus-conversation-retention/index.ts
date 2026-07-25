/**
 * Nexus Conversation Retention Sweep (Issue #1330)
 *
 * Runs nightly (05:00 UTC). Hard-deletes Nexus conversations whose last message
 * is older than the admin-configured NEXUS_CONVERSATION_RETENTION_DAYS setting,
 * unless the user flagged them Keep (is_saved) or pinned them. Archived
 * conversations ARE eligible — archiving is what the Nexus "Delete" button does
 * today and is not protection.
 *
 * The retention window is read from the `settings` table on EVERY run with no
 * caching, so an admin change takes effect on the next run without a deploy —
 * and clearing the value disables the sweep just as immediately.
 *
 * Invoke with `{ "dryRun": true }` to list the candidate conversation IDs and
 * the storage/rows that WOULD be removed, without deleting anything.
 *
 * Env vars:
 *   DATABASE_HOST          — Aurora host
 *   DATABASE_SECRET_ARN    — Aurora credentials secret
 *   DATABASE_NAME          — Aurora database (default aistudio)
 *   DATABASE_PORT          — default 5432
 *   DOCUMENTS_BUCKET_NAME  — versioned S3 bucket holding documents + repositories
 *   SWEEP_BATCH_LIMIT      — max conversations per run (default 200)
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  S3Client,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  type ObjectIdentifier,
} from "@aws-sdk/client-s3";
import postgres from "postgres";

import { CANDIDATE_WHERE_CLAUSE } from "./retention-policy";
import {
  runRetentionSweep,
  type CandidateConversation,
  type LegacyDocument,
  type SweepLogger,
  type SweepPorts,
  type SweepResult,
} from "./sweep";

const DATABASE_HOST = process.env.DATABASE_HOST || "";
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || "";
const DATABASE_NAME = process.env.DATABASE_NAME || "aistudio";
const DATABASE_PORT = Number.parseInt(process.env.DATABASE_PORT || "5432", 10);
const DOCUMENTS_BUCKET_NAME = process.env.DOCUMENTS_BUCKET_NAME || "";
const SWEEP_BATCH_LIMIT = Number.parseInt(process.env.SWEEP_BATCH_LIMIT || "200", 10);

const RETENTION_SETTING_KEY = "NEXUS_CONVERSATION_RETENTION_DAYS";
const LOGGER_NAME = "nexus-conversation-retention";

const secrets = new SecretsManagerClient({});
const s3 = new S3Client({});

const log: SweepLogger = {
  info: (evt, fields) => emit("INFO", evt, fields),
  warn: (evt, fields) => emit("WARN", evt, fields),
  error: (evt, fields) => emit("ERROR", evt, fields),
};

function emit(level: string, evt: string, fields?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level, logger: LOGGER_NAME, evt, ...fields }));
}

let sqlClient: postgres.Sql | null = null;
async function getSql(): Promise<postgres.Sql> {
  if (sqlClient) return sqlClient;
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: DATABASE_SECRET_ARN })
  );
  if (!res.SecretString) throw new Error("Database secret missing SecretString");
  const creds = JSON.parse(res.SecretString) as {
    username: string;
    password: string;
  };
  sqlClient = postgres({
    host: DATABASE_HOST,
    port: DATABASE_PORT,
    database: DATABASE_NAME,
    username: creds.username,
    password: creds.password,
    ssl: "require",
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return sqlClient;
}

/**
 * Permanently remove every version AND delete marker under a prefix.
 *
 * The documents bucket is versioned, so a plain DeleteObject only writes a new
 * delete marker and leaves the content retrievable — which would make a
 * "permanent" retention deletion a lie. `matchExactKey` narrows a prefix listing
 * to one object, because S3 has no exact-key listing and
 * `Prefix="a/b.pdf"` also matches `a/b.pdf.bak`.
 */
async function deleteVersionsUnderPrefix(
  prefix: string,
  matchExactKey?: string
): Promise<number> {
  if (!DOCUMENTS_BUCKET_NAME) {
    throw new Error("DOCUMENTS_BUCKET_NAME is not configured");
  }

  let deleted = 0;
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: DOCUMENTS_BUCKET_NAME,
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      })
    );

    const identifiers: ObjectIdentifier[] = [];
    for (const entry of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
      if (!entry.Key || !entry.VersionId) continue;
      if (matchExactKey !== undefined && entry.Key !== matchExactKey) continue;
      identifiers.push({ Key: entry.Key, VersionId: entry.VersionId });
    }

    // DeleteObjects caps at 1000 keys per call; a version listing page is also
    // capped at 1000, so one chunk per page is sufficient.
    if (identifiers.length > 0) {
      const res = await s3.send(
        new DeleteObjectsCommand({
          Bucket: DOCUMENTS_BUCKET_NAME,
          Delete: { Objects: identifiers, Quiet: true },
        })
      );
      if (res.Errors && res.Errors.length > 0) {
        throw new Error(
          `S3 delete reported ${res.Errors.length} error(s), first: ${res.Errors[0]?.Code ?? "unknown"}`
        );
      }
      deleted += identifiers.length;
    }

    // Fail loudly rather than silently stopping half-way. A truncated page with
    // no cursor would otherwise exit the loop reporting success, and the caller
    // would go on to delete the database rows — permanently orphaning every
    // object we had not reached yet. Throwing routes this into the fail-closed
    // path, which leaves the conversation intact for the next run.
    // Mirrors S3_PREFIX_LIST_CURSOR_ERROR in lib/aws/s3-client.ts.
    if (page.IsTruncated && !page.NextKeyMarker) {
      throw new Error(
        `S3 returned a truncated version listing without a cursor for prefix ${prefix}`
      );
    }

    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker || versionIdMarker);

  return deleted;
}

/**
 * The current writers store a bare S3 object key in `documents.url` (see
 * app/api/documents/{process,upload}/route.ts — "Store S3 key"). Anything that
 * parses as a URL is NOT usable as an S3 Key and is rejected here rather than
 * passed to S3, where it would silently address the wrong object (or nothing).
 */
export function toObjectKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("/")) return null;
  if (trimmed.includes("..")) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve `documents.url` to an S3 object key.
 *
 * Current rows hold a bare key, but rows written before the mid-2025 change
 * (commit 49230981) hold a full presigned https URL, and the oldest hold a
 * Supabase URL. Rejecting every URL outright would silently orphan the S3
 * objects of exactly the oldest conversations the retention sweep exists to
 * clear, so https values are parsed — but ONLY when the host proves the object
 * belongs to this deployment's bucket. Anything else returns null and the row
 * is deleted without touching S3, because addressing the wrong object is
 * irreversible and strictly worse than leaving one behind.
 */
export function documentUrlToObjectKey(
  value: string | null | undefined,
  bucket: string = DOCUMENTS_BUCKET_NAME
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^https?:\/\//i.test(trimmed)) return toObjectKey(trimmed);
  if (!bucket) return null;
  // `new URL()` silently RESOLVES traversal segments (".../a/../../b" becomes
  // "/b"), so the check has to happen on the raw string. A stored URL
  // containing them is malformed; refuse it rather than delete whatever it
  // happens to normalise to.
  if (trimmed.includes("../")) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  // Only genuine S3 hosts for THIS bucket. A Supabase or CloudFront URL yields
  // null rather than a guess.
  const isVirtualHosted =
    host.startsWith(`${bucket.toLowerCase()}.s3.`) && host.endsWith(".amazonaws.com");
  const isPathStyle = /^s3[.-][a-z0-9-]*\.?amazonaws\.com$/.test(host) || host === "s3.amazonaws.com";
  if (!isVirtualHosted && !isPathStyle) return null;

  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (path === "") return null;

  if (isVirtualHosted) return toObjectKey(path);

  const bucketPrefix = `${bucket}/`;
  if (!path.startsWith(bucketPrefix)) return null;
  return toObjectKey(path.slice(bucketPrefix.length));
}

/**
 * Prefixes that hold everything a conversation owns in S3.
 * See app/api/nexus/conversations/[id]/messages/route.ts, which authorises reads
 * against exactly these two.
 */
function conversationStoragePrefixes(conversationId: string): string[] {
  return [`conversations/${conversationId}/`, `v2/generated-images/${conversationId}/`];
}

interface MessagePartRow {
  parts: unknown;
}

/**
 * Extract `parts[].s3Key` values that fall OUTSIDE the conversation-scoped
 * prefixes. Anything inside them is already removed wholesale by the prefix
 * sweep, so re-deleting it per key would just be extra S3 calls.
 *
 * Note this cannot be the primary mechanism: chat-helpers.ts serialises user
 * image parts as `{ type: 'image', metadata: { hasImage: true } }`, dropping the
 * s3Key from the persisted row entirely. The prefix sweep is what actually
 * reclaims those objects.
 */
function extractOutOfPrefixKeys(rows: MessagePartRow[], conversationId: string): string[] {
  const prefixes = conversationStoragePrefixes(conversationId);
  const keys = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row.parts)) continue;
    for (const part of row.parts) {
      if (!part || typeof part !== "object") continue;
      const key = toObjectKey((part as { s3Key?: unknown }).s3Key as string | undefined);
      if (key === null) continue;
      if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
      keys.add(key);
    }
  }
  return [...keys];
}

function buildPorts(sql: postgres.Sql): SweepPorts {
  return {
    getRetentionSetting: async () => {
      const rows = await sql<{ value: string | null }[]>`
        SELECT value FROM settings WHERE key = ${RETENTION_SETTING_KEY} LIMIT 1
      `;
      return rows.length === 0 ? null : rows[0]!.value;
    },

    findCandidates: async (retentionDays, limit) => {
      // Oldest-first so a backlog drains deterministically and a per-run cap
      // always makes forward progress. CANDIDATE_WHERE_CLAUSE is shared with
      // the unit-tested predicate module so the two cannot drift.
      // One sql.unsafe call for the WHOLE statement rather than embedding the
      // clause in a template: a nested unsafe fragment carries its own $1 and
      // would collide with the outer query's parameter numbering. Both values
      // are still bound parameters ($1/$2), never interpolated.
      const rows = await sql.unsafe<
        {
          id: string;
          user_id: number;
          last_message_at: Date | null;
          is_archived: boolean | null;
        }[]
      >(
        `SELECT id, user_id, last_message_at, is_archived
         FROM nexus_conversations
         WHERE ${CANDIDATE_WHERE_CLAUSE}
         ORDER BY last_message_at ASC
         LIMIT $2`,
        [retentionDays, limit]
      );
      return rows.map<CandidateConversation>((row) => ({
        id: row.id,
        userId: row.user_id,
        lastMessageAt: row.last_message_at,
        isArchived: row.is_archived,
      }));
    },

    isStillEligible: async (conversationId, retentionDays) => {
      // The FULL predicate, not just the flags: re-testing last_message_at is
      // what catches a user who resumed the conversation mid-sweep, which
      // should protect it exactly as much as clicking Keep would.
      // Same CANDIDATE_WHERE_CLAUSE constant as the batch scan, so the late
      // re-check and the initial selection can never disagree. $1 is the
      // retention window, $2 the conversation id.
      const rows = await sql.unsafe<{ id: string }[]>(
        `SELECT id
         FROM nexus_conversations
         WHERE ${CANDIDATE_WHERE_CLAUSE}
           AND id = $2::uuid
         LIMIT 1`,
        [retentionDays, conversationId]
      );
      return rows.length > 0;
    },

    getBoundRepositoryIds: async (conversationId) => {
      const rows = await sql<{ repository_id: number }[]>`
        SELECT repository_id
        FROM nexus_repository_bindings
        WHERE conversation_id = ${conversationId}::uuid
      `;
      return rows.map((row) => row.repository_id);
    },

    getLegacyDocuments: async (conversationId) => {
      const rows = await sql<{ id: number; url: string | null }[]>`
        SELECT id, url
        FROM documents
        WHERE conversation_id = ${conversationId}::uuid
      `;
      // Every row is returned, including ones whose url yields no usable object
      // key: the row must go regardless, or documents.conversation_id's SET NULL
      // rule leaves a dangling row pointing at a conversation that no longer
      // exists. A null objectKey just means no S3 delete is attempted.
      return rows.map<LegacyDocument>((row) => {
        const objectKey = documentUrlToObjectKey(row.url);
        if (objectKey === null && row.url) {
          // Observable rather than silent: an operator can tell the difference
          // between "no objects to clean" and "we could not resolve this one".
          log.warn("document_url_unresolvable", { conversationId, documentId: row.id });
        }
        return { id: row.id, objectKey };
      });
    },

    getMessageObjectKeys: async (conversationId) => {
      const rows = await sql<MessagePartRow[]>`
        SELECT parts
        FROM nexus_messages
        WHERE conversation_id = ${conversationId}::uuid
          AND parts IS NOT NULL
      `;
      return extractOutOfPrefixKeys(rows, conversationId);
    },

    deleteConversationStorage: async (conversationId) => {
      let deleted = 0;
      for (const prefix of conversationStoragePrefixes(conversationId)) {
        deleted += await deleteVersionsUnderPrefix(prefix);
      }
      return deleted;
    },

    deleteRepositoryStorage: (repositoryId) => {
      // Defence in depth: a non-integer would build a prefix that could match
      // far more than one repository's namespace.
      if (!Number.isInteger(repositoryId) || repositoryId <= 0) {
        throw new Error(`Refusing to sweep storage for invalid repository id: ${repositoryId}`);
      }
      return deleteVersionsUnderPrefix(`repositories/${repositoryId}/`);
    },

    deleteObjectStorage: async (key) => {
      const objectKey = toObjectKey(key);
      if (objectKey === null) return 0;
      return deleteVersionsUnderPrefix(objectKey, objectKey);
    },

    deleteRepositoryRows: async (repositoryIds) => {
      // Cascades repository_items, repository_item_versions and the
      // nexus_repository_bindings row that pointed at it.
      const rows = await sql<{ id: number }[]>`
        DELETE FROM knowledge_repositories
        WHERE id = ANY(${repositoryIds}::int[])
        RETURNING id
      `;
      return rows.length;
    },

    deleteDocumentRows: async (documentIds) => {
      const rows = await sql<{ id: number }[]>`
        DELETE FROM documents
        WHERE id = ANY(${documentIds}::int[])
        RETURNING id
      `;
      return rows.length;
    },

    deleteConversationRow: async (conversationId) => {
      // Cascades nexus_messages, nexus_conversation_events,
      // nexus_conversation_folders, nexus_cache_entries, nexus_shares and
      // nexus_provider_metrics.
      // The Keep/pin predicate is re-asserted HERE, in the delete itself, so
      // the check and the deletion are one atomic statement. A user who clicks
      // Keep after the sweep's pre-check but before this line still wins: the
      // WHERE matches nothing, 0 rows come back, and the caller aborts.
      const rows = await sql<{ id: string }[]>`
        DELETE FROM nexus_conversations
        WHERE id = ${conversationId}::uuid
          AND is_saved = false
          AND is_pinned IS NOT TRUE
        RETURNING id
      `;
      return rows.length;
    },
  };
}

function isDryRun(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { dryRun?: unknown }).dryRun === true
  );
}

export const handler = async (event: unknown): Promise<SweepResult> => {
  const dryRun = isDryRun(event);
  const sql = await getSql();
  const ports = buildPorts(sql);

  try {
    return await runRetentionSweep(ports, log, {
      dryRun,
      batchLimit: Number.isSafeInteger(SWEEP_BATCH_LIMIT) && SWEEP_BATCH_LIMIT > 0
        ? SWEEP_BATCH_LIMIT
        : 200,
    });
  } catch (error) {
    log.error("sweep_failed", {
      dryRun,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
