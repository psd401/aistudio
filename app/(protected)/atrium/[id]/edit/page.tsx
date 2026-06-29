/**
 * Atrium authoring page (#1051 documents, #1052 artifacts)
 *
 * The editing surface for one content object. Server component: resolves the
 * session user, gates by the object's visibility, then renders the kind-specific
 * client editor bound to that user's identity:
 *  - `document` -> <DocumentEditor> (live collaborative Proof editor; #1051).
 *  - `artifact` -> <ArtifactCanvas> (Preview|Code canvas + cross-origin sandbox;
 *    #1052). The canvas re-fetches versions/code via canView-enforced actions.
 *
 * `notFound()` (404) for a missing object AND for a non-viewable object (existence
 * masking: 403 would leak "this ID exists but you can't see it"). Edit permission is enforced AGAIN server-side by the
 * snapshot/create-version/publish actions (and, for documents, the collab
 * server's read-only token) — this page only gates visibility and passes a
 * `canEdit` hint to the artifact canvas so the Code-tab Save button is hidden for
 * read-only viewers.
 */

import { forbidden, notFound } from "next/navigation";
import { getUserRequester } from "@/actions/db/atrium/requester";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { canEdit } from "@/lib/content/helpers";
import { DocumentEditor } from "@/components/atrium/DocumentEditor";
import { ArtifactCanvas } from "@/components/atrium/ArtifactCanvas";
import { VisibilityChip } from "@/components/atrium/VisibilityChip";
import { getArtifactSandboxRenderUrl } from "@/lib/content/artifact-sandbox-config";

export const dynamic = "force-dynamic";

export default async function AtriumEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // getUserRequester throws when unauthenticated; the (protected) layout already
  // guarantees a session, so this resolves to a `user` requester here.
  const req = await getUserRequester();
  const obj = await contentService.loadByIdOrSlug(id);
  if (!obj) notFound();

  const viewable = await visibilityService.canView(req, {
    id: obj.id,
    ownerUserId: obj.ownerUserId,
    visibilityLevel: obj.visibilityLevel,
  });
  // Existence-mask: a non-viewable object must NOT return 403 — that leaks existence
  // (403 "exists but forbidden" vs 404 "absent"). Consistent with canView masking in
  // publishService.publish, setVisibilityAction, getVisibilityAction, and /c/[slug].
  if (!viewable) notFound();

  if (req.kind !== "user" || req.userId == null) {
    // Authoring is a logged-in-human surface. Existence is already confirmed above
    // (viewable), so 403 is correct here — we're blocking the requester type, not
    // hiding the object's existence.
    forbidden();
  }

  // Whether this user may save new versions. The artifact canvas uses this only
  // to show/hide the Save control; the create-version action re-checks server-side.
  const userCanEdit = canEdit(req, obj.ownerUserId);

  if (obj.kind === "artifact") {
    return (
      <main className="mx-auto max-w-4xl px-4 py-6">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{obj.title}</h1>
            <p className="text-xs text-gray-500">
              Interactive artifact · preview runs in an isolated sandbox
            </p>
          </div>
          <VisibilityChip idOrSlug={obj.id} />
        </header>
        <ArtifactCanvas key={obj.id} idOrSlug={obj.id} canEdit={userCanEdit} sandboxSrc={getArtifactSandboxRenderUrl()} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{obj.title}</h1>
          <p className="text-xs text-gray-500">
            Live document · agent edits show purple, your edits show green
          </p>
        </div>
        <VisibilityChip idOrSlug={obj.id} />
      </header>
      <DocumentEditor key={obj.id} idOrSlug={obj.id} userId={req.userId} />
    </main>
  );
}
