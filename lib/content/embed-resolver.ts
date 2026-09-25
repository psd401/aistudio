/**
 * Atrium embedded-artifact resolver (Epic #1059 Meridian redesign, slice D)
 *
 * Resolves an `::atrium-artifact{id="…"}` embed for a reader (or the editor
 * NodeView) into either a live, code-bearing render OR a quiet "unavailable"
 * placeholder — gated on the EMBEDDED ARTIFACT's OWN visibility for the current
 * viewer, independent of the containing document's visibility.
 *
 * ## Visibility rule (never leak an artifact through a document that embeds it)
 * The masking is identical for "does not exist", "is not an artifact", and "exists
 * but the viewer may not see it": all three return `available: false` with NO
 * title, href, or code. That is the 404-style existence mask — a viewer can never
 * distinguish a private artifact from an absent one via an embed, and content is
 * never loaded (let alone rendered) for an artifact the viewer cannot see.
 *
 * ## Audience
 * - `internal` (the `/c/[slug]` reader + the editor NodeView) gates on
 *   `visibilityService.canView(requester, …)` — the SAME gate every internal read
 *   uses. Expand links target `/c/<slug>`.
 * - `public` (the anonymous `/p/[slug]` reader) gates STRICTLY on
 *   `visibility_level === 'public'` AND the artifact being LIVE, and
 *   admits the fixed anonymous principal to the containing collection. It
 *   consults NO session — matching the public reader's own contract (a public
 *   surface must serve the same thing to everyone, and an unpublish/archive must
 *   mask immediately). Expand links target `/p/<slug>`.
 *
 * The resolved `code` is the PUBLISHED version whenever the artifact is live — the
 * same version the top-level `/c/<slug>` and `/p/<slug>` routes serve — so
 * unpublished head edits never leak through an embed. An UNPUBLISHED artifact
 * renders its current head for the internal audience (and masks for the public
 * one). Either way the code is UNTRUSTED and is only ever handed to the
 * cross-origin `<ArtifactSandbox>` (§28.1), never rendered on the app origin.
 *
 * ## Artifact data bridge (#1790)
 * An `internal` resolve of a LIVE artifact additionally returns `dataBridge` —
 * the content id, the published version's `data_access` stamp, and that version's
 * id — so `ArtifactEmbedBlock` can enable the sandbox bridge. An unpublished
 * artifact's head never gets the bridge: draft code must not run against live
 * data for every reader of a document that happens to embed it. Before
 * #1790 it could not, which meant every `AtriumData.query` inside an embedded
 * dashboard failed with a generic error even in the authenticated `/c/` reader,
 * where THIS function had already run the same 404-masking `canView` the bridge's
 * server actions repeat. Enabling it grants nothing new (see the `/view` header:
 * publication was never the authorization) — it only decides where a request may
 * originate.
 *
 * The `public` audience gets `dataBridge: null`, always, because there is no
 * viewer identity to scope a query to. That is a property of this function, not
 * of its callers: `ReaderDocumentBody` is shared by `/c/` and `/p/`, so the
 * fail-closed decision has to live here where the audience is known.
 */

import { and, eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentObjects, contentPublications } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { versionService } from "./version-service";
import { visibilityService } from "./visibility-service";
import { livePublicationConditions } from "./live-publication";
import {
  collectionAccessSnapshot,
  requesterMayViewCollection,
  type CollectionAccessSnapshot,
} from "./collection-access";
import { getArtifactSandboxRenderUrl } from "./artifact-sandbox-config";
import { isArtifactId } from "./embed-directive";
import { renderDocumentToParts } from "./render/document-parts";
import { resolveVersionDataAccess } from "./types";
import type { ContentDataAccess, Requester, VisibilityLevel } from "./types";

const log = createLogger({ context: "atrium.embedResolver" });
const ANONYMOUS_REQUESTER: Requester = {
  kind: "user",
  userId: null,
  roles: [],
  groups: [],
  isAdmin: false,
};

/**
 * What an embedded artifact needs in order to run the sandbox data bridge (#1790).
 * Present ONLY for a viewable artifact resolved for the `internal` audience; the
 * public reader and every masked result carry `null`, which is what keeps those
 * surfaces fail-closed at the type boundary rather than by caller discipline.
 */
export interface ResolvedEmbedDataBridge {
  /** The trusted content id — the sandbox never accepts one from the frame. */
  contentId: string;
  /** The artifact's mode as read for THIS resolve; the sandbox pins it (#1712). */
  dataAccess: ContentDataAccess;
  /** The version actually running in the frame, for the data MCP audit (#1787). */
  versionId?: string;
}

