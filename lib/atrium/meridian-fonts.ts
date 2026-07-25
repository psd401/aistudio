/**
 * Atrium Meridian typography (Epic #1059 redesign)
 *
 * Schibsted Grotesk is the Meridian UI + document typeface (handoff spec). It is
 * loaded from the checked-in Google Fonts asset via `next/font/local` and
 * exposed as the `--font-meridian` CSS variable. Keeping the asset local makes
 * production builds deterministic and removes their dependency on Google Fonts
 * DNS/network availability. The Atrium `layout.tsx` applies
 * `fontMeridian.variable` to the shell root, and
 * `styles/atrium-meridian.css` maps `.atrium-meridian` to it, so the face is
 * scoped to Atrium and never overrides the global `font-sans`.
 */
import localFont from "next/font/local";

export const fontMeridian = localFont({
  src: "../../public/fonts/SchibstedGrotesk-Variable.woff2",
  weight: "400 700",
  variable: "--font-meridian",
  display: "swap",
  fallback: ["Arial", "sans-serif"],
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
