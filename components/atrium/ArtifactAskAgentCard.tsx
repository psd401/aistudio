"use client";

/**
 * Atrium artifact "Ask the agent" card (Epic #1059 Meridian redesign, slice D)
 *
 * The rail card that reinforces the Atrium model: artifacts are changed by
 * PROMPTING the agent, never by hand-editing HTML. It offers a few example prompts
 * and a free-text input; submitting opens the artifact BESIDE the Nexus chat
 * (`/nexus?workspace=<id>`), the existing agent re-prompt surface (spec §17), with
 * the prompt carried as a query hint. Client component (input state + navigation).
 *
 * #1791: it now continues the most recent conversation bound to this artifact
 * (`&id=<conversation>`) instead of always opening a new one, and auto-sends the
 * prompt on arrival via the same-tab handshake in `lib/nexus/draft-auto-send`.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import {
  armDraftAutoSend,
  DRAFT_AUTO_SEND_PARAM,
} from "@/lib/nexus/draft-auto-send";
import { findWorkspaceConversationAction } from "@/actions/nexus/workspace-binding.actions";

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
  // The conversation lookup is a round trip, so the click needs a visible
  // "working on it" state — otherwise pressing Ask looks like a no-op for as
  // long as the action takes.
  const [opening, setOpening] = useState(false);

  const open = useCallback(async (text: string, forceNewChat = false): Promise<void> => {
    setOpening(true);
    // #1791 finding 1: continue the conversation that already worked on this
    // artifact instead of starting a fresh one. The old link always opened a
    // NEW chat, so the second one re-ran `list_available_tables`, three
    // `inspect_table_schema` calls and several probe queries the first chat had
    // already done before it could make a one-table change.
    //
    // A failed or empty lookup falls through to a new conversation — the
    // previous behaviour — so this can never block the person from asking.
    let base = `/nexus?workspace=${encodeURIComponent(artifactId)}`;
    if (!forceNewChat) {
      try {
        const found = await findWorkspaceConversationAction(artifactId);
        if (found.isSuccess && found.data.conversationId) {
          base += `&id=${encodeURIComponent(found.data.conversationId)}`;
        }
      } catch {
        // Fall through to a new chat.
      }
    }
    // `draft` is the ONLY param the Nexus composer prefills from — see
    // app/(protected)/nexus/_components/prompt-auto-loader.tsx, which reads
    // `draft` and `promptId` and nothing else. This used to send `prompt`,
    // which no code path reads, so every chip and every typed change silently
    // landed in an empty composer.
    const draft = text.trim();
    if (!draft) {
      router.push(base);
      return;
    }
    // #1791 finding 2: the button said "Ask" but only prefilled, so the person
    // had to press send a second time on a different page. Arm the one-shot
    // handshake so the composer sends it on arrival. A link without a matching
    // sessionStorage entry — i.e. one that did not originate from this click —
    // still only prefills, so the flag cannot be weaponised from outside.
    const nonce = armDraftAutoSend(draft);
    const href =
      `${base}&draft=${encodeURIComponent(draft)}` +
      (nonce ? `&${DRAFT_AUTO_SEND_PARAM}=${encodeURIComponent(nonce)}` : "");
    router.push(href);
    // `opening` is deliberately left set: the navigation is in flight and the
    // controls should stay disabled until this page is torn down.
  }, [artifactId, router]);

  return (
    <div className="mer-artifact-rail-card mer-artifact-ask" data-testid="artifact-ask-agent">
      <div className="mer-artifact-rail-label">
        <span className="mer-agent-mark" aria-hidden="true">
          ✦
        </span>{" "}
        Ask the agent
      </div>
      <p className="mer-artifact-ask-hint">
        Describe a change and the agent rebuilds the page — or edit the HTML
        yourself in the Code tab.
      </p>
      <div className="mer-artifact-ask-examples">
        {EXAMPLE_PROMPTS.map((ex) => (
          <button
            key={ex}
            type="button"
            className="mer-artifact-ask-chip"
            disabled={opening}
            onClick={() => void open(ex)}
          >
            {ex}
          </button>
        ))}
      </div>
      <form
        className="mer-artifact-ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          void open(prompt);
        }}
      >
        <input
          className="mer-artifact-ask-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe a change…"
          aria-label="Describe a change for the agent"
          disabled={opening}
        />
        <button type="submit" className="mer-btn mer-btn-agent" disabled={opening}>
          Ask
        </button>
      </form>
      {/*
        #1791 finding 1: Ask continues the chat that already knows this artifact.
        Starting over is still one click away — a long thread can be the reason
        someone wants a clean one, and silently reusing it with no escape would
        trade one trap for another.
      */}
      <button
        type="button"
        className="mer-artifact-ask-newchat"
        disabled={opening}
        onClick={() => void open(prompt, true)}
      >
        Start a new chat instead
      </button>
    </div>
  );
}

export default ArtifactAskAgentCard;
