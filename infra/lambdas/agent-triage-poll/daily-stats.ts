/**
 * Per-day triage counters (#1855 addendum 1).
 *
 * WHY: the daily digest used to count `recentDecisions`, a rolling buffer
 * trimmed to 20 entries. Every digest therefore reported "20 messages
 * sorted in the last 24h" whether the real number was 3 or 300 — a capped
 * buffer cannot express a daily total. These counters are written as the
 * classifier goes, so the digest reports what actually happened.
 *
 * Pure and dependency-free; `storage.ts` persists what these return.
 */

import type { DailyStat, DecisionRecord, CorrectionRecord } from "./types";

/** Days of history kept on the row. Bounds the attribute's size. */
export const DAILY_STATS_RETENTION_DAYS = 45;

export const EMPTY_DAILY_STAT: Readonly<DailyStat> = Object.freeze({
  total: 0,
  important: 0,
  later: 0,
  news: 0,
  rule: 0,
  llm: 0,
  corrections: 0,
});

/**
 * Calendar day of an instant in the user's timezone, as `YYYY-MM-DD`.
 *
 * The timezone matters: a digest at 08:00 Pacific must count the mail the
 * user received yesterday evening Pacific, not yesterday evening UTC.
 * Falls back to UTC when the stored timezone is missing or unrecognised,
 * which is wrong by a few hours rather than throwing inside the poll.
 */
export function dayKey(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
    } catch {
      // Unknown IANA zone — fall through to UTC.
    }
  }
  return date.toISOString().slice(0, 10);
}

/** Shift a `YYYY-MM-DD` key by whole days. */
export function shiftDayKey(key: string, days: number): string {
  const shifted = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(shifted.getTime())) return key;
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function addDecision(stat: DailyStat, decision: DecisionRecord): void {
  stat.total += 1;
  if (decision.label === "important") stat.important += 1;
  else if (decision.label === "news") stat.news += 1;
  else stat.later += 1;
  // `content` decisions are deterministic like a rule and cost no model
  // call, so they count on the rule side of the rule-vs-model split.
  if (decision.source === "llm") stat.llm += 1;
  else stat.rule += 1;
}

/**
 * Fold a tick's decisions and corrections into the stored counters,
 * dropping days past the retention window. Returns a new object — the
 * caller writes it back whole.
 */
export function accumulateDailyStats(
  existing: Record<string, DailyStat> | undefined,
  decisions: DecisionRecord[],
  corrections: CorrectionRecord[],
  timeZone: string | undefined,
  now: Date = new Date(),
): Record<string, DailyStat> {
  const next: Record<string, DailyStat> = {};
  const cutoff = shiftDayKey(
    dayKey(now.toISOString(), timeZone),
    -DAILY_STATS_RETENTION_DAYS,
  );
  for (const [key, stat] of Object.entries(existing ?? {})) {
    if (key >= cutoff) next[key] = { ...EMPTY_DAILY_STAT, ...stat };
  }

  const bucket = (ts: string): DailyStat | null => {
    const key = dayKey(ts, timeZone);
    if (!key) return null;
    if (!next[key]) next[key] = { ...EMPTY_DAILY_STAT };
    return next[key];
  };

  for (const decision of decisions) {
    const stat = bucket(decision.ts);
    if (stat) addDecision(stat, decision);
  }
  for (const correction of corrections) {
    const stat = bucket(correction.ts);
    if (stat) stat.corrections += 1;
  }
  return next;
}

/** Total the counters across a set of day keys. */
export function sumDailyStats(
  stats: Record<string, DailyStat> | undefined,
  keys: string[],
): DailyStat {
  const total: DailyStat = { ...EMPTY_DAILY_STAT };
  for (const key of keys) {
    const stat = stats?.[key];
    if (!stat) continue;
    total.total += stat.total ?? 0;
    total.important += stat.important ?? 0;
    total.later += stat.later ?? 0;
    total.news += stat.news ?? 0;
    total.rule += stat.rule ?? 0;
    total.llm += stat.llm ?? 0;
    total.corrections += stat.corrections ?? 0;
  }
  return total;
}
