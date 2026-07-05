/**
 * OKF export service — Phase 8 (Issue #1103, Epic #1059, spec §36.2)
 *
 * Serializes a `content_collections` subtree to a portable OKF bundle. This is
 * the collection-grained companion to the single-object `okf` publish adapter
 * (`../publish-adapters/okf.ts`); both share the pure serializers in `./serialize`.
 *
 * ## The one security-critical surface: permission-at-export (spec §36.2)
 * A bundle is portable files that escape `canView` the moment they are written, so
 * export MUST:
 *  1. Filter EVERY object through the same visibility predicate every read uses —
 *     here via `visibilityService.listVisible` (permission pushed into SQL, never
 *     load-then-drop). A student-identity bundle therefore contains no staff-only
 *     concept.
 *  2. Route a `public`/anonymous bundle through the §26.4 gate (`canPublishPublic`)
 *     AND restrict it to `visibility_level = 'public'` objects only — a bundle
 *     meant for anonymous hands must carry nothing but already-public content.
 *
 * Bodies come from the Phase 6 whole-object read (`retrievalService.getContextDocument`,
 * spec §16.3), which itself re-checks `canView` + published status — defense in
 * depth on top of the SQL filter.
 *
 * Read-only over content: it does NOT mutate object status/visibility and does NOT
 * write `content_publications` rows (that is the single-object adapter's job, where
 * "publish to okf" is an explicit act). The bundle is persisted to S3 for durability
 * and its location returned; the calling surface writes the `content_audit_logs`
 * row (§27).
 */

import { and, asc, eq, isNotNull } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentCollections, contentPublications } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { canPublishPublic, raisePublishApprovalRequired } from "../helpers";
import { visibilityService } from "../visibility-service";
import { versionService } from "../version-service";
import { retrievalService } from "../retrieval-service";
import { s3Store } from "../storage/s3-store";
import { NotFoundError } from "../errors";
import type { ContentObjectDTO, Requester } from "../types";
import {
  OKF_GENERATOR,
  OKF_INDEX_FILE,
  OKF_LOG_FILE,
  OKF_VERSION,
  conceptFileName,
  type OkfAudience,
  type OkfBundle,
  type OkfFile,
} from "./profile";
import {
  buildConceptFile,
  buildIndexFile,
  buildLogFile,
  type ConceptSource,
  type IndexLink,
  type LogEntry,
} from "./serialize";

/** Per-export options. */
export interface OkfExportInput {
  /**
   * `internal` (default) → the bundle is scoped to what the requester can view.
   * `public` → the bundle is meant for anonymous distribution; the §26.4 gate runs
   * and only `visibility_level = 'public'` objects are included.
   */
  audience?: OkfAudience;
  /**
   * The requester's EXPLICIT `content:publish_public` authority, resolved at the
   * surface (session capability / token scope). Consulted only for the `user` kind;
   * agents derive their own authority (see `canPublishPublic`).
   */
  hasPublishPublicCapability?: boolean;
}

/** The export result: the portable bundle plus where it was persisted. */
export interface OkfExportResult {
  bundle: OkfBundle;
  /** S3 key the bundle JSON was written to (null when persistence failed). */
  s3Key: string | null;
  /** A presigned read URL for the bundle (null when persistence failed). */
  url: string | null;
}

/** A collection row as loaded for the subtree walk. */
interface CollectionRow {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

/** Load every collection (id, name, slug, parent) ordered for a stable tree. */
async function loadAllCollections(): Promise<CollectionRow[]> {
  return executeQuery(
    (db) =>
      db
        .select({
          id: contentCollections.id,
          name: contentCollections.name,
          slug: contentCollections.slug,
          parentId: contentCollections.parentId,
        })
        .from(contentCollections)
        .orderBy(asc(contentCollections.position), asc(contentCollections.name)),
    "okf.export.loadCollections"
  );
}

/** The root collection + every descendant, in a stable pre-order. */
function collectSubtree(
  rootId: string,
  all: CollectionRow[]
): CollectionRow[] {
  const byParent = new Map<string | null, CollectionRow[]>();
  const byId = new Map<string, CollectionRow>();
  for (const c of all) {
    byId.set(c.id, c);
    const siblings = byParent.get(c.parentId) ?? [];
    siblings.push(c);
    byParent.set(c.parentId, siblings);
  }
  const root = byId.get(rootId);
  if (!root) return [];
  const ordered: CollectionRow[] = [];
  const walk = (node: CollectionRow) => {
    ordered.push(node);
    for (const child of byParent.get(node.id) ?? []) walk(child);
  };
  walk(root);
  return ordered;
}

/**
 * All requester-visible, published objects in one collection, fully paginated so a
 * collection larger than the `listVisible` page cap is never silently truncated.
 * `listVisible` applies the same `canView` SQL predicate as every read path.
 */
async function listCollectionObjects(
  req: Requester,
  collectionId: string
): Promise<ContentObjectDTO[]> {
  const pageSize = 200;
  const objects: ContentObjectDTO[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await visibilityService.listVisible(req, {
      collectionId,
      status: "published",
      limit: pageSize,
      offset,
    });
    objects.push(...page);
    if (page.length < pageSize) break;
  }
  return objects;
}

/**
 * A prior publication URL for an object (`content_publications.external_ref`) → the
 * OKF `resource` field. Picks any live publication that recorded an external ref
 * (e.g. a `public_web` reader URL); null when the object was never published with
 * one.
 */
async function priorPublicationRef(objectId: string): Promise<string | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ externalRef: contentPublications.externalRef })
        .from(contentPublications)
        .where(
          and(
            eq(contentPublications.objectId, objectId),
            eq(contentPublications.status, "live"),
            isNotNull(contentPublications.externalRef)
          )
        )
        .limit(1),
    "okf.export.priorPublication"
  );
  return rows[0]?.externalRef ?? null;
}

