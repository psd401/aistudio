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
