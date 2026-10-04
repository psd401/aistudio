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
 * what the classifier Lambda would actually do. parity.test.js runs both
 * copies (and the content-features.ts port below) over a shared corpus
 * and fails CI on any divergence.
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

/** Non-empty string, or null. A boolean `true` is NOT a criterion. */
function criterionText(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function criterionList(value) {
  return Array.isArray(value) ? value.filter((entry) => criterionText(entry)) : [];
}

/**
 * A rule is well-formed when at least one positive criterion carries real
 * text. `rules add-keyword x --from` used to store `from_domain: true`,
 * which matches nothing and cannot be addressed by value — #1855 item 1.
 */
function isWellFormedKeywordRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  const hasText = ['subject_contains', 'snippet_contains', 'from_domain', 'from_address'].some(
    (key) => criterionText(rule[key]),
  );
  const hasList = ['subject_any', 'snippet_any'].some(
    (key) => criterionList(rule[key]).length > 0,
  );
  const labelIsValid = ['important', 'later', 'news'].includes(rule.label);
  return labelIsValid && (hasText || hasList);
}

/** Human-readable summary of what a rule matches on. */
function describeKeywordRule(rule) {
  const parts = [];
  if (!rule || typeof rule !== 'object') return 'malformed';
  const fromAddress = criterionText(rule.from_address);
  const fromDomain = criterionText(rule.from_domain);
  const subject = criterionText(rule.subject_contains);
  const snippet = criterionText(rule.snippet_contains);
  const subjectAny = criterionList(rule.subject_any);
  const snippetAny = criterionList(rule.snippet_any);
  if (fromAddress) parts.push(`from=${fromAddress}`);
  if (fromDomain) parts.push(`from_domain=${fromDomain}`);
  if (subject) parts.push(`subject~"${subject}"`);
  if (subjectAny.length > 0) parts.push(`subject~any(${subjectAny.join('|')})`);
  if (snippet) parts.push(`snippet~"${snippet}"`);
  if (snippetAny.length > 0) parts.push(`snippet~any(${snippetAny.join('|')})`);
  if (rule.external) parts.push('external');
  return parts.length > 0 ? parts.join(' + ') : 'malformed';
}

function senderCriteriaMatch(rule, features) {
  const fromDomain = criterionText(rule.from_domain);
  if (fromDomain && features.fromDomain !== fromDomain.toLowerCase()) return false;
  const fromAddress = criterionText(rule.from_address);
  return !fromAddress || features.fromEmail === fromAddress.toLowerCase();
}

function textCriteriaMatch(rule, features) {
  const subject = criterionText(rule.subject_contains);
  if (subject && !features.subjectLower.includes(subject.toLowerCase())) return false;
  const snippet = criterionText(rule.snippet_contains);
  return !snippet || features.snippetLower.includes(snippet.toLowerCase());
}

function listCriteriaMatch(rule, features) {
  const subjectAny = criterionList(rule.subject_any);
  if (
    subjectAny.length > 0 &&
    !subjectAny.some((kw) => features.subjectLower.includes(kw.toLowerCase()))
  ) {
    return false;
  }
  const snippetAny = criterionList(rule.snippet_any);
  return (
    snippetAny.length === 0 ||
    snippetAny.some((kw) => features.snippetLower.includes(kw.toLowerCase()))
  );
}

function matchesKeywordRule(rule, features) {
  if (!isWellFormedKeywordRule(rule)) return false;
  if (rule.external && features.isInternal) return false;
  return (
    senderCriteriaMatch(rule, features) &&
    textCriteriaMatch(rule, features) &&
    listCriteriaMatch(rule, features)
  );
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
      return {
        label: rule.label,
        reason: `keyword:${describeKeywordRule(rule)}`,
        source: 'rule',
      };
    }
  }
  return { decided: false, reason: 'no-rule-match' };
}

// =====================================================================
// Content signals — JS port of
// infra/lambdas/agent-triage-poll/content-features.ts. Used by the
// `simulate` subcommand and by the human-sender check on `suggestions
// apply`. Keep behaviour-equivalent with the TypeScript original; that
// file carries the reasoning behind each pattern.
// =====================================================================

const OPENING_TEXT_CHARS = 400;
const BROADCAST_RECIPIENT_COUNT = 8;

const ACTION_RE =
  /\b(can you|could you|would you|will you|are you able|please (?:review|send|confirm|respond|reply|complete|fill|sign|update|look|advise|provide|share|let)|need (?:you|your)|needs your|let me know|your (?:thoughts|input|feedback|take)|action (?:required|needed)|requires? your|waiting on you|over to you|follow up with)\b/i;
const APPROVAL_RE =
  /\b(approve|authorize|authorise|sign[- ]?off on|please sign|pending your|awaiting your|ready for (?:your )?(?:review|signature)|(?:your|submitted for|sent for|routed for) (?:approval|authori[sz]ation|sign[- ]?off)|(?:needs?|requires?|requesting|request for|awaiting|pending) (?:your )?(?:approval|authori[sz]ation|sign[- ]?off|signature)|(?:approval|authori[sz]ation|sign[- ]?off|signature) (?:needed|required|requested))\b/i;
