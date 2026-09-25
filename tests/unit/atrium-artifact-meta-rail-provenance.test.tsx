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
import type { ContentDataAccess } from "@/lib/content/types";

function renderRail(props: {
  agentMaintained: boolean;
  headAuthorActor?: "human" | "agent" | null;
  headAuthorLabel?: string | null;
  dataAccess?: ContentDataAccess;
}) {
  render(
    <ArtifactMetaRail
      artifactId="obj-1"
      updatedAt={null}
      versionNumber={2}
      visibilityLevel="private"
      dataAccess="none"
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

/**
 * #1790: the About card is where an author looks to find out what the page IS.
 * For a live-data dashboard it said "Human-authored / Source: Human" and nothing
 * about the data — the mode was reachable only from the Content settings dialog.
 */
describe("ArtifactMetaRail data-access row", () => {
  it("names live PSD data, and says it is scoped to the reader", () => {
    const text = renderRail({ agentMaintained: false, dataAccess: "query" });
    expect(text).toContain("Live PSD data (as viewer)");
    expect(text).toContain("their own district permissions");
  });

  it("renders the Content settings control inline in the live-data note", () => {
    render(
      <ArtifactMetaRail
        artifactId="obj-1"
        agentMaintained={false}
        updatedAt={null}
        versionNumber={2}
        visibilityLevel="private"
        dataAccess="query"
        settingsLink={<button type="button">Content settings</button>}
        backlinks={[]}
      />
    );
    const note = screen.getByTestId("artifact-data-note");
    expect(note.querySelector("button")?.textContent).toBe("Content settings");
    expect(note.textContent).toContain("Change this in Content settings.");
  });

  it("does not claim live data for a records-mode artifact", () => {
    const text = renderRail({ agentMaintained: false, dataAccess: "records" });
    expect(text).toContain("Saves reader entries");
    expect(text).not.toContain("Live PSD data");
    expect(screen.queryByTestId("artifact-data-note")).toBeNull();
  });

  it("says None for an artifact with no bridge", () => {
    const text = renderRail({ agentMaintained: false, dataAccess: "none" });
    expect(text).toContain("None");
    expect(screen.queryByTestId("artifact-data-note")).toBeNull();
  });
});
