/**
 * Atrium document authoring page (#1051)
 *
 * The editing surface that mounts the live collaborative editor for one document.
 * Server component: resolves the session user, gates by the object's visibility,
 * then renders the client <DocumentEditor> bound to that user's identity (so their
 * edits stamp green on the rail). The reference E2E drives "human edits two lines"
 * here.
 *
 * `forbidden()` (403) for a viewer who cannot see the object; `notFound()` for a
 * missing object. Edit permission is enforced again server-side by the collab
 * server (read-only token) and the snapshot/publish actions — this page only gates
 * visibility.
 */

import { forbidden, notFound } from "next/navigation";
import { getUserRequester } from "@/actions/db/atrium/requester";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { DocumentEditor } from "@/components/atrium/DocumentEditor";

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
  if (!viewable) forbidden();

  if (req.kind !== "user" || req.userId == null) {
    // Phase 1 authoring is a logged-in-human surface.
    forbidden();
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">{obj.title}</h1>
        <p className="text-xs text-gray-500">
          Live document · agent edits show purple, your edits show green
        </p>
      </header>
      <DocumentEditor idOrSlug={obj.id} userId={req.userId} />
    </main>
  );
}
