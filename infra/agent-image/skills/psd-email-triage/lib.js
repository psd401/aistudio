/**
 * Shared helpers for the psd-email-triage skill.
 *
 * Three concerns bundled here for simplicity:
 *   - DynamoDB I/O on the psd-agent-triage-<env> table
 *   - Gmail label management via the psd-workspace common.js token helper
 *     (we reuse, not duplicate, the per-user OAuth refresh)
 *   - EventBridge Scheduler entries for the daily digest
 *
 * Kept in one file because the skill is small and the boundaries are
 * straightforward. If this grows past ~600 lines, split.
 *
 * Rules engine is a port of infra/lambdas/agent-triage-poll/rules.ts —
 * keep behaviour-equivalent so the skill's `simulate` subcommand matches
 * what the classifier Lambda would actually do.
 */

'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
} = require('@aws-sdk/client-scheduler');

// Reuse the per-user OAuth machinery from psd-workspace. Absolute
// require path matches the pattern psd-data uses — avoids duplicating
// refresh-token + Secrets Manager code in every skill.
const WS = require('/opt/psd-skills/psd-workspace/common.js');

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const TRIAGE_TABLE = process.env.TRIAGE_TABLE || `psd-agent-triage-${ENVIRONMENT}`;
const SCHEDULER_GROUP = process.env.EVENTBRIDGE_SCHEDULE_GROUP || `psd-agent-${ENVIRONMENT}`;
const SCHEDULER_INVOKE_ROLE_ARN = process.env.EVENTBRIDGE_ROLE_ARN || '';
const TRIAGE_DIGEST_LAMBDA_ARN =
  process.env.TRIAGE_DIGEST_LAMBDA_ARN ||
  `arn:aws:lambda:${REGION}:${process.env.AWS_ACCOUNT || ''}:function:psd-agent-triage-digest-${ENVIRONMENT}`;

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);
const scheduler = new SchedulerClient({ region: REGION });

// =====================================================================
// DynamoDB I/O
// =====================================================================

const DEFAULT_LABELS = {
  important: '@psd/Important',
  later: '@psd/Later',
  news: '@psd/News',
  // User-only gesture label. The classifier never assigns this — when
  // the user labels an email with @psd/Task, the polling Lambda detects
  // the labelsAdded event and (if tasksMode=invoke-agent) invokes
  // AgentCore to create a task per the user's MEMORY.md instructions.
  // See docs/operations/email-triage.md and Phase 1.5 design notes.
  task: '@psd/Task',
};

const DEFAULT_RULES = {
  vipSenders: [],
  muteSenders: [
    'noreply@*',
    'notifications@github.com',
    'jira-noreply@*',
  ],
  keywordRules: [
    { subject_contains: 'newsletter', label: 'news' },
    { subject_contains: 'urgent', external: true, label: 'later' },
  ],
};

const DEFAULT_ESCALATION = {
  senders: [],
  keywords: [],
  labelTriggers: ['important'],
};

async function getRow(userEmail) {
  const r = await ddb.send(
    new GetCommand({ TableName: TRIAGE_TABLE, Key: { userEmail } }),
  );
  return r.Item || null;
}

async function deleteRow(userEmail) {
  await ddb.send(
    new DeleteCommand({ TableName: TRIAGE_TABLE, Key: { userEmail } }),
  );
}

