/**
 * Daily activity series helpers for the Atrium usage dashboard.
 *
 * The database returns one row per day that HAD activity; the dashboard wants a
 * contiguous window ending today so quiet days read as zero rather than
 * vanishing. Pure, so the window arithmetic is unit-testable.
 */

export interface DailyActivityPoint {
  /** Calendar day as `YYYY-MM-DD` (UTC). */
  day: string;
  created: number;
  updated: number;
  published: number;
}

/** `YYYY-MM-DD` (UTC) for a Date. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A contiguous `days`-long window ending on `today` (UTC), with the given
 * points placed on their days and zeros everywhere else. Points outside the
 * window are dropped; duplicate days are summed (defensive — the query groups
 * by day, so it should never happen).
 */
export function fillDailySeries(
  points: DailyActivityPoint[],
  days: number,
  today: Date = new Date()
): DailyActivityPoint[] {
  const span = Math.max(1, Math.floor(days));
  const byDay = new Map<string, DailyActivityPoint>();
  for (const point of points) {
    const existing = byDay.get(point.day);
    if (existing) {
      existing.created += point.created;
      existing.updated += point.updated;
      existing.published += point.published;
    } else {
      byDay.set(point.day, { ...point });
    }
  }
  const out: DailyActivityPoint[] = [];
  const end = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate()
  );
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const day = dayKey(new Date(end - offset * 86_400_000));
    const point = byDay.get(day);
    out.push(
      point
        ? { day, created: point.created, updated: point.updated, published: point.published }
        : { day, created: 0, updated: 0, published: 0 }
    );
  }
  return out;
}
