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
 * collide. S3 writes happen *after* the row insert inside the same transaction:
 * a unique-violation aborts before any blob is written; the deterministic,
 * content-addressed key means a rare post-write rollback only leaves a harmless,
 * overwritable object.
 */

import { desc, eq, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client";
import { contentObjects, contentVersions } from "@/lib/db/schema";
import { pgTimestampAsText } from "@/lib/db/drizzle-helpers";
import { createLogger } from "@/lib/logger";
import { actorKindOf, agentIdOf, authorUserIdOf } from "./helpers";
import { rowToVersionDTO, type VersionRowAsText } from "./mappers";
import { renderMarkdownToHtml } from "./render/markdown-render";
import { s3Store } from "./storage/s3-store";
import { NotFoundError, ValidationError } from "./errors";
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

/**
 * Core snapshot routine that runs inside an existing transaction. Used by
 * `content-service.create` (sharing its transaction) and by the public
 * `snapshot` wrapper below.
 */
export async function snapshotInTx(
  tx: DbTransaction,
  req: Requester,
  obj: { id: string; kind: "document" | "artifact" },
  input: SnapshotInput
): Promise<ContentVersionDTO> {
  if (typeof input.body !== "string") {
    throw new ValidationError("Version body is required");
  }
  const bodyFormat = input.bodyFormat ?? defaultBodyFormat(obj.kind);
  const next = (await maxVersion(tx, obj.id)) + 1;

  const isDocument = obj.kind === "document";
  const inline =
    !isDocument && Buffer.byteLength(input.body, "utf8") <= INLINE_ARTIFACT_MAX_BYTES;

  let bodyLocation: string;
  let bodyInline: string | null = null;

  if (isDocument) {
    // Document live state belongs to the Proof doc-store (Phase 1). Phase 0
    // persists the canonical markdown + a rendered snapshot to S3 so content is
    // legible/round-trippable before any editor exists.
    bodyLocation = "proof";
  } else if (inline) {
    bodyLocation = "inline";
    bodyInline = input.body;
  } else {
    bodyLocation = s3Store.key(obj.id, next, artifactFileName(bodyFormat));
  }

  // Insert the version row first so a uniqueness violation aborts before S3 IO.
  const [versionRow] = await tx
    .insert(contentVersions)
    .values({
      objectId: obj.id,
      versionNumber: next,
      authorActor: actorKindOf(req),
      authorUserId: authorUserIdOf(req),
      authorAgentId: agentIdOf(req),
      bodyFormat,
      bodyLocation,
      bodyInline,
      // renderLocation filled in below for documents (deterministic key).
      renderLocation: isDocument ? s3Store.key(obj.id, next, "render.html") : null,
      summary: input.summary ?? null,
    })
    .returning(versionSelectFields);

  // S3 writes (deterministic keys; safe to overwrite on retry).
  if (isDocument) {
    const html = renderMarkdownToHtml(input.body);
    await s3Store.putText(
      s3Store.key(obj.id, next, "source.md"),
      input.body,
      "text/markdown"
    );
    if (versionRow.renderLocation) {
      await s3Store.putText(versionRow.renderLocation, html, "text/html");
    }
  } else if (!inline) {
    await s3Store.putText(
      bodyLocation,
      input.body,
      bodyFormat === "jsx" ? "text/jsx" : "text/html"
    );
  }

  // Advance the object's working head.
  await tx
    .update(contentObjects)
    .set({ currentVersionId: versionRow.id, updatedAt: new Date() })
    .where(eq(contentObjects.id, obj.id));

  return rowToVersionDTO(versionRow as VersionRowAsText);
}

export const versionService = {
  snapshotInTx,

  /**
   * Snapshot a new version of an existing object (standalone transaction).
   * Body-change entry point for `create-version` server actions / surfaces.
   */
  async snapshot(
    req: Requester,
    obj: { id: string; kind: "document" | "artifact" },
    input: SnapshotInput
  ): Promise<ContentVersionDTO> {
    return executeTransaction(
      (tx) => snapshotInTx(tx, req, obj, input),
      "content.snapshot"
    );
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
   * Point the object's working head at an earlier version. Validates the target
   * version belongs to the object. Re-publishing the rolled-back version is an
   * explicit, separate step (publish service, Phase 5/7).
   */
  async rollback(objectId: string, toVersionId: string): Promise<void> {
    const log = createLogger({ action: "content.rollback" });
    await executeTransaction(async (tx) => {
      const target = await tx
        .select({ id: contentVersions.id })
        .from(contentVersions)
        .where(eq(contentVersions.id, toVersionId))
        .limit(1);
      if (!target[0]) {
        throw new NotFoundError("Target version not found", { toVersionId });
      }
      // Ensure the version belongs to this object.
      const belongs = await tx
        .select({ id: contentVersions.id })
        .from(contentVersions)
        .where(
          sql`${contentVersions.id} = ${toVersionId} AND ${contentVersions.objectId} = ${objectId}`
        )
        .limit(1);
      if (!belongs[0]) {
        throw new ValidationError(
          "Target version does not belong to this object",
          { objectId, toVersionId }
        );
      }
      await tx
        .update(contentObjects)
        .set({ currentVersionId: toVersionId, updatedAt: new Date() })
        .where(eq(contentObjects.id, objectId));
    }, "content.rollback");
    log.info("Rolled back content head", { objectId, toVersionId });
  },
};
