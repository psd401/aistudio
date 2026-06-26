/**
 * Atrium provenance pure-logic tests (#1051)
 *
 * Covers lib/content/collab/provenance.ts — author classification, tag building,
 * and the per-block dominant-author vote that drives the green/purple rail. Pure
 * TS (no TipTap/Yjs), so it runs under jest. The TipTap/Yjs bridge is covered by
 * tests/smoke/atrium-collab-bridge.smoke.ts (Bun).
 */

import {
  authorKindOf,
  makeAuthorTag,
  dominantBlockAuthor,
} from "@/lib/content/collab/provenance";

describe("authorKindOf", () => {
  it("classifies human / ai / agent / unknown", () => {
    expect(authorKindOf("human:42")).toBe("human");
    expect(authorKindOf("ai:bot-1")).toBe("agent");
    expect(authorKindOf("agent:bot-1")).toBe("agent");
    expect(authorKindOf("system:x")).toBe("unknown");
    expect(authorKindOf("")).toBe("unknown");
    expect(authorKindOf(null)).toBe("unknown");
    expect(authorKindOf(undefined)).toBe("unknown");
  });
});

describe("makeAuthorTag", () => {
  it("normalizes agents to ai: and humans to human:", () => {
    expect(makeAuthorTag("agent", "bot-1")).toBe("ai:bot-1");
    expect(makeAuthorTag("human", 42)).toBe("human:42");
  });
  it("falls back to 'unknown' for empty ids", () => {
    expect(makeAuthorTag("human", "")).toBe("human:unknown");
    expect(makeAuthorTag("agent", "   ")).toBe("ai:unknown");
  });
});

describe("dominantBlockAuthor", () => {
  it("picks the author with more characters", () => {
    expect(dominantBlockAuthor(10, 3)).toBe("human");
    expect(dominantBlockAuthor(2, 9)).toBe("agent");
  });
  it("resolves ties to human (human review wins)", () => {
    expect(dominantBlockAuthor(5, 5)).toBe("human");
  });
  it("returns null for an unattributed block", () => {
    expect(dominantBlockAuthor(0, 0)).toBeNull();
  });
});
