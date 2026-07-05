/**
 * OKF concept / index / log serialization — Phase 8 (Issue #1103, spec §36.1)
 *
 * Pure builders that turn Atrium DTO fields into the three OKF file shapes:
 *  - a **concept** file per content object (frontmatter + body),
 *  - one **`index.md`** per collection (navigation — links to child concepts +
 *    child collections),
 *  - one **`log.md`** per object (its immutable version history = the change log).
 *
 * No database or IO here — the export service (`./export`) supplies the loaded
 * rows and assembles the bundle. Kept pure so the mapping table (spec §36.1) is
 * unit-testable without a DB.
 */

import type { BodyFormat, ContentKind } from "../types";
import { okfTypeForKind, type OkfFrontmatter } from "./profile";
import { serializeConceptFile } from "./frontmatter";

/** The loaded fields a single object contributes to its concept file. */
export interface ConceptSource {
  kind: ContentKind;
  title: string;
  /** head-version summary → `description`. */
  summary: string | null;
  tags: string[];
  /** `content_objects.updated_at` (ISO) → `timestamp`. */
  updatedAt: string | null;
  /** a prior publication URL (`content_publications.external_ref`) → `resource`. */
  resource: string | null;
  /** head-version body format (drives the artifact fence language). */
  bodyFormat: BodyFormat;
  /** head-version body: markdown for documents, code for artifacts. */
  body: string;
}

/** Choose a fenced-code language token for an artifact body. */
function fenceLanguage(bodyFormat: BodyFormat): string {
  return bodyFormat === "jsx" ? "jsx" : "html";
}

/**
 * Wrap artifact code in a fenced block whose fence is longer than any backtick run
 * inside the code (so code containing ``` cannot break out of the block). Documents
 * emit their markdown verbatim.
 */
function conceptBody(source: ConceptSource): string {
  if (source.kind !== "artifact") return source.body;
  const longestRun = (source.body.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${fenceLanguage(source.bodyFormat)}\n${source.body}\n${fence}`;
}

/** Build the OKF frontmatter for a concept, omitting every absent optional field. */
export function conceptFrontmatter(source: ConceptSource): OkfFrontmatter {
  return {
    type: okfTypeForKind(source.kind),
    title: source.title,
    description: source.summary ?? undefined,
    resource: source.resource ?? undefined,
    tags: source.tags.length > 0 ? source.tags : undefined,
    timestamp: source.updatedAt ?? undefined,
  };
}

/** Serialize one object to its OKF concept `.md` file (frontmatter + body). */
export function buildConceptFile(source: ConceptSource): string {
  return serializeConceptFile(conceptFrontmatter(source), conceptBody(source));
}

/** A link in an `index.md` navigation file. */
export interface IndexLink {
  title: string;
  /** href relative to the index file's own directory. */
  href: string;
}

/**
 * Build a collection's `index.md` navigation file: an OKF-reserved file that links
 * its child concepts and child collections. `type: index` marks it as navigation
 * (not a concept) so the importer skips it as content and uses it for the tree.
 */
export function buildIndexFile(
  collectionName: string,
  concepts: IndexLink[],
  childCollections: IndexLink[]
): string {
  const fm: OkfFrontmatter = { type: "index", title: collectionName };
  const parts: string[] = [`# ${collectionName}`];

  if (concepts.length > 0) {
    parts.push(
      ["## Concepts", ...concepts.map((c) => `- [${c.title}](${c.href})`)].join("\n")
    );
  }
  if (childCollections.length > 0) {
    parts.push(
      [
        "## Collections",
        ...childCollections.map((c) => `- [${c.title}](${c.href})`),
      ].join("\n")
    );
  }
  return serializeConceptFile(fm, parts.join("\n\n"));
}

/** One version's summary line for `log.md`. */
export interface LogEntry {
  versionNumber: number;
  authorActor: "human" | "agent";
  summary: string | null;
  /** ISO-8601 created timestamp. */
  createdAt: string | null;
}

/**
 * Build an object's `log.md` change history from its version list (newest-first).
 * The immutable `content_versions` list already IS the change log (spec §36.1);
 * this renders it as portable markdown.
 */
export function buildLogFile(title: string, entries: LogEntry[]): string {
  const lines = [`# Change history — ${title}`, ""];
  for (const e of entries) {
    const when = e.createdAt ?? "unknown";
    const summary = e.summary ? ` — ${e.summary.replace(/\s+/g, " ").trim()}` : "";
    lines.push(`- v${e.versionNumber} · ${e.authorActor} · ${when}${summary}`);
  }
  return `${lines.join("\n")}\n`;
}
