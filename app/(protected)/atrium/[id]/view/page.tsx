/**
 * Atrium artifact full-screen viewer (#1052 sizing fix)
 *
 * A chrome-free, full-viewport view of ONE artifact. This is the target of the
 * authoring view's primary "Open full screen ↗" action. Unlike the /c and /p
 * readers (which require a *live publication*), this route renders the artifact's
 * CURRENT head version and therefore works for UNPUBLISHED / draft artifacts too —
 * it is gated purely on the same `canView` visibility check every content read
 * uses.
 *
 * ## Visibility gate (always 404, never 403)
 * A missing object, a non-artifact object, OR an object the requester cannot view
 * all resolve to `notFound()` (404) — the existence-masking contract used across
 * the content layer (a 403 would confirm the id exists and let it be enumerated).
 * The route is under `(protected)`, so a session is already guaranteed.
 *
 * ## Chrome-free
 * The `/atrium` layout wraps every child in the Meridian shell (icon rail + nav
 * column). This page escapes that chrome by rendering a `position: fixed` overlay
 * that covers the viewport, so only the artifact sandbox is visible — the point of
 * a "full screen" view.
 *
 * ## Security
 * The UNTRUSTED artifact code is loaded server-side and handed to the client
 * `<ArtifactSandbox>`, which renders it ONLY inside the cross-origin sandboxed
 * iframe (`sandbox="allow-scripts"`, no `allow-same-origin`) served from a separate
 * origin (§19.2 / §28.1). The code never touches app-origin HTML.
 *
 * ## Artifact data bridge (#1725)
 * This route ENABLES the sandbox data bridge (`dataBridgeEnabled` + `contentId`
 * + the `dataAccess` pin). It is the surface an author uses to look at their own
 * unpublished work, and before #1725 it was the only place a draft could render
 * — with the bridge absent, so every `AtriumData` call failed and a query-mode
 * dashboard could not be exercised until after it was published in front of an
 * audience.
 *
 * Enabling it grants nothing new: `queryArtifactData` / `submitArtifactRecord` /
 * `listArtifactRecords` each independently resolve the session, run
 * `contentService.get` (the same 404-masking `canView` this page just ran),
 * re-check `kind === "artifact"`, and re-check the `data_access` mode of the
 * VERSION being rendered (#1789). None of them consults publication state, so
 * publication was never the authorization — it only decided *where* the parent
 * was willing to forward a request. Thumbnails, embeds, and the anonymous
 * `/p/<slug>` reader stay fail-closed.
 *
 * ## Which version (#1789)
 * An editor gets their working head, or `?version=` when it belongs to this
 * object. A plain reader gets the LIVE published version when the object is
 * Live — `/c/` links here for every viewer, and before #1789 that handed a
 * reader the author's half-finished draft, exploratory SQL included. See
 * `resolveViewVersion`.
 *
 * `dynamic = "force-dynamic"`: visibility depends on the caller's session, so the
 * page must never be statically cached or shared across principals.
 */

import { notFound } from "next/navigation";
import { getUserRequester } from "@/actions/db/atrium/requester";
import { canEdit } from "@/lib/content/helpers";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { versionService } from "@/lib/content/version-service";
import { livePublishedVersionId } from "@/lib/content/live-publication";
import { resolveVersionDataAccess } from "@/lib/content/types";
import type { ContentVersionDTO } from "@/lib/content/types";
import { getArtifactSandboxRenderUrl } from "@/lib/content/artifact-sandbox-config";
import { ArtifactSandbox } from "@/components/atrium/ArtifactSandbox";
import { ArtifactViewportBack } from "@/components/atrium/ArtifactViewportBack";
import "@/styles/atrium-content.css";

export const dynamic = "force-dynamic";

/**
 * WHICH version this viewer gets (#1789).
 *
 * Before this issue the route always rendered the head, and `/c/` linked here
 * for every viewer — so a staff member reading a Live dashboard hit "Full
 * screen" and got the author's half-finished draft, exploratory SQL included.
 *
 *  - A NON-EDITOR gets the LIVE published version whenever the object is Live.
 *    `?version=` is ignored for them: the Live page is the only thing they were
 *    offered a full-screen link to. When the object is NOT Live there is no
 *    published version to show, so they get the head — which is the whole point
 *    of the `/c/` dead-link backstop (PR #1699) that redirects a viewable-but-
 *    unpublished object here. 404ing them instead would kill that backstop for
 *    exactly the audience it exists for.
 *  - An EDITOR gets `?version=` when it belongs to THIS object (so the link
 *    from `/c/` shows them what readers see), and the head otherwise. A
 *    `version` from another object is ignored rather than honoured — the lookup
 *    is scoped by object id, so it simply finds nothing.
 */
