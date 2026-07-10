/**
 * Atrium Schoology publish adapter (v1 stub, behind the public-publish gate)
 *
 * Issue #1057 (Epic #1059, Atrium Phase 7, spec §15.2 / §26.4). Schoology is a
 * family-facing LMS destination and is an EXPLICIT non-goal for v1 beyond this
 * stub (§2): the publish PATH exists and is governed, but the external push is
 * finished in a later increment.
 *
 * ## Behind the public-publish gate
 * Schoology is a PUBLIC destination (`isPublicDestination` → true), so the publish
 * service routes an unauthorized caller — including EVERY autonomous agent —
 * through the §26.4 approval gate FIRST. An authorized caller then reaches the
 * `implemented === false` guard below (checked before the publish transaction),
 * which fails loudly rather than committing a `content_publications` row that
 * claims "live" while nothing was actually pushed to Schoology (a silent-failure
 * pattern the content layer forbids). This is exactly the "stub behind the gate"
 * the acceptance criteria call for.
 *
 * ## Finishing later (the intended implementation)
 * When implemented, this adapter will push the published version into Schoology
 * over `lib/mcp/connector-service.ts` + the existing per-user OAuth connectors
 * (the Canva pattern, Epic #774): resolve the caller's stored Schoology OAuth
 * access token, POST the rendered document / a link to the object's public reader
 * URL, and return the Schoology resource id as `external_ref` (with `unpublish`
 * deleting that resource). Flip `implemented` to `true` and replace the throwing
 * body at that point; the registry wiring + the §26.4 gate already hold.
 *
 * See docs/features/atrium-design-spec.md §15.2 / §26.4 and
 * lib/mcp/connector-service.ts.
 */

import { ValidationError } from "../errors";
import type { PublishAdapter } from "./types";

export const schoologyAdapter: PublishAdapter = {
  destination: "schoology",
  // Not yet implemented: the publish service blocks BEFORE its transaction so no
  // publication row is written. The §26.4 gate runs first, so an unauthorized
  // caller gets the approval signal rather than this error.
  implemented: false,

  async publish(): Promise<{ externalRef: string | null }> {
    throw new ValidationError(
      "Publishing to Schoology is not yet available (connector stub)",
      { destination: "schoology" }
    );
  },
};
