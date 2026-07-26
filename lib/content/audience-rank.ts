/**
 * Audience breadth ordering for `VisibilityLevel`.
 *
 * Narrowest first. Used to compare REACH — "does this level already carry at
 * least as far as that one?" — in two places that must never disagree:
 *
 *  - `lib/atrium/publish-audience.ts` decides, on the authoring surface, whether
 *    publishing to a destination needs the object's visibility widened first.
 *  - `lib/content/publish-service.ts` re-evaluates that same question inside
 *    `runPublishTx`, against the `FOR UPDATE`-locked row, to honour a
 *    `widenOnly` request without ever narrowing a concurrently-widened object.
 *
 * Those were independent copies of this table until they were consolidated here:
 * a surface that ranked `internal` above `public` while the transaction ranked
 * them the other way would let the "widen-only" guard narrow the very thing it
 * exists to protect. One table, one ordering.
 *
 * NOT an authorization ordering. Nothing here decides WHO may widen — that is
 * the §26.4 gate's job, evaluated against the locked row. This only says which
 * audience is larger.
 */

import type { VisibilityLevel } from "./types";

export const AUDIENCE_RANK: Record<VisibilityLevel, number> = {
  private: 0,
  group: 1,
  internal: 2,
  public: 3,
};

/** True when `level` reaches at least as far as `required`. */
export function reachesAtLeast(
  level: VisibilityLevel,
  required: VisibilityLevel
): boolean {
  return AUDIENCE_RANK[level] >= AUDIENCE_RANK[required];
}
