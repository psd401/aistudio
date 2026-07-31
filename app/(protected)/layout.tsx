"use client"

import { ReactNode } from "react";
import { UserProvider } from "@/components/auth/user-provider";
import { fontMeridian } from "@/lib/meridian/fonts";
import "@/styles/meridian.css";

/**
 * Every authenticated surface renders inside the Meridian scope.
 *
 * Scoping HERE rather than in each route's own layout is what makes the design
 * system actually one system: a new page under /(protected) is Meridian by
 * default instead of by remembering to opt in. The alternative — ten per-route
 * layouts each importing the stylesheet — is exactly how surfaces drift.
 *
 * Most of the conversion is free. `meridian-tokens.css` remaps the Tailwind-v4
 * `--color-*` theme tokens, so every shadcn primitive below this point renders
 * Meridian without touching its markup.
 *
 * TWO THINGS THIS DOES NOT REACH:
 *  1. Radix portals (Dialog/Select/Popover/DropdownMenu/Sheet) mount on
 *     document.body, OUTSIDE this element. They need `meridianPortalClassName`
 *     on the content — see `lib/meridian/fonts.ts`.
 *  2. Markup that hardcodes its own colours, radii or shadows rather than
 *     reading theme tokens. Those have to be rewritten per surface.
 *
 * Routes that scope themselves again (atrium, dashboard, nexus, settings) are
 * harmless — nesting the same class re-declares identical values. Their local
 * scope is kept because those layouts also carry surface-specific concerns.
 *
 * NOT applied to /(public) or the auth routes, which stay on the global cream
 * theme until deliberately converted.
 */
export default function ProtectedLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`meridian ${fontMeridian.variable}`}>
      <UserProvider>{children}</UserProvider>
    </div>
  );
}
