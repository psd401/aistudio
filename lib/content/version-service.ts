/**
 * Atrium version service
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). Creates immutable version snapshots
 * and supports rollback of the working head. See
 * docs/features/atrium-design-spec.md §14.
 *
 * Body storage (spec §6.1 / §14):
 * - document  -> body lives in the Proof doc-store; `body_location = "proof"`.
 *   The canonical markdown is also snapshotted to S3 (`source.md`) and a rendered
 *   HTML snapshot to `render.html`.
 * - artifact  -> code <= 4096 bytes stored inline (`body_location = "inline"`,
 *   `body_inline` set); larger code goes to S3 (`artifact.{html|jsx}`).
 *
 * Version numbers are allocated inside a transaction and guarded by the
 * `uq_version_object_number` unique constraint so concurrent writers cannot
 * collide. S3 writes happen *outside* (after) the transaction: `snapshotInTx`
 * does only DB IO and returns the body/render blobs, which `flushSnapshotWrites`
 * persists once the transaction has committed. A unique-violation therefore
 * aborts before any blob is written, and the deterministic, content-addressed
 * key means a rare post-commit retry only re-writes an identical, overwritable
 * object. (Doing S3 IO inside the transaction is a drizzle-client anti-pattern:
 * retries would be amplified, blobs could orphan on rollback, and the pooled
 * connection would be pinned during slow external IO.)
 */

