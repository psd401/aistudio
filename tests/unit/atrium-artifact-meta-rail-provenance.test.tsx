/** @jest-environment jsdom */

/**
 * #1791: the About card describes the CURRENT version, so its provenance comes
 * from the head version's actor, not from who created the artifact.
 */

import { render, screen } from "@testing-library/react";

jest.mock("@/components/atrium/ArtifactAskAgentCard", () => ({
  ArtifactAskAgentCard: () => null,
}));

import { ArtifactMetaRail } from "@/components/atrium/ArtifactMetaRail";
import { NEXUS_CHAT_AUTHOR_LABEL } from "@/lib/content/version-author-label";

function renderRail(props: {
  agentMaintained: boolean;
  headAuthorActor?: "human" | "agent" | null;
  headAuthorLabel?: string | null;
}) {
  render(
    <ArtifactMetaRail
      artifactId="obj-1"
      updatedAt={null}
      versionNumber={2}
      visibilityLevel="private"
      backlinks={[]}
      {...props}
    />
  );
  return screen.getByTestId("artifact-meta-rail").textContent ?? "";
}

describe("ArtifactMetaRail provenance", () => {
  it("describes an agent-created artifact whose head a person edited as human-authored", () => {
    const text = renderRail({ agentMaintained: true, headAuthorActor: "human" });
    expect(text).toContain("Human-authored");
    expect(text).not.toContain("Agent-maintained");
  });

  it("describes a human-created artifact whose head an agent wrote as agent-maintained", () => {
    const text = renderRail({ agentMaintained: false, headAuthorActor: "agent" });
    expect(text).toContain("Agent-maintained");
  });

  it("says a chat-written head was written in Nexus chat, without naming an account", () => {
    const text = renderRail({
      agentMaintained: false,
      headAuthorActor: "human",
      headAuthorLabel: NEXUS_CHAT_AUTHOR_LABEL,
    });
    expect(text).toContain("Written by the agent in Nexus chat");
    expect(text).not.toMatch(/your account/i);
  });

  it("falls back to the creator when no head version is known", () => {
    expect(renderRail({ agentMaintained: true })).toContain("Agent-maintained");
  });
});
