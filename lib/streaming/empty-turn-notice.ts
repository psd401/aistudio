/**
 * Why a finished turn left the user with nothing to read, and what to say about it (#1899).
 *
 * A read of 375 staff members' Nexus use (Aug–Oct 2026) found ~45 people who hit
 * a turn with no reply and then resent the same message two to six times. The
 * blank bubble has several distinct causes, and the previous check
 * (`BaseProviderAdapter.isVisibleChunkType`) collapsed them: it counted
 * `reasoning-delta` and `file` chunks as "visible" and so suppressed the
 * empty-response notice for them. But the Nexus Thread
 * (`components/assistant-ui/thread.tsx`, `DEFAULT_ASSISTANT_MESSAGE_CONTENT_COMPONENTS`)
 * registers **no** Reasoning and **no** File renderer, and assistant-ui's
 * defaults draw nothing for those parts — so a model that thinks and then
 * returns no text produced a genuinely blank bubble with no notice.
 *
 * The rule here is therefore anchored on TEXT, not on "some chunk arrived":
 * a turn with no text part gets a notice that names what actually happened.
 * Tool activity is included even though the thread *does* render tool cards —
 * a wall of tool cards with no answer is the #2 reported shape of this bug, and
 * the step budget (`lib/nexus/chat-step-budget.ts`) makes it reachable on an
 * ordinary three-step turn.
 *
 * Kept free of AI SDK and React imports so both the stream transform and the
 * persistence path can use it, and so it is unit-testable on its own.
 */

/** What a single UI message chunk puts (or fails to put) in front of the user. */
export type ChunkVisibility = "text" | "reasoning" | "file" | "tool" | "other" | "none";

/**
 * Bucket a UI-message-stream chunk type by what the Nexus thread does with it.
 *
 * `other` covers the part types the thread renders but which never stand in for
 * an answer on their own: retrieved sources (`source-*`, rendered by
 * `WebSearchSource`) and custom `data-*` parts. A turn made only of those is
 * left alone rather than labelled empty — calling a rendered answer "empty" is
 * the one failure mode worse than staying quiet.
 */
export function classifyChunkVisibility(type: string): ChunkVisibility {
  if (type === "text-delta") return "text";
  if (type.startsWith("reasoning-")) return "reasoning";
  if (type === "file") return "file";
  // MCP tools stream through these same types with a `dynamic` flag.
  if (type.startsWith("tool-")) return "tool";
  if (type.startsWith("source-") || type.startsWith("data-")) return "other";
  return "none";
}

/** The shape of an answer-less turn, in the order we prefer to explain it. */
export type EmptyTurnKind =
  | "step_budget_exhausted"
  | "tool_only"
  | "reasoning_only"
  | "file_only"
  | "nothing";

export interface EmptyTurnObservation {
  sawText: boolean;
  sawReasoning: boolean;
  sawFile: boolean;
  sawToolActivity: boolean;
  /** `source-*` / `data-*` parts, which the thread renders on their own. */
  sawOtherRendered: boolean;
  /** `finish-step` chunks seen, i.e. agent-loop steps that completed. */
  completedSteps: number;
  /** The run's step budget (`resolveMaxSteps`), when the caller knows it. */
  maxSteps?: number;
}

/**
 * Classify a cleanly-finished turn, or return null when there is nothing to say.
 *
 * Any text at all means the user has an answer to read, so no notice. Tool
 * activity is ranked ahead of reasoning and files because it is the more
 * actionable explanation: "it spent its steps on tools" tells the user to
 * narrow the request, where "it thought and said nothing" only tells them to
 * retry.
 */
export function classifyEmptyTurn(
  observation: EmptyTurnObservation
): EmptyTurnKind | null {
  if (observation.sawText) return null;

  if (observation.sawToolActivity) {
    const { maxSteps, completedSteps } = observation;
    // A turn that burned its whole budget on tool calls is a different problem
    // from one that stopped after a single call, and deserves different advice.
    if (
      typeof maxSteps === "number" &&
      Number.isFinite(maxSteps) &&
      maxSteps > 0 &&
      completedSteps >= maxSteps
    ) {
      return "step_budget_exhausted";
    }
    return "tool_only";
  }

  if (observation.sawReasoning) return "reasoning_only";
  if (observation.sawFile) return "file_only";
  // Sources and data parts render by themselves; leave those turns alone.
  if (observation.sawOtherRendered) return null;
  return "nothing";
}

/**
 * User-facing text for each shape. Rendered verbatim by `MessagePrimitive.Error`,
 * so each one says what happened and what to do next — no codes, no internals.
 */
const EMPTY_TURN_NOTICES: Record<EmptyTurnKind, string> = {
  step_budget_exhausted:
    "The model used up all of its tool steps before writing an answer. Please try again, or break the request into smaller parts.",
  tool_only:
    "The model used its tools but never wrote an answer. Please try again, or rephrase your request.",
  reasoning_only:
    "The model finished thinking but never wrote an answer. Please try again — if it keeps happening, rephrase your request or pick a different model.",
  file_only:
    "The model produced a file but no written answer. Please try again, and ask for the answer in the chat as well.",
  // Wording retained from #1686 — referenced by existing tests and docs.
  nothing:
    "The model returned an empty response. Please try again, or rephrase your request.",
};

export function emptyTurnNotice(kind: EmptyTurnKind): string {
  return EMPTY_TURN_NOTICES[kind];
}

/**
 * The row saved for an answer-less turn so a reload never shows a prompt with
 * no reply (#1899, case 1).
 *
 * Deliberately kind-agnostic: the kind is known only inside the stream
 * transform, which sees the chunk types, while persistence runs from `onFinish`
 * and sees only the final text and step history. Rather than guess, the durable
 * row states the fact both paths agree on. The live stream still shows the more
 * specific notice above.
 */
export const EMPTY_TURN_PERSIST_NOTICE =
  "This turn ended without a written answer. Please try again, or rephrase your request.";

/**
 * The row saved when persisting the real assistant message threw (#1899, case 4).
 *
 * Without it the user message is already saved and the reply is not, so the
 * conversation reloads showing a prompt that was apparently never answered.
 */
export const ASSISTANT_SAVE_FAILED_NOTICE =
  "This reply could not be saved, so it is not available here any more. Please ask again.";
