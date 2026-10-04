/**
 * Digest window arithmetic (#1855 addendum 1).
 *
 * The digest used to count `recentDecisions`, which the classifier trims
 * to 20 entries — so every digest said "20 messages sorted in the last
 * 24h" regardless of the real number. The classifier now keeps per-day
 * counters (`dailyStats`, written by agent-triage-poll/daily-stats.ts);
 * this module turns "since the last digest, in the user's timezone" into
 * the set of day keys to total.
 *
 * Deliberately standalone: this Lambda is bundled from its own directory,
 * so it cannot import the poll Lambda's copy. Keep the two `dayKey`
 * implementations behaviourally identical.
 */

export interface DailyStat {
  total: number;
  important: number;
  later: number;
  news: number;
  rule: number;
  llm: number;
  corrections: number;
}

export const EMPTY_DAILY_STAT: Readonly<DailyStat> = Object.freeze({
  total: 0,
  important: 0,
  later: 0,
  news: 0,
  rule: 0,
  llm: 0,
  corrections: 0,
});

/** Longest window a single digest will report, in days. */
export const MAX_DIGEST_WINDOW_DAYS = 14;

/** Calendar day of an instant in `timeZone`, as `YYYY-MM-DD`. */
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

function shiftDayKey(key: string, days: number): string {
  const shifted = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(shifted.getTime())) return key;
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The day keys this digest covers: from the day after the last digest
 * through today, in the user's timezone. With no previous digest — a new
 * user, or the first run after this change — it reports today and
 * yesterday, which is what an 08:00 digest means by "since you last
 * looked".
 *
 * A long gap (the user was away, the schedule was paused) is clamped to
 * the most recent MAX_DIGEST_WINDOW_DAYS so one catch-up digest cannot
 * claim a quarter's worth of mail arrived overnight — but it still
 * reports that full clamped window, not the 2-day first-run default.
 */
export function digestWindowKeys(
  nowIso: string,
  lastDigestAt: string | undefined,
  timeZone: string | undefined,
): string[] {
  const today = dayKey(nowIso, timeZone);
  if (!today) return [];
  const lastKey = lastDigestAt ? dayKey(lastDigestAt, timeZone) : "";
  const earliest = shiftDayKey(today, -(MAX_DIGEST_WINDOW_DAYS - 1));
  // Re-count the day of the last digest: a digest at 08:00 leaves the
  // rest of that day uncounted, and the alternative drops it entirely.
  let cursor: string;
  if (!lastKey) cursor = shiftDayKey(today, -1);
  else cursor = lastKey > earliest ? lastKey : earliest;
  if (cursor > today) cursor = today;
  const keys: string[] = [];
  while (cursor <= today && keys.length < MAX_DIGEST_WINDOW_DAYS) {
    keys.push(cursor);
    cursor = shiftDayKey(cursor, 1);
  }
  return keys;
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

/** "the last 24h", "since Tue", … for the card subtitle. */
export function describeWindow(keys: string[]): string {
  if (keys.length <= 1) return "today";
  if (keys.length === 2) return "since yesterday";
  return `over the last ${keys.length} days`;
}
