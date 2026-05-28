#!/usr/bin/env node
/**
 * psd-email-triage — agent-facing CLI for the smart email triage feature.
 *
 * Dispatches subcommands documented in SKILL.md. Every call returns one
 * JSON line on stdout — `{ ok, subcommand, summary, data? }` on success
 * or `{ ok: false, subcommand, error, code }` on failure. The agent
 * reads this in its tool result and decides whether to render a card
 * or just acknowledge.
 *
 * All state lives in DynamoDB `psd-agent-triage-<env>`. Gmail labels are
 * created via the user's `user_account` OAuth slot (gmail.modify). The
 * digest is an EventBridge Scheduler entry per opted-in user.
 */

'use strict';

const lib = require('./lib');

// ---------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------

function parseArgs(argv) {
  // argv = [node, run.js, subcmd, ...rest]
  const args = { _subcmd: argv[2] || null, _positional: [] };
  for (let i = 3; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._positional.push(tok);
    }
  }
  return args;
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function bail(code, message, subcommand) {
  emit({ ok: false, subcommand, error: message, code });
  process.exit(1);
}

function requireUser(args, subcmd) {
  const u = args.user;
  if (!u || typeof u !== 'string') {
    bail('missing-user', '--user <email> is required', subcmd);
  }
  if (!/^[\w%+.-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(u)) {
    bail('bad-user', `--user "${u}" is not a valid email`, subcmd);
  }
  return u.toLowerCase();
}

function requirePositional(args, n, subcmd) {
  if (args._positional.length < n) {
    bail('missing-args', `Expected ${n} positional argument(s)`, subcmd);
  }
  return args._positional;
}

// ---------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------

async function cmd_enable(args) {
  const user = requireUser(args, 'enable');
  const existing = await lib.getRow(user);
  const accessToken = await lib.getUserAccessToken(user);

  // Merge: defaults first (so new keys like `task` get picked up on
  // re-enable), existing user-renamed keys win (so we don't trample
  // their `@psd/P0` rename). Phase 1.5 added the `task` key so users
  // who enabled before that ship need a way to get it without resetting.
  const labels = {
    ...lib.DEFAULT_LABELS,
    ...((existing && existing.labels) || {}),
  };
  const labelIdsByKey = await lib.ensureLabels(accessToken, labels);

  // Idempotent path for already-enabled users — refresh labels (so
  // schema additions like Phase 1.5's `task` label propagate) without
  // resetting cursor, rules, escalation, or digest state. This is the
  // "refresh my email triage setup" path.
  if (existing && existing.enabled) {
    const labelsChanged =
      JSON.stringify(labels) !== JSON.stringify(existing.labels || {}) ||
      JSON.stringify(labelIdsByKey) !== JSON.stringify(existing.labelIdsByKey || {});
    if (labelsChanged) {
      await lib.updateRow(user, { labels, labelIdsByKey });
    }
    emit({
      ok: true,
      subcommand: 'enable',
      summary: labelsChanged
        ? `Refreshed: triage was already enabled, labels updated to ${Object.values(labels).join(', ')}.`
        : `Triage already enabled for ${user}. No changes needed.`,
      data: { alreadyEnabled: true, labels, labelIdsByKey, refreshed: labelsChanged },
    });
    return;
  }
  const startHistoryId = await lib.getCurrentHistoryId(accessToken);

  const internalDomain = user.split('@')[1];
  const now = new Date().toISOString();

  const newRow = {
    enabled: true,
    enabledAt: now,
    disabledAt: null,
    classifierStartHistoryId: startHistoryId,
    lastHistoryId: startHistoryId,
    lastPollAt: now,
    labels,
    labelIdsByKey,
    rules: (existing && existing.rules) || lib.DEFAULT_RULES,
    escalation: (existing && existing.escalation) || lib.DEFAULT_ESCALATION,
    digestEnabled: existing ? existing.digestEnabled !== false : true,
    digestTime: (existing && existing.digestTime) || '08:00',
    digestTz: (existing && existing.digestTz) || 'America/Los_Angeles',
    recentDecisions: (existing && existing.recentDecisions) || [],
    recentCorrections: (existing && existing.recentCorrections) || [],
    learnedPatterns: (existing && existing.learnedPatterns) || [],
    internalDomain,
    // NOTE: do NOT include `userEmail` here. It's the DynamoDB partition
    // key — UpdateCommand passes it via Key{userEmail} and DDB refuses
    // to modify PK attributes in the SET expression. lib.updateRow()
    // also guards against this, but keeping the bag clean here too.
  };

  // Build digest schedule first; if it fails, we still want to be able
  // to persist the rest of the row (digest is recoverable).
  let digestArn = null;
  let digestNote = null;
  if (newRow.digestEnabled) {
    try {
      digestArn = await lib.upsertDigestSchedule(
        user,
        newRow.digestTime,
        newRow.digestTz,
      );
    } catch (err) {
      digestNote = `Digest schedule deferred (${err.message}). Re-run 'digest enable' once env is configured.`;
      newRow.digestEnabled = false;
    }
  }
  newRow.digestScheduleArn = digestArn;

  await lib.updateRow(user, newRow);

  emit({
    ok: true,
    subcommand: 'enable',
    summary:
      `Watching ${user}. Gmail labels: ${Object.values(labels).join(', ')}. ` +
      `Default rules seeded. Cursor anchored at historyId ${startHistoryId}.` +
      (digestNote ? ' ' + digestNote : ''),
    data: { labels, labelIdsByKey, startHistoryId, digestArn },
  });
}

async function cmd_disable(args) {
  const user = requireUser(args, 'disable');
  const row = await lib.getRow(user);
  if (!row) {
    emit({ ok: true, subcommand: 'disable', summary: `No triage configured for ${user}. Nothing to do.` });
    return;
  }
  const forget = args.forget === true;
  const now = new Date().toISOString();

  if (!forget) {
    await lib.updateRow(user, { enabled: false, disabledAt: now });
    // Pause digest too — preserves the schedule config for re-enable.
    if (row.digestEnabled && row.digestScheduleArn) {
      try { await lib.deleteDigestSchedule(user); } catch (_) {}
    }
    emit({
      ok: true,
      subcommand: 'disable',
      summary: `Paused triage for ${user}. Rules and labels are kept. Re-enable anytime.`,
    });
    return;
  }

  // --forget: nuke state, delete labels, remove schedule.
  let labelsDeleted = 0;
  try {
    const accessToken = await lib.getUserAccessToken(user);
    for (const [, labelId] of Object.entries(row.labelIdsByKey || {})) {
      try { await lib.deleteLabel(accessToken, labelId); labelsDeleted++; } catch (_) {}
    }
  } catch (_) {
    // If OAuth fails, leave labels — better than crashing the forget.
  }
  try { await lib.deleteDigestSchedule(user); } catch (_) {}
  await lib.deleteRow(user);

  emit({
    ok: true,
    subcommand: 'disable',
    summary: `Forgot all triage state for ${user}. Deleted ${labelsDeleted} Gmail labels.`,
  });
}

async function cmd_status(args) {
  const user = requireUser(args, 'status');
  const row = await lib.getRow(user);
  if (!row) {
    emit({
      ok: true,
      subcommand: 'status',
      summary: `Triage is not enabled for ${user}. Call 'enable' to start.`,
      data: { enabled: false },
    });
    return;
  }
  emit({
    ok: true,
    subcommand: 'status',
    summary:
      `${row.enabled ? 'Active' : 'Paused'} · ` +
      `${(row.rules.vipSenders || []).length} VIPs · ` +
      `${(row.rules.muteSenders || []).length} muted · ` +
      `${(row.rules.keywordRules || []).length} keyword rules · ` +
      `${(row.recentDecisions || []).length} recent decisions · ` +
      `digest ${row.digestEnabled ? `${row.digestTime} ${row.digestTz || ''}` : 'off'}.`,
    data: {
      enabled: row.enabled,
      enabledAt: row.enabledAt,
      disabledAt: row.disabledAt,
      labels: row.labels,
      lastPollAt: row.lastPollAt,
      counts: {
        vipSenders: (row.rules.vipSenders || []).length,
        muteSenders: (row.rules.muteSenders || []).length,
        keywordRules: (row.rules.keywordRules || []).length,
        escalationSenders: (row.escalation.senders || []).length,
        escalationKeywords: (row.escalation.keywords || []).length,
        recentDecisions: (row.recentDecisions || []).length,
        recentCorrections: (row.recentCorrections || []).length,
      },
      digest: {
        enabled: row.digestEnabled,
        time: row.digestTime,
        tz: row.digestTz,
      },
    },
  });
}

// ---------------------------------------------------------------------
// rules.*
// ---------------------------------------------------------------------

async function requireEnabledRow(user, subcommand) {
  const row = await lib.getRow(user);
  if (!row) {
    bail('not-enabled', `Triage not enabled for ${user}. Call 'enable' first.`, subcommand);
  }
  return row;
}

async function cmd_rules(args) {
  const verb = args._positional[0];
  if (verb === 'list') {
    const user = requireUser(args, 'rules list');
    const row = await requireEnabledRow(user, 'rules list');
    emit({
      ok: true,
      subcommand: 'rules list',
      summary: 'Current rules',
      data: { rules: row.rules },
    });
    return;
  }
  if (verb === 'add-vip') {
    const user = requireUser(args, 'rules add-vip');
    const [, email] = requirePositional(args, 2, 'rules add-vip');
    const row = await requireEnabledRow(user, 'rules add-vip');
    const vips = Array.from(new Set([...(row.rules.vipSenders || []), email.toLowerCase()]));
    await lib.updateRow(user, { rules: { ...row.rules, vipSenders: vips } });
    emit({ ok: true, subcommand: 'rules add-vip', summary: `Added VIP: ${email}` });
    return;
  }
  if (verb === 'mute') {
    const user = requireUser(args, 'rules mute');
    const [, pattern] = requirePositional(args, 2, 'rules mute');
    const row = await requireEnabledRow(user, 'rules mute');
    const muted = Array.from(new Set([...(row.rules.muteSenders || []), pattern.toLowerCase()]));
    await lib.updateRow(user, { rules: { ...row.rules, muteSenders: muted } });
    emit({ ok: true, subcommand: 'rules mute', summary: `Muted: ${pattern}` });
    return;
  }
  if (verb === 'add-keyword') {
    const user = requireUser(args, 'rules add-keyword');
    const [, keyword] = requirePositional(args, 2, 'rules add-keyword');
    const label = args.label || 'later';
    if (!['important', 'later', 'news'].includes(label)) {
      bail('bad-label', `--label must be important|later|news (got "${label}")`, 'rules add-keyword');
    }
    const row = await requireEnabledRow(user, 'rules add-keyword');
    const rule = { label };
    if (args.snippet) rule.snippet_contains = keyword;
    else if (args.from) rule.from_domain = args.from;
    else rule.subject_contains = keyword;
    if (args.external === true) rule.external = true;
    const next = [...(row.rules.keywordRules || []), rule];
    await lib.updateRow(user, { rules: { ...row.rules, keywordRules: next } });
    emit({
      ok: true,
      subcommand: 'rules add-keyword',
      summary: `Keyword rule added: "${keyword}" → ${label}`,
      data: { rule },
    });
    return;
  }
  if (verb === 'remove') {
    const user = requireUser(args, 'rules remove');
    const [, type, value] = requirePositional(args, 3, 'rules remove');
    const row = await requireEnabledRow(user, 'rules remove');
    const next = { ...row.rules };
    if (type === 'vip') {
      next.vipSenders = (row.rules.vipSenders || []).filter((v) => v !== value.toLowerCase());
    } else if (type === 'mute') {
      next.muteSenders = (row.rules.muteSenders || []).filter((v) => v !== value.toLowerCase());
    } else if (type === 'keyword') {
      // Match on subject_contains / snippet_contains / from_domain.
      next.keywordRules = (row.rules.keywordRules || []).filter((r) => {
        return r.subject_contains !== value && r.snippet_contains !== value && r.from_domain !== value;
      });
    } else {
      bail('bad-type', `Unknown rule type "${type}"`, 'rules remove');
    }
    await lib.updateRow(user, { rules: next });
    emit({ ok: true, subcommand: 'rules remove', summary: `Removed ${type}: ${value}` });
    return;
  }
  bail('bad-verb', `Unknown rules subcommand: ${verb}`, 'rules');
}

// ---------------------------------------------------------------------
// escalation.*
// ---------------------------------------------------------------------

async function cmd_escalation(args) {
  const verb = args._positional[0];
  if (verb === 'list') {
    const user = requireUser(args, 'escalation list');
    const row = await requireEnabledRow(user, 'escalation list');
    emit({
      ok: true,
      subcommand: 'escalation list',
      summary: 'Current escalation rules',
      data: { escalation: row.escalation },
    });
    return;
  }
  if (verb === 'add-sender') {
    const user = requireUser(args, 'escalation add-sender');
    const [, email] = requirePositional(args, 2, 'escalation add-sender');
    const row = await requireEnabledRow(user, 'escalation add-sender');
    const senders = Array.from(new Set([...(row.escalation.senders || []), email.toLowerCase()]));
    await lib.updateRow(user, { escalation: { ...row.escalation, senders } });
    emit({ ok: true, subcommand: 'escalation add-sender', summary: `Will ping for: ${email}` });
    return;
  }
  if (verb === 'add-keyword') {
    const user = requireUser(args, 'escalation add-keyword');
    const [, keyword] = requirePositional(args, 2, 'escalation add-keyword');
    const row = await requireEnabledRow(user, 'escalation add-keyword');
    const keywords = Array.from(new Set([...(row.escalation.keywords || []), keyword]));
    await lib.updateRow(user, { escalation: { ...row.escalation, keywords } });
    emit({ ok: true, subcommand: 'escalation add-keyword', summary: `Will ping when "${keyword}" appears in Important mail` });
    return;
  }
  if (verb === 'remove') {
    const user = requireUser(args, 'escalation remove');
    const [, type, value] = requirePositional(args, 3, 'escalation remove');
    const row = await requireEnabledRow(user, 'escalation remove');
    const next = { ...row.escalation };
    if (type === 'sender') next.senders = (row.escalation.senders || []).filter((v) => v !== value.toLowerCase());
    else if (type === 'keyword') next.keywords = (row.escalation.keywords || []).filter((v) => v !== value);
    else bail('bad-type', `Unknown escalation type "${type}"`, 'escalation remove');
    await lib.updateRow(user, { escalation: next });
    emit({ ok: true, subcommand: 'escalation remove', summary: `Removed escalation ${type}: ${value}` });
    return;
  }
  if (verb === 'labels') {
    const user = requireUser(args, 'escalation labels');
    const [, labels] = requirePositional(args, 2, 'escalation labels');
    const triggers = labels.split(',').map((l) => l.trim()).filter(Boolean);
    for (const t of triggers) {
      if (!['important', 'later', 'news'].includes(t)) {
        bail('bad-label', `Unknown label "${t}" (use important|later|news)`, 'escalation labels');
      }
    }
    const row = await requireEnabledRow(user, 'escalation labels');
    await lib.updateRow(user, { escalation: { ...row.escalation, labelTriggers: triggers } });
    emit({ ok: true, subcommand: 'escalation labels', summary: `Label triggers set to: ${triggers.join(', ')}` });
    return;
  }
  bail('bad-verb', `Unknown escalation subcommand: ${verb}`, 'escalation');
}

// ---------------------------------------------------------------------
// training.*
// ---------------------------------------------------------------------

async function cmd_training(args) {
  const verb = args._positional[0];
  if (verb === 'recent') {
    const user = requireUser(args, 'training recent');
    const row = await requireEnabledRow(user, 'training recent');
    const limit = parseInt(args.limit || '20', 10);
    const decisions = (row.recentDecisions || []).slice(-limit).reverse();
    emit({
      ok: true,
      subcommand: 'training recent',
      summary: `${decisions.length} recent decision(s)`,
      data: { decisions, corrections: (row.recentCorrections || []).slice(-limit).reverse() },
    });
    return;
  }
  if (verb === 'correct') {
    const user = requireUser(args, 'training correct');
    const [, messageId, newLabel] = requirePositional(args, 3, 'training correct');
    if (!['important', 'later', 'news'].includes(newLabel)) {
      bail('bad-label', `newLabel must be important|later|news (got "${newLabel}")`, 'training correct');
    }
    const row = await requireEnabledRow(user, 'training correct');
    const prior = (row.recentDecisions || []).find((d) => d.messageId === messageId);
    const fromLabel = prior ? prior.label : 'unknown';
    const accessToken = await lib.getUserAccessToken(user);

    // Swap labels in Gmail.
    const newLabelId = (row.labelIdsByKey || {})[newLabel];
    if (!newLabelId) bail('missing-label', `Gmail label for "${newLabel}" not configured`, 'training correct');
    const removeLabelIds = [];
    for (const [k, id] of Object.entries(row.labelIdsByKey || {})) {
      if (k !== newLabel) removeLabelIds.push(id);
    }
    // If the correction is to important, also re-inbox the message.
    const addLabelIds = [newLabelId];
    // All three labels are "folders" — the message belongs in exactly
    // one place. Important is the user's @psd/Important folder, not a
    // dual-tagged Inbox+label entry. Matches the classifier Lambda.
    removeLabelIds.push('INBOX');
    await lib.modifyMessage(accessToken, messageId, addLabelIds, removeLabelIds);

    const correction = {
      messageId,
      fromLabel,
      toLabel: newLabel,
      ts: new Date().toISOString(),
      source: 'user-correction',
    };
    const corrections = [...(row.recentCorrections || []), correction].slice(-50);
    await lib.updateRow(user, { recentCorrections: corrections });

    emit({
      ok: true,
      subcommand: 'training correct',
      summary: `Re-labeled message ${messageId}: ${fromLabel} → ${newLabel}`,
      data: { correction },
    });
    return;
  }
  bail('bad-verb', `Unknown training subcommand: ${verb}`, 'training');
}

// ---------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------

async function cmd_simulate(args) {
  const user = requireUser(args, 'simulate');
  const row = await requireEnabledRow(user, 'simulate');
  const fromEmail = (args.from || '').toLowerCase();
  if (!fromEmail) bail('missing-from', '--from <email> is required', 'simulate');
  const internalDomain = row.internalDomain || user.split('@')[1];
  const features = {
    fromEmail,
    fromDomain: fromEmail.split('@')[1] || '',
    isInternal: (fromEmail.split('@')[1] || '').toLowerCase() === internalDomain.toLowerCase(),
    subject: args.subject || '',
    subjectLower: (args.subject || '').toLowerCase(),
    snippetLower: (args.snippet || '').toLowerCase(),
    hasUserReply: args['has-user-reply'] === true,
  };
  const decision = lib.applyRules(features, row.rules);
  emit({
    ok: true,
    subcommand: 'simulate',
    summary: 'label' in decision
      ? `Would label as ${decision.label} (${decision.reason})`
      : `Rules engine undecided — classifier would call Bedrock Nova Micro for the final decision`,
    data: { features, decision },
  });
}

// ---------------------------------------------------------------------
// labels.*
// ---------------------------------------------------------------------

async function cmd_labels(args) {
  const verb = args._positional[0];
  if (verb === 'list') {
    const user = requireUser(args, 'labels list');
    const row = await requireEnabledRow(user, 'labels list');
    emit({
      ok: true,
      subcommand: 'labels list',
      summary: 'Current labels',
      data: { labels: row.labels, labelIdsByKey: row.labelIdsByKey },
    });
    return;
  }
  if (verb === 'rename') {
    const user = requireUser(args, 'labels rename');
    const [, key, newName] = requirePositional(args, 3, 'labels rename');
    if (!['important', 'later', 'news'].includes(key)) {
      bail('bad-key', `Label key must be important|later|news (got "${key}")`, 'labels rename');
    }
    const row = await requireEnabledRow(user, 'labels rename');
    const labelId = (row.labelIdsByKey || {})[key];
    if (!labelId) bail('missing-label', `Gmail label for "${key}" not configured`, 'labels rename');
    const accessToken = await lib.getUserAccessToken(user);
    await lib.renameLabel(accessToken, labelId, newName);
    await lib.updateRow(user, {
      labels: { ...row.labels, [key]: newName },
    });
    emit({ ok: true, subcommand: 'labels rename', summary: `Renamed ${key} → ${newName}` });
    return;
  }
  bail('bad-verb', `Unknown labels subcommand: ${verb}`, 'labels');
}

// ---------------------------------------------------------------------
// digest.*
// ---------------------------------------------------------------------

async function cmd_digest(args) {
  const verb = args._positional[0];
  const user = requireUser(args, `digest ${verb}`);
  const row = await requireEnabledRow(user, `digest ${verb}`);
  if (verb === 'enable') {
    const arn = await lib.upsertDigestSchedule(user, row.digestTime || '08:00', row.digestTz || 'America/Los_Angeles');
    await lib.updateRow(user, { digestEnabled: true, digestScheduleArn: arn });
    emit({ ok: true, subcommand: 'digest enable', summary: `Daily digest scheduled for ${row.digestTime || '08:00'} ${row.digestTz || ''}.` });
    return;
  }
  if (verb === 'disable') {
    try { await lib.deleteDigestSchedule(user); } catch (_) {}
    await lib.updateRow(user, { digestEnabled: false });
    emit({ ok: true, subcommand: 'digest disable', summary: 'Daily digest disabled.' });
    return;
  }
  if (verb === 'time') {
    const [, time] = requirePositional(args, 2, 'digest time');
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) {
      bail('bad-time', `Time must be HH:MM 24-hour (got "${time}")`, 'digest time');
    }
    if (row.digestEnabled) {
      await lib.upsertDigestSchedule(user, time, row.digestTz || 'America/Los_Angeles');
    }
    await lib.updateRow(user, { digestTime: time });
    emit({ ok: true, subcommand: 'digest time', summary: `Digest time set to ${time}` });
    return;
  }
  bail('bad-verb', `Unknown digest subcommand: ${verb}`, 'digest');
}

