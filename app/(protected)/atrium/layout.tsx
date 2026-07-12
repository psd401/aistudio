/**
 * Atrium Meridian layout (Epic #1059 redesign, slice A)
 *
 * The dedicated shell for every `/atrium` route. It establishes the Meridian
 * design scope in one place:
 *  - `.atrium-meridian` on the root → the scoped token layer in
 *    `styles/atrium-meridian.css` (nothing leaks to /dashboard, /nexus, …).
 *  - `fontMeridian.variable` → Schibsted Grotesk, applied only inside this scope
 *    so the global `font-sans` is untouched.
 *  - `<AtriumShell>` → the 64px icon rail + workspace nav column + main region.
 *
 * Kept as a Server Component (no client hooks here); the interactive shell lives
 * in `AtriumShell`. Force-dynamic so it composes with the force-dynamic library
 * page and never gets statically cached.
 */

import "@/styles/atrium-meridian.css";
import { fontMeridian } from "@/lib/atrium/meridian-fonts";
import { AtriumShell } from "@/components/atrium/shell/AtriumShell";

export const dynamic = "force-dynamic";

export default function AtriumLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={`atrium-meridian ${fontMeridian.variable}`}>
      <AtriumShell>{children}</AtriumShell>
    </div>
  );
}
