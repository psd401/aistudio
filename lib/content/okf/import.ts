/**
 * OKF import service — Phase 8 (Issue #1103, Epic #1059, spec §36.3)
 *
 * Parses an OKF bundle (concept files + the `index.md` tree + `log.md`) and
 * writes it into Atrium content through the SAME service every other surface uses
 * (`contentService`), so imported content obeys every invariant native content
 * does. Import is inbound, so — unlike export — it is NOT a `publish_destination`;
 * it is a plain service invoked by the `import_okf` MCP tool / REST endpoint.
 *
 * ## Provenance: imported content is agent-authored (spec §36.3 / §11)
 * A machine transformed an external bundle into content; nobody typed it. So every
 * imported object + version is written as the seeded **`atrium-importer`** agent
 * identity (an `agent-autonomous` requester), stamping `actor_kind = 'agent'` and
 * `author_agent_id` — never fabricated human authorship. The human/agent that
 * TRIGGERED the import is still authorized at the surface (`content:create`) and
 * recorded in the audit row; only the content provenance is the importer agent.
 *
 * ## Safe defaults
 * Imported objects are created **private + draft** (owner = the §26.5 system user):
 * inbound external content must not land pre-widened. A human/agent publishes or
 * widens it afterward through the normal gated paths.
 */

import { executeQuery } from "@/lib/db/drizzle-client";
import { contentCollections } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { contentService } from "../content-service";
import { assertCanCreate, slugCandidate, slugifyTitle } from "../helpers";
import { ConflictError, ValidationError } from "../errors";
import type { BodyFormat, Requester } from "../types";
import { OKF_GENERATOR, OKF_INDEX_FILE, OKF_LOG_FILE, kindForOkfType, type OkfFile } from "./profile";
import { parseConceptFile, parseFrontmatter } from "./frontmatter";

/**
 * The seeded `atrium-importer` agent identity id (migration 095). Every imported
 * object/version is authored as this identity so `actor_kind = 'agent'` provenance
 * is stamped regardless of who triggered the import. The FK to `agent_identities`
 * requires the row to exist — it is seeded idempotently in the migration.
 */
export const ATRIUM_IMPORT_AGENT_ID = "0a710f00-0000-4000-a000-000000000f36";

/** The `agent-autonomous` requester every import write is attributed to. */
function importRequester(): Requester {
  return {
    kind: "agent-autonomous",
    agentId: ATRIUM_IMPORT_AGENT_ID,
    roleId: null,
    roles: [],
    scopes: ["content:create", "content:update"],
    agentLabel: "atrium-importer",
  };
}

/** Import input: the bundle files plus an optional collection to import under. */
export interface OkfImportInput {
  /** The bundle's files (the exporter's `OkfBundle.files`, or an external bundle). */
  files: OkfFile[];
  /**
   * An existing collection id to import the bundle root INTO. When omitted, a fresh
   * root collection is created (named from the root `index.md`).
   */
  targetCollectionId?: string;
}

/** One imported object in the result summary. */
export interface OkfImportedObject {
  id: string;
  slug: string;
  title: string;
  collectionId: string | null;
}

/** The import result summary. */
export interface OkfImportResult {
  rootCollectionId: string | null;
  collectionsCreated: number;
  objects: OkfImportedObject[];
  objectCount: number;
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: string }).code === "23505";

/** Directory of a bundle path (no trailing slash; "" for the root). */
function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/** Basename of a bundle path. */
function baseOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** The parent directory of a directory key ("sub/deep" → "sub", "sub" → ""). */
function parentDir(dir: string): string {
  const idx = dir.lastIndexOf("/");
  return idx === -1 ? "" : dir.slice(0, idx);
}

/** The last path segment of a directory key ("sub/deep" → "deep"). */
function lastSegment(dir: string): string {
  const idx = dir.lastIndexOf("/");
  return idx === -1 ? dir : dir.slice(idx + 1);
}

/** Insert one collection, retrying with a `-N` slug suffix on a unique collision. */
async function createCollection(
  name: string,
  baseSlug: string,
  parentId: string | null
): Promise<string> {
  const base = slugifyTitle(baseSlug || name);
  for (let attempt = 0; attempt < 50; attempt++) {
    const slug = slugCandidate(base, attempt);
    try {
      const rows = await executeQuery(
        (db) =>
          db
            .insert(contentCollections)
            .values({
              name: name.slice(0, 200),
              slug,
              parentId,
              // Inbound external content lands private-by-default (safe).
              defaultVisibilityLevel: "private",
            })
            .returning({ id: contentCollections.id }),
        "okf.import.createCollection"
      );
      if (rows[0]) return rows[0].id;
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new ConflictError("Could not allocate a unique collection slug", { base });
}

/** Parse the `title` frontmatter from an `index.md`, if present. */
function indexTitle(files: Map<string, OkfFile>, dir: string): string | undefined {
  const indexPath = dir ? `${dir}/${OKF_INDEX_FILE}` : OKF_INDEX_FILE;
  const file = files.get(indexPath);
  if (!file) return undefined;
  const { frontmatter } = parseFrontmatter(file.content);
  const title = frontmatter.title;
  return typeof title === "string" ? title : Array.isArray(title) ? title[0] : undefined;
}

/**
 * Reconstruct the collection tree from the bundle's directory layout. Returns a map
 * of directory-key → collection id. The root dir ("") maps to `targetCollectionId`
 * when supplied, else to a freshly created root collection.
 */
async function reconstructCollections(
  dirs: Set<string>,
  fileMap: Map<string, OkfFile>,
  targetCollectionId: string | undefined
): Promise<{ map: Map<string, string | null>; created: number }> {
  const map = new Map<string, string | null>();
  let created = 0;

  // Depth-sorted so a parent directory is always created before its children.
  const ordered = Array.from(dirs).sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)
  );

  for (const dir of ordered) {
    if (dir === "") {
      if (targetCollectionId) {
        map.set("", targetCollectionId);
      } else {
        const rootName = indexTitle(fileMap, "") ?? "Imported OKF bundle";
        map.set("", await createCollection(rootName, rootName, null));
        created++;
      }
      continue;
    }
    const parentId = map.get(parentDir(dir)) ?? targetCollectionId ?? null;
    const segment = lastSegment(dir);
    const name = indexTitle(fileMap, dir) ?? segment;
    map.set(dir, await createCollection(name, segment, parentId));
    created++;
  }
  return { map, created };
}

