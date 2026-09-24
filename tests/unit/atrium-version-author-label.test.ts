/** @jest-environment node */

/**
 * #1791 finding 6: versions the Nexus chat MODEL wrote showed as "v3 · human"
 * and "Human-authored", because the workspace chat tools deliberately run under
 * the USER's own requester — the right call for authorization, and why
 * `authorActor` is `human`. The label records the authoring SURFACE alongside
 * that unchanged authorization record.
 */

import { describe, it, expect } from "@jest/globals";
import {
  NEXUS_CHAT_AUTHOR_LABEL,
  versionAuthorDescription,
  versionAuthorLabel,
} from "@/lib/content/version-author-label";

describe("versionAuthorLabel", () => {
  it("still says human for a version a person wrote directly", () => {
    expect(versionAuthorLabel({ authorActor: "human", authorLabel: null })).toBe(
      "human"
    );
    expect(versionAuthorLabel({ authorActor: "human" })).toBe("human");
  });

  it("distinguishes a chat-written version from a hand-written one", () => {
    expect(
      versionAuthorLabel({
        authorActor: "human",
        authorLabel: NEXUS_CHAT_AUTHOR_LABEL,
      })
    ).toBe("via Nexus chat");
  });

  it("never says 'you' — the DTO cannot tell whether the author is the viewer", () => {
    // VersionSummary omits authorUserId on purpose (anti-enumeration), so no
    // surface can know; "you" would mislabel an admin's edit as the viewer's.
    for (const label of [null, NEXUS_CHAT_AUTHOR_LABEL]) {
      expect(
        versionAuthorLabel({ authorActor: "human", authorLabel: label })
      ).not.toMatch(/\byou\b/i);
    }
  });

  it("keeps an autonomous agent's version as AI, whatever the surface label says", () => {
    // `authorActor: "agent"` is the stronger statement and must not be softened
    // into a surface label.
    expect(
      versionAuthorLabel({
        authorActor: "agent",
        authorLabel: NEXUS_CHAT_AUTHOR_LABEL,
      })
    ).toBe("AI");
    expect(versionAuthorLabel({ authorActor: "agent", authorLabel: null })).toBe(
      "AI"
    );
  });

  it("treats an unrecognised surface label as a plain human version", () => {
    // A label from some future surface must not render as raw text in the UI.
    expect(
      versionAuthorLabel({ authorActor: "human", authorLabel: "something-else" })
    ).toBe("human");
  });
});

describe("versionAuthorDescription", () => {
  it("says the agent wrote it, under the user's account", () => {
    expect(
      versionAuthorDescription({
        authorActor: "human",
        authorLabel: NEXUS_CHAT_AUTHOR_LABEL,
      })
    ).toBe("Written by the agent in Nexus chat, under your account");
  });

  it("keeps the existing phrasing for the other two cases", () => {
    expect(
      versionAuthorDescription({ authorActor: "human", authorLabel: null })
    ).toBe("Human-authored");
    expect(
      versionAuthorDescription({ authorActor: "agent", authorLabel: null })
    ).toBe("Agent-maintained · auto-refreshes");
  });
});