/** A resolved embed: either a live sandbox render or an unavailable placeholder. */
export interface ResolvedEmbed {
  artifactId: string;
  /** True only when the viewer may see the artifact AND it is an artifact object. */
  available: boolean;
  /** The artifact title (only when available — masked otherwise). */
  title: string | null;
  /** The artifact's reader route for the "Expand ↗" link (only when available). */
  href: string | null;
  /** UNTRUSTED artifact code — empty unless available. Sandbox-only (§28.1). */
  code: string;
  /** The cross-origin sandbox render URL, or null when unconfigured. */
  sandboxSrc: string | null;
  /**
   * Bridge wiring for an authenticated embed (#1790), or null — for the public
   * audience and for every masked result. Null is the fail-closed value.
   */
  dataBridge: ResolvedEmbedDataBridge | null;
}

export type EmbedAudience = "internal" | "public";

export interface ResolveEmbedOptions {
  audience: EmbedAudience;
  /** Required for the `internal` audience (the session principal); ignored for `public`. */
  requester?: Requester;
  /** Request-scoped reuse for documents containing multiple embedded artifacts. */
  collectionAccess?: CollectionAccessSnapshot;
}

/** The masked/unavailable result — identical for absent, non-artifact, and hidden. */
function unavailable(artifactId: string): ResolvedEmbed {
  return {
    artifactId,
    available: false,
    title: null,
    href: null,
    code: "",
    sandboxSrc: null,
    dataBridge: null,
  };
}

interface EmbedVisibilityObject {
  id: string;
  ownerUserId: number;
  collectionId: string | null;
  visibilityLevel: VisibilityLevel;
}

async function canResolveEmbed(
  obj: EmbedVisibilityObject,
  opts: ResolveEmbedOptions,
  collectionAccess?: CollectionAccessSnapshot
): Promise<boolean> {
  if (opts.audience === "internal") {
    return (
      opts.requester != null &&
      visibilityService.canView(opts.requester, obj, collectionAccess)
    );
  }
  if (obj.visibilityLevel !== "public") return false;
  if (obj.collectionId == null) return true;
  if (collectionAccess) {
    return collectionAccess.allowedCollectionIds.has(obj.collectionId);
  }
  return requesterMayViewCollection(ANONYMOUS_REQUESTER, obj.collectionId);
}

/**
 * Resolve one embed. Returns an `unavailable` placeholder for any of: an invalid
 * id, an absent object, a non-artifact object, or an artifact the viewer may not
 * see. Only a viewable artifact loads its code (best-effort — a missing body
 * degrades to an empty live preview rather than surfacing a raw S3 error).
 */
/**
 * Load the code a viewable embed runs — the published version when live, else
 * the head — and the version/mode the bridge pins. Best-effort: a failed version
 * lookup or missing body degrades to an empty live preview with `running: null`
 * (the body-load fallback is loadArtifactCodeSafe's contract).
 */
