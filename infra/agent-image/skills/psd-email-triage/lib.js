/**
 * Shared helpers for the psd-email-triage skill.
 *
 * Three concerns bundled here for simplicity:
 *   - Owner-bound state I/O through the trusted web broker
 *   - Gmail label management through that broker (tokens never enter this
 *     model-facing runtime)
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

const {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
} = require('@aws-sdk/client-scheduler');

const { requestAgentBroker } = require('../_shared/agent-broker');

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const TRIAGE_TABLE = process.env.TRIAGE_TABLE || `psd-agent-triage-${ENVIRONMENT}`;
const SCHEDULER_GROUP = process.env.EVENTBRIDGE_SCHEDULE_GROUP || `psd-agent-${ENVIRONMENT}`;
const SCHEDULER_INVOKE_ROLE_ARN = process.env.EVENTBRIDGE_ROLE_ARN || '';
const TRIAGE_DIGEST_LAMBDA_ARN =
  process.env.TRIAGE_DIGEST_LAMBDA_ARN ||
  `arn:aws:lambda:${REGION}:${process.env.AWS_ACCOUNT || ''}:function:psd-agent-triage-digest-${ENVIRONMENT}`;

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
  void userEmail;
  const response = await requestAgentBroker('/api/agent/email-triage', {
    operation: 'get-state',
  });
  return response.state || null;
}

async function deleteRow(userEmail) {
  void userEmail;
  await requestAgentBroker('/api/agent/email-triage', {
    operation: 'delete-state',
  });
}

async function updateRow(userEmail, attrs) {
  void userEmail;
  const safeAttrs = { ...attrs };
  delete safeAttrs.userEmail;
  if (Object.keys(safeAttrs).length === 0) return;
  await requestAgentBroker('/api/agent/email-triage', {
    operation: 'update-state',
    attrs: safeAttrs,
  });
}

// =====================================================================
// Gmail label management
// =====================================================================

async function getUserAccessToken(userEmail) {
  void userEmail;
  return 'owner-bound-broker';
}

async function getCurrentHistoryId(accessToken) {
  void accessToken;
  const response = await requestAgentBroker('/api/agent/email-triage', {
    operation: 'gmail-profile',
  });
  return response.result.historyId;
}

async function listLabels(accessToken) {
  void accessToken;
  const response = await requestAgentBroker('/api/agent/email-triage', {
    operation: 'list-labels',
  });
  return response.result.labels || [];
}

async function createLabel(accessToken, name) {
  void accessToken;
  const response = await requestAgentBroker('/api/agent/email-triage', {
    operation: 'create-label',
    name,
  });
  return response.result;
}

async function renameLabel(accessToken, labelId, newName) {
  void accessToken;
  const response = await requestAgentBroker('/api/agent/email-triage', {
    operation: 'rename-label',
    labelId,
    name: newName,
  });
  return response.result;
}

async function deleteLabel(accessToken, labelId) {
  void accessToken;
  await requestAgentBroker('/api/agent/email-triage', {
    operation: 'delete-label',
    labelId,
  });
}

async function modifyMessage(accessToken, messageId, addLabelIds, removeLabelIds = []) {
  void accessToken;
  await requestAgentBroker('/api/agent/email-triage', {
    operation: 'modify-message',
    messageId,
    addLabelIds,
    removeLabelIds,
  });
}

/**
 * Ensure the 3 triage labels exist in Gmail; return a map of
 * { important: id, later: id, news: id } and the canonical name map.
 *
 * Idempotent — if the label already exists, we keep the existing one.
 */
async function ensureLabels(accessToken, labels) {
  void accessToken;
  void labels;
  const response = await requestAgentBroker('/api/agent/email-triage', {
    operation: 'ensure-labels',
  });
  return response.result.labelIdsByKey;
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
  const parts = p.split('*');
  let position = 0;
  for (const [index, part] of parts.entries()) {
    if (part.length === 0) continue;
    if (index === parts.length - 1 && !p.endsWith('*')) {
      return v.endsWith(part) && v.length - part.length >= position;
    }
    const matchAt = v.indexOf(part, position);
    if (matchAt < 0 || (index === 0 && matchAt !== 0)) return false;
    position = matchAt + part.length;
  }
  return true;
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
