/**
 * Atrium Meridian typography (Epic #1059 redesign)
 *
 * Schibsted Grotesk is the Meridian UI + document typeface (handoff spec). It is
 * loaded here via `next/font/google` (self-hosted at build time — NO external
 * `<link>` tags, matching `lib/fonts.ts`) and exposed as the `--font-meridian`
 * CSS variable. The Atrium `layout.tsx` applies `fontMeridian.variable` to the
 * shell root, and `styles/atrium-meridian.css` maps `.atrium-meridian` to it, so
 * the face is scoped to Atrium and never overrides the global `font-sans`.
 */
import { Schibsted_Grotesk } from "next/font/google";

export const fontMeridian = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-meridian",
  display: "swap",
});

/**
 * The className to put on any Radix portal content (Dialog / Select / Popover /
 * DropdownMenu content) rendered from an Atrium surface.
 *
 * WHY: Radix portals its content to `document.body` — OUTSIDE the Atrium
 * `layout.tsx` `.atrium-meridian` scope and its `fontMeridian.variable`. Without
 * this, every Atrium modal/menu renders with the GLOBAL cream tokens, the default
 * shadcn look, and the system font. Applying this class to the portaled element
 * carries the Meridian token layer (`.mer-portal` maps the shadcn `--color-*`
 * theme tokens + `--mer-*` tokens) AND the Schibsted Grotesk face onto the portal,
 * so it renders Meridian just like the in-scope surfaces. Paired with the
 * `.mer-portal[data-slot="dialog-content"]` surface rules in
 * `styles/atrium-meridian.css` (white sheet, 16px radius, elevated shadow,
 * centered max-width — never full-width).
 */
export const meridianPortalClassName = `mer-portal ${fontMeridian.variable}`;
