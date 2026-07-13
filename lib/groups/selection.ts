/**
 * Selection resolution for group sync (Epic #1202, Phase 0).
 *
 * Given the admin-configured selection rules (hand-picked group emails ∪ prefix
 * rules) and the full set of groups available in the directory, resolve WHICH
 * groups are selected and by which source. A hand-pick wins over a prefix match
 * on a tie (source = 'manual'). Both modes apply simultaneously.
 *
 * Pure and directory-agnostic: the admin UI uses it to preview a rule set against
 * the currently-known groups; the sync Lambda re-implements the same predicate
 * against live Google listings (it cannot import app code). Kept trivial so the
 * two copies cannot drift meaningfully.
 */

import type { GroupSource } from "@/lib/db/schema";
import { normalizeEmail, normalizePrefix } from "./normalize";

/** A selection rule, as stored in group_selection_rules (only what matters here). */
export interface SelectionRuleInput {
  ruleType: "pick" | "prefix";
  value: string;
  isActive: boolean;
}

/** Minimal group shape the resolver needs — a normalized email is enough. */
export interface SelectableGroup {
  groupEmail: string;
}

export interface ResolvedSelection<G extends SelectableGroup> {
  group: G;
  /** 'manual' when a pick matched (wins on tie), else 'prefix'. */
  source: GroupSource;
}

/**
 * Resolve the selected groups from active rules. A group is selected if its
 * (normalized) email exactly equals an active pick OR startsWith an active,
 * non-empty prefix. Empty prefixes are ignored (an empty prefix would select
 * every group — never the intent, and a footgun for authorization).
 */
export function resolveSelection<G extends SelectableGroup>(
  rules: SelectionRuleInput[],
  groups: G[]
): ResolvedSelection<G>[] {
  const picks = new Set<string>();
  const prefixes: string[] = [];
  for (const rule of rules) {
    if (!rule.isActive) continue;
    if (rule.ruleType === "pick") {
      const p = normalizeEmail(rule.value);
      if (p) picks.add(p);
    } else {
      const p = normalizePrefix(rule.value);
      if (p) prefixes.push(p);
    }
  }

  const resolved: ResolvedSelection<G>[] = [];
  for (const group of groups) {
    const email = normalizeEmail(group.groupEmail);
    if (!email) continue;
    if (picks.has(email)) {
      resolved.push({ group, source: "manual" });
    } else if (prefixes.some((prefix) => email.startsWith(prefix))) {
      resolved.push({ group, source: "prefix" });
    }
  }
  return resolved;
}
