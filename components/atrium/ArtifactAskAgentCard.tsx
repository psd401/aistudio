"use client";

/**
 * Atrium artifact "Ask the agent" card (Epic #1059 Meridian redesign, slice D)
 *
 * The rail card that reinforces the Atrium model: artifacts are changed by
 * PROMPTING the agent, never by hand-editing HTML. It offers a few example prompts
 * and a free-text input; submitting opens the artifact BESIDE the Nexus chat
 * (`/nexus?workspace=<id>`), the existing agent re-prompt surface (spec §17), with
 * the prompt carried as a query hint. Client component (input state + navigation).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

const EXAMPLE_PROMPTS: readonly string[] = [
  "Add a comparison to last year",
  "Make the chart colors match our brand",
  "Summarize the key takeaway at the top",
];

export interface ArtifactAskAgentCardProps {
  /** The artifact id — opened beside the Nexus chat as the re-prompt workspace. */
  artifactId: string;
}

export function ArtifactAskAgentCard({
  artifactId,
}: ArtifactAskAgentCardProps): React.JSX.Element {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");

  const open = (text: string): void => {
    const base = `/nexus?workspace=${encodeURIComponent(artifactId)}`;
    const href = text.trim() ? `${base}&prompt=${encodeURIComponent(text.trim())}` : base;
    router.push(href);
  };

  return (
    <div className="mer-artifact-rail-card mer-artifact-ask" data-testid="artifact-ask-agent">
      <div className="mer-artifact-rail-label">
        <span className="mer-agent-mark" aria-hidden="true">
          ✦
        </span>{" "}
        Ask the agent
      </div>
      <p className="mer-artifact-ask-hint">
        Describe a change — the agent rebuilds the artifact. You never edit the HTML
        by hand.
      </p>
      <div className="mer-artifact-ask-examples">
        {EXAMPLE_PROMPTS.map((ex) => (
          <button
            key={ex}
            type="button"
            className="mer-artifact-ask-chip"
            onClick={() => open(ex)}
          >
            {ex}
          </button>
        ))}
      </div>
      <form
        className="mer-artifact-ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          open(prompt);
        }}
      >
        <input
          className="mer-artifact-ask-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe a change…"
          aria-label="Describe a change for the agent"
        />
        <button type="submit" className="mer-btn mer-btn-agent">
          Ask
        </button>
      </form>
    </div>
  );
}

export default ArtifactAskAgentCard;