async function loadRunningVersion(
  obj: { id: string; dataAccess: unknown },
  publishedVersionId: string | null
): Promise<{
  code: string;
  running: { versionId: string; dataAccess: ContentDataAccess } | null;
}> {
  try {
    const version = publishedVersionId
      ? await versionService.getById(obj.id, publishedVersionId)
      : await versionService.current(obj.id);
    if (!version) return { code: "", running: null };
    return {
      code: await versionService.loadArtifactCodeSafe(version),
      // #1789: the mode the RUNNING version is stamped with, not the object's
      // current one. A Content-settings mode flip does not restamp the head, and
      // the bridge actions authorize against the version's stamp — pinning the
      // object's mode here let the sandbox and the server disagree.
      running: {
        versionId: version.id,
        dataAccess: resolveVersionDataAccess(version, obj.dataAccess),
      },
    };
  } catch (error) {
    log.warn("embedded artifact version unavailable; rendering empty live preview", {
      artifactId: obj.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { code: "", running: null };
  }
}

async function resolveEmbedForReaderWithAccess(
  artifactId: string,
  opts: ResolveEmbedOptions,
  collectionAccess?: CollectionAccessSnapshot
): Promise<ResolvedEmbed> {
  // Validate the id shape before any DB lookup so a malformed/injected value never
  // becomes a query key.
  if (!isArtifactId(artifactId)) return unavailable(artifactId);

  const [obj] = await executeQuery(
    (db) =>
      db
        .select({
          id: contentObjects.id,
          kind: contentObjects.kind,
          ownerUserId: contentObjects.ownerUserId,
          collectionId: contentObjects.collectionId,
          visibilityLevel: contentObjects.visibilityLevel,
          title: contentObjects.title,
          slug: contentObjects.slug,
          dataAccess: contentObjects.dataAccess,
        })
        .from(contentObjects)
        .where(eq(contentObjects.id, artifactId))
        .limit(1),
    "atrium.embed.resolveArtifact"
  );

  // Absent, or not an artifact (documents/collections are never embeddable): mask.
  if (!obj || obj.kind !== "artifact") return unavailable(artifactId);

  // Visibility gate — on the ARTIFACT's own visibility for THIS viewer.
  const visible = await canResolveEmbed(obj, opts, collectionAccess);
  if (!visible) return unavailable(artifactId);

  // A LIVE artifact renders its PUBLISHED version for both audiences — never
  // unpublished head edits — exactly like the top-level `/c/` and `/p/` readers.
  // The public audience is additionally held to the public reader's stricter
  // contract: no live publication masks the embed, so a retraction masks it
  // immediately. An unpublished artifact still renders its head for the internal
  // audience, but WITHOUT the data bridge (#1790): unreviewed draft code never
  // runs against live data just because some document embeds it.
  const [publication] = await executeQuery(
    (db) =>
      db
        .select({ publishedVersionId: contentPublications.publishedVersionId })
        .from(contentPublications)
        .where(
          and(
            eq(contentPublications.objectId, obj.id),
            ...livePublicationConditions()
          )
        )
        .limit(1),
    "atrium.embed.livePublication"
  );
  if (!publication && opts.audience === "public") return unavailable(artifactId);
  const publishedVersionId = publication?.publishedVersionId ?? null;

  const { code, running } = await loadRunningVersion(obj, publishedVersionId);

  return {
    artifactId,
    available: true,
    title: obj.title,
    href: opts.audience === "public" ? `/p/${obj.slug}` : `/c/${obj.slug}`,
    code,
    sandboxSrc: getArtifactSandboxRenderUrl(),
    // #1790: only the authenticated audience gets the bridge. `/p/` has no
    // viewer to scope a query to, so it stays fail-closed here rather than in
    // the shared reader component. Only a PUBLISHED version gets live data (see
    // above), and no loaded version means no code to run, so no bridge either.
    dataBridge:
      opts.audience === "internal" && publishedVersionId && running
        ? {
            contentId: obj.id,
            // An out-of-enum mode fails closed to "none" (inside
            // `resolveVersionDataAccess`), under which the sandbox refuses
            // every operation.
            dataAccess: running.dataAccess,
            versionId: running.versionId,
          }
        : null,
  };
}

export async function resolveEmbedForReader(
  artifactId: string,
  opts: ResolveEmbedOptions
): Promise<ResolvedEmbed> {
  // A caller cannot smuggle an authenticated snapshot into the public audience.
  // Public document batches use the private helper below with an anonymous
  // snapshot created inside this module.
  const collectionAccess =
    opts.audience === "internal" ? opts.collectionAccess : undefined;
  return resolveEmbedForReaderWithAccess(artifactId, opts, collectionAccess);
}

/** A rendered document body segment: sanitized HTML or a resolved embed. */
export type RenderedDocumentPart =
  | { kind: "html"; html: string }
  | { kind: "embed"; embed: ResolvedEmbed };

/**
 * Render a document body to an ordered list of parts with every embed resolved for
 * the given audience/viewer — the single entry point both readers use. Embeds are
 * resolved concurrently; each is independently visibility-gated (an unavailable
 * artifact yields a masked placeholder part, never leaking title/code).
 */
export async function resolveDocumentParts(
  markdown: string,
  opts: ResolveEmbedOptions
): Promise<RenderedDocumentPart[]> {
  const parts = renderDocumentToParts(markdown);
  const hasEmbed = parts.some((part) => part.kind === "embed");
  const snapshotRequester =
    opts.audience === "public" ? ANONYMOUS_REQUESTER : opts.requester;
  const collectionAccess =
    opts.audience === "internal" && opts.collectionAccess
      ? opts.collectionAccess
      : hasEmbed && snapshotRequester
        ? await collectionAccessSnapshot(snapshotRequester)
        : undefined;
  return Promise.all(
    parts.map(async (part): Promise<RenderedDocumentPart> =>
      part.kind === "html"
        ? { kind: "html", html: part.html }
        : {
            kind: "embed",
            embed: await resolveEmbedForReaderWithAccess(
              part.artifactId,
              opts,
              collectionAccess
            ),
          }
    )
  );
}
