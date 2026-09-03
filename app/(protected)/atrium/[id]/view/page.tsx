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
 * re-check `kind === "artifact"`, and re-check the artifact's CURRENT
 * `data_access` mode. None of them consults publication state, so publication
 * was never the authorization — it only decided *where* the parent was willing
 * to forward a request. Thumbnails, embeds, and the anonymous `/p/<slug>` reader
 * stay fail-closed.
 *
 * `dynamic = "force-dynamic"`: visibility depends on the caller's session, so the
 * page must never be statically cached or shared across principals.
 */

import { notFound } from "next/navigation";
import { getUserRequester } from "@/actions/db/atrium/requester";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { versionService } from "@/lib/content/version-service";
import { getArtifactSandboxRenderUrl } from "@/lib/content/artifact-sandbox-config";
import { ArtifactSandbox } from "@/components/atrium/ArtifactSandbox";
import "@/styles/atrium-content.css";

export const dynamic = "force-dynamic";

export default async function AtriumArtifactViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;

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

  // The CURRENT head version — NOT a published one — so a draft/unpublished
  // artifact still renders here (the whole reason this route exists alongside the
  // publication-gated readers).
  const version = await versionService.current(obj.id);
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
      <ArtifactSandbox
        // #1712: the loaded-mode pin lives in a ref for the mount's lifetime, so
        // a mount must belong to exactly one artifact. Keying on the id makes
        // that true by construction rather than relying on the router remounting
        // the leaf page on a param change (same as the /c reader).
        key={obj.id}
        code={code}
        src={getArtifactSandboxRenderUrl()}
        title={obj.title}
        className="atrium-artifact-viewport"
        dataBridgeEnabled={true}
        contentId={obj.id}
        // #1712: the mode as read for THIS load. `rowToObjectDTO` already
        // fails an out-of-enum value closed to "none".
        dataAccess={obj.dataAccess}
      />
    </div>
  );
}
