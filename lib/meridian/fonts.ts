/**
 * Meridian typography + the portal scope class.
 *
 * Schibsted Grotesk is the Meridian UI typeface. Loaded from the checked-in
 * Google Fonts asset via `next/font/local` and exposed as `--font-meridian`, so
 * production builds are deterministic and do not depend on Google Fonts DNS.
 * Applied via the `.meridian` scope class rather than globally, so surfaces
 * that have not adopted Meridian yet keep the global `font-sans`.
 *
 * Formerly `lib/atrium/meridian-fonts.ts`. The path implied Atrium ownership of
 * something every Meridian surface uses.
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
 * Put this on any Radix portal content (Dialog / Select / Popover /
 * DropdownMenu / Sheet) rendered from a Meridian surface.
 *
 * WHY: Radix portals content to `document.body` — OUTSIDE the `.meridian` scope
 * its trigger lives in. Without this class the portal renders with the GLOBAL
 * cream tokens, the default shadcn look and the system font, however Meridian
 * the page behind it is. This carries the token layer (`.meridian-portal` in
 * `styles/meridian-tokens.css`) and the Schibsted Grotesk face onto the portal.
 *
 * Paired with the `.meridian-portal[data-slot="dialog-content"]` surface rules
 * in `styles/meridian-core.css` (white sheet, 16px radius, capped width, styled
 * title/description, and the `data-mer-size` wide/xwide scale).
 *
 * SHARED COMPONENTS: pass this in from the call site rather than hardcoding it
 * inside a shared picker or dialog. Components like `RepositoryPicker` and
 * `assistant-ui/thread` render both inside and outside Meridian scopes, so the
 * scope decision belongs to the caller that knows which surface it is on.
 *
 * Replaces the former Atrium-teal and app-palette portal constants, which
 * existed only because there were two token sets. One palette, one constant.
 */
export const meridianPortalClassName = `meridian-portal ${fontMeridian.variable}`;
