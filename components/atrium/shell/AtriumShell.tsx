"use client";

/**
 * Atrium Meridian shell (Epic #1059 redesign, slice A)
 *
 * The dedicated Atrium chrome that replaces the (absent) global navigation on
 * `/atrium` routes: a 64px dark-teal icon rail + a 236px white workspace nav
 * column (section tree + AGENT ACTIVITY panel) + the fluid main content region.
 *
 * The nav column is library-scoped — it shows only on the library index
 * (`/atrium`), where the section tree filters the grid. On the editor route the
 * rail stays but the column collapses so the sheet gets full width, matching the
 * per-screen designs. The column reads `?collection=` (URL-driven selection) so
 * it is isolated in `WorkspaceNav` behind its own Suspense boundary.
 */

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Library } from "lucide-react";
import { useBranding } from "@/contexts/branding-context";
import { useUser } from "@/components/auth/user-provider";
import { WorkspaceNav } from "./WorkspaceNav";

/** Two-letter initials for the rail avatar, from name or email. */
function initialsOf(
  firstName?: string | null,
  lastName?: string | null,
  email?: string | null
): string {
  const f = (firstName ?? "").trim();
  const l = (lastName ?? "").trim();
  const named = `${f.charAt(0)}${l.charAt(0)}`.toUpperCase();
  if (named) return named;
  const e = (email ?? "").trim();
  return e ? e.charAt(0).toUpperCase() : "?";
}

export function AtriumShell({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();
  const branding = useBranding();
  const { user } = useUser();

  // The nav column belongs to the library index only.
  const isLibrary = pathname === "/atrium";
  const inAtrium = pathname.startsWith("/atrium");

  const appInitial = (branding.appName ?? "A").charAt(0).toUpperCase();
  const avatarInitials = initialsOf(
    user?.firstName,
    user?.lastName,
    user?.email
  );

  return (
    <div className="mer-shell">
      <nav className="mer-rail" aria-label="Atrium">
        <Link
          href="/atrium"
          className="mer-rail-logo"
          aria-label={`${branding.appName} home`}
        >
          {appInitial}
        </Link>
        <Link
          href="/atrium"
          className="mer-rail-tile"
          data-active={inAtrium ? "true" : "false"}
          aria-label="Library"
          aria-current={inAtrium ? "page" : undefined}
        >
          <Library className="h-5 w-5" aria-hidden="true" />
        </Link>
        <Link
          href="/dashboard"
          className="mer-rail-tile"
          aria-label="Back to dashboard"
        >
          <Home className="h-5 w-5" aria-hidden="true" />
        </Link>
        <span className="mer-rail-spacer" />
        <span
          className="mer-rail-avatar"
          aria-hidden="true"
          title={user?.email ?? undefined}
        >
          {avatarInitials}
        </span>
      </nav>

      {isLibrary && (
        <Suspense fallback={<aside className="mer-navcol" aria-label="Workspace" />}>
          <WorkspaceNav />
        </Suspense>
      )}

      <div className="mer-main">{children}</div>
    </div>
  );
}