const DEADLINE_RE =
  /\b(by (?:eod|cob|end of day|close of business|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2})|due (?:by|on|date)|deadline|no later than|before the (?:end|close) of|asap|as soon as possible|expires? (?:on|in)|last chance to (?:respond|reply|submit))\b/i;
// Removed before the ask patterns run: "no action required" contains
// "action required" and would otherwise read as a request.
const NEGATED_ASK_RE =
  /\bno (?:action|response|reply|rsvp|approval|authori[sz]ation|sign[- ]?off|signature) (?:is )?(?:needed|required|necessary)\b|\bnothing (?:is )?(?:needed|required)(?: from you)?\b|\bno need to (?:reply|respond|act|approve|sign)\b|\b(?:does not|doesn't|do not|don't|no longer) (?:need|require)s? (?:your )?(?:approval|authori[sz]ation|sign[- ]?off|signature)\b/gi;
const INFORMATIONAL_RE =
  /\b(fyi|for your (?:information|awareness|records|reference)|just (?:a )?(?:heads[- ]up|so you know)|no action (?:is )?(?:needed|required|necessary)|nothing (?:is )?(?:needed|required) from you|status (?:report|update)|(?:daily|weekly|monthly|quarterly) (?:report|digest|summary|roundup|recap)|newsletter|read[- ]only|informational(?:ly)? )\b/i;
// Bulk-mail footer boilerplate (#1861). Only consulted for automated
// senders — "go ahead and" is ordinary English from a colleague. Kept as
// literals, not one alternation regex: that form tripped
// security/detect-unsafe-regex, and this array is a verbatim copy of
// MARKETING_FOOTER_PHRASES in content-features.ts.
const MARKETING_FOOTER_PHRASES = [
  'unsubscribe',
  'manage your preferences',
  'manage your email preferences',
  'manage email preferences',
  'update your preferences',
  'update your email preferences',
  'opt out of these',
  'opt-out of these',
  'you are receiving this',
  "you're receiving this",
  'this email was sent to',
  'this e-mail was sent to',
  'this message was sent to',
  'view this in your browser',
  'view this email in your browser',
  'view it in your browser',
  'view in browser',
  'add us to your address book',
  'add us to your safe sender',
  // Both named verbatim in #1861 item 4. "go ahead and" is ordinary
  // English, which is why the list is gated on automatedSender.
  'go ahead and',
  'think this is awesome',
];

function hasMarketingFooter(text) {
  const lower = String(text || '').toLowerCase();
  return MARKETING_FOOTER_PHRASES.some((phrase) => lower.includes(phrase));
}
// A question only counts when the clause it terminates speaks to the
// reader (#1861) — "Think this is awesome?" is not an ask. No contraction
// alternative needed: an apostrophe is a non-word char, so \byou\b already
// matches "you're". Scanned by hand rather than with /[^.!?\n]*\?/g, which
// is quadratic on text with no question mark — see content-features.ts.
const SECOND_PERSON_RE = /\b(you|your|yours|yourself)\b/i;
const CLAUSE_TERMINATORS = new Set(['.', '!', '?', '\n']);

function hasDirectQuestion(text) {
  const str = String(text || '');
  let clauseStart = 0;
  for (let i = 0; i < str.length; i += 1) {
    const char = str[i];
    if (!CLAUSE_TERMINATORS.has(char)) continue;
    if (char === '?' && SECOND_PERSON_RE.test(str.slice(clauseStart, i))) {
      return true;
    }
    clauseStart = i + 1;
  }
  return false;
}

const AUTOMATED_LOCALPARTS = new Set([
  'admin',
  'alert',
  'alerts',
  'auto',
  'automated',
  'bounce',
  'bounces',
  'daemon',
  'mailer',
  'mailer-daemon',
  'noreply',
  'notification',
  'notifications',
  'postmaster',
  'robot',
  'system',
]);
const AUTOMATED_LOCALPART_FRAGMENTS = [
  'noreply',
  'no-reply',
  'no_reply',
  'no.reply',
  'donotreply',
  'do-not-reply',
  'do_not_reply',
  'mailer-daemon',
];
const AUTOMATED_LOCALPART_PREFIXES = ['serv_', 'svc_', 'svc-', 'tsd-', 'noreply'];

