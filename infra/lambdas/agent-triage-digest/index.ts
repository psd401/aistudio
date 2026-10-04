/**
 * Daily Email Triage Digest Lambda
 *
 * Invoked per-user via EventBridge Scheduler at the user's configured
 * `digestTime` (in their timezone). Reads the last 24 hours of
 * `recentDecisions` from the triage DDB row and posts a card to the
 * user's Chat DM summarising what got filed.
 *
 * Cheap and templated — no LLM call. Failure does NOT cascade; if the
 * Chat post fails we just log and exit, the next day's run picks up.
 *
 * Event shape (from the skill's upsertDigestSchedule):
 *   { "userEmail": "hagelk@psd401.net" }
 */

import type { Handler } from "aws-lambda";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import * as chatPkg from "@googleapis/chat";

import {
  type DailyStat,
  describeWindow,
  digestWindowKeys,
  sumDailyStats,
} from "./digest-window";

interface DigestEvent {
  userEmail: string;
}

interface DecisionRecord {
  messageId: string;
  threadId: string;
  label: "important" | "later" | "news";
  source: "rule" | "content" | "llm";
  reason: string;
  confidence: number;
  ts: string;
  fromEmail: string;
  subject: string;
}

interface TriageRow {
  userEmail: string;
  enabled: boolean;
  dmSpaceName?: string;
  labels?: Record<string, string>;
  recentDecisions?: DecisionRecord[];
  digestEnabled?: boolean;
  digestTz?: string;
  /** Per-day counters written by the classifier — the real totals. */
  dailyStats?: Record<string, DailyStat>;
  /** When the previous digest went out; bounds this one's window. */
  lastDigestAt?: string;
}

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TRIAGE_TABLE = process.env.TRIAGE_TABLE ?? "";
const GOOGLE_CREDENTIALS_SECRET_ARN =
  process.env.GOOGLE_CREDENTIALS_SECRET_ARN ?? "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sm = new SecretsManagerClient({ region: REGION });

let cachedClient: ReturnType<typeof chatPkg.chat> | null = null;
let cachedCredsAt = 0;

async function getChatClient(): Promise<ReturnType<typeof chatPkg.chat>> {
  if (cachedClient && Date.now() - cachedCredsAt < 10 * 60_000) {
    return cachedClient;
  }
  const resp = await sm.send(
    new GetSecretValueCommand({ SecretId: GOOGLE_CREDENTIALS_SECRET_ARN }),
  );
  if (!resp.SecretString) throw new Error("Chat credentials secret empty");
  const credentials = JSON.parse(resp.SecretString);
  const auth = new chatPkg.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/chat.bot"],
  });
  cachedClient = chatPkg.chat({ version: "v1", auth });
  cachedCredsAt = Date.now();
  return cachedClient;
}