// ---------------------------------------------------------------------
// tasks.* — Phase 1.5 user-gesture task creation
// ---------------------------------------------------------------------

async function cmd_tasks(args) {
  const verb = args._positional[0];
  const user = requireUser(args, `tasks ${verb}`);
  const row = await requireEnabledRow(user, `tasks ${verb}`);

  if (verb === 'mode') {
    const [, mode] = requirePositional(args, 2, 'tasks mode');
    if (mode !== 'none' && mode !== 'invoke-agent') {
      bail('bad-mode', `mode must be 'none' or 'invoke-agent' (got "${mode}")`, 'tasks mode');
    }
    const updates = { tasksMode: mode };
    let labelCreated = false;
    // Lazily create the @psd/Task Gmail label if it's missing — when
    // a user upgrades from a pre-Phase-1.5 enable to invoke-agent mode,
    // they need the label to exist before the gesture works.
    if (mode === 'invoke-agent' && !((row.labelIdsByKey || {}).task)) {
      const accessToken = await lib.getUserAccessToken(user);
      const labels = {
        ...lib.DEFAULT_LABELS,
        ...(row.labels || {}),
      };
      const labelIdsByKey = await lib.ensureLabels(accessToken, labels);
      updates.labels = labels;
      updates.labelIdsByKey = labelIdsByKey;
      labelCreated = true;
    }
    await lib.updateRow(user, updates);
    emit({
      ok: true,
      subcommand: 'tasks mode',
      summary: mode === 'invoke-agent'
        ? `Task gestures will now invoke your agent to create tasks per your MEMORY.md instructions.${labelCreated ? ' Created the @psd/Task Gmail label.' : ''}`
        : `Task gestures will be ignored — emails labeled @psd/Task just sit there. No automation.`,
      data: { tasksMode: mode, labelCreated },
    });
    return;
  }

  if (verb === 'notify-success') {
    const [, flag] = requirePositional(args, 2, 'tasks notify-success');
    const on = flag === 'on' || flag === 'true' || flag === '1';
    await lib.updateRow(user, { tasksNotifySuccess: on });
    emit({
      ok: true,
      subcommand: 'tasks notify-success',
      summary: on
        ? 'Success notifications enabled — Chat card will confirm each task creation.'
        : 'Success notifications disabled — task creations will be silent (failures still notify).',
    });
    return;
  }

  if (verb === 'status') {
    emit({
      ok: true,
      subcommand: 'tasks status',
      summary:
        `Task mode: ${row.tasksMode || 'none'} · ` +
        `Success notify: ${row.tasksNotifySuccess ? 'on' : 'off'} · ` +
        `${(row.recentTaskCreations || []).length} recent task(s) created`,
      data: {
        tasksMode: row.tasksMode || 'none',
        tasksNotifySuccess: Boolean(row.tasksNotifySuccess),
        recentTaskCreations: (row.recentTaskCreations || []).slice(-10).reverse(),
        taskLabelName: (row.labels || {}).task || '@psd/Task',
      },
    });
    return;
  }

  bail('bad-verb', `Unknown tasks subcommand: ${verb} (try 'mode', 'notify-success', 'status')`, 'tasks');
}

// ---------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------

const COMMANDS = {
  enable: cmd_enable,
  disable: cmd_disable,
  status: cmd_status,
  rules: cmd_rules,
  escalation: cmd_escalation,
  training: cmd_training,
  simulate: cmd_simulate,
  labels: cmd_labels,
  digest: cmd_digest,
  tasks: cmd_tasks,
};

async function main() {
  const args = parseArgs(process.argv);
  if (!args._subcmd || args.help === true) {
    process.stdout.write(
      'Usage: psd-email-triage <subcommand> --user <email> [args]\n' +
      'Subcommands: ' + Object.keys(COMMANDS).join(', ') + '\n' +
      'See /opt/psd-skills/psd-email-triage/SKILL.md for full reference.\n',
    );
    process.exit(args.help === true ? 0 : 2);
  }
  const fn = COMMANDS[args._subcmd];
  if (!fn) {
    bail('unknown-subcommand', `Unknown subcommand: ${args._subcmd}`, args._subcmd);
  }
  try {
    await fn(args);
  } catch (err) {
    const code = (err && err.code) || 'unexpected-error';
    const msg = err && err.message ? err.message : String(err);
    emit({ ok: false, subcommand: args._subcmd, error: msg, code });
    process.exit(1);
  }
}

main();
