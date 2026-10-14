/**
 * Rewrite OpenClaw's one-shot "aborted last run" session hint (issue #1897).
 *
 * THE BUG, in full. OpenClaw keeps a per-session `abortedLastRun` flag in its
 * SQLite session store. When the flag is set, the next turn's reply pipeline
 * (`applySessionHints`, src/auto-reply/reply/body.ts in the pinned
 * 2026.7.2-beta.5 bundle) PREPENDS a sentence to the agent-visible prompt body
 * and then clears the flag:
 *
 *     const abortedHint = params.abortedLastRun
 *       ? "Note: The previous agent run was aborted by the user. ..."
 *       : "";
 *     if (abortedHint) prefixedBodyBase = `${abortedHint}\n\n${prefixedBodyBase}`;
 *
 * So the first thing the model reads, above the user's actual message, is the
 * platform asserting that THE USER aborted it — plus an invitation to "ask for
 * clarification". That is where "it looks like you stopped the last run" and
 * the endless "want me to continue?" pauses come from. It is not the model
 * inventing a stop; it is the model being told about one, in the user's name.
 *
 * WHY THE SENTENCE IS NEVER TRUE IN THIS DEPLOYMENT. Every path that sets
 * `abortedLastRun` in the pinned bundle is the platform, never a person:
 *
 *   1. `markStartupOrphanedMainSessionsForRecovery`
 *      (main-session-restart-recovery): on gateway startup, any session entry
 *      still at `status: "running"` with no live owner process is marked
 *      `mark_interrupted` -> `abortedLastRun = true`. This is the common case
 *      here: `harness_adapter.shutdown()` SIGTERMs then SIGKILLs the whole
 *      gateway process group at turn end, so a turn cut short by the chat
 *      deadline, a gateway restart, or promotion to a background job leaves the
 *      entry at `running` and the NEXT turn's gateway marks it.
 *   2. `markSessionAbortTarget` (session-accessor): a `chat.abort` request.
 *      The only `chat.abort` senders in this repo are the harness itself — the
 *      default-off pre-send abort and the reactive `_abort_and_resend` — and
 *      Google Chat exposes no stop control, so a user cannot reach this.
 *   3. `persistForceClearedEmbeddedRunTerminalState` (runs): a forced run
 *      registry clear.
 *   4. The restart-recovery claim cleanup with a terminal-pending receipt.
 *
 * All four are the system. So the honest fix is to make the sentence say so,
 * which is why this replaces the text rather than suppressing the hint: the
 * hint itself is useful (the previous run really did not finish), only its
 * attribution and its "ask for clarification" tail are wrong.
 *
 * #1740 fixed a DIFFERENT source of the same user-visible symptom (an orphaned
 * `ask_user` tool call whose synthetic error result the model read as a stop).
 * That fix was correct and is unchanged; this is the second, independent
 * source, and it is the one that survives a deadline expiry.
 */

/**
 * The verbatim hint from the pinned OpenClaw 2026.7.2-beta.5 bundle. Anchored
 * as the whole assignment, not just the sentence, so the replacement cannot
 * silently land on a copy of the string in unrelated UI code.
 */
export const UPSTREAM_ABORTED_HINT_ANCHOR =
  'const abortedHint = params.abortedLastRun ? ' +
  '"Note: The previous agent run was aborted by the user. ' +
  'Resume carefully or ask for clarification." : "";';

/**
 * What the model reads instead. Requirements, in order of why they exist:
 *   - name the real cause (platform cutoff) so the hint stays informative;
 *   - deny the user-stop reading explicitly, because the false claim is
 *     self-reinforcing once it enters the session history (psd-rules R15);
 *   - do NOT invite a permission check — "ask for clarification" is what
 *     produced ~25 false "continue?" pauses for one deputy principal and ~14
 *     "yes, continue" replies for one case manager;
 *   - keep upstream's real safety intent ("resume carefully") as the concrete
 *     thing it was protecting: don't repeat a side effect that already landed.
 */
export const SYSTEM_CUTOFF_HINT =
  'Note: your previous run on this session was cut off by the platform — a ' +
  'turn time limit, a gateway restart, or promotion to a background job. ' +
  'The user did NOT stop, interrupt, pause, or abort you, and nobody asked ' +
  'you to hold; do not say or imply that they did. Pick the work back up and ' +
  'finish what was already asked, without asking permission to continue. ' +
  'Before re-running any side effect (creating, sharing, posting, sending), ' +
  'check whether it already completed in your earlier work and skip it if so.';

/** The patched assignment, with the attribution corrected. */
export const PATCHED_ABORTED_HINT_ASSIGNMENT =
  `const abortedHint = params.abortedLastRun ? ${JSON.stringify(
    SYSTEM_CUTOFF_HINT,
  )} : "";`;

/**
 * Phrases that must never appear in the hint the model is handed. Asserted by
 * the tests against the patched text, so a future reword cannot reintroduce
 * the fabrication this issue exists to remove.
 */
export const FORBIDDEN_HINT_PHRASES = Object.freeze([
  'aborted by the user',
  'ask for clarification',
  'you stopped',
  'you interrupted',
]);

/**
 * Replace the hint in one bundle source.
 *
 * Throws when the anchor is missing or appears more than once. That is
 * deliberate: this runs in the image build, so a host bump that reworks
 * `applySessionHints` must fail the build loudly rather than ship an image
 * where the agent quietly blames users again.
 */
export function rewriteAbortedRunHint(source) {
  if (typeof source !== 'string') {
    throw new TypeError('aborted-run hint rewrite: source must be a string');
  }
  const first = source.indexOf(UPSTREAM_ABORTED_HINT_ANCHOR);
  if (first < 0) {
    throw new Error(
      'aborted-run hint rewrite: expected anchor was not found',
    );
  }
  if (
    source.includes(
      UPSTREAM_ABORTED_HINT_ANCHOR,
      first + UPSTREAM_ABORTED_HINT_ANCHOR.length,
    )
  ) {
    throw new Error(
      'aborted-run hint rewrite: expected anchor occurred more than once',
    );
  }
  return (
    source.slice(0, first) +
    PATCHED_ABORTED_HINT_ASSIGNMENT +
    source.slice(first + UPSTREAM_ABORTED_HINT_ANCHOR.length)
  );
}
