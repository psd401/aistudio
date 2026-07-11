/**
 * Atrium document cover gradients (Epic #1059 Meridian slice F)
 *
 * The "2b — Rich document" cover band is a CSS GRADIENT chosen from a FIXED preset
 * set (README §"2b": "gradient covers are CSS", "No raster assets"). The stored
 * `content_objects.cover_gradient` value is one of these PRESET KEYS — never raw
 * CSS — so a cover can only ever select one of these classes, keeping author input
 * off the style-injection surface. This module is the ONE definition of:
 *  - the valid keys (write validation via `isCoverGradientKey`), and
 *  - the CSS class a key maps to (`coverGradientClass`), whose gradient is defined
 *    in styles/atrium-meridian.css (`.mer-cover--<key>`).
 * shared by the editor (Change-cover picker + render), both readers, and the
 * settings write path so they can never drift.
 */

/** The preset cover-gradient keys, in the order the Change-cover picker offers. */
export const COVER_GRADIENT_KEYS = [
  "default",
  "sunrise",
  "forest",
  "violet",
  "dusk",
] as const;

export type CoverGradientKey = (typeof COVER_GRADIENT_KEYS)[number];

/** Human labels for the Change-cover picker swatches. */
export const COVER_GRADIENT_LABELS: Record<CoverGradientKey, string> = {
  default: "Teal → Violet",
  sunrise: "Sunrise",
  forest: "Forest",
  violet: "Violet",
  dusk: "Dusk",
};

/** Whether an arbitrary value is a valid preset key (the write-validation gate). */
export function isCoverGradientKey(value: unknown): value is CoverGradientKey {
  return (
    typeof value === "string" &&
    (COVER_GRADIENT_KEYS as readonly string[]).includes(value)
  );
}

/**
 * The CSS class for a cover-gradient key (or null when the value is absent/invalid,
 * so a bad stored value renders NO cover band rather than an unstyled div). Only a
 * class name is ever produced — never inline author CSS.
 */
export function coverGradientClass(value: string | null | undefined): string | null {
  return isCoverGradientKey(value) ? `mer-cover--${value}` : null;
}
