/**
 * Atrium SECTION landing page — `/atrium/s/[slug]`.
 *
 * Before this route existed, clicking a section pushed `?collection=<uuid>` onto
 * the library and re-rendered the same flat card grid under the same generic
 * "Content library" heading. There was nowhere to say what a section was for,
 * no way to see that it had subsections, and no way to reach them except by
 * hunting the sidebar tree. For an intranet whose whole shape is "Intranet →
 * Business Office → the actual pages", that made the structure invisible.
 *
 * This page gives a section a hero (name, description, breadcrumb), its child
 * sections as cards, an optional pinned "start here" page, and then its
 * contents.
 *
 * EXISTENCE MASK: `collectionDetailAction` resolves the section out of the
 * requester-filtered tree and returns `null` for BOTH an unknown slug and a
 * section the caller may not enter. This page calls `notFound()` for either —
 * never a 403, which would confirm the section exists and let someone walk the
 * district's structure by guessing slugs.
 *
 * `dynamic = "force-dynamic"`: the section's contents and even its existence
 * depend on the caller's visibility, so it must never be cached or shared.
 */

import { notFound, redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server-session";
import { hasCapabilityAccess } from "@/utils/roles";
import { collectionDetailAction } from "@/actions/db/atrium/collection-detail";
import { SectionLanding } from "@/components/atrium/SectionLanding";
import { getArtifactSandboxRenderUrl } from "@/lib/content/artifact-sandbox-config";

export const dynamic = "force-dynamic";

interface SectionPageProps {
  params: Promise<{ slug: string }>;
}

export default async function AtriumSectionPage({
  params,
}: SectionPageProps): Promise<React.JSX.Element> {
  const { slug } = await params;

  const session = await getServerSession();
  if (!session) {
    redirect("/sign-in");
  }
  // Same capability gate as the library itself — this is the authoring/browsing
  // surface. Per-object visibility is still enforced inside every action.
  const hasAccess = await hasCapabilityAccess("atrium-content", session.sub);
  if (!hasAccess) {
    redirect("/dashboard");
  }

  const res = await collectionDetailAction(slug);
  // A failed read and an invisible section both 404 — see the mask note above.
  if (!res.isSuccess || !res.data) {
    notFound();
  }

  return (
    <SectionLanding
      node={res.data.node}
      breadcrumb={res.data.breadcrumb}
      subtreeIds={res.data.subtreeIds}
      sandboxSrc={getArtifactSandboxRenderUrl()}
    />
  );
}
