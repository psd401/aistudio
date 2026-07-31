/**
 * Meridian portal class for NON-Atrium surfaces (app palette).
 *
 * WHY THIS EXISTS
 * Radix portals Dialog / Select / Popover / DropdownMenu content to
 * `document.body` — outside the `.app-meridian` scope its trigger lives in. A
 * portaled surface therefore renders with the GLOBAL cream tokens, the default
 * shadcn look and the system font, however Meridian-styled the page behind it
 * is. Confirmed in the browser on the Nexus repositories modal: the dialog
 * reported `insideScope: false`, `font: fontSans` and the Sea Foam background.
 *
 * Putting this class on the portaled element carries the app-palette token
 * layer (`.app-mer-portal` in `styles/app-meridian.css`) and the Schibsted
 * Grotesk face onto the portal, so it renders Meridian like the surface behind
 * it. Paired with the `.app-mer-portal[data-slot="dialog-content"]` surface
 * rules (white sheet, 16px radius, capped width, styled title/description).
 *
 * This is the app-palette twin of `meridianPortalClassName` in
 * `lib/atrium/meridian-fonts.ts`, which does the same job for Atrium's teal.
 * Use THIS one on any surface scoped with `.app-meridian`; use that one inside
 * `/atrium`.
 *
 * SHARED COMPONENTS: pass this in from the call site rather than hardcoding it
 * inside a shared picker/dialog. Components like `RepositoryPicker` and
 * `assistant-ui/thread` render both inside and outside Meridian scopes, so the
 * scope decision belongs to the caller that knows which surface it is on.
 *
 * NOTE: `fontMeridian` still lives under `lib/atrium/` for historical reasons.
 * It is now shared by every Meridian surface and should move to `lib/meridian/`
 * once the rollout settles — deferred to avoid touching Atrium's import graph
 * mid-migration.
 */
import { fontMeridian } from "@/lib/atrium/meridian-fonts";

export const appMeridianPortalClassName = `app-mer-portal ${fontMeridian.variable}`;
