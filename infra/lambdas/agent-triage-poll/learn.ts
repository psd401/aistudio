/**
 * Nightly per-user learning job (#1172, #996 items 3 + 4).
 *
 * Orchestration around the pure algorithm in learning.ts:
 *   1. Recompute weighted learnedPatterns + fresh suggestions from the
 *      user's recent corrections/decisions.
 *   2. Merge suggestions into the pending list (dedupe by id, drop
 *      dismissed/applied, keep original createdAt).
 *   3. Persist learnedPatterns + merged pending suggestions + learnedAt.
 *   4. Post a Chat card for any GENUINELY NEW suggestions this run.
 *
 * Runs off the same SQS/worker path as the poll — one `learn` message per
 * enabled user, enqueued by the dispatcher on the daily EventBridge rule.
 */

import { log } from "./index";
import { computeLearning, mergeSuggestions } from "./learning";
import { postSuggestionCard, resolveDmSpace } from "./chat";
import {
  backfillDmSpaceName,
  getGoogleIdentityForEmail,
  saveLearning,
} from "./storage";
import type { TriageRow } from "./types";

export async function runLearning(row: TriageRow): Promise<void> {
  const t0 = Date.now();

  const { learnedPatterns, suggestions } = computeLearning({
    corrections: row.recentCorrections ?? [],
    decisions: row.recentDecisions ?? [],
    rules: row.rules,
    dismissedSuggestionIds: row.dismissedSuggestions,
    appliedSuggestionIds: row.appliedSuggestions,
  });

  const { merged, added } = mergeSuggestions(
    row.pendingSuggestions ?? [],
    suggestions,
    row.dismissedSuggestions ?? [],
    row.appliedSuggestions ?? [],
  );

  await saveLearning(
    row.userEmail,
    learnedPatterns,
    merged,
    new Date().toISOString(),
  );

  // Surface only the NEW suggestions via Chat — don't re-nag about ones
  // already pending. Resolve the DM space lazily (same pattern as
  // escalation) and backfill it onto the row for next time.
  if (added.length > 0) {
    let dmSpace = row.dmSpaceName;
    if (!dmSpace) {
      const gid = await getGoogleIdentityForEmail(row.userEmail);
      if (gid) {
        dmSpace = (await resolveDmSpace(gid)) ?? undefined;
        if (dmSpace) await backfillDmSpaceName(row.userEmail, dmSpace);
      }
    }
    if (dmSpace) {
      try {
        await postSuggestionCard({ dmSpaceName: dmSpace, suggestions: added });
      } catch (err) {
        log("WARN", "suggestion_card_failed", {
          user: row.userEmail,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      log("INFO", "suggestion_card_skipped_no_dm", {
        user: row.userEmail,
        new_suggestions: added.length,
      });
    }
  }

  log("INFO", "learning_run", {
    user: row.userEmail,
    patterns: learnedPatterns.length,
    pending: merged.length,
    new_suggestions: added.length,
    elapsed_ms: Date.now() - t0,
  });
}
