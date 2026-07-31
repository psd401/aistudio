/**
 * Dashboard layout — first non-Atrium surface on the Meridian design language.
 *
 * Mirrors the Atrium pattern exactly (see `app/(protected)/atrium/layout.tsx`):
 *  - `styles/atrium-meridian.css` supplies the ~309 structural `.mer-*` classes.
 *    They are not scoped to Atrium and reference only `var(--mer-*)`, so they
 *    render in whatever token set is in scope.
 *  - `styles/app-meridian.css` supplies that token set — Meridian's contrast
 *    structure in the AI Studio palette.
 *  - `fontMeridian.variable` → Schibsted Grotesk, scoped here so the global
 *    `font-sans` is untouched.
 *
 * The scope wraps the shared shell as well as the page, so the sidebar picks up
 * Meridian too. `/tutorials` uses the same `DashboardLayout` component but is
 * NOT inside this scope, so it keeps the cream palette until it is converted.
 */

import "@/styles/atrium-meridian.css";
import "@/styles/app-meridian.css";
import { fontMeridian } from "@/lib/atrium/meridian-fonts";
import { DashboardLayout as DashboardLayoutComponent } from "@/components/layouts/dashboard-layout";

export default function DashboardLayout({
  children
}: {
  children: React.ReactNode
}) {
  return (
    <div className={`app-meridian ${fontMeridian.variable}`}>
      <DashboardLayoutComponent>{children}</DashboardLayoutComponent>
    </div>
  );
}