async function resolveViewVersion(
  objectId: string,
  mayEdit: boolean,
  requestedVersionId: string | undefined
): Promise<ContentVersionDTO | null> {
  if (!mayEdit) {
    const publishedVersionId = await livePublishedVersionId(objectId);
    if (publishedVersionId) {
      return versionService.getById(objectId, publishedVersionId);
    }
    return versionService.current(objectId);
  }
  if (requestedVersionId) {
    const requested = await versionService.getById(objectId, requestedVersionId);
    if (requested) return requested;
  }
  return versionService.current(objectId);
}

/** First value of a repeated query param; Next hands arrays for `?a=1&a=2`. */
function singleParam(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim() ? first.trim() : undefined;
}

export default async function AtriumArtifactViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const { version: requestedVersion } = await searchParams;

  // getUserRequester throws when unauthenticated; the (protected) layout already
  // guarantees a session, so this resolves to a `user` requester.
  const req = await getUserRequester();
  const obj = await contentService.loadByIdOrSlug(id);
  if (!obj) notFound();

  // The full-screen viewport is artifact-only (documents have their own reader).
  // A non-artifact object is masked as absent rather than mis-rendered.
  if (obj.kind !== "artifact") notFound();

  // Existence-masking visibility gate: a non-viewable artifact 404s (never 403),
  // consistent with /c, /p, and the authoring page.
  const viewable = await visibilityService.canView(req, {
    id: obj.id,
    ownerUserId: obj.ownerUserId,
    collectionId: obj.collectionId,
    visibilityLevel: obj.visibilityLevel,
  });
  if (!viewable) notFound();

  // #1789: an editor sees their working head (or the version they asked for);
  // a plain reader sees the LIVE published version when there is one. See
  // `resolveViewVersion`. An unpublished artifact still renders its head, so a
  // draft is still previewable here — the reason this route exists alongside
  // the publication-gated readers.
  //
  // #1793 reuses the SAME predicate for the way back rendered below: whoever
  // gets their working head here is exactly whoever the editor will let in.
  const userCanEdit = canEdit(req, obj.ownerUserId);
  const version = await resolveViewVersion(
    obj.id,
    userCanEdit,
    singleParam(requestedVersion)
  );
  // Missing/unreadable body degrades to an empty preview (never the raw S3 error).
  const code = version ? await versionService.loadArtifactCodeSafe(version) : "";

  // A fixed, full-viewport overlay covers the inherited Meridian shell chrome so
  // only the sandbox is visible. No transformed ancestor sits in this subtree, so
  // `position: fixed` is viewport-relative (verified against the shell CSS).
  return (
    <div
      data-testid="artifact-viewport"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "#fff",
      }}
    >
      {/* #1793: this route is a dead end — the overlay hides every piece of app
          chrome, so whoever followed "Open full screen" had no title, no close
          button and no link back. Shown to EVERYONE (the library grid and the
          reader both link here in the same tab, so a plain viewer is stranded
          just the same); only the destination depends on who is looking. The
          id is the SERVER-resolved one, never the route param. */}
      <ArtifactViewportBack
        editHref={userCanEdit ? `/atrium/${obj.id}/edit` : undefined}
      />
      <ArtifactSandbox
        // #1712: the loaded-mode pin lives in a ref for the mount's lifetime, so
        // a mount must belong to exactly one artifact. Keying on the id makes
        // that true by construction rather than relying on the router remounting
        // the leaf page on a param change (same as the /c reader).
        // #1789: the version is in the key too — a soft navigation to another
        // `?version=` must remount, or its code would run under the old pin.
        key={`${obj.id}:${version?.id ?? ""}`}
        code={code}
        src={getArtifactSandboxRenderUrl()}
        title={obj.title}
        className="atrium-artifact-viewport"
        dataBridgeEnabled={true}
        contentId={obj.id}
        // #1712 + #1789: the mode the version being RENDERED was authored for.
        // For an editor's head that equals the object's mode by construction
        // (`contentService.update` keeps them in step); for a reader seeing the
        // live published version it is the mode that version was published
        // with, so an author's draft-time flip cannot re-capability it. A
        // version predating migration 184 carries no stamp and falls back to
        // the object's mode — the pre-#1789 behaviour. `normalizeDataAccess`
        // inside the resolver still fails an out-of-enum value closed.
        dataAccess={resolveVersionDataAccess(version, obj.dataAccess)}
        // #1787: the version THIS render loaded. This page never remounts when
        // the head advances, so omitting it would audit a still-open old version
        // under whatever head exists when each later query runs.
        versionId={version?.id}
      />
    </div>
  );
}
