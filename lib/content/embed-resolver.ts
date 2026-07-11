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
 *   `visibility_level === 'public'` and consults NO session — matching the public
 *   reader's own contract (a public surface must serve the same thing to everyone).
 *   Expand links target `/p/<slug>`.
 *
 * The resolved `code` is the artifact's CURRENT head (the "live artifact" the
 * mockup describes). It is UNTRUSTED and is only ever handed to the cross-origin
 * `<ArtifactSandbox>` (§28.1), never rendered on the app origin.
 */

import { eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentObjects } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { versionService } from "./version-service";
import { visibilityService } from "./visibility-service";
import { getArtifactSandboxRenderUrl } from "./artifact-sandbox-config";
import { isArtifactId } from "./embed-directive";
import { renderDocumentToParts } from "./render/document-parts";
import type { Requester } from "./types";

const log = createLogger({ context: "atrium.embedResolver" });

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
}

export type EmbedAudience = "internal" | "public";

export interface ResolveEmbedOptions {
  audience: EmbedAudience;
  /** Required for the `internal` audience (the session principal); ignored for `public`. */
  requester?: Requester;
}

/** The masked/unavailable result — identical for absent, non-artifact, and hidden. */
function unavailable(artifactId: string): ResolvedEmbed {
  return { artifactId, available: false, title: null, href: null, code: "", sandboxSrc: null };
}

/**
 * Resolve one embed. Returns an `unavailable` placeholder for any of: an invalid
 * id, an absent object, a non-artifact object, or an artifact the viewer may not
 * see. Only a viewable artifact loads its code (best-effort — a missing body
 * degrades to an empty live preview rather than surfacing a raw S3 error).
 */
export async function resolveEmbedForReader(
  artifactId: string,
  opts: ResolveEmbedOptions
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
          visibilityLevel: contentObjects.visibilityLevel,
          title: contentObjects.title,
          slug: contentObjects.slug,
        })
        .from(contentObjects)
        .where(eq(contentObjects.id, artifactId))
        .limit(1),
    "atrium.embed.resolveArtifact"
  );

  // Absent, or not an artifact (documents/collections are never embeddable): mask.
  if (!obj || obj.kind !== "artifact") return unavailable(artifactId);

  // Visibility gate — on the ARTIFACT's own visibility for THIS viewer.
  const visible =
    opts.audience === "public"
      ? obj.visibilityLevel === "public"
      : opts.requester != null &&
        (await visibilityService.canView(opts.requester, {
          id: obj.id,
          ownerUserId: obj.ownerUserId,
          visibilityLevel: obj.visibilityLevel,
        }));
  if (!visible) return unavailable(artifactId);

  // Viewable: load the current (live) head code. Best-effort — degrade to empty.
  let code = "";
  try {
    const version = await versionService.current(obj.id);
    if (version) code = await versionService.loadArtifactCode(version);
  } catch (error) {
    log.warn("embedded artifact body unavailable; rendering empty live preview", {
      artifactId: obj.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    artifactId,
    available: true,
    title: obj.title,
    href: opts.audience === "public" ? `/p/${obj.slug}` : `/c/${obj.slug}`,
    code,
    sandboxSrc: getArtifactSandboxRenderUrl(),
  };
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
  return Promise.all(
    parts.map(async (part): Promise<RenderedDocumentPart> =>
      part.kind === "html"
        ? { kind: "html", html: part.html }
        : { kind: "embed", embed: await resolveEmbedForReader(part.artifactId, opts) }
    )
  );
}
