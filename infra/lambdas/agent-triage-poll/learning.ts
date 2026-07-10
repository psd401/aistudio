/**
 * Correction-driven learning (#1172, #996 items 3 + 4).
 *
 * Pure, side-effect-free algorithm that mines a user's recent corrections
 * (+ the decisions they correct) into two products:
 *
 *   1. `learnedPatterns` — weighted, age-decayed sender hints. These are a
 *      SOFT signal: the nightly job writes them onto the row and the LLM
 *      classifier injects them as prompt hints. They apply automatically
 *      but never hard-label anything.
 *
 *   2. `suggestions` — pending, user-approvable rule changes ("you archived
 *      3 important emails from X → mute X"). Hard rules are SUGGEST-ONLY:
 *      a suggestion becomes a real `rules` entry only when the user runs
 *      `suggestions apply <id>` from the skill.
 *
 * Kept in its own file (no AWS SDK) so it's trivially unit-testable — the
 * nightly worker just persists what this returns.
 */

import { wildcardMatch, type TriageRules } from "./rules";
import type {
  CorrectionRecord,
  DecisionRecord,
  LearnedPattern,
  Suggestion,
} from "./types";

/** Half-life for correction weight decay, in days. A 30-day-old correction
 * contributes half as much as a fresh one. */
export const WEIGHT_HALF_LIFE_DAYS = 30;

/** Minimum net weight for a pattern to be emitted as a soft LLM hint. */
export const LEARN_MIN_WEIGHT = 0.5;

/** Minimum net weight before a pattern is promoted to a rule suggestion. */
export const SUGGESTION_MIN_WEIGHT = 1.5;

/** Minimum number of corrections behind a suggestion (repeat behaviour). */
export const SUGGESTION_MIN_COUNT = 2;

/** Cap on how many learned patterns we keep on the row. */
export const MAX_LEARNED_PATTERNS = 40;

type PatternKind = "mute" | "vip";

interface Accum {
  sender: string;
  vipWeight: number;
  muteWeight: number;
  vipCount: number;
  muteCount: number;
}

export interface LearningContext {
  corrections: CorrectionRecord[];
  decisions: DecisionRecord[];
  /** Current rules — used to skip suggestions the user already configured. */
  rules: TriageRules;
  /** Suggestion ids the user dismissed — never re-raised. */
  dismissedSuggestionIds?: string[];
  /** Suggestion ids already applied — no need to re-suggest. */
  appliedSuggestionIds?: string[];
  /** Injected clock for deterministic tests; defaults to Date.now(). */
  now?: number;
}

export interface LearningResult {
  learnedPatterns: LearnedPattern[];
  suggestions: Suggestion[];
}

/**
 * Map a correction to the sender it implicates and the direction of the
 * signal. Returns null when the sender can't be resolved (no snapshot on
 * the correction and no matching decision to join against).
 */
function classifyCorrection(
  c: CorrectionRecord,
  decisionsById: Map<string, DecisionRecord>,
): { sender: string; kind: PatternKind } | null {
  const sender = (c.fromEmail ?? decisionsById.get(c.messageId)?.fromEmail ?? "")
    .trim()
    .toLowerCase();
  if (!sender || !sender.includes("@")) return null;

  // "archived" = user archived something we called important → demote/mute.
  // "inbox"    = user rescued a later/news back to inbox → promote/VIP.
  // direct re-label to important → VIP; to later/news → mute.
  let kind: PatternKind;
  if (c.toLabel === "archived" || c.toLabel === "later" || c.toLabel === "news") {
    kind = "mute";
  } else if (c.toLabel === "inbox" || c.toLabel === "important") {
    kind = "vip";
  } else {
    return null;
  }
  return { sender, kind };
}

/** Age-decayed contribution of a single correction. */
function decayedWeight(ts: string, now: number): number {
  const ageMs = now - new Date(ts).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 1; // future/garbage ts → full weight
  const ageDays = ageMs / 86_400_000;
  return Math.pow(0.5, ageDays / WEIGHT_HALF_LIFE_DAYS);
}

/** Is this sender already covered by an existing rule of the given kind? */
function alreadyRuled(sender: string, kind: PatternKind, rules: TriageRules): boolean {
  if (kind === "vip") {
    return (rules.vipSenders ?? []).some((v) => v.toLowerCase() === sender);
  }
  // mute — exact or wildcard match against the muteSenders patterns.
  const domain = sender.split("@")[1] ?? "";
  return (rules.muteSenders ?? []).some(
    (p) => wildcardMatch(p, sender) || (domain && wildcardMatch(p, domain)),
  );
}

