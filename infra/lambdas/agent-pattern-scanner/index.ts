/**
 * Agent Pattern Scanner Lambda
 *
 * Weekly Organizational Nervous System scan. Runs Sunday evening.
 *
 * Reads from psd-agent-signals DynamoDB and detects cross-building topic
 * convergence. Writes results to agent_patterns in Aurora for the admin
 * dashboard Patterns tab.
 *
 * Privacy contract (CRITICAL — see issue #890):
 *   - Reads ONLY: {building, weekTopic, topic, week, count}
 *   - Writes ONLY: aggregated counts + topic + list of building names
 *   - Never stores user identity, message text, or message IDs.
 *   - Suppresses patterns below threshold (3 signals / 2 buildings) to
 *     avoid proxying individual users in low-traffic weeks.
 *
 * Env vars:
 *   SIGNALS_TABLE         — DynamoDB signal store
 *   DATABASE_HOST         — Aurora host
 *   DATABASE_SECRET_ARN   — Aurora credentials secret
 *   DATABASE_NAME         — Aurora database (default aistudio)
 *   DATABASE_PORT         — default 5432
 *   MIN_SIGNALS           — suppression threshold, default 3
 *   MIN_BUILDINGS         — suppression threshold, default 2
 *   SPIKE_RATIO           — current / rolling-avg multiplier for spike flag, default 2.0
 *   ROLLING_WEEKS         — weeks in rolling-average window, default 4
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import postgres from 'postgres';

/**
 * ISO 8601 week utilities.
 *
 * NOTE: These implementations are duplicated in agent-router/topic-classifier.ts
 * and shared/iso-week.ts. Each Lambda has an isolated Docker build context that
 * prevents cross-directory imports. The canonical source of truth is
 * infra/lambdas/shared/iso-week.ts — keep all copies in sync.
 */
function isoWeek(date: Date = new Date()): string {
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

function priorWeek(week: string, stepsBack: number): string {
  const [y, w] = week.split('-W').map(Number);
  const base = new Date(Date.UTC(y, 0, 4));
  const baseDayNr = (base.getUTCDay() + 6) % 7;
  const weekStart = new Date(base);
  weekStart.setUTCDate(base.getUTCDate() - baseDayNr + (w - 1) * 7);
  weekStart.setUTCDate(weekStart.getUTCDate() - stepsBack * 7);
  return isoWeek(weekStart);
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});

const SIGNALS_TABLE = process.env.SIGNALS_TABLE || '';
const DATABASE_HOST = process.env.DATABASE_HOST || '';
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || '';
const DATABASE_NAME = process.env.DATABASE_NAME || 'aistudio';
const DATABASE_PORT = parseInt(process.env.DATABASE_PORT || '5432', 10);
const MIN_SIGNALS = parseInt(process.env.MIN_SIGNALS || '3', 10);
const MIN_BUILDINGS = parseInt(process.env.MIN_BUILDINGS || '2', 10);
const SPIKE_RATIO = parseFloat(process.env.SPIKE_RATIO || '2.0');
const ROLLING_WEEKS = parseInt(process.env.ROLLING_WEEKS || '4', 10);

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, meta: Record<string, unknown> = {}) {
  const stream = level === 'ERROR' ? process.stderr : process.stdout;
  stream.write(
    JSON.stringify({ level, message, service: 'agent-pattern-scanner', timestamp: new Date().toISOString(), ...meta }) + '\n'
  );
}

interface SignalItem {
  building: string;
  weekTopic: string;
  week: string;
  topic: string;
  count: number;
}