/** Split an artifact concept body (a fenced code block) into code + format. */
function extractArtifactBody(body: string): { code: string; bodyFormat: BodyFormat } {
  const match = /^\s*(`{3,})([A-Za-z]*)\r?\n([\s\S]*?)\r?\n\1\s*$/.exec(body.trim());
  if (match) {
    const lang = match[2].toLowerCase();
    return { code: match[3], bodyFormat: lang === "jsx" ? "jsx" : "html" };
  }
  // No fence — treat the whole body as HTML artifact code.
  return { code: body, bodyFormat: "html" };
}

/** A title for a concept lacking a `title` frontmatter — humanize its filename. */
function titleFromFile(path: string): string {
  const base = baseOf(path).replace(/\.md$/i, "");
  const words = base.replace(/[-_]+/g, " ").trim();
  return words.length > 0 ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : "Untitled";
}

/** Derive a create-ready body + format from a parsed concept (fence-aware). */
function conceptBodyForCreate(
  kind: "document" | "artifact",
  conceptBody: string
): { body?: string; bodyFormat?: BodyFormat } {
  if (kind === "artifact") {
    const extracted = extractArtifactBody(conceptBody);
    const body = extracted.code.trim().length > 0 ? extracted.code : undefined;
    return { body, bodyFormat: body ? extracted.bodyFormat : undefined };
  }
  const body = conceptBody.trim().length > 0 ? conceptBody : undefined;
  return { body, bodyFormat: body ? "markdown" : undefined };
}

/** Create ONE imported object from a concept file, as the import agent. */
async function importConcept(
  importReq: Requester,
  file: OkfFile,
  dirToCollection: Map<string, string | null>,
  targetCollectionId: string | undefined
): Promise<OkfImportedObject> {
  const concept = parseConceptFile(file.content);
  const kind = kindForOkfType(concept.frontmatter.type);
  const title = concept.frontmatter.title?.trim() || titleFromFile(file.path);
  const collectionId =
    dirToCollection.get(dirOf(file.path)) ?? targetCollectionId ?? undefined;
  const { body, bodyFormat } = conceptBodyForCreate(kind, concept.body);

  const createdObject = await contentService.create(importReq, {
    kind,
    title,
    collectionId,
    body,
    bodyFormat,
    // Inbound content is private + draft; never pre-widened.
    visibility: { level: "private" },
    tags: concept.frontmatter.tags,
    sourceRef: { type: "okf", generator: OKF_GENERATOR },
  });
  return {
    id: createdObject.id,
    slug: createdObject.slug,
    title: createdObject.title,
    collectionId: createdObject.collectionId,
  };
}

export const okfImportService = {
  /**
   * Import an OKF bundle into Atrium content. See the module header for the
   * provenance + safe-default guarantees.
   */
  async importBundle(
    callerReq: Requester,
    input: OkfImportInput
  ): Promise<OkfImportResult> {
    const log = createLogger({ action: "okf.import" });
    // Defense in depth: the surface already gated `content:create`, but re-assert so
    // an internal/mis-wired caller can never write content it is not entitled to.
    assertCanCreate(callerReq);

    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw new ValidationError("OKF bundle contains no files");
    }

    const fileMap = new Map(input.files.map((f) => [f.path, f]));
    // Concept files are everything that is NOT a reserved OKF filename.
    const conceptFiles = input.files.filter((f) => {
      const base = baseOf(f.path);
      return base !== OKF_INDEX_FILE && base !== OKF_LOG_FILE;
    });
    if (conceptFiles.length === 0) {
      throw new ValidationError("OKF bundle contains no concept files");
    }

    // Every directory referenced by any file needs a collection.
    const dirs = new Set<string>(input.files.map((f) => dirOf(f.path)));
    const { map: dirToCollection, created } = await reconstructCollections(
      dirs,
      fileMap,
      input.targetCollectionId
    );

    const importReq = importRequester();
    const objects: OkfImportedObject[] = [];
    for (const file of conceptFiles) {
      objects.push(
        await importConcept(importReq, file, dirToCollection, input.targetCollectionId)
      );
    }

    const rootCollectionId = dirToCollection.get("") ?? input.targetCollectionId ?? null;
    log.info("Imported OKF bundle", {
      rootCollectionId,
      collectionsCreated: created,
      objectCount: objects.length,
    });
    return {
      rootCollectionId,
      collectionsCreated: created,
      objects,
      objectCount: objects.length,
    };
  },
};
