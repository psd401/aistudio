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
 * imported object + version is attributed to the seeded **`atrium-importer`**
 * agent identity, stamping `actor_kind = 'agent'` and `author_agent_id` — never
 * fabricated human authorship. Ownership and collection authorization remain
 * bound to the human/delegated caller, so imported content can safely live in
 * that caller's private hierarchy.
 *
 * ## Safe defaults
 * Imported objects are created **private + draft** and owned by the triggering
 * human/delegated owner. Inbound external content must not land pre-widened. An
 * autonomous caller may import into an existing selectable collection, but
 * cannot mint an ownerless/shared hierarchy as a side door around collection
 * administration.
 *
 * ## Retry / partial-failure semantics (NOT transactional)
 * Import is deliberately **additive and NOT wrapped in a single transaction**:
 * each object is created via `contentService.create`, which runs its own DB
 * transaction AND does S3 body IO *after* that transaction commits (the drizzle
 * anti-pattern is external IO inside a tx; a single tx over up to
 * `OKF_IMPORT_MAX_FILES` creates would also pin a pooled connection far too long).
 * Consequently, if a run fails partway, the collections + objects already created
 * are **left in place** (they are valid private/draft content), and there is no
 * dedup on path/`sourceRef`. A blind retry may duplicate objects or meet a
 * sibling-name conflict. Callers that need idempotency should create/select a
 * fresh target and treat a failed run as "archive the partial imported subtree,
 * then retry into a new target". Documented on the REST/MCP surfaces.
 */

import { createLogger } from "@/lib/logger";
import { contentService } from "../content-service";
import { collectionManagementService } from "../collection-management-service";
import {
  collectionAccessSnapshot,
  collectionOwnerUserId,
} from "../collection-access";
import { assertCanCreate } from "../helpers";
import { ForbiddenError, ValidationError } from "../errors";
import type {
  BodyFormat,
  CollectionScope,
  Requester,
} from "../types";
import type { ContentAuditSurface } from "../audit";
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

/**
 * The directory portion of a slash-path — everything before the last "/", or "" when
 * top-level. Works on a file path (`a/b.md` → `a`) AND on a directory key, where it
 * yields the parent directory (`sub/deep` → `sub`, `sub` → "").
 */
function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * The last segment of a slash-path — the basename of a file (`a/b.md` → `b.md`) or a
 * directory's own name (`sub/deep` → `deep`).
 */
function baseOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

interface OkfImportOptions {
  surface?: ContentAuditSurface;
  requestId?: string;
}

/** Create one collection through the shared authority/audit write path. */
async function createCollection(
  req: Requester,
  name: string,
  parentId: string | null,
  scope: CollectionScope,
  options: OkfImportOptions
): Promise<string> {
  const collection = await collectionManagementService.create(
    req,
    {
      name: name.slice(0, 200),
      scope,
      parentId,
      defaultVisibilityLevel: "private",
      inheritGrants: scope === "district",
    },
    options
  );
  return collection.id;
}

async function importCollectionScope(
  req: Requester,
  targetCollectionId: string | undefined
): Promise<CollectionScope> {
  const access = await collectionAccessSnapshot(req);
  const target = targetCollectionId
    ? access.byId.get(targetCollectionId)
    : undefined;
  if (
    targetCollectionId &&
    (!target || !access.selectableCollectionIds.has(targetCollectionId))
  ) {
    throw new ValidationError("Target collection not found");
  }
  if (target) {
    return target.ownerUserId == null ? "district" : "private";
  }
  if (collectionOwnerUserId(req) == null) {
    throw new ForbiddenError(
      "Autonomous imports require an existing selectable target collection"
    );
  }
  return "private";
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
  req: Requester,
  dirs: Set<string>,
  fileMap: Map<string, OkfFile>,
  targetCollectionId: string | undefined,
  options: OkfImportOptions
): Promise<{ map: Map<string, string | null>; created: number }> {
  const map = new Map<string, string | null>();
  let created = 0;
  const scope = await importCollectionScope(req, targetCollectionId);

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
        map.set(
          "",
          await createCollection(req, rootName, null, scope, options)
        );
        created++;
      }
      continue;
    }
    const parentId = map.get(dirOf(dir)) ?? targetCollectionId ?? null;
    const segment = baseOf(dir);
    const name = indexTitle(fileMap, dir) ?? segment;
    map.set(
      dir,
      await createCollection(req, name, parentId, scope, options)
    );
    created++;
  }
  return { map, created };
}

/** Split an artifact concept body (a fenced code block) into code + format. */
function extractArtifactBody(body: string): { code: string; bodyFormat: BodyFormat } {
  // Accept backtick OR tilde fences (CommonMark / other OKF producers use both);
  // `\1` requires the closing fence to match the opening run character + length.
  const match = /^\s*([`~]{3,})([A-Za-z]*)\r?\n([\s\S]*?)\r?\n\1\s*$/.exec(body.trim());
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
  callerReq: Requester,
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

  const createdObject = await contentService.create(
    callerReq,
    {
      kind,
      title,
      collectionId,
      body,
      bodyFormat,
      // Inbound content is private + draft; never pre-widened.
      visibility: { level: "private" },
      tags: concept.frontmatter.tags,
      sourceRef: { type: "okf", generator: OKF_GENERATOR },
    },
    { attributionRequester: importReq }
  );
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
    input: OkfImportInput,
    options: OkfImportOptions = {}
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

    // Every directory referenced by any file needs a collection — INCLUDING every
    // ancestor. A bundle with `math/algebra/x.md` but no file directly in `math/`
    // (another producer may omit intermediate index.md files) must still create the
    // `math` collection, or `math/algebra` would be mis-parented / flattened.
    const dirs = new Set<string>([""]);
    for (const file of input.files) {
      let dir = dirOf(file.path);
      while (dir !== "") {
        dirs.add(dir);
        dir = dirOf(dir);
      }
    }
    const { map: dirToCollection, created } = await reconstructCollections(
      callerReq,
      dirs,
      fileMap,
      input.targetCollectionId,
      options
    );

    const importReq = importRequester();
    const objects: OkfImportedObject[] = [];
    for (const file of conceptFiles) {
      objects.push(
        await importConcept(
          callerReq,
          importReq,
          file,
          dirToCollection,
          input.targetCollectionId
        )
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
