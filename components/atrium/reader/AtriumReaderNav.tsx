/**
 * Atrium reader top nav — branded "{org} Intranet" chrome (Epic #1059, slice E)
 *
 * The published-page top bar for BOTH readers (screen 2c). An async server
 * component that reads the district's branding (`getBrandingConfig` — org/app name,
 * derived from Settings, NOT hardcoded, so it deploys per-district) and renders the
 * intranet brand, a Home link, and a search affordance.
 *
 * ## Authenticated vs anonymous
 * - The internal reader (`/c/[slug]`) passes `authenticated`, so the user avatar
 *   renders and the search links into the library (`/atrium`) where real search
 *   lives. The avatar initials come from the session — read ONLY here, only when
 *   authenticated.
 * - The public reader (`/p/[slug]`) passes `authenticated={false}`: NO session is
 *   ever consulted (the public surface must serve the same thing to everyone), so
 *   there is no avatar and the search is inert chrome. `getBrandingConfig` itself
 *   reads no session (it resolves logos via a direct S3 signed URL), so it is safe
 *   on the anonymous route.
 */

import Link from "next/link";
import { Search } from "lucide-react";
import { getBrandingConfig } from "@/lib/branding";
import { getServerSession } from "@/lib/auth/server-session";

/**
 * 1–2 uppercase initials from an email local-part ("hs-staff@x" -> "HS",
 * "hagelk@x" -> "HA"). A best-effort avatar label — the reader has no first/last
 * name in scope (only the session's email/sub), so the local-part is the source.
 */
function initialsFromEmail(email: string | null | undefined): string {
  const local = (email ?? "").split("@")[0] ?? "";
  const parts = local.split(/[.\-_+]/).filter(Boolean);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
  }
  if (local.length >= 2) return local.slice(0, 2).toUpperCase();
  const first = local.charAt(0).toUpperCase();
  return first || "?";
}

export async function AtriumReaderNav({
  authenticated,
}: {
  /** True on the internal reader (renders the avatar + real search link). */
  authenticated: boolean;
}): Promise<React.JSX.Element> {
  const branding = await getBrandingConfig();
  // Session (for the avatar) is read ONLY when authenticated — the public reader
  // must consult no session. getServerSession is cached per request, so on /c/ it
  // coalesces with the page's own requester resolution rather than double-reading.
  const session = authenticated ? await getServerSession() : null;

  const appInitial = (branding.appName || "A").charAt(0).toUpperCase();
  const orgName = branding.orgName?.trim() || "Intranet";
  // Home targets the content library on the authed reader; the public reader has no
  // authenticated home, so it points at the site root.
  const homeHref = authenticated ? "/atrium" : "/";

  return (
    <nav className="mer-reader-nav" aria-label="Intranet">
      <Link
        href={homeHref}
        className="mer-reader-brand"
        aria-label={`${orgName} Intranet home`}
      >
        <span className="mer-reader-brand-logo" aria-hidden="true">
          {appInitial}
        </span>
        <span className="mer-reader-brand-name">{orgName} Intranet</span>
      </Link>

      <span className="mer-reader-nav-spacer" />

      <div className="mer-reader-nav-links">
        <Link href={homeHref} className="mer-reader-nav-link">
          Home
        </Link>
      </div>

      {authenticated ? (
        <Link
          href="/atrium"
          className="mer-reader-search"
          aria-label="Search the library"
        >
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="mer-reader-search-label">Search</span>
          <span className="mer-reader-search-kbd" aria-hidden="true">
            ⌘K
          </span>
        </Link>
      ) : (
        <span className="mer-reader-search" aria-hidden="true">
          <Search className="h-3.5 w-3.5" />
          <span className="mer-reader-search-label">Search</span>
          <span className="mer-reader-search-kbd">⌘K</span>
        </span>
      )}

      {session && (
        <span
          className="mer-reader-avatar"
          title={session.email ?? undefined}
          data-testid="reader-nav-avatar"
        >
          {initialsFromEmail(session.email)}
        </span>
      )}
    </nav>
  );
}

export default AtriumReaderNav;
