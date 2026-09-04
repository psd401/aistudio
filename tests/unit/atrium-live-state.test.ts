/**
 * The single Live/Draft state (#1726) — the two pure pieces of it.
 *
 * Atrium used to model publication as a DESTINATION choice ("the intranet" vs
 * "the public web"), which made it a second audience switch competing with the
 * object's visibility Level. Reconciling the two needed a "Widen who can see
 * this?" prompt whose claim was false (`/c/[slug]` runs `canView` before it looks
 * at the publication) and whose confirmation replaced the author's grant set with
 * none.
 *
 * Publication is now one state. These tests pin the two pure functions the whole
 * model rests on:
 *
 *  - `isLive` — the list form of "is this object live?", shared by every
 *    authoring surface. If it stopped accepting a pre-migration `public_web` row,
 *    an object serving readers would be shown to its author as a draft.
 *  - `liveConsequence` — the sentence that REPLACED the widen prompt. It has to
 *    be true for every Level, including the one the prompt used to refuse: a Live
 *    object that only its named grantees can open.
 */

import { isLive } from "@/lib/content/publish-adapters/types";
import { livePublicationConditions } from "@/lib/content/live-publication";
import { liveConsequence } from "@/components/atrium/SharePublishSection";

describe("isLive", () => {
  it("is false for an object with no publications", () => {
    expect(isLive([])).toBe(false);
  });

  it("is true for the live row", () => {
    expect(isLive(["intranet"])).toBe(true);
  });

  it("is true for a pre-migration public_web row", () => {
    // Migration 180 folds these into the live row, but the deploy and the
    // migration can land in either order — a page already serving readers must
    // not be reported as a draft in the window between them.
    expect(isLive(["public_web"])).toBe(true);
  });

  it("is FALSE for connector destinations alone", () => {
    // An OKF bundle in S3, or a copy pushed to Schoology, is not a reader page.
    // Counting one as Live would make `/p/{slug}` resolve for an object that has
    // no live page at all.
    expect(isLive(["okf"])).toBe(false);
    expect(isLive(["schoology", "google"])).toBe(false);
  });

  it("is true when a live row sits alongside connector rows", () => {
    expect(isLive(["okf", "intranet"])).toBe(true);
  });
});

describe("livePublicationConditions", () => {
  it("yields TWO defined conditions — a dropped one would fail OPEN", () => {
    // Drizzle's `and()` SILENTLY SKIPS undefined operands, so a helper typed
    // `SQL | undefined` can contribute nothing to a `where` and leave a gate
    // matching every row. Every caller of this helper gates what ANONYMOUS
    // visitors may read (the public reader, the sitemap, the public asset-bytes
    // route, the public embed resolver), so a dropped condition would serve any
    // object carrying any publication row.
    const conditions = livePublicationConditions();
    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      expect(condition).toBeDefined();
    }
  });
});

describe("liveConsequence", () => {
  it("states the grant count for a Group object — the case the prompt refused", () => {
    // This is the whole point of the change. The old dialog called this state a
    // "live page its readers cannot open" and offered to fix it by deleting the
    // grants. It is in fact exactly what the author asked for.
    expect(liveConsequence("group", 2)).toBe(
      "Live for the 2 people and groups you've granted."
    );
  });

  it("does not say '1 people', and does not claim every grant is a person", () => {
    // A grant can be a role, building, department, grade or Google group as well
    // as a named person, so "N people" would be false for most Group objects —
    // and a line that replaced a false prompt has to be true.
    expect(liveConsequence("group", 1)).toBe(
      "Live for the 1 person or group you've granted."
    );
  });

  it("names the signed-in audience for Internal", () => {
    expect(liveConsequence("internal", 0)).toBe("Live for everyone signed in.");
  });

  it("says NO SIGN-IN for Public — the only level that reaches the open internet", () => {
    expect(liveConsequence("public", 0)).toBe(
      "Live for anyone with the link, no sign-in."
    );
  });

  it("is honest about a Live PRIVATE object rather than pretending it is shared", () => {
    // Publishing a private object is legitimate (it pins a version and gives it a
    // page); the line must not imply an audience that does not exist.
    expect(liveConsequence("private", 0)).toBe(
      "Live, but only you and administrators can open it."
    );
  });

  it("counts the per-user grants a PRIVATE object still honours", () => {
    // `setLevelInTx` preserves `user` grants across a group -> private
    // round-trip so a colleague is not silently cut off, and `canView` honours
    // them. "Only you and administrators" would be false for such an object —
    // and a line that replaced a false prompt cannot itself be false.
    expect(liveConsequence("private", 1)).toBe(
      "Live for you, administrators, and 1 person who still has access."
    );
    expect(liveConsequence("private", 3)).toBe(
      "Live for you, administrators, and 3 people who still have access."
    );
  });
});