function parseAddressList(headerValue) {
  if (!headerValue) return [];
  const matches = String(headerValue).match(
    /[\w!#$%&'*+/=?^`{|}~.-]+@[\w.-]+\.[A-Za-z]{2,}/g,
  );
  return matches ? matches.map((address) => address.toLowerCase()) : [];
}

function isAutomatedSender(fromEmail, headers = {}) {
  if (headers.listUnsubscribe && String(headers.listUnsubscribe).trim()) return true;
  const autoSubmitted = String(headers.autoSubmitted || '').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  const precedence = String(headers.precedence || '').trim().toLowerCase();
  if (['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) return true;

  const localPart = String(fromEmail || '').split('@')[0].toLowerCase().split('+')[0];
  if (!localPart) return false;
  if (AUTOMATED_LOCALPARTS.has(localPart)) return true;
  if (AUTOMATED_LOCALPART_FRAGMENTS.some((f) => localPart.includes(f))) return true;
  return AUTOMATED_LOCALPART_PREFIXES.some((p) => localPart.startsWith(p));
}

function deriveShape(signals) {
  if (signals.approvalRequest) return 'approval';
  if (signals.liveThread) return 'live-thread';
  if (signals.directQuestion || signals.actionRequest) return 'direct-ask';
  if (signals.automatedSender) return 'notification';
  if (signals.informational || signals.ccOnly || signals.broadcast) return 'fyi';
  return 'unknown';
}

function detectContentSignals(input) {
  const subject = input.subject || '';
  const headers = input.headers || {};
  const opening = `${subject}\n${input.body || ''}`.slice(
    0,
    OPENING_TEXT_CHARS + subject.length,
  );
  const userEmail = String(input.userEmail || '').toLowerCase();
  const toAddresses = parseAddressList(headers.to);
  const ccAddresses = parseAddressList(headers.cc);
  const addressedToUser = toAddresses.includes(userEmail);
  const askText = opening.replace(NEGATED_ASK_RE, ' ');
  const listMail = Boolean(String(headers.listUnsubscribe || '').trim());
  const automatedSender = isAutomatedSender(input.fromEmail, headers);
  const base = {
    directQuestion: hasDirectQuestion(askText),
    actionRequest: ACTION_RE.test(askText),
    approvalRequest: APPROVAL_RE.test(askText),
    deadline: DEADLINE_RE.test(askText),
    addressedToUser,
    ccOnly: !addressedToUser && ccAddresses.includes(userEmail),
    broadcast:
      Boolean(headers.listUnsubscribe) ||
      toAddresses.length + ccAddresses.length >= BROADCAST_RECIPIENT_COUNT,
    liveThread:
      Boolean(input.hasUserReply) &&
      Boolean(headers.inReplyTo || headers.references || /^\s*re\s*:/i.test(subject)),
    informational:
      INFORMATIONAL_RE.test(opening) ||
      listMail ||
      (automatedSender && hasMarketingFooter(opening)),
    automatedSender,
  };
  return { ...base, shape: deriveShape(base) };
}

function hasAsk(signals) {
  return Boolean(
    signals.directQuestion ||
      signals.actionRequest ||
      signals.approvalRequest ||
      signals.deadline,
  );
}

function classifyByContent(signals) {
  if (signals.approvalRequest) {
    return { label: 'important', reason: 'content:approval-or-signature-requested' };
  }
  if (signals.liveThread) {
    return { label: 'important', reason: 'content:reply-in-a-thread-you-are-in' };
  }
  // An automated/bulk sender is vetoed here (#1861): nobody is waiting on a
  // reply to a noreply mailbox, and marketing copy is full of second-person
  // questions. Approval requests are exempt — they returned above.
  if (
    signals.addressedToUser &&
    !signals.automatedSender &&
    (signals.directQuestion || signals.actionRequest)
  ) {
    return {
      label: 'important',
      reason: signals.directQuestion
        ? 'content:direct-question-addressed-to-you'
        : 'content:action-requested-of-you',
    };
  }
  if (!hasAsk(signals)) {
    if (signals.automatedSender) {
      return { label: 'later', reason: 'content:automated-notice-no-ask' };
    }
    if (signals.informational) {
      return { label: 'later', reason: 'content:fyi-nothing-asked-of-you' };
    }
    if (signals.ccOnly || signals.broadcast) {
      return { label: 'later', reason: 'content:you-are-not-the-recipient' };
    }
  }
  return null;
}

// Reporting order only — the declaration order of the signals object, so
// the list is stable across calls and across the TS/JS copies. NOT a claim
// about which signal "won"; the deciding branch is named by `reason`.
// See the SIGNAL_REPORT_ORDER comment in content-features.ts.
const SIGNAL_REPORT_ORDER = [
  'directQuestion',
  'actionRequest',
  'approvalRequest',
  'deadline',
  'addressedToUser',
  'ccOnly',
  'broadcast',
  'liveThread',
  'informational',
  'automatedSender',
];

function firedContentSignals(signals) {
  return SIGNAL_REPORT_ORDER.filter((name) => signals[name] === true);
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
  describeKeywordRule,
  isWellFormedKeywordRule,
  wildcardMatch,
  // content signals
  MARKETING_FOOTER_PHRASES,
  classifyByContent,
  detectContentSignals,
  firedContentSignals,
  hasAsk,
  hasDirectQuestion,
  isAutomatedSender,
  parseAddressList,
};