async function updateRow(userEmail, attrs) {
  // attrs is a flat object {name: value}; we build SET key = :v entries.
  // Strip the partition key if a caller accidentally includes it —
  // DDB rejects UpdateItem expressions that touch key attributes
  // (2026-05-21 incident: cmd_enable's newRow object included
  // userEmail and the whole enable flow failed). Belt-and-suspenders
  // with the cmd_enable comment.
  const names = {};
  const values = {};
  const sets = [];
  let i = 0;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'userEmail') continue;
    const ek = `#k${i}`;
    const ev = `:v${i}`;
    names[ek] = k;
    values[ev] = v;
    sets.push(`${ek} = ${ev}`);
    i++;
  }
  if (sets.length === 0) {
    // Nothing to set — bail rather than send a malformed UpdateExpression.
    return;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: TRIAGE_TABLE,
      Key: { userEmail },
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

// =====================================================================
// Gmail label management
// =====================================================================

let _cachedOAuthClient = null;
async function getOAuthClient() {
  if (_cachedOAuthClient) return _cachedOAuthClient;
  _cachedOAuthClient = await WS.getSecretJson(WS.GOOGLE_OAUTH_CLIENT_SECRET_ID);
  return _cachedOAuthClient;
}

async function getUserAccessToken(userEmail) {
  // Use the user_account slot — gmail.modify is in that scope set.
  const token = await WS.getUserWorkspaceToken(userEmail, 'user_account');
  if (!token) {
    const err = new Error('User has not consented to workspace access yet');
    err.code = 'needs-auth';
    throw err;
  }
  const client = await getOAuthClient();
  const refreshed = await WS.refreshAccessToken(
    token.refresh_token,
    client.client_id,
    client.client_secret,
  );
  return refreshed.access_token;
}

async function gmailFetch(accessToken, path, init = {}) {
  const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  return resp;
}

async function getCurrentHistoryId(accessToken) {
  const resp = await gmailFetch(accessToken, '/profile');
  if (!resp.ok) {
    throw new Error(`Gmail profile fetch failed: ${resp.status} ${await resp.text()}`);
  }
  const j = await resp.json();
  return j.historyId;
}

async function listLabels(accessToken) {
  const resp = await gmailFetch(accessToken, '/labels');
  if (!resp.ok) {
    throw new Error(`Gmail labels.list failed: ${resp.status} ${await resp.text()}`);
  }
  const j = await resp.json();
  return j.labels || [];
}

async function createLabel(accessToken, name) {
  const resp = await gmailFetch(accessToken, '/labels', {
    method: 'POST',
    body: JSON.stringify({
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }),
  });
  if (!resp.ok) {
    // 409 = already exists; find it and return.
    const existing = await listLabels(accessToken);
    const match = existing.find((l) => l.name === name);
    if (match) return match;
    throw new Error(`Gmail labels.create failed for "${name}": ${resp.status} ${await resp.text()}`);
  }
  return await resp.json();
}

async function renameLabel(accessToken, labelId, newName) {
  const resp = await gmailFetch(accessToken, `/labels/${labelId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: newName }),
  });
  if (!resp.ok) {
    throw new Error(`Gmail labels.patch failed: ${resp.status} ${await resp.text()}`);
  }
  return await resp.json();
}

async function deleteLabel(accessToken, labelId) {
  const resp = await gmailFetch(accessToken, `/labels/${labelId}`, { method: 'DELETE' });
  if (resp.status !== 204 && resp.status !== 404) {
    throw new Error(`Gmail labels.delete failed: ${resp.status} ${await resp.text()}`);
  }
}

async function modifyMessage(accessToken, messageId, addLabelIds, removeLabelIds = []) {
  const resp = await gmailFetch(accessToken, `/messages/${messageId}/modify`, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
  if (!resp.ok) {
    throw new Error(`Gmail messages.modify failed: ${resp.status} ${await resp.text()}`);
  }
}

/**
 * Ensure the 3 triage labels exist in Gmail; return a map of
 * { important: id, later: id, news: id } and the canonical name map.
 *
 * Idempotent — if the label already exists, we keep the existing one.
 */
async function ensureLabels(accessToken, labels) {
  const existing = await listLabels(accessToken);
  const byName = new Map(existing.map((l) => [l.name, l]));
  const ids = {};
  for (const [key, name] of Object.entries(labels)) {
    if (byName.has(name)) {
      ids[key] = byName.get(name).id;
    } else {
      const created = await createLabel(accessToken, name);
      ids[key] = created.id;
    }
  }
  return ids;
}

// =====================================================================
// EventBridge Scheduler — daily digest
// =====================================================================

function digestScheduleName(userEmail) {
  // Scheduler names are <= 64 chars; email local parts are usually short.
  // We slug + suffix to make it unique without collisions.
  const slug = userEmail.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 50);
  return `triage-digest-${slug}`;
}

function buildDigestCronExpr(timeHHMM, _tz) {
  // EventBridge Scheduler accepts a cron(min hour day-of-month month day-of-week year) expression with a TIMEZONE field set on the schedule itself.
  // We store the time in the user's tz and pass tz as a separate field so
  // Scheduler does the timezone math.
  const [hStr, mStr] = String(timeHHMM).split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`Invalid digest time "${timeHHMM}" — expected HH:MM 24-hour`);
  }
  // EventBridge cron: minutes hours day-of-month month day-of-week year
  return `cron(${m} ${h} * * ? *)`;
}

async function upsertDigestSchedule(userEmail, timeHHMM, tz) {
  if (!SCHEDULER_INVOKE_ROLE_ARN) {
    throw new Error('EVENTBRIDGE_ROLE_ARN env var not set — cannot create digest schedule');
  }
  const name = digestScheduleName(userEmail);
  const expr = buildDigestCronExpr(timeHHMM, tz);
  const input = {
    Name: name,
    GroupName: SCHEDULER_GROUP,
    ScheduleExpression: expr,
    ScheduleExpressionTimezone: tz || 'America/Los_Angeles',
    FlexibleTimeWindow: { Mode: 'OFF' },
    Target: {
      Arn: TRIAGE_DIGEST_LAMBDA_ARN,
      RoleArn: SCHEDULER_INVOKE_ROLE_ARN,
      Input: JSON.stringify({ userEmail }),
    },
    State: 'ENABLED',
  };
  // Try create; on conflict, update.
  try {
    await scheduler.send(new CreateScheduleCommand(input));
  } catch (err) {
    if (err && err.name === 'ConflictException') {
      await scheduler.send(new UpdateScheduleCommand(input));
    } else {
      throw err;
    }
  }
  return `arn:aws:scheduler:${REGION}:${process.env.AWS_ACCOUNT || '*'}:schedule/${SCHEDULER_GROUP}/${name}`;
}

async function deleteDigestSchedule(userEmail) {
  const name = digestScheduleName(userEmail);
  try {
    await scheduler.send(
      new DeleteScheduleCommand({ Name: name, GroupName: SCHEDULER_GROUP }),
    );
  } catch (err) {
    if (err && err.name === 'ResourceNotFoundException') return;
    throw err;
  }
}

// =====================================================================
// Rules engine — JS port of infra/lambdas/agent-triage-poll/rules.ts.
// Used only by the `simulate` subcommand; the real classifier path runs
// the TS version. Keep behaviour-equivalent.
// =====================================================================

function wildcardMatch(pattern, value) {
  if (!pattern || !value) return false;
  const p = String(pattern).toLowerCase();
  const v = String(value).toLowerCase();
  if (!p.includes('*')) return p === v;
  const escaped = p.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$').test(v);
}

function matchesKeywordRule(rule, features) {
  if (rule.external && features.isInternal) return false;
  if (rule.from_domain && features.fromDomain !== String(rule.from_domain).toLowerCase()) {
    return false;
  }
  if (
    rule.subject_contains &&
    !features.subjectLower.includes(String(rule.subject_contains).toLowerCase())
  ) {
    return false;
  }
  if (
    rule.snippet_contains &&
    !features.snippetLower.includes(String(rule.snippet_contains).toLowerCase())
  ) {
    return false;
  }
  return Boolean(rule.from_domain || rule.subject_contains || rule.snippet_contains);
}

function applyRules(features, rules) {
  if ((rules.vipSenders || []).includes(features.fromEmail)) {
    return { label: 'important', reason: `vip:${features.fromEmail}`, source: 'rule' };
  }
  for (const pattern of rules.muteSenders || []) {
    if (
      wildcardMatch(pattern, features.fromEmail) ||
      wildcardMatch(pattern, features.fromDomain)
    ) {
      return { label: 'later', reason: `mute:${pattern}`, source: 'rule' };
    }
  }
  if (features.hasUserReply) {
    return { label: 'important', reason: 'thread:user-replied-here', source: 'rule' };
  }
  for (const rule of rules.keywordRules || []) {
    if (matchesKeywordRule(rule, features)) {
      const desc = rule.subject_contains
        ? `subject~"${rule.subject_contains}"`
        : rule.snippet_contains
          ? `snippet~"${rule.snippet_contains}"`
          : rule.from_domain
            ? `from_domain=${rule.from_domain}`
            : 'rule';
      return { label: rule.label, reason: `keyword:${desc}`, source: 'rule' };
    }
  }
  return { decided: false, reason: 'no-rule-match' };
}

module.exports = {
  // constants
  DEFAULT_LABELS,
  DEFAULT_RULES,
  DEFAULT_ESCALATION,
  TRIAGE_TABLE,
  ENVIRONMENT,
  // ddb
  getRow,
  updateRow,
  deleteRow,
  // gmail
  getUserAccessToken,
  getCurrentHistoryId,
  ensureLabels,
  listLabels,
  createLabel,
  renameLabel,
  deleteLabel,
  modifyMessage,
  // scheduler
  upsertDigestSchedule,
  deleteDigestSchedule,
  // rules
  applyRules,
};
