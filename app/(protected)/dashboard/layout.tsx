/**
 * Dashboard layout — Meridian.
 *
 * Same three lines every Meridian surface needs (cf. the Atrium and Nexus
 * layouts):
 *  - `styles/meridian-core.css` supplies the shared structural `.mer-*`
 *    classes. They belong to no single surface and reference only
 *    `var(--mer-*)`.
 *  - `styles/meridian-tokens.css` supplies the one palette every Meridian
 *    surface shares.
 *  - `fontMeridian.variable` → Schibsted Grotesk, scoped here so the global
 *    `font-sans` is untouched.
 *
 * The scope wraps the shared shell as well as the page, so the sidebar picks up
 * Meridian too. `/tutorials` uses the same `DashboardLayout` component but is
 * NOT inside this scope, so it keeps the cream palette until it is converted.
 */

import "@/styles/meridian.css";
import { fontMeridian } from "@/lib/meridian/fonts";
import { DashboardLayout as DashboardLayoutComponent } from "@/components/layouts/dashboard-layout";

export default function DashboardLayout({
  children
}: {
  children: React.ReactNode
}) {
  return (
    <div className={`meridian ${fontMeridian.variable}`}>
      <DashboardLayoutComponent>{children}</DashboardLayoutComponent>
    </div>
  );
}