import { and, desc, eq, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import { contentObjects, contentVersions } from "@/lib/db/schema";
import { pgTimestampAsText } from "@/lib/db/drizzle-helpers";
import { createLogger } from "@/lib/logger";
import { actorKindOf, agentIdOf, assertCanEdit, authorUserIdOf } from "./helpers";
import { rowToVersionDTO, type VersionRowAsText } from "./mappers";
import { renderMarkdownToHtml } from "./render/markdown-render";
import { s3Store } from "./storage/s3-store";
import { visibilityService } from "./visibility-service";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./errors";
import type {
  BodyFormat,
  ContentVersionDTO,
  Requester,
  SnapshotInput,
} from "./types";

/** Artifact bodies up to this size are stored inline rather than in S3. */
export const INLINE_ARTIFACT_MAX_BYTES = 4096;

const versionSelectFields = {
  id: contentVersions.id,
  objectId: contentVersions.objectId,
  versionNumber: contentVersions.versionNumber,
  authorActor: contentVersions.authorActor,
  authorUserId: contentVersions.authorUserId,
  authorAgentId: contentVersions.authorAgentId,
  bodyFormat: contentVersions.bodyFormat,
  bodyLocation: contentVersions.bodyLocation,
  bodyInline: contentVersions.bodyInline,
  renderLocation: contentVersions.renderLocation,
  proofDocRef: contentVersions.proofDocRef,
  summary: contentVersions.summary,
  createdAt: pgTimestampAsText(contentVersions.createdAt),
} as const;

function defaultBodyFormat(kind: "document" | "artifact"): BodyFormat {
  return kind === "document" ? "markdown" : "html";
}

function artifactFileName(format: BodyFormat): string {
  return format === "jsx" ? "artifact.jsx" : "artifact.html";
}

/** Postgres unique-violation (SQLSTATE 23505) detector for typed-error mapping. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

async function maxVersion(
  tx: DbTransaction,
  objectId: string
): Promise<number> {
  const rows = await tx
    .select({ max: sql<number | null>`max(${contentVersions.versionNumber})` })
    .from(contentVersions)
    .where(eq(contentVersions.objectId, objectId));
  return rows[0]?.max ?? 0;
}

/** A single S3 object to write after the snapshot transaction commits. */
interface PendingS3Write {
  key: string;
  body: string;
  contentType: string;
  /** "attachment" for active-markup keys (render.html, artifact html). */
  contentDisposition?: string;
}

/** Result of the DB-only snapshot step: the version + its post-commit S3 writes. */
export interface SnapshotResult {
  version: ContentVersionDTO;
  s3Writes: PendingS3Write[];
}

/**
 * Enforce the DB invariant `actor_kind = 'human' ⟹ author_user_id IS NOT NULL`
 * at the snapshot boundary. Current callers guard upstream (ownerFor /
 * assertCanEdit), but `snapshotInTx` / `versionService.snapshot` are exported and
 * Phase 5 adds REST/MCP callers — a misconfigured one skipping the upstream guard
 * would otherwise silently insert a 'human' version with a null author_user_id
 * (e.g. a guest `user` requester whose `userId` is null).
 */
function assertHumanAuthorId(
  req: Requester,
  authorActor: "human" | "agent",
  authorUserId: number | null
): void {
  if (authorActor === "human" && authorUserId == null) {
    throw new ForbiddenError("Authentication required to author a version", {
      kind: req.kind,
    });
  }
}

/**
 * DB-only snapshot step that runs inside an existing transaction: allocates the
 * next version number, inserts the immutable version row, and advances the
 * object's working head. **Does no S3 IO** — it returns the body/render blobs
 * the caller must persist *after* the transaction commits (see
 * `flushSnapshotWrites`).
 *
 * Keeping S3 IO out of the transaction matters: the repo's `executeTransaction`
 * retries on transient DB errors and holds a pooled connection for the whole
 * callback. External-storage writes inside it would be retried (amplified),
 * could orphan blobs on rollback, and would pin a connection during slow IO —
 * all flagged by the drizzle-client JSDoc as an anti-pattern.
 *
 * Used by `content-service.create` (sharing its transaction) and by the public
 * `snapshot` wrapper below; both flush the returned writes post-commit.
 */
export async function snapshotInTx(
  tx: DbTransaction,
  req: Requester,
  obj: { id: string; kind: "document" | "artifact" },
  input: SnapshotInput
): Promise<SnapshotResult> {
  // Reject empty AND whitespace-only bodies, mirroring the `.trim()` title check
  // in content-service so "   " is not silently snapshotted as content.
  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    throw new ValidationError("Version body is required");
  }
  const bodyFormat = input.bodyFormat ?? defaultBodyFormat(obj.kind);
  // The downstream branches assume documents are markdown (rendered via
  // renderMarkdownToHtml) and artifacts are html/jsx (content-type + filename).
  // Reject mismatched formats so storage/rendering stay consistent rather than
  // silently producing the wrong content-type or rendering artifact code.
  if (obj.kind === "document" && bodyFormat !== "markdown") {
    throw new ValidationError("Documents must use bodyFormat 'markdown'", {
      bodyFormat,
    });
  }
  if (obj.kind === "artifact" && bodyFormat === "markdown") {
    throw new ValidationError("Artifacts must use bodyFormat 'html' or 'jsx'", {
      bodyFormat,
    });
  }
  // Enforce the DB invariant `actor_kind = 'human' ⟹ author_user_id IS NOT NULL`
  // at this boundary (see `assertHumanAuthorId`).
  const authorActor = actorKindOf(req);
  const authorUserId = authorUserIdOf(req);
  assertHumanAuthorId(req, authorActor, authorUserId);

  const next = (await maxVersion(tx, obj.id)) + 1;

  const isDocument = obj.kind === "document";
  const inline =
    !isDocument && Buffer.byteLength(input.body, "utf8") <= INLINE_ARTIFACT_MAX_BYTES;

  const s3Writes: PendingS3Write[] = [];
  let bodyLocation: string;
  let bodyInline: string | null = null;
  let renderLocation: string | null = null;

  if (isDocument) {
    // Document live state belongs to the Proof doc-store (Phase 1). Phase 0
    // persists the canonical markdown + a rendered snapshot to S3 so content is
    // legible/round-trippable before any editor exists.
    bodyLocation = "proof";
    renderLocation = s3Store.key(obj.id, next, "render.html");
    s3Writes.push({
      key: s3Store.key(obj.id, next, "source.md"),
      body: input.body,
      contentType: "text/markdown",
    });
    s3Writes.push({
      key: renderLocation,
      body: renderMarkdownToHtml(input.body),
      contentType: "text/html",
      // Force download (not inline render) when served from a presigned URL, so
      // the rendered HTML is never executed on the S3/CloudFront origin.
      contentDisposition: "attachment",
    });
  } else if (inline) {
    bodyLocation = "inline";
    bodyInline = input.body;
  } else {
    // SECURITY: artifact code is UNTRUSTED. It is stored verbatim and must only
    // be rendered inside the cross-origin sandboxed iframe (§28.1) — never served
    // directly as text/html nor injected as innerHTML. The sandbox is Phase 2.
    bodyLocation = s3Store.key(obj.id, next, artifactFileName(bodyFormat));
    s3Writes.push({
      key: bodyLocation,
      body: input.body,
      contentType: bodyFormat === "jsx" ? "text/jsx" : "text/html",
      // Untrusted artifact code: never let a presigned URL render it as a live
      // document. It is served only inside the cross-origin sandbox (§28.1).
      contentDisposition: "attachment",
    });
  }

  // The unique (object_id, version_number) constraint guards concurrent writers:
  // two transactions can both read maxVersion()=N and both try to insert N+1; the
  // loser hits the constraint. Translate that raw 23505 into a typed ConflictError
  // (HTTP 409) so surfaces return "retry" rather than leaking a raw PostgresError,
  // mirroring content-service.create()'s slug-collision handling.
  const inserted = await tx
    .insert(contentVersions)
    .values({
      objectId: obj.id,
      versionNumber: next,
      authorActor,
      authorUserId,
      authorAgentId: agentIdOf(req),
      bodyFormat,
      bodyLocation,
      bodyInline,
      renderLocation,
      summary: input.summary ?? null,
    })
    .returning(versionSelectFields)
    .catch((e: unknown) => {
      if (isUniqueViolation(e)) {
        throw new ConflictError("Concurrent version conflict; please retry", {
          objectId: obj.id,
        });
      }
      throw e;
    });

  const versionRow = inserted[0];
  if (!versionRow) {
    // INSERT ... RETURNING should always yield a row; guard rather than crash.
    throw new ValidationError("Failed to create version", { objectId: obj.id });
  }

  // Advance the object's working head.
  await tx
    .update(contentObjects)
    .set({ currentVersionId: versionRow.id, updatedAt: new Date() })
    .where(eq(contentObjects.id, obj.id));

  return {
    version: rowToVersionDTO(versionRow as VersionRowAsText),
    s3Writes,
  };
}