export function computeLearning(ctx: LearningContext): LearningResult {
  const now = ctx.now ?? Date.now();
  const decisionsById = new Map<string, DecisionRecord>();
  for (const d of ctx.decisions ?? []) decisionsById.set(d.messageId, d);

  const bySender = new Map<string, Accum>();
  for (const c of ctx.corrections ?? []) {
    const mapped = classifyCorrection(c, decisionsById);
    if (!mapped) continue;
    const w = decayedWeight(c.ts, now);
    const acc =
      bySender.get(mapped.sender) ??
      { sender: mapped.sender, vipWeight: 0, muteWeight: 0, vipCount: 0, muteCount: 0 };
    if (mapped.kind === "vip") {
      acc.vipWeight += w;
      acc.vipCount += 1;
    } else {
      acc.muteWeight += w;
      acc.muteCount += 1;
    }
    bySender.set(mapped.sender, acc);
  }

  const dismissed = new Set(ctx.dismissedSuggestionIds ?? []);
  const applied = new Set(ctx.appliedSuggestionIds ?? []);

  const learnedPatterns: LearnedPattern[] = [];
  const suggestions: Suggestion[] = [];
  const nowIso = new Date(now).toISOString();

  for (const acc of bySender.values()) {
    // Net signal: the dominant direction wins; conflicting equal signals
    // cancel to ~0 (ambiguous) and are dropped.
    const net = acc.vipWeight - acc.muteWeight;
    const kind: PatternKind = net >= 0 ? "vip" : "mute";
    const weight = Math.abs(net);
    if (weight < LEARN_MIN_WEIGHT) continue;
    const count = kind === "vip" ? acc.vipCount : acc.muteCount;

    learnedPatterns.push({
      pattern: acc.sender,
      weight: round2(weight),
      source: "correction",
      kind,
      count,
    });

    // Promote to a suggestion when the signal is strong + repeated, the
    // rule isn't already configured, and the user hasn't dismissed/applied
    // it before.
    const id = `${kind}:${acc.sender}`;
    if (
      weight >= SUGGESTION_MIN_WEIGHT &&
      count >= SUGGESTION_MIN_COUNT &&
      !dismissed.has(id) &&
      !applied.has(id) &&
      !alreadyRuled(acc.sender, kind, ctx.rules)
    ) {
      suggestions.push({
        id,
        kind,
        target: acc.sender,
        reason:
          kind === "mute"
            ? `You archived ${count} "important" emails from ${acc.sender} — mute (auto-archive) future mail from them?`
            : `You rescued ${count} emails from ${acc.sender} — mark them VIP (always Important)?`,
        count,
        weight: round2(weight),
        createdAt: nowIso,
      });
    }
  }

  // Strongest signal first; cap the stored list.
  learnedPatterns.sort((a, b) => b.weight - a.weight);
  suggestions.sort((a, b) => b.weight - a.weight);
  return {
    learnedPatterns: learnedPatterns.slice(0, MAX_LEARNED_PATTERNS),
    suggestions,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Merge freshly-computed suggestions into the existing pending list,
 * de-duplicating by id and dropping any the user has since dismissed or
 * applied. Preserves the original `createdAt` of pre-existing pending
 * suggestions so "new since last night" stays meaningful.
 *
 * Returns { merged, added } — `added` is the subset that is genuinely new
 * this run (used to decide which Chat cards to post).
 */
export function mergeSuggestions(
  existing: Suggestion[],
  fresh: Suggestion[],
  dismissedIds: string[] = [],
  appliedIds: string[] = [],
): { merged: Suggestion[]; added: Suggestion[] } {
  const dismissed = new Set(dismissedIds);
  const applied = new Set(appliedIds);
  const byId = new Map<string, Suggestion>();
  for (const s of existing) {
    if (dismissed.has(s.id) || applied.has(s.id)) continue;
    byId.set(s.id, s);
  }
  const added: Suggestion[] = [];
  for (const s of fresh) {
    if (dismissed.has(s.id) || applied.has(s.id)) continue;
    if (byId.has(s.id)) {
      // Refresh weight/count/reason but keep the original createdAt.
      const prev = byId.get(s.id)!;
      byId.set(s.id, { ...s, createdAt: prev.createdAt });
    } else {
      byId.set(s.id, s);
      added.push(s);
    }
  }
  return { merged: Array.from(byId.values()), added };
}
