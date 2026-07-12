/**
 * Atrium content library (Issue #1054, Epic #1059, Phase 4, spec §21)
 *
 * The permission-filtered library landing for the Atrium content workspace: a
 * visibility-filtered section tree (`CollectionTree`) beside the list of content
 * the user may view, with search / kind / collection / tag filters and "new doc /
 * new artifact" creation.
 *
 * Gating: the AUTHORING surface is gated on the `atrium-content` capability here
 * (a non-holder is redirected to the dashboard). The data itself is additionally
 * bounded by `canView` inside every action the client calls, so the capability
 * gate is the feature gate, not the data gate. The Meridian shell
 * (`atrium/layout.tsx`) provides the icon rail + workspace nav column; this page
 * renders only the library main area.
 *
 * `dynamic = "force-dynamic"`: the library content depends on the caller's
 * session/visibility, so it must never be statically cached or shared.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server-session";
import { hasCapabilityAccess } from "@/utils/roles";
import { LibraryView } from "@/components/atrium/LibraryView";

export const dynamic = "force-dynamic";

export default async function AtriumLibraryPage(): Promise<React.JSX.Element> {
  const session = await getServerSession();
  if (!session) {
    redirect("/sign-in");
  }
  // Authoring/library is the gated feature surface (mirrors the create/publish
  // actions, which re-check server-side). Read access to a shared object lives at
  // /c/[slug] and is bounded by visibility, not this capability.
  const hasAccess = await hasCapabilityAccess("atrium-content", session.sub);
  if (!hasAccess) {
    redirect("/dashboard");
  }

  return <LibraryView />;
}