async function scanAllSignals(): Promise<SignalItem[]> {
  const items: SignalItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await dynamo.send(
      new ScanCommand({
        TableName: SIGNALS_TABLE,
        ExclusiveStartKey: lastKey,
      })
    );
    for (const item of res.Items ?? []) {
      if (item.building && item.weekTopic && item.topic && item.week) {
        items.push({
          building: String(item.building),
          weekTopic: String(item.weekTopic),
          week: String(item.week),
          topic: String(item.topic),
          count: Number(item.count ?? 0),
        });
      }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

let sqlClient: postgres.Sql | null = null;
async function getSql(): Promise<postgres.Sql> {
  if (sqlClient) return sqlClient;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: DATABASE_SECRET_ARN }));
  if (!res.SecretString) throw new Error('Database secret missing SecretString');
  const creds = JSON.parse(res.SecretString) as { username: string; password: string };
  sqlClient = postgres({
    host: DATABASE_HOST,
    port: DATABASE_PORT,
    database: DATABASE_NAME,
    username: creds.username,
    password: creds.password,
    ssl: 'require',
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return sqlClient;
}

interface ScanEvent {
  /** ISO 8601 week (e.g. "2026-W18") to scan. Defaults to current week. */
  week?: string;
  /** When true, scan the last N weeks (1..52). Useful for first-time backfill. */
  backfillWeeks?: number;
}

export const handler = async (
  event?: ScanEvent,
): Promise<{ detected: number; weeks: string[] }> => {
  if (!SIGNALS_TABLE || !DATABASE_HOST || !DATABASE_SECRET_ARN) {
    log('ERROR', 'Missing required environment variables');
    throw new Error('Pattern scanner misconfigured');
  }

  // Build the list of weeks to scan. Default = current. Manual invocations
  // can override with `{ week: "2026-W18" }` or backfill with
  // `{ backfillWeeks: 12 }` to populate the last 12 weeks at once.
  const today = new Date();
  const currentWeek = isoWeek(today);
  const weeksToScan: string[] = [];
  if (event?.week) {
    if (!/^\d{4}-W\d{2}$/.test(event.week)) {
      log('ERROR', 'Invalid week format', { week: event.week, expected: 'YYYY-WNN' });
      throw new Error(`Invalid week format: "${event.week}" — expected YYYY-WNN (e.g. "2026-W18")`);
    }
    // Validate week number is in range (W01–W53)
    const weekNum = parseInt(event.week.split('-W')[1], 10);
    if (weekNum < 1 || weekNum > 53) {
      log('ERROR', 'Week number out of range', { week: event.week, weekNum });
      throw new Error(`Week number out of range: "${event.week}" — must be W01–W53`);
    }
    weeksToScan.push(event.week);
  } else if (event?.backfillWeeks && event.backfillWeeks > 0) {
    // n weeks total: currentWeek + (n-1) prior weeks
    const n = Math.min(Math.floor(event.backfillWeeks), 52);
    weeksToScan.push(currentWeek);
    for (let i = 1; i < n; i++) {
      weeksToScan.push(priorWeek(currentWeek, i));
    }
  } else {
    weeksToScan.push(currentWeek);
  }

  // Scan DynamoDB once and reuse the signal set across all weeks to avoid
  // O(N * table_size) reads during multi-week backfills.
  //
  // NOTE: This means historical weeks are evaluated against the *current*
  // signal set rather than the set that existed at that time. This is
  // intentional — backfills populate the dashboard "last scan ran" banner
  // rather than reconstructing exact historical pattern detection.
  const signals = await scanAllSignals();
  log('INFO', 'Scanned signals for backfill', { total: signals.length, weeks: weeksToScan.length });

  let totalDetected = 0;
  const failedWeeks: string[] = [];
  for (const targetWeek of weeksToScan) {
    try {
      totalDetected += await scanForWeek(targetWeek, signals);
    } catch (err) {
      // Log but continue — a single week's failure should not abort the
      // entire backfill. The skipped week will have no scan-run marker,
      // making it retryable via `{ week: "YYYY-WNN" }`.
      log('ERROR', 'scanForWeek failed, continuing with remaining weeks', {
        week: targetWeek,
        error: err instanceof Error ? err.message : String(err),
      });
      failedWeeks.push(targetWeek);
    }
  }
  if (failedWeeks.length > 0) {
    log('WARN', 'Backfill completed with partial failures', {
      failedWeeks,
      succeeded: weeksToScan.length - failedWeeks.length,
    });
  }
  return { detected: totalDetected, weeks: weeksToScan };
};

async function scanForWeek(currentWeek: string, prefetchedSignals?: SignalItem[]): Promise<number> {
  const rollingWeeks = new Set<string>();
  for (let i = 1; i <= ROLLING_WEEKS; i++) {
    rollingWeeks.add(priorWeek(currentWeek, i));
  }

  const signals = prefetchedSignals ?? await scanAllSignals();
  log('INFO', 'Processing signals', {
    total: signals.length,
    currentWeek,
    rollingWeeks: Array.from(rollingWeeks),
    prefetched: !!prefetchedSignals,
  });

  // Aggregate: topic → { currentCount, buildings: Set, priorCounts: number[] }
  interface Agg {
    currentCount: number;
    buildings: Set<string>;
    priorTotals: Map<string, number>;
  }
  const byTopic = new Map<string, Agg>();
  // Count signals that are relevant to this week (current or rolling window)
  // rather than using the total DynamoDB signal count which includes all weeks.
  let weekRelevantSignals = 0;
  for (const s of signals) {
    if (s.week !== currentWeek && !rollingWeeks.has(s.week)) continue;
    weekRelevantSignals++;
    let agg = byTopic.get(s.topic);
    if (!agg) {
      agg = { currentCount: 0, buildings: new Set(), priorTotals: new Map() };
      byTopic.set(s.topic, agg);
    }
    if (s.week === currentWeek) {
      agg.currentCount += s.count;
      agg.buildings.add(s.building);
    } else if (rollingWeeks.has(s.week)) {
      agg.priorTotals.set(s.week, (agg.priorTotals.get(s.week) ?? 0) + s.count);
    }
  }

  const sql = await getSql();
  let detected = 0;
  let suppressed = 0;

  for (const [topic, agg] of byTopic.entries()) {
    // Suppression: below thresholds → skip entirely. Do NOT write anything,
    // not even "topic below threshold". Dashboard users should never see
    // low-count signals that could proxy individual users.
    if (agg.currentCount < MIN_SIGNALS || agg.buildings.size < MIN_BUILDINGS) {
      suppressed += 1;
      continue;
    }

    const priorValues = Array.from(agg.priorTotals.values());
    const rollingAvg =
      priorValues.length > 0
        ? priorValues.reduce((a, b) => a + b, 0) / ROLLING_WEEKS
        : 0;
    const isEmerging = rollingAvg === 0;
    const spikeRatio = rollingAvg > 0 ? agg.currentCount / rollingAvg : 0;
    const isSpike = isEmerging || spikeRatio >= SPIKE_RATIO;

    if (!isSpike) {
      continue;
    }

    const buildings = Array.from(agg.buildings).sort().join(',');
    await sql`
      INSERT INTO agent_patterns
        (week, topic, signal_count, building_count, rolling_avg, spike_ratio, is_emerging, buildings)
      VALUES
        (${currentWeek}, ${topic}, ${agg.currentCount}, ${agg.buildings.size},
         ${rollingAvg}, ${spikeRatio}, ${isEmerging}, ${buildings})
      ON CONFLICT (week, topic) DO UPDATE SET
        signal_count = EXCLUDED.signal_count,
        building_count = EXCLUDED.building_count,
        rolling_avg = EXCLUDED.rolling_avg,
        spike_ratio = EXCLUDED.spike_ratio,
        is_emerging = EXCLUDED.is_emerging,
        buildings = EXCLUDED.buildings,
        detected_at = NOW()
    `;
    detected += 1;
  }

  // Record an explicit "scan run" marker so admins can tell the difference
  // between "scanner never ran" (table empty + no marker) and "scanner ran
  // but suppression thresholds filtered everything" (table empty + marker).
  // Best-effort — failure of the marker write must not fail the scan.
  try {
    await sql`
      INSERT INTO agent_pattern_scan_runs
        (run_at, week, signals_total, topics_total, detected, suppressed)
      VALUES (NOW(), ${currentWeek}, ${weekRelevantSignals}, ${byTopic.size}, ${detected},
              ${suppressed})
    `;
  } catch (err) {
    log('WARN', 'Failed to record scan_runs marker', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log('INFO', 'Pattern scan complete', {
    detected,
    currentWeek,
    signalsRelevant: weekRelevantSignals,
    signalsTotalPrefetched: signals.length,
    topicsTotal: byTopic.size,
    suppressed,
  });
  return detected;
}