function log(level: "INFO" | "WARN" | "ERROR", evt: string, fields: Record<string, unknown>) {

  console.log(
    JSON.stringify({
      level,
      logger: "triage-digest",
      evt,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
}

/**
 * Load the row and apply every reason to skip this user. Returns null
 * when the digest should not go out; each case logs its own reason.
 */
async function loadDigestTarget(
  userEmail: string,
): Promise<TriageRow | null> {
  const row = await ddb.send(
    new GetCommand({ TableName: TRIAGE_TABLE, Key: { userEmail } }),
  );
  const triage = row.Item as TriageRow | undefined;
  if (!triage || !triage.enabled) {
    log("INFO", "skip_disabled", { user: userEmail });
    return null;
  }
  if (!triage.dmSpaceName) {
    // The enable flow doesn't populate dmSpaceName; it gets backfilled
    // on the first escalation or task gesture in the poll Lambda.
    // If it's still missing here, the user hasn't had an escalation
    // yet. Skip digest rather than fail — next poll escalation will
    // backfill the DM space and future digests will work.
    log("WARN", "no_dm_space_skipping_digest", { user: userEmail });
    return null;
  }
  if (triage.digestEnabled === false) {
    log("INFO", "skip_digest_off", { user: userEmail });
    return null;
  }
  return triage;
}

/**
 * Group the rolling-buffer EXAMPLES by label, dropping anything older
 * than the window. These are samples to show, never the counts.
 */
function bucketExamples(
  decisions: DecisionRecord[],
  windowKeys: string[],
): Record<string, DecisionRecord[]> {
  const firstKey = windowKeys[0];
  const windowStart = firstKey ? Date.parse(`${firstKey}T00:00:00Z`) : NaN;
  const buckets: Record<string, DecisionRecord[]> = {
    important: [],
    later: [],
    news: [],
  };
  for (const d of decisions) {
    const t = Date.parse(d.ts);
    if (!Number.isFinite(t)) continue;
    if (Number.isFinite(windowStart) && t < windowStart) continue;
    if (buckets[d.label]) buckets[d.label].push(d);
  }
  return buckets;
}

export const handler: Handler<DigestEvent, void> = async (event) => {
  const userEmail = event?.userEmail;
  if (!userEmail) {
    log("ERROR", "missing_user", { event });
    return;
  }

  const triage = await loadDigestTarget(userEmail);
  if (!triage) return;

  // Real totals come from the per-day counters. `recentDecisions` is a
  // 20-entry rolling buffer, so it can only ever supply EXAMPLES — using
  // it for the count is the #1855 bug where every digest said "20".
  const nowIso = new Date().toISOString();
  const windowKeys = digestWindowKeys(
    nowIso,
    triage.lastDigestAt,
    triage.digestTz,
  );
  const totals = sumDailyStats(triage.dailyStats, windowKeys);
  const windowLabel = describeWindow(windowKeys);
  const buckets = bucketExamples(triage.recentDecisions ?? [], windowKeys);

  const labels = triage.labels ?? {
    important: "@psd/Important",
    later: "@psd/Later",
    news: "@psd/News",
  };

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const sections = buildSections(labels, buckets, totals, windowLabel);

  const headline =
    `${totals.total} message${totals.total === 1 ? "" : "s"} sorted ${windowLabel}`;
  const card = {
    header: {
      title: `📬 Triage digest · ${dateStr}`,
      subtitle: headline,
    },
    sections,
  };

  const client = await getChatClient();
  const requestBody: Record<string, unknown> = {
    text: `Triage digest · ${headline}`,
    cardsV2: [{ cardId: `triage-digest-${Date.now()}`, card }],
  };
  try {
    await client.spaces.messages.create({
      parent: triage.dmSpaceName,
      requestBody,
    });
    log("INFO", "digest_posted", {
      user: userEmail,
      window: windowKeys,
      counts: totals,
    });
  } catch (err) {
    log("ERROR", "post_failed", {
      user: userEmail,
      err: err instanceof Error ? err.message : String(err),
    });
    // Leave `lastDigestAt` alone so the next run re-reports this window
    // rather than silently dropping it.
    return;
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TRIAGE_TABLE,
        Key: { userEmail },
        UpdateExpression: "SET lastDigestAt = :at",
        ExpressionAttributeValues: { ":at": nowIso },
      }),
    );
  } catch (err) {
    // A missed stamp only widens tomorrow's window; never fail the run.
    log("WARN", "digest_stamp_failed", {
      user: userEmail,
      err: err instanceof Error ? err.message : String(err),
    });
  }
};

interface CardSection {
  header: string;
  widgets: unknown[];
}

/**
 * One section per label, plus a corrections section when the user moved
 * anything. Headers carry the real per-label totals; the widgets inside
 * are a sample drawn from the rolling buffer.
 */
function buildSections(
  labels: Record<string, string>,
  buckets: Record<string, DecisionRecord[]>,
  totals: DailyStat,
  windowLabel: string,
): CardSection[] {
  const sections: CardSection[] = [
    {
      header: `${labels.important} · ${totals.important}`,
      widgets: buildSectionWidgets(buckets.important, 5, totals.important),
    },
    {
      header: `${labels.later} · ${totals.later}`,
      widgets: buildSectionWidgets(buckets.later, 3, totals.later),
    },
    {
      header: `${labels.news} · ${totals.news}`,
      widgets: buildSectionWidgets(buckets.news, 3, totals.news),
    },
  ];
  if (totals.corrections > 0) {
    sections.push({
      header: `Your corrections · ${totals.corrections}`,
      widgets: [
        {
          textParagraph: {
            text:
              `You moved ${totals.corrections} message(s) ${windowLabel}. ` +
              `Those are being learned from.`,
          },
        },
      ],
    });
  }
  return sections;
}

/**
 * `examples` comes from the 20-entry rolling buffer, so it is a sample.
 * `total` is the real count for the window and is what the "and N more"
 * line must be computed from — otherwise the card contradicts its own
 * header.
 */
function buildSectionWidgets(
  examples: DecisionRecord[],
  max: number,
  total: number,
): unknown[] {
  if (total === 0) {
    return [{ textParagraph: { text: "_(none)_" } }];
  }
  const slice = examples.slice(-max).reverse();
  const widgets: unknown[] = slice.map((d) => ({
    decoratedText: {
      topLabel: d.fromEmail,
      text: d.subject || "(no subject)",
      bottomLabel: `${d.source} · ${d.reason}`,
    },
  }));
  const remaining = total - slice.length;
  if (remaining > 0) {
    widgets.push({
      textParagraph: {
        text: `_…and ${remaining} more_`,
      },
    });
  }
  return widgets;
}
