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

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import { contentEmbedLinks, contentObjects, contentVersions } from "@/lib/db/schema";
import { parseEmbeddedArtifactIds } from "./embed-directive";
import { pgTimestampAsText } from "@/lib/db/drizzle-helpers";
import { createLogger } from "@/lib/logger";
import { actorKindOf, agentIdOf, assertCanEdit, authorUserIdOf } from "./helpers";
import {
  assertScreened,
  screenAgentBodyForWrite,
  type ScreeningProof,
} from "./agent-screening";
import { rowToVersionDTO, type VersionRowAsText } from "./mappers";
import { renderMarkdownToHtml } from "./render/markdown-render";
import { s3Store } from "./storage/s3-store";
import { contentEvents } from "./events";
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

/**
 * Maintain the `content_embed_links` backlinks for a DOCUMENT snapshot (Meridian
 * slice D). The document's canonical markdown is the source of truth for which
 * artifacts it embeds (`::atrium-artifact{id="…"}` directives), so on every version
 * write we REPLACE this document's rows to match the new body: parse the referenced
 * ids, keep only those that are EXISTING artifacts (so a stale/typo id can never
 * abort the snapshot on the FK, and a non-artifact edge is never stored), then
 * delete-then-insert inside the same transaction. Runs in-tx so the backlinks are
 * transactionally consistent with the committed version. Called for documents only
 * (artifacts never embed).
 */
