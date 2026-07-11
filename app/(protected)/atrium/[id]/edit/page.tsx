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
import { collectionService } from "@/lib/content/collection-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { canEdit } from "@/lib/content/helpers";
import { DocumentEditor } from "@/components/atrium/DocumentEditor";
import { ArtifactAuthoringView } from "@/components/atrium/ArtifactAuthoringView";
import { VisibilityChip } from "@/components/atrium/VisibilityChip";
import { ContentSettings } from "@/components/atrium/ContentSettings";
import { VersionMenu } from "@/components/atrium/VersionMenu";

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

  // The collection name for the Meridian breadcrumb + eyebrow (a section label,
  // not sensitive; the object is already cleared for view above).
  const collectionName = await collectionService.nameById(obj.collectionId);

  if (obj.kind === "artifact") {
    // The Meridian artifact chrome (topbar + canvas + manage-rights-only rail) is
    // its own server component so this route handler stays lean.
    return (
      <ArtifactAuthoringView
        obj={obj}
        req={req}
        userCanEdit={userCanEdit}
        collectionName={collectionName}
      />
    );
  }

  // Documents render the full-bleed Meridian editor: the topbar (breadcrumb,
  // title, live AGENT-WRITING pill, presence, controls) + the sheet on the desk.
  // The topbar OWNS the chrome, so the page adds no header/main wrapper here —
  // the history (VersionMenu) + settings/visibility controls are injected into
  // the topbar via props. The narrow Nexus workspace panel is a separate mount
  // (WorkspacePanel) that passes layout="panel".
  const documentTopbarControls = (
    <div className="flex shrink-0 items-center gap-2">
      <a
        href={`/nexus?workspace=${obj.id}`}
        className="mer-ectl"
        // Nexus workspace (spec §17): open this object BESIDE the chat so the
        // adjacent conversation becomes the re-prompt/tweak path.
      >
        Open beside chat
      </a>
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

  return (
    <DocumentEditor
      key={obj.id}
      idOrSlug={obj.id}
      userId={req.userId}
      title={obj.title}
      eyebrow={collectionName ? `${collectionName} · Document` : "Document"}
      breadcrumb={
        collectionName && obj.collectionId
          ? [{ label: collectionName, href: `/atrium?collection=${obj.collectionId}` }]
          : []
      }
      askAgentHref={`/nexus?workspace=${obj.id}`}
      coverGradient={obj.coverGradient}
      icon={obj.icon}
      historyControl={
        <VersionMenu key={`versions-${obj.id}`} idOrSlug={obj.id} canEdit={userCanEdit} />
      }
      settingsControl={documentTopbarControls}
    />
  );
}