/**
 * Build the `ConceptSource` for one object, or null when its body is unavailable.
 * A single object whose body cannot be read (a missing S3 blob, a transient read
 * error) is SKIPPED — logged, not fatal — so one bad object never fails an
 * otherwise-complete bundle. `getContextDocument` returns null for a not-found /
 * not-published / not-viewable object (all expected skips); a thrown read error is
 * caught here.
 */
async function loadConceptSource(
  req: Requester,
  obj: ContentObjectDTO,
  log: ReturnType<typeof createLogger>
): Promise<ConceptSource | null> {
  try {
    // Whole-object body via the Phase 6 read (re-checks canView + published).
    const body = await retrievalService.getContextDocument(req, obj.id);
    if (body == null) return null;
    const version = await versionService.current(obj.id);
    const resource = await priorPublicationRef(obj.id);
    return {
      kind: obj.kind,
      title: obj.title,
      summary: version?.summary ?? null,
      tags: obj.tags,
      updatedAt: obj.updatedAt,
      resource,
      bodyFormat:
        version?.bodyFormat ?? (obj.kind === "document" ? "markdown" : "html"),
      body,
    };
  } catch (err) {
    log.warn("Skipping OKF concept: body unavailable", {
      objectId: obj.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Build an object's `log.md` change-history entries from its version list. */
async function loadLogEntries(objectId: string): Promise<LogEntry[]> {
  const versions = await versionService.list(objectId);
  return versions.map((v) => ({
    versionNumber: v.versionNumber,
    authorActor: v.authorActor,
    summary: v.summary,
    createdAt: v.createdAt,
  }));
}

/** The bundle-relative directory for a collection (root → "", nested by slug). */
function collectionDir(
  collection: CollectionRow,
  rootId: string,
  byId: Map<string, CollectionRow>
): string {
  const segments: string[] = [];
  let cursor: CollectionRow | undefined = collection;
  while (cursor && cursor.id !== rootId) {
    segments.unshift(cursor.slug);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return segments.length > 0 ? `${segments.join("/")}/` : "";
}

/**
 * Guard an object slug against colliding with a reserved OKF filename
 * (`index.md` / `log.md`). A slug of literally "index" or "log" is legal but would
 * overwrite the directory's navigation/history file.
 */
function conceptFile(slug: string): string {
  if (slug === "index" || slug === "log") return conceptFileName(`${slug}-concept`);
  return conceptFileName(slug);
}

/** Assemble one collection directory's files (index.md, log.md, concept files). */
function buildCollectionFiles(
  dir: string,
  collection: CollectionRow,
  concepts: Array<{ obj: ContentObjectDTO; source: ConceptSource; log: LogEntry[] }>,
  childCollections: CollectionRow[]
): OkfFile[] {
  const files: OkfFile[] = [];
  const conceptLinks: IndexLink[] = [];
  const logSections: string[] = [];

  for (const { obj, source, log } of concepts) {
    const fileName = conceptFile(obj.slug);
    files.push({ path: `${dir}${fileName}`, content: buildConceptFile(source) });
    conceptLinks.push({ title: obj.title, href: fileName });
    logSections.push(buildLogFile(obj.title, log));
  }

  const childLinks: IndexLink[] = childCollections.map((c) => ({
    title: c.name,
    href: `${c.slug}/${OKF_INDEX_FILE}`,
  }));

  files.push({
    path: `${dir}${OKF_INDEX_FILE}`,
    content: buildIndexFile(collection.name, conceptLinks, childLinks),
  });
  files.push({
    path: `${dir}${OKF_LOG_FILE}`,
    content:
      logSections.length > 0
        ? logSections.join("\n---\n\n")
        : `# Change history — ${collection.name}\n\n_No published concepts._\n`,
  });
  return files;
}

/**
 * A collision-resistant export id for the S3 key (no crypto import — this module
 * is pulled in via the broad content barrel, and `node:crypto` risks the Edge
 * webpack build). Time-ordered + random suffix; both are `[0-9a-z]`, a safe key
 * segment.
 */
function newExportId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Persist the bundle JSON to S3 (best-effort) and return its key + presigned URL. */
async function persistBundle(
  rootCollectionId: string,
  bundle: OkfBundle,
  log: ReturnType<typeof createLogger>
): Promise<{ s3Key: string | null; url: string | null }> {
  try {
    const key = s3Store.okfBundleKey(rootCollectionId, newExportId());
    await s3Store.putText(key, JSON.stringify(bundle), "application/json", "attachment");
    const url = await s3Store.signedReadUrl(key);
    return { s3Key: key, url };
  } catch (err) {
    // The bundle is already produced and returned inline — a persistence failure
    // must not fail the export. Log and return a null location.
    log.warn("Failed to persist OKF bundle to S3", {
      rootCollectionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { s3Key: null, url: null };
  }
}

/**
 * §26.4 gate — a public/anonymous bundle requires the public-publish authority.
 * The check is destination-shaped (a public bundle is ALWAYS a public exposure),
 * so it is race-free here and mirrors the publish service's pre-tx gate. Autonomous
 * agents can never hold it → they receive approval_required.
 */
function assertPublicExportAllowed(
  req: Requester,
  rootCollectionId: string,
  input: OkfExportInput
): void {
  const mayPublishPublic = canPublishPublic(
    req,
    input.hasPublishPublicCapability ?? false
  );
  if (!mayPublishPublic) {
    raisePublishApprovalRequired(
      req,
      "Exporting a public OKF bundle requires approval",
      { objectId: "", destination: "okf" },
      { collectionId: rootCollectionId, audience: "public" }
    );
  }
}

/**
 * Build one collection directory's OKF files (index.md, log.md, concept files),
 * applying the audience filter (a `public` bundle carries ONLY already-public
 * content — it escapes into anonymous hands, so the §26.4-authorized producer must
 * still emit a payload that is safe in anonymous hands). Returns the files plus how
 * many concepts were emitted.
 */
async function buildSection(
  req: Requester,
  collection: CollectionRow,
  dir: string,
  audience: OkfAudience,
  childCollections: CollectionRow[]
): Promise<{ files: OkfFile[]; objectCount: number }> {
  const log = createLogger({ action: "okf.export.section" });
  let objects = await listCollectionObjects(req, collection.id);
  if (audience === "public") {
    objects = objects.filter((o) => o.visibilityLevel === "public");
  }
  const concepts: Array<{
    obj: ContentObjectDTO;
    source: ConceptSource;
    log: LogEntry[];
  }> = [];
  for (const obj of objects) {
    const source = await loadConceptSource(req, obj, log);
    if (!source) continue; // body unavailable (race / not published) — skip.
    const logEntries = await loadLogEntries(obj.id);
    concepts.push({ obj, source, log: logEntries });
  }
  return {
    files: buildCollectionFiles(dir, collection, concepts, childCollections),
    objectCount: concepts.length,
  };
}

export const okfExportService = {
  /**
   * Export a collection subtree to an OKF bundle. See the module header for the
   * permission boundary (the security-critical surface).
   */
  async exportCollection(
    req: Requester,
    rootCollectionId: string,
    input: OkfExportInput = {}
  ): Promise<OkfExportResult> {
    const log = createLogger({ action: "okf.export" });
    const audience: OkfAudience = input.audience ?? "internal";

    if (audience === "public") {
      assertPublicExportAllowed(req, rootCollectionId, input);
    }

    const all = await loadAllCollections();
    const byId = new Map(all.map((c) => [c.id, c]));
    if (!byId.has(rootCollectionId)) {
      throw new NotFoundError("Collection not found", { rootCollectionId });
    }
    const subtree = collectSubtree(rootCollectionId, all);
    const subtreeIds = new Set(subtree.map((c) => c.id));
    const childrenByParent = new Map<string | null, CollectionRow[]>();
    for (const c of all) {
      const siblings = childrenByParent.get(c.parentId) ?? [];
      siblings.push(c);
      childrenByParent.set(c.parentId, siblings);
    }

    const files: OkfFile[] = [];
    let objectCount = 0;

    for (const collection of subtree) {
      const dir = collectionDir(collection, rootCollectionId, byId);
      // Child collections KEPT in the bundle are only those in the subtree.
      const childCollections = (childrenByParent.get(collection.id) ?? []).filter(
        (c) => subtreeIds.has(c.id)
      );
      const section = await buildSection(
        req,
        collection,
        dir,
        audience,
        childCollections
      );
      files.push(...section.files);
      objectCount += section.objectCount;
    }

    const rootCollection = byId.get(rootCollectionId) ?? null;
    const bundle: OkfBundle = {
      okfVersion: OKF_VERSION,
      generator: OKF_GENERATOR,
      rootCollectionId,
      rootCollectionSlug: rootCollection?.slug ?? null,
      audience,
      objectCount,
      collectionCount: subtree.length,
      files,
    };

    const location = await persistBundle(rootCollectionId, bundle, log);
    log.info("Exported OKF bundle", {
      rootCollectionId,
      audience,
      objectCount,
      collectionCount: subtree.length,
      persisted: location.s3Key != null,
    });
    return { bundle, s3Key: location.s3Key, url: location.url };
  },
};
