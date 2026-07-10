/**
 * Atrium Google publish adapter (v1 stub, behind the public-publish gate)
 *
 * Issue #1057 (Epic #1059, Atrium Phase 7, spec §15.2 / §26.4). Google (Classroom
 * / Sites / Drive) is a family-facing destination and is an EXPLICIT non-goal for
 * v1 beyond this stub (§2): the publish PATH exists and is governed, but the
 * external push is finished in a later increment.
 *
 * ## Behind the public-publish gate
 * Google is a PUBLIC destination (`isPublicDestination` → true), so the publish
 * service routes an unauthorized caller — including EVERY autonomous agent —
 * through the §26.4 approval gate FIRST. An authorized caller then reaches the
 * `implemented === false` guard below (checked before the publish transaction),
 * which fails loudly rather than committing a `content_publications` row that
 * claims "live" while nothing was actually pushed to Google (a silent-failure
 * pattern the content layer forbids). This is exactly the "stub behind the gate"
 * the acceptance criteria call for.
 *
 * ## Finishing later (the intended implementation)
 * When implemented, this adapter will push the published version into Google over
 * `lib/mcp/connector-service.ts` + the existing per-user OAuth connectors (the
 * Canva pattern, Epic #774): resolve the caller's stored Google OAuth access
 * token, create the target resource (a Classroom announcement / a Site page / a
 * Drive doc linking the object's public reader URL), and return the Google
 * resource id as `external_ref` (with `unpublish` removing that resource). Flip
 * `implemented` to `true` and replace the throwing body at that point; the
 * registry wiring + the §26.4 gate already hold.
 *
 * See docs/features/atrium-design-spec.md §15.2 / §26.4 and
 * lib/mcp/connector-service.ts.
 */

import { ValidationError } from "../errors";
import type { PublishAdapter } from "./types";

export const googleAdapter: PublishAdapter = {
  destination: "google",
  // Not yet implemented: the publish service blocks BEFORE its transaction so no
  // publication row is written. The §26.4 gate runs first, so an unauthorized
  // caller gets the approval signal rather than this error.
  implemented: false,

  async publish(): Promise<{ externalRef: string | null }> {
    throw new ValidationError(
      "Publishing to Google is not yet available (connector stub)",
      { destination: "google" }
    );
  },
};