async function syncEmbedBacklinksInTx(
  tx: DbTransaction,
  documentId: string,
  markdown: string
): Promise<void> {
  const referenced = parseEmbeddedArtifactIds(markdown);
  let validArtifactIds: string[] = [];
  if (referenced.length > 0) {
    const rows = await tx
      .select({ id: contentObjects.id })
      .from(contentObjects)
      .where(
        and(
          inArray(contentObjects.id, referenced),
          eq(contentObjects.kind, "artifact")
        )
      );
    validArtifactIds = rows.map((r) => r.id);
  }
  // Replace this document's backlink set to match the latest snapshot (also clears
  // links when an embed was removed, since referenced may now be empty).
  await tx
    .delete(contentEmbedLinks)
    .where(eq(contentEmbedLinks.documentObjectId, documentId));
  if (validArtifactIds.length > 0) {
    await tx
      .insert(contentEmbedLinks)
      .values(
        validArtifactIds.map((artifactObjectId) => ({
          documentObjectId: documentId,
          artifactObjectId,
        }))
      )
      .onConflictDoNothing();
  }
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
 *
 * `proof` is the §28.3 screening evidence (issue #1118 item 3): this primitive
 * itself asserts (via `assertScreened`) that agent-authored content was screened
 * BEFORE reaching the DB. Screening is pre-tx external IO (Bedrock) and cannot
 * move inside the transaction, so the guard is an assertion the proof ran rather
 * than the screening call itself — a future caller that skips
 * `screenAgentBodyForWrite` cannot forge a proof and fails loudly here.
 */
export async function snapshotInTx(
  tx: DbTransaction,
  req: Requester,
  obj: { id: string; kind: "document" | "artifact" },
  input: SnapshotInput,
  proof: ScreeningProof
): Promise<SnapshotResult> {
  // Reject empty AND whitespace-only bodies, mirroring the `.trim()` title check
  // in content-service so "   " is not silently snapshotted as content.
  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    throw new ValidationError("Version body is required");
  }
  // §28.3 defense in depth (issue #1118 item 3): agent content must have been
  // screened before reaching this shared write primitive. No-op for human writers.
  assertScreened(req, input.body, proof, obj.id);
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

  // Maintain the "EMBEDDED IN" backlinks from this document's embed directives
  // (Meridian slice D). Documents only — artifacts never embed. In-tx so the
  // backlinks stay consistent with the committed version body.
  if (isDocument) {
    await syncEmbedBacklinksInTx(tx, obj.id, input.body);
  }

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
 * `render.html` not), OR a total failure after the row already committed (S3
 * down/throttled), leaves the committed version row's `render_location` pointing
 * at a key that is absent. `render.html` is deterministically derivable from the
 * persisted `source.md`, so the Phase 1 render path can regenerate it on demand.
 * We still throw on any failure so the caller learns the write did not fully
 * succeed (an aggregate of the underlying errors).
 *
 * CONTRACT FOR PHASE 1+ CONSUMERS: `version.renderLocation` is NOT guaranteed to
 * resolve to an existing S3 object. Treat a `NoSuchKey` as "not yet rendered" and
 * regenerate from `source.md` (or fall back gracefully) — never surface the raw
 * S3 error. Phase 0 has no render-serving consumer, so no live path dereferences
 * it yet.
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

/**
 * Snapshot a new version in a standalone transaction given a pre-computed
 * screening `proof` — does the tx + S3 flush + event emit but NO screening
 * (issue #1118 item 7). Splitting screening out lets a caller that RETRIES the
 * transaction (createVersion's version-number-conflict retry) re-run only the DB
 * work without re-invoking the unmemoized external screening IO — which would
 * otherwise double the Bedrock/Comprehend calls and could reject already-passed
 * content if the 2nd call transiently degraded.
 */
async function snapshotScreened(
  req: Requester,
  obj: { id: string; kind: "document" | "artifact" },
  input: SnapshotInput,
  proof: ScreeningProof
): Promise<ContentVersionDTO> {
  const { version, s3Writes } = await executeTransaction(
    (tx) => snapshotInTx(tx, req, obj, input, proof),
    "content.snapshot"
  );
  await flushSnapshotWrites(s3Writes);

  // Emit after the row commits + blobs flush (§27): drives re-index of the new
  // head. Best-effort — never rolls back a committed version. Fire-and-forget
  // (`void`, not `await`): `emit` swallows its own errors, so awaiting only holds
  // the response open for an SNS round-trip (matches the audit-write pattern).
  void contentEvents.emit("content.version_created", {
    objectId: obj.id,
    versionId: version.id,
    actorKind: actorKindOf(req),
    agentLabel: req.kind === "user" ? null : req.agentLabel,
  });

  return version;
}

export const versionService = {
  snapshotInTx,
  snapshotScreened,
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
    // §28.3 — agent-authored bodies (document markdown AND artifact code) are
    // guardrails/PII-screened BEFORE the write, mirroring the agent bridge.
    // No-op for human/delegated authors. Runs pre-transaction: screening is
    // external IO (Bedrock) that must never hold a pooled connection.
    // Fail-closed: blocked or unscreenable content throws ValidationError.
    const proof = await screenAgentBodyForWrite(req, input.body, obj.id);
    return snapshotScreened(req, obj, input, proof);
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
   * Load one version by id, scoped to its object (the caller already knows the
   * object). Returns null when the version does not exist OR does not belong to
   * `objectId` — scoping by object prevents a caller who passed `canView` for
   * object A from loading a version of an unrelated, possibly-restricted object B
   * by guessing its version id.
   */
  async getById(
    objectId: string,
    versionId: string
  ): Promise<ContentVersionDTO | null> {
    const rows = await executeQuery(
      (db) =>
        db
          .select(versionSelectFields)
          .from(contentVersions)
          .where(
            and(
              eq(contentVersions.id, versionId),
              eq(contentVersions.objectId, objectId)
            )
          )
          .limit(1),
      "content.versionById"
    );
    return rows[0] ? rowToVersionDTO(rows[0] as VersionRowAsText) : null;
  },

  /**
   * Resolve the raw artifact code for an artifact version, from wherever it lives
   * (inline `body_inline` for small bodies, or the S3 object at `body_location`
   * for larger ones — see `snapshotInTx`). Returns the verbatim, UNTRUSTED code.
   *
   * SECURITY: the returned string is untrusted artifact source. It must only be
   * shown in the CodeMirror editor or delivered to the cross-origin
   * `<ArtifactSandbox>` via postMessage — never `dangerouslySetInnerHTML`, never
   * served as text/html on the app origin (§28.1).
   *
   * Document versions have no artifact body; calling this on one throws so a
   * mis-routed caller fails loudly rather than reading `source.md` as "code".
   * An S3 read failure (e.g. NoSuchKey) is surfaced to the caller, which should
   * degrade gracefully (the reader shows an empty/unavailable preview) rather
   * than leaking the raw S3 error.
   */
  async loadArtifactCode(version: ContentVersionDTO): Promise<string> {
    if (version.bodyFormat === "markdown") {
      throw new ValidationError(
        "loadArtifactCode called on a non-artifact (markdown) version",
        { versionId: version.id }
      );
    }
    if (version.bodyLocation === "inline") {
      // Inline bodies always carry their code in `body_inline`. A null here means
      // the row is malformed; treat it as empty rather than crashing the canvas.
      return version.bodyInline ?? "";
    }
    // Larger artifacts: `body_location` is the deterministic S3 key.
    return s3Store.getText(version.bodyLocation);
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

    // Refresh the retrieval index (§16). The index stores a PERSISTED snapshot of
    // the head version's chunked text, so repointing the working head above changes
    // what "current" means without touching that snapshot — a published,
    // retrieval-scoped object would keep surfacing the STALE pre-rollback text to
    // assistants until some unrelated republish re-indexed it. Best-effort: the
    // rollback has already committed, so a re-index failure is logged, never thrown.
    await reindexAfterRollbackBestEffort(objectId);
  },
};

/**
 * Best-effort retrieval-index refresh after a rollback repoints the working head.
 * `retrievalService.indexObject` self-guards on `status === "published"` (and on a
 * missing object / current version), so this is a safe no-op for a draft/archived
 * or unindexed object — it never wrongly ADDS an unpublished object to the index —
 * while a published object is re-indexed to reflect the rolled-back head. Mirrors
 * the publish path's inline `indexObject` and content-service's
 * `pruneRetrievalIndexBestEffort`: the head change has already committed, so a
 * re-index failure is logged, never thrown. Lazy import: retrieval-service
 * statically imports THIS module, so a static import back would create a cycle.
 */
async function reindexAfterRollbackBestEffort(objectId: string): Promise<void> {
  try {
    const { retrievalService } = await import("./retrieval-service");
    await retrievalService.indexObject(objectId);
  } catch (indexError) {
    createLogger({ action: "content.rollback" }).warn(
      "Failed to re-index retrieval snapshot after rollback",
      {
        objectId,
        error:
          indexError instanceof Error ? indexError.message : String(indexError),
      }
    );
  }
}
