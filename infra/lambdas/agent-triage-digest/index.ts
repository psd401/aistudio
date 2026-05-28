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
} from "@aws-sdk/lib-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import * as chatPkg from "@googleapis/chat";

interface DigestEvent {
  userEmail: string;
}

interface DecisionRecord {
  messageId: string;
  threadId: string;
  label: "important" | "later" | "news";
  source: "rule" | "llm";
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
  // eslint-disable-next-line no-console
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

export const handler: Handler<DigestEvent, void> = async (event) => {
  const userEmail = event?.userEmail;
  if (!userEmail) {
    log("ERROR", "missing_user", { event });
    return;
  }

  const row = await ddb.send(
    new GetCommand({ TableName: TRIAGE_TABLE, Key: { userEmail } }),
  );
  const triage = row.Item as TriageRow | undefined;
  if (!triage || !triage.enabled) {
    log("INFO", "skip_disabled", { user: userEmail });
    return;
  }
  if (!triage.dmSpaceName) {
    // The enable flow doesn't populate dmSpaceName; it gets backfilled
    // on the first escalation or task gesture in the poll Lambda.
    // If it's still missing here, the user hasn't had an escalation
    // yet. Skip digest rather than fail — next poll escalation will
    // backfill the DM space and future digests will work.
    log("WARN", "no_dm_space_skipping_digest", { user: userEmail });
    return;
  }
  if (triage.digestEnabled === false) {
    log("INFO", "skip_digest_off", { user: userEmail });
    return;
  }

  // Last 24h of decisions.
  const since = Date.now() - 24 * 60 * 60_000;
  const recent = (triage.recentDecisions ?? []).filter((d) => {
    const t = Date.parse(d.ts);
    return Number.isFinite(t) && t >= since;
  });

  const buckets: Record<string, DecisionRecord[]> = {
    important: [],
    later: [],
    news: [],
  };
  for (const d of recent) {
    if (buckets[d.label]) buckets[d.label].push(d);
  }

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

  const sections = [
    {
      header: `${labels.important} · ${buckets.important.length}`,
      widgets: buildSectionWidgets(buckets.important, 5),
    },
    {
      header: `${labels.later} · ${buckets.later.length}`,
      widgets: buildSectionWidgets(buckets.later, 3),
    },
    {
      header: `${labels.news} · ${buckets.news.length}`,
      widgets: buildSectionWidgets(buckets.news, 3),
    },
  ];

  const card = {
    header: {
      title: `📬 Triage digest · ${dateStr}`,
      subtitle: `${recent.length} message${recent.length === 1 ? "" : "s"} sorted in the last 24h`,
    },
    sections,
  };

  const client = await getChatClient();
  const requestBody: Record<string, unknown> = {
    text: `Triage digest · ${recent.length} sorted in the last 24h`,
    cardsV2: [{ cardId: `triage-digest-${Date.now()}`, card }],
  };
  try {
    await client.spaces.messages.create({
      parent: triage.dmSpaceName,
      requestBody: requestBody as never,
    });
    log("INFO", "digest_posted", {
      user: userEmail,
      counts: {
        important: buckets.important.length,
        later: buckets.later.length,
        news: buckets.news.length,
      },
    });
  } catch (err) {
    log("ERROR", "post_failed", {
      user: userEmail,
      err: err instanceof Error ? err.message : String(err),
    });
  }
};

function buildSectionWidgets(decisions: DecisionRecord[], max: number): unknown[] {
  if (decisions.length === 0) {
    return [{ textParagraph: { text: "_(none)_" } }];
  }
  const slice = decisions.slice(-max).reverse();
  const widgets: unknown[] = slice.map((d) => ({
    decoratedText: {
      topLabel: d.fromEmail,
      text: d.subject || "(no subject)",
      bottomLabel: `${d.source} · ${d.reason}`,
    },
  }));
  if (decisions.length > max) {
    widgets.push({
      textParagraph: {
        text: `_…and ${decisions.length - max} more_`,
      },
    });
  }
  return widgets;
}
