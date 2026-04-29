/**
 * ISO 8601 week utilities shared across Lambda functions.
 *
 * Single source of truth for ISO week calculation. Used by:
 *   - agent-router/topic-classifier.ts
 *   - agent-pattern-scanner/index.ts
 *
 * ISO weeks are Monday-based and defined by the week containing
 * the year's first Thursday.
 */

/**
 * ISO 8601 week identifier (e.g., "2026-W17"). Monday-based weeks.
 */
export function isoWeek(date: Date = new Date()): string {
  // Shift to Thursday of the current week — ISO weeks are defined by the
  // week containing the first Thursday of the year.
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const weekNr =
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7
    );
  return `${target.getUTCFullYear()}-W${String(weekNr).padStart(2, '0')}`;
}

/**
 * Calculate the ISO week string N weeks before the given week.
 */
export function priorWeek(week: string, stepsBack: number): string {
  const [y, w] = week.split('-W').map(Number);
  const base = new Date(Date.UTC(y, 0, 4));
  const baseDayNr = (base.getUTCDay() + 6) % 7;
  const weekStart = new Date(base);
  weekStart.setUTCDate(base.getUTCDate() - baseDayNr + (w - 1) * 7);
  weekStart.setUTCDate(weekStart.getUTCDate() - stepsBack * 7);
  return isoWeek(weekStart);
}