/**
 * Persist a snapshot's S3 blobs. Run AFTER the snapshot transaction commits.
 * Keys are deterministic and content-addressed, so a retry overwrites the same
 * object harmlessly.
 *
 * Writes run concurrently (`Promise.allSettled`) rather than sequentially: the
 * source/render blobs are independent, so this halves P99 latency and attempts
 * both even if one fails. A partial failure (e.g. `source.md` written but
 * `render.html` not) leaves the committed version row's `render_location`
 * pointing at a key that is briefly absent — but `render.html` is deterministically
 * derivable from the persisted `source.md`, so the Phase 1 render path can
 * regenerate it on demand. We still throw on any failure so the caller learns the
 * write did not fully succeed (an aggregate of the underlying errors).
 */
export async function flushSnapshotWrites(
  writes: PendingS3Write[]
): Promise<void> {
  const results = await Promise.allSettled(
    writes.map((w) =>
      s3Store.putText(w.key, w.body, w.contentType, w.contentDisposition)
    )
  );
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected"
  );
  if (rejected.length > 0) {
    throw new AggregateError(
      rejected.map((r) => r.reason),
      `Failed to persist ${rejected.length} of ${writes.length} snapshot blob(s)`
    );
  }
}

export const versionService = {
  snapshotInTx,
  flushSnapshotWrites,

  /**
   * Snapshot a new version of an existing object (standalone transaction).
   * Body-change entry point for `create-version` server actions / surfaces.
   * The DB row commits first, then the S3 blobs are flushed.
   */
  async snapshot(
    req: Requester,
    obj: { id: string; kind: "document" | "artifact" },
    input: SnapshotInput
  ): Promise<ContentVersionDTO> {
    const { version, s3Writes } = await executeTransaction(
      (tx) => snapshotInTx(tx, req, obj, input),
      "content.snapshot"
    );
    await flushSnapshotWrites(s3Writes);
    return version;
  },

  /** Load the current (head) version of an object, or null if none exists. */
  async current(objectId: string): Promise<ContentVersionDTO | null> {
    const rows = await executeQuery(
      (db) =>
        db
          .select(versionSelectFields)
          .from(contentVersions)
          .innerJoin(
            contentObjects,
            eq(contentObjects.currentVersionId, contentVersions.id)
          )
          .where(eq(contentObjects.id, objectId))
          .limit(1),
      "content.currentVersion"
    );
    return rows[0] ? rowToVersionDTO(rows[0] as VersionRowAsText) : null;
  },

  /** List an object's versions newest-first. */
  async list(objectId: string): Promise<ContentVersionDTO[]> {
    const rows = await executeQuery(
      (db) =>
        db
          .select(versionSelectFields)
          .from(contentVersions)
          .where(eq(contentVersions.objectId, objectId))
          .orderBy(desc(contentVersions.versionNumber)),
      "content.listVersions"
    );
    return rows.map((r) => rowToVersionDTO(r as VersionRowAsText));
  },

  /**
   * Point the object's working head at an earlier version, enforcing edit
   * permission. Validates the target version belongs to the object.
   * Re-publishing the rolled-back version is an explicit, separate step
   * (publish service, Phase 5/7).
   */
  async rollback(
    req: Requester,
    objectId: string,
    toVersionId: string
  ): Promise<void> {
    const log = createLogger({ action: "content.rollback" });

    // Load owner + visibility and run the permission checks OUTSIDE the
    // transaction. `canView` may issue its own `executeQuery` (grant lookup),
    // which acquires a second pooled connection — doing that inside an
    // `executeTransaction` callback (which already holds one connection) risks a
    // pool deadlock under concurrency (every slot held by a transaction waiting
    // for a second slot). The owner row read here is also used by `canView`.
    const owner = await executeQuery(
      (db) =>
        db
          .select({
            ownerUserId: contentObjects.ownerUserId,
            visibilityLevel: contentObjects.visibilityLevel,
          })
          .from(contentObjects)
          .where(eq(contentObjects.id, objectId))
          .limit(1),
      "content.rollback.loadOwner"
    );
    if (!owner[0]) {
      throw new NotFoundError("Content not found", { objectId });
    }
    // Mask existence from callers who cannot view the object *before* revealing
    // edit state: a non-viewable object must 404 (not 403), mirroring
    // `content-service.createVersion`/`update`. Otherwise `rollback` lets an
    // attacker enumerate private object ids (403 = exists, 404 = absent).
    const viewable = await visibilityService.canView(req, {
      id: objectId,
      ownerUserId: owner[0].ownerUserId,
      visibilityLevel: owner[0].visibilityLevel,
    });
    if (!viewable) {
      throw new NotFoundError("Content not found", { objectId });
    }
    assertCanEdit(req, owner[0].ownerUserId);

    await executeTransaction(async (tx) => {
      // Single query: the target must exist AND belong to this object.
      const target = await tx
        .select({ id: contentVersions.id })
        .from(contentVersions)
        .where(
          and(
            eq(contentVersions.id, toVersionId),
            eq(contentVersions.objectId, objectId)
          )
        )
        .limit(1);
      if (!target[0]) {
        throw new ValidationError(
          "Target version not found for this object",
          { objectId, toVersionId }
        );
      }

      const updated = await tx
        .update(contentObjects)
        .set({ currentVersionId: toVersionId, updatedAt: new Date() })
        .where(eq(contentObjects.id, objectId))
        .returning({ id: contentObjects.id });
      // The object row could be deleted between the outer permission check
      // (loaded via executeQuery, outside this tx) and this UPDATE. The
      // target-version SELECT above guards the version row, not the object row,
      // so without this check a concurrent object delete would log a successful
      // rollback that affected 0 rows.
      if (!updated[0]) {
        throw new NotFoundError("Content not found", { objectId });
      }
    }, "content.rollback");
    log.info("Rolled back content head", { objectId, toVersionId });
  },
};
