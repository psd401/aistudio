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
 *      reactive `_abort_and_resend` and the default-off pre-send abort. Google
 *      Chat exposes no stop control. With the `OPENCLAW_PRESEND_ABORT=1` kill
 *      switch, a user's NEW message makes the harness abort a background job's
 *      overlapping run — triggered by the user, but still not a stop they
 *      asked for (the 2026-08-17 incident in harness_adapter.py: "I never
 *      aborted anything", and they were right). The hint names that cause.
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
 *     "yes, continue" replies for one case manager — while keeping R15's two
 *     real reasons to ask (missing information, destructive actions);
 *   - keep upstream's real safety intent ("resume carefully") as the concrete
 *     thing it was protecting: don't repeat a side effect that already landed;
 *   - defer to the message it is prepended to: that message may change or
 *     cancel the earlier request, and "finish what was already asked" must
 *     not override it;
 *   - keep it out of the reply: every line the agent writes reaches the user
 *     (psd-rules R1), so the note and the cutoff mechanism stay internal.
 */
export const SYSTEM_CUTOFF_HINT =
  'Note: your previous run on this session was cut off by the platform — a ' +
  'turn time limit, a gateway restart, promotion to a background job, or ' +
  'the platform replacing a run that overlapped a newer message. The user ' +
  'did NOT stop, interrupt, pause, or abort you, and nobody asked you to ' +
  'hold; do not say or imply that they did. The user\'s message below comes ' +
  'first: if it changes or cancels the earlier request, follow it. ' +
  'Otherwise pick the work back up and finish what was already asked, ' +
  'without asking permission to continue — ask only ' +
  'for information you cannot obtain yourself or before something ' +
  'destructive or irreversible. Before re-running any side effect (creating, ' +
  'sharing, posting, sending), check whether it already completed in your ' +
  'earlier work and skip it if so. Do not mention this note or the cutoff to ' +
  'the user.';

/** The patched assignment, with the attribution corrected. */
export const PATCHED_ABORTED_HINT_ASSIGNMENT =
  `const abortedHint = params.abortedLastRun ? ${JSON.stringify(
    SYSTEM_CUTOFF_HINT,
  )} : "";`;

/**
 * Phrases that must never appear in the hint the model is handed. The tests
 * import this list and assert it against the patched text, so a future reword
 * cannot reintroduce the fabrication this issue exists to remove.
 * "interrupt" is deliberately absent: the hint has to be able to deny the
 * claim, and banning the word would ban the denial.
 */
export const FORBIDDEN_HINT_PHRASES = Object.freeze([
  'aborted by the user',
  'ask for clarification',
  'you stopped',
  'you interrupted',
]);
