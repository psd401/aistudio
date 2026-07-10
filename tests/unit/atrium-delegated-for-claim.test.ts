/**
 * Unit tests for `parseDelegatedForClaim` (Atrium §26.1, #1059).
 *
 * This is the single chokepoint for the delegation trigger. The security-relevant
 * property (raised in PR #1120 review): delegation is triggered ONLY by a numeric
 * `delegated_for` — a numeric RFC-8693 `act.sub` must NOT be promoted to delegation
 * (no `content:delegate` check exists on that fallback path). This pins that the
 * `act.sub` fallback was removed.
 */

import { parseDelegatedForClaim } from "@/lib/api/auth-middleware";

describe("parseDelegatedForClaim", () => {
  it("returns the numeric delegated_for claim", () => {
    expect(parseDelegatedForClaim({ delegated_for: 42 })).toBe(42);
    expect(parseDelegatedForClaim({ delegated_for: "42" })).toBe(42);
  });

  it("returns undefined when delegated_for is absent", () => {
    expect(parseDelegatedForClaim({})).toBeUndefined();
    expect(parseDelegatedForClaim({ sub: "999", scope: "content:read" })).toBeUndefined();
  });

  it("ignores a non-integer delegated_for", () => {
    expect(parseDelegatedForClaim({ delegated_for: "not-a-number" })).toBeUndefined();
    expect(parseDelegatedForClaim({ delegated_for: 1.5 })).toBeUndefined();
    expect(parseDelegatedForClaim({ delegated_for: null })).toBeUndefined();
  });

  it("does NOT promote a numeric act.sub to delegation (fallback removed)", () => {
    // A token carrying only a numeric act.sub — an audit actor, or a future
    // subsystem using `act` — must NOT be treated as Atrium delegation.
    expect(parseDelegatedForClaim({ act: { sub: "42" } })).toBeUndefined();
    expect(parseDelegatedForClaim({ act: { sub: 42 } })).toBeUndefined();
    // Even alongside the minted token's own (non-numeric) act.sub, only the
    // explicit numeric delegated_for is the trigger.
    expect(
      parseDelegatedForClaim({ delegated_for: 7, act: { sub: "agent-client-uuid" } })
    ).toBe(7);
  });
});
