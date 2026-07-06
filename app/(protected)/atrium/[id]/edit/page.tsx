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
 *
 * Header controls (Epic #1059 completion): ContentSettings (rename / tags /
 * section / archive-restore, editors only) and — for documents — the VersionMenu
 * (history + restore); artifacts restore inline in the canvas toolbar.
 */

import { forbidden, notFound } from "next/navigation";
import { getUserRequester } from "@/actions/db/atrium/requester";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { canEdit } from "@/lib/content/helpers";
import { DocumentEditor } from "@/components/atrium/DocumentEditor";
import { ArtifactCanvas } from "@/components/atrium/ArtifactCanvas";
import { VisibilityChip } from "@/components/atrium/VisibilityChip";
import { ContentSettings } from "@/components/atrium/ContentSettings";
import { VersionMenu } from "@/components/atrium/VersionMenu";
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

  // Header controls (Epic #1059 completion): the ContentSettings dialog (rename /
  // tags / section / archive-restore) for editors, and — for documents — the
  // VersionMenu (history + restore; the artifact canvas has its own inline
  // version select + restore). Server actions re-check permission regardless;
  // the settings dialog is simply not rendered for read-only viewers.
  const headerControls = (
    <div className="flex shrink-0 items-center gap-2">
      {/* Nexus workspace (spec §17): open this object BESIDE the chat so the
          adjacent conversation becomes the re-prompt/tweak path. */}
      <a
        href={`/nexus?workspace=${obj.id}`}
        className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
      >
        Open beside chat
      </a>
      {obj.kind === "document" && (
        <VersionMenu key={`versions-${obj.id}`} idOrSlug={obj.id} canEdit={userCanEdit} />
      )}
      {userCanEdit && (
        <ContentSettings
          key={`settings-${obj.id}`}
          objectId={obj.id}
          title={obj.title}
          tags={obj.tags}
          collectionId={obj.collectionId}
          status={obj.status}
        />
      )}
      <VisibilityChip key={obj.id} idOrSlug={obj.id} />
    </div>
  );

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
          {headerControls}
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
        {headerControls}
      </header>
      <DocumentEditor key={obj.id} idOrSlug={obj.id} userId={req.userId} />
    </main>
  );
}
