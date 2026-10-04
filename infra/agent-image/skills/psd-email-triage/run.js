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

"use strict";

const lib = require("./lib");

// ---------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------

function parseArgs(argv) {
  // argv = [node, run.js, subcmd, ...rest]
  const args = { _subcmd: argv[2] || null, _positional: [] };
  for (let i = 3; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
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
  process.stdout.write(JSON.stringify(payload) + "\n");
}

/**
 * A refusal with a machine-readable code. Thrown rather than exiting so
 * the control flow is testable and so a caller that wraps a subcommand
 * still unwinds cleanly; `main` turns it into the documented JSON line.
 */
class BailError extends Error {
  constructor(code, message, subcommand) {
    super(message);
    this.name = "BailError";
    this.code = code;
    this.subcommand = subcommand;
  }
}

function bail(code, message, subcommand) {
  throw new BailError(code, message, subcommand);
}

function requireUser(args, subcmd) {
  const u = args.user;
  if (!u || typeof u !== "string") {
    bail("missing-user", "--user <email> is required", subcmd);
  }
  if (!/^[\w%+.-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(u)) {
    bail("bad-user", `--user "${u}" is not a valid email`, subcmd);
  }
  return u.toLowerCase();
}

function requirePositional(args, n, subcmd) {
  if (args._positional.length < n) {
    bail("missing-args", `Expected ${n} positional argument(s)`, subcmd);
  }
  return args._positional;
}

/**
 * Read a flag that must carry a value.
 *
 * `parseArgs` stores a bare `--foo` as the boolean `true`, which is right
 * for switches like `--external` and wrong for everything else. Before
 * #1855 `rules add-keyword x --from` persisted `from_domain: true`; the
 * rule then matched nothing, and `rules remove keyword <value>` compared
 * strings so it could never delete it — while still reporting "Removed
 * keyword". Rejecting the valueless flag at the door is the fix.
 */
function flagValue(args, name, subcmd) {
  const raw = args[name];
  if (raw === undefined) return undefined;
  if (raw === true || String(raw).trim() === "") {
    bail(
      "missing-value",
      `--${name} requires a value (e.g. --${name} <value>)`,
      subcmd,
    );
  }
  return String(raw).trim();
}

/** Split a comma-separated flag into trimmed, non-empty parts. */
function flagList(args, name, subcmd) {
  const raw = flagValue(args, name, subcmd);
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    bail("missing-value", `--${name} needs at least one value`, subcmd);
  }
  return parts;
}

/**
 * Stable per-rule id (#1855 item 1). Rules created before this change
 * have none, which is why removal also accepts a list index.
 */
function newRuleId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `kw-${Date.now().toString(36)}${random}`;
}

// Escalation modes recognised by the classifier Lambda (rules.ts). Keep in
// sync with EscalationMode there.
const ESCALATION_MODES = ["all", "high-confidence", "rules-only", "none"];

// Initial-inbox sweep defaults — mirror sweep.ts (last 30 days, cap 1000).
const SWEEP_WINDOW_DAYS = 30;
const SWEEP_CAP = 1000;

function newSweepState(now) {
  const t = now || new Date().toISOString();
  return {
    status: "pending",
    pageToken: null,
    processed: 0,
    labeled: 0,
    windowDays: SWEEP_WINDOW_DAYS,
    cap: SWEEP_CAP,
    startedAt: t,
    updatedAt: t,
  };
}

function emitExistingEnable(user, existing, labels, labelIdsByKey) {
  if (!existing?.enabled) return false;
  const labelsChanged =
    JSON.stringify(labels) !== JSON.stringify(existing.labels || {}) ||
    JSON.stringify(labelIdsByKey) !==
      JSON.stringify(existing.labelIdsByKey || {});
  emit({
    ok: true,
    subcommand: "enable",
    summary: labelsChanged
      ? `Refreshed: triage was already enabled, labels updated to ${Object.values(labels).join(", ")}.`
      : `Triage already enabled for ${user}. No changes needed.`,
    data: {
      alreadyEnabled: true,
      labels,
      labelIdsByKey,
      refreshed: labelsChanged,
    },
  });
  return true;
}

function initialTriageRow(existing, user, startHistoryId, now) {
  const configured = {
    rules: lib.DEFAULT_RULES,
    escalation: lib.DEFAULT_ESCALATION,
    digestEnabled: true,
    digestTime: "08:00",
    digestTz: "America/Los_Angeles",
    recentDecisions: [],
    recentCorrections: [],
    learnedPatterns: [],
    escalationMode: "all",
    escalationConfidenceThreshold: 0.85,
    ...existing,
  };
  return {
    enabled: true,
    enabledAt: now,
    disabledAt: null,
    classifierStartHistoryId: startHistoryId,
    lastHistoryId: startHistoryId,
    lastPollAt: now,
    rules: configured.rules,
    escalation: configured.escalation,
    digestEnabled: configured.digestEnabled !== false,
    digestTime: configured.digestTime,
    digestTz: configured.digestTz,
    recentDecisions: configured.recentDecisions,
    recentCorrections: configured.recentCorrections,
    learnedPatterns: configured.learnedPatterns,
    escalationMode: configured.escalationMode,
    escalationConfidenceThreshold: configured.escalationConfidenceThreshold,
    sweep: newSweepState(now),
    internalDomain: user.split("@")[1],
  };
}

async function configureInitialDigest(user, row) {
  if (!row.digestEnabled) return { digestArn: null, digestNote: null };
  try {
    const digestArn = await lib.upsertDigestSchedule(
      user,
      row.digestTime,
      row.digestTz,
    );
    return { digestArn, digestNote: null };
  } catch (err) {
    row.digestEnabled = false;
    return {
      digestArn: null,
      digestNote: `Digest schedule deferred (${err.message}). Re-run 'digest enable' once env is configured.`,
    };
  }
}

// ---------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------

async function cmd_enable(args) {
  const user = requireUser(args, "enable");
  const existing = await lib.getRow(user);
  const accessToken = await lib.getUserAccessToken(user);

  // Label names and IDs are resolved and persisted only by the trusted,
  // owner-bound broker operation. Model-controlled state updates cannot
  // choose Gmail label IDs.
  const labels = { ...lib.DEFAULT_LABELS };
  const labelIdsByKey = await lib.ensureLabels(accessToken, labels);

  // Idempotent path for already-enabled users — refresh labels (so
  // schema additions like Phase 1.5's `task` label propagate) without
  // resetting cursor, rules, escalation, or digest state. This is the
  // "refresh my email triage setup" path.
  if (emitExistingEnable(user, existing, labels, labelIdsByKey)) return;
  const startHistoryId = await lib.getCurrentHistoryId(accessToken);
  const now = new Date().toISOString();
  const newRow = initialTriageRow(existing, user, startHistoryId, now);
  const { digestArn, digestNote } = await configureInitialDigest(user, newRow);
  newRow.digestScheduleArn = digestArn;

  await lib.updateRow(user, newRow);

  emit({
    ok: true,
    subcommand: "enable",
    summary:
      `Watching ${user}. Gmail labels: ${Object.values(labels).join(", ")}. ` +
      `Default rules seeded. Cursor anchored at historyId ${startHistoryId}. ` +
      `Kicking off an inbox sweep of the last ${SWEEP_WINDOW_DAYS} days (up to ` +
      `${SWEEP_CAP} messages, no Chat pings) on the next tick.` +
      (digestNote ? " " + digestNote : ""),
    data: { labels, labelIdsByKey, startHistoryId, digestArn },
  });
}

async function cmd_disable(args) {
  const user = requireUser(args, "disable");
  const row = await lib.getRow(user);
  if (!row) {
    emit({
      ok: true,
      subcommand: "disable",
      summary: `No triage configured for ${user}. Nothing to do.`,
    });
    return;
  }
  const forget = args.forget === true;
  const now = new Date().toISOString();

  if (!forget) {
    await lib.updateRow(user, { enabled: false, disabledAt: now });
    // Pause digest too — preserves the schedule config for re-enable.
    if (row.digestEnabled && row.digestScheduleArn) {
      try {
        await lib.deleteDigestSchedule(user);
      } catch {
        // Disabling triage must still succeed if the stale schedule is absent.
      }
    }
    emit({
      ok: true,
      subcommand: "disable",
      summary: `Paused triage for ${user}. Rules and labels are kept. Re-enable anytime.`,
    });
    return;
  }

  // --forget: nuke state, delete labels, remove schedule.
  let labelsDeleted = 0;
  try {
    const accessToken = await lib.getUserAccessToken(user);
    const trustedLabelIds = await lib.ensureLabels(
      accessToken,
      lib.DEFAULT_LABELS,
    );
    for (const [, labelId] of Object.entries(trustedLabelIds)) {
      try {
        await lib.deleteLabel(accessToken, labelId);
        labelsDeleted++;
      } catch {
        // Continue deleting the remaining independently-owned Gmail labels.
      }
    }
  } catch {
    // If OAuth fails, leave labels — better than crashing the forget.
  }
  try {
    await lib.deleteDigestSchedule(user);
  } catch {
    // Forget remains idempotent when the digest schedule is already absent.
  }
  await lib.deleteRow(user);

  emit({
    ok: true,
    subcommand: "disable",
    summary: `Forgot all triage state for ${user}. Deleted ${labelsDeleted} Gmail labels.`,
  });
}

function triageStatusView(row) {
  const normalized = {
    escalationMode: "all",
    escalationConfidenceThreshold: 0.85,
    pendingSuggestions: [],
    recentDecisions: [],
    recentCorrections: [],
    learnedPatterns: [],
    digestTz: "",
    ...row,
  };
  const rules = {
    vipSenders: [],
    muteSenders: [],
    keywordRules: [],
    ...row.rules,
  };
  const escalation = {
    senders: [],
    keywords: [],
    ...row.escalation,
  };
  const sweep = row.sweep || null;
  const sweepSummary = sweep
    ? `sweep ${sweep.status} (${sweep.processed || 0}/${sweep.cap || SWEEP_CAP})`
    : "no sweep";
  const counts = {
    vipSenders: rules.vipSenders.length,
    muteSenders: rules.muteSenders.length,
    keywordRules: rules.keywordRules.length,
    escalationSenders: escalation.senders.length,
    escalationKeywords: escalation.keywords.length,
    recentDecisions: normalized.recentDecisions.length,
    recentCorrections: normalized.recentCorrections.length,
    learnedPatterns: normalized.learnedPatterns.length,
    pendingSuggestions: normalized.pendingSuggestions.length,
  };
  return {
    summary:
      `${row.enabled ? "Active" : "Paused"} · ` +
      `escalation ${normalized.escalationMode} · ` +
      `${counts.vipSenders} VIPs · ${counts.muteSenders} muted · ` +
      `${counts.keywordRules} keyword rules · ` +
      `${counts.pendingSuggestions} pending suggestion(s) · ${sweepSummary} · ` +
      `digest ${row.digestEnabled ? `${row.digestTime} ${normalized.digestTz}` : "off"}.`,
    data: {
      enabled: row.enabled,
      enabledAt: row.enabledAt,
      disabledAt: row.disabledAt,
      labels: row.labels,
      lastPollAt: row.lastPollAt,
      escalationMode: normalized.escalationMode,
      escalationConfidenceThreshold: normalized.escalationConfidenceThreshold,
      sweep,
      learnedAt: row.learnedAt,
      pendingSuggestions: normalized.pendingSuggestions.slice(0, 10),
      counts,
      digest: {
        enabled: row.digestEnabled,
        time: row.digestTime,
        tz: normalized.digestTz,
      },
    },
  };
}

async function cmd_status(args) {
  const user = requireUser(args, "status");
  const row = await lib.getRow(user);
  if (!row) {
    emit({
      ok: true,
      subcommand: "status",
      summary: `Triage is not enabled for ${user}. Call 'enable' to start.`,
      data: { enabled: false },
    });
    return;
  }
  const view = triageStatusView(row);
  emit({
    ok: true,
    subcommand: "status",
    summary: view.summary,
    data: view.data,
  });
}

// ---------------------------------------------------------------------
// rules.*
// ---------------------------------------------------------------------

async function requireEnabledRow(user, subcommand) {
  const row = await lib.getRow(user);
  if (!row) {
    bail(
      "not-enabled",
      `Triage not enabled for ${user}. Call 'enable' first.`,
      subcommand,
    );
  }
  return row;
}

async function rulesList(args) {
  const user = requireUser(args, "rules list");
  const row = await requireEnabledRow(user, "rules list");
  const keywordRules = (row.rules?.keywordRules || []).map((rule, index) => ({
    index,
    id: rule.id || null,
    label: rule.label,
    matches: lib.describeKeywordRule(rule),
    wellFormed: lib.isWellFormedKeywordRule(rule),
    rule,
  }));
  const malformed = keywordRules.filter((entry) => !entry.wellFormed).length;
  emit({
    ok: true,
    subcommand: "rules list",
    summary:
      `${(row.rules?.vipSenders || []).length} VIP · ` +
      `${(row.rules?.muteSenders || []).length} muted · ` +
      `${keywordRules.length} keyword rule(s)` +
      (malformed > 0
        ? ` · ${malformed} malformed (remove with 'rules remove keyword --malformed')`
        : ""),
    data: {
      rules: row.rules,
      keywordRules,
      malformedCount: malformed,
      removeHint:
        "Remove a keyword rule by id, by #index as shown above, or by a value it matches on.",
    },
  });
}

async function rulesAddVip(args) {
  const user = requireUser(args, "rules add-vip");
  const [, email] = requirePositional(args, 2, "rules add-vip");
  const row = await requireEnabledRow(user, "rules add-vip");
  const vips = Array.from(
    new Set([...(row.rules.vipSenders || []), email.toLowerCase()]),
  );
  await lib.updateRow(user, { rules: { ...row.rules, vipSenders: vips } });
  emit({
    ok: true,
    subcommand: "rules add-vip",
    summary: `Added VIP: ${email}`,
  });
}

async function rulesMute(args) {
  const user = requireUser(args, "rules mute");
  const [, pattern] = requirePositional(args, 2, "rules mute");
  const row = await requireEnabledRow(user, "rules mute");
  const muted = Array.from(
    new Set([...(row.rules.muteSenders || []), pattern.toLowerCase()]),
  );
  await lib.updateRow(user, { rules: { ...row.rules, muteSenders: muted } });
  emit({
    ok: true,
    subcommand: "rules mute",
    summary: `Muted: ${pattern}`,
  });
}

/**
 * Build a keyword rule from the flags.
 *
 * Every criterion is ANDed, so one rule can say "from this person AND
 * this subject" — the combination #1855 item 5 asks for. The positional
 * keyword fills whichever text field the selector flags name, defaulting
 * to the subject as before.
 */
function keywordRuleFromArgs(args, keyword, label) {
  const subcmd = "rules add-keyword";
  const rule = { id: newRuleId(), label };
  const fromDomain = flagValue(args, "from", subcmd);
  const fromAddress = flagValue(args, "from-address", subcmd);
  const subjectAny = flagList(args, "subject-any", subcmd);
  const snippetAny = flagList(args, "snippet-any", subcmd);

  if (fromDomain) rule.from_domain = fromDomain.toLowerCase();
  if (fromAddress) rule.from_address = fromAddress.toLowerCase();
  if (subjectAny) rule.subject_any = subjectAny;
  if (snippetAny) rule.snippet_any = snippetAny;

  // The positional keyword goes where the selector flags point, and
  // defaults to the subject (the pre-#1855 behaviour). When the rule
  // already matches text through --subject-any / --snippet-any, the
  // positional is NOT stored unless --subject / --snippet asks for it:
  // ANDing a placeholder keyword onto the list would make the rule
  // unmatchable.
  if (args.snippet === true) rule.snippet_contains = keyword;
  else if (args.subject === true) rule.subject_contains = keyword;
  else if (!subjectAny && !snippetAny) rule.subject_contains = keyword;

  if (args.external === true) rule.external = true;
  return rule;
}

async function rulesAddKeyword(args) {
  const user = requireUser(args, "rules add-keyword");
  const [, keyword] = requirePositional(args, 2, "rules add-keyword");
  const label = flagValue(args, "label", "rules add-keyword") || "later";
  if (!["important", "later", "news"].includes(label)) {
    bail(
      "bad-label",
      `--label must be important|later|news (got "${label}")`,
      "rules add-keyword",
    );
  }
  const row = await requireEnabledRow(user, "rules add-keyword");
  const rule = keywordRuleFromArgs(args, keyword, label);
  if (!lib.isWellFormedKeywordRule(rule)) {
    bail(
      "empty-rule",
      "That rule has nothing to match on. Give a keyword, or one of " +
        "--from <domain> / --from-address <email> / --subject-any a,b.",
      "rules add-keyword",
    );
  }
  const keywordRules = [...(row.rules.keywordRules || []), rule];
  await lib.updateRow(user, {
    rules: { ...row.rules, keywordRules },
  });
  emit({
    ok: true,
    subcommand: "rules add-keyword",
    summary:
      `Keyword rule ${rule.id} added: ${lib.describeKeywordRule(rule)} → ${label}`,
    data: { rule },
  });
}

/**
 * Every way a keyword rule can be addressed.
 *
 * Matching on values alone was the #1855 item 1 defect: a rule whose
 * `from_domain` was the boolean `true` matched no string, so it could
 * never be deleted through the CLI and had to be removed by writing the
 * row directly. Id and index are addressable whatever the rule contains,
 * and `--malformed` sweeps out entries that can never match anything.
 */
function keywordRuleSelector(args, value) {
  if (args.malformed === true) {
    return {
      describe: "malformed rules",
      matches: (rule) => !lib.isWellFormedKeywordRule(rule),
    };
  }
  const byIndexFlag = args.index !== undefined
    ? Number(flagValue(args, "index", "rules remove"))
    : undefined;
  const indexToken = /^#\d+$/.test(String(value ?? ""))
    ? Number(String(value).slice(1))
    : undefined;
  const index = byIndexFlag ?? indexToken;
  if (index !== undefined) {
    if (!Number.isInteger(index) || index < 0) {
      bail(
        "bad-index",
        `Index must be a non-negative integer (got "${value ?? args.index}")`,
        "rules remove",
      );
    }
    return {
      describe: `rule #${index}`,
      matches: (_rule, position) => position === index,
    };
  }
  if (value === undefined) {
    bail(
      "missing-args",
      "Give a rule id, a #index, a value to match, or --malformed",
      "rules remove",
    );
  }
  const needle = String(value);
  const lowered = needle.toLowerCase();
  return {
    describe: `"${needle}"`,
    matches: (rule) =>
      rule.id === needle ||
      // Text criteria match case-insensitively at classification time,
      // so removal by value must too.
      [
        rule.subject_contains,
        rule.snippet_contains,
        rule.from_domain,
        rule.from_address,
        ...(rule.subject_any || []),
        ...(rule.snippet_any || []),
      ].some((v) => v !== undefined && String(v).toLowerCase() === lowered),
  };
}

function removeFromList(list, value) {
  const lowered = String(value).toLowerCase();
  const kept = (list || []).filter((candidate) => candidate !== lowered);
  return { kept, removed: (list || []).length - kept.length };
}

async function rulesRemove(args) {
  const user = requireUser(args, "rules remove");
  requirePositional(args, 2, "rules remove");
  const [, type, value] = args._positional;
  const row = await requireEnabledRow(user, "rules remove");
  const next = { ...row.rules };
  let removed = 0;
  let described = value;

  if (type === "vip") {
    requirePositional(args, 3, "rules remove");
    const result = removeFromList(row.rules.vipSenders, value);
    next.vipSenders = result.kept;
    removed = result.removed;
  } else if (type === "mute") {
    requirePositional(args, 3, "rules remove");
    const result = removeFromList(row.rules.muteSenders, value);
    next.muteSenders = result.kept;
    removed = result.removed;
  } else if (type === "keyword") {
    const selector = keywordRuleSelector(args, value);
    described = selector.describe;
    const existing = row.rules.keywordRules || [];
    next.keywordRules = existing.filter(
      (rule, position) => !selector.matches(rule, position),
    );
    removed = existing.length - next.keywordRules.length;
  } else {
    bail("bad-type", `Unknown rule type "${type}"`, "rules remove");
  }

  // Report the truth. Claiming "Removed" when nothing matched is how the
  // undeletable rule in #1855 stayed hidden for so long.
  if (removed === 0) {
    bail(
      "not-found",
      `No ${type} rule matched ${described} — nothing was removed. ` +
        `Run 'rules list' to see ids and indexes.`,
      "rules remove",
    );
  }
  await lib.updateRow(user, { rules: next });
  emit({
    ok: true,
    subcommand: "rules remove",
    summary: `Removed ${removed} ${type} rule(s) matching ${described}`,
    data: { removed },
  });
}

const RULE_COMMANDS = {
  list: rulesList,
  "add-vip": rulesAddVip,
  mute: rulesMute,
  "add-keyword": rulesAddKeyword,
  remove: rulesRemove,
};

async function cmd_rules(args) {
  const verb = args._positional[0];
  const handler = RULE_COMMANDS[verb];
  if (!handler) bail("bad-verb", `Unknown rules subcommand: ${verb}`, "rules");
  await handler(args);
}

// ---------------------------------------------------------------------
// escalation.*
// ---------------------------------------------------------------------

async function escalationList(args) {
  const user = requireUser(args, "escalation list");
  const row = await requireEnabledRow(user, "escalation list");
  emit({
    ok: true,
    subcommand: "escalation list",
    summary: `Mode: ${row.escalationMode || "all"} · threshold ${row.escalationConfidenceThreshold ?? 0.85}`,
    data: {
      escalation: row.escalation,
      escalationMode: row.escalationMode || "all",
      escalationConfidenceThreshold: row.escalationConfidenceThreshold ?? 0.85,
    },
  });
}

async function escalationAddSender(args) {
  const user = requireUser(args, "escalation add-sender");
  const [, email] = requirePositional(args, 2, "escalation add-sender");
  const row = await requireEnabledRow(user, "escalation add-sender");
  const senders = Array.from(
    new Set([...(row.escalation.senders || []), email.toLowerCase()]),
  );
  await lib.updateRow(user, {
    escalation: { ...row.escalation, senders },
  });
  emit({
    ok: true,
    subcommand: "escalation add-sender",
    summary: `Will ping for: ${email}`,
  });
}

async function escalationAddKeyword(args) {
  const user = requireUser(args, "escalation add-keyword");
  const [, keyword] = requirePositional(args, 2, "escalation add-keyword");
  const row = await requireEnabledRow(user, "escalation add-keyword");
  const keywords = Array.from(
    new Set([...(row.escalation.keywords || []), keyword]),
  );
  await lib.updateRow(user, {
    escalation: { ...row.escalation, keywords },
  });
  emit({
    ok: true,
    subcommand: "escalation add-keyword",
    summary: `Will ping when "${keyword}" appears in Important mail`,
  });
}

async function escalationRemove(args) {
  const user = requireUser(args, "escalation remove");
  const [, type, value] = requirePositional(args, 3, "escalation remove");
  const row = await requireEnabledRow(user, "escalation remove");
  const next = { ...row.escalation };
  if (type === "sender") {
    next.senders = (row.escalation.senders || []).filter(
      (candidate) => candidate !== value.toLowerCase(),
    );
  } else if (type === "keyword") {
    next.keywords = (row.escalation.keywords || []).filter(
      (candidate) => candidate !== value,
    );
  } else {
    bail("bad-type", `Unknown escalation type "${type}"`, "escalation remove");
  }
  await lib.updateRow(user, { escalation: next });
  emit({
    ok: true,
    subcommand: "escalation remove",
    summary: `Removed escalation ${type}: ${value}`,
  });
}

async function escalationLabels(args) {
  const user = requireUser(args, "escalation labels");
  const [, labels] = requirePositional(args, 2, "escalation labels");
  const triggers = labels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  const invalid = triggers.find(
    (trigger) => !["important", "later", "news"].includes(trigger),
  );
  if (invalid) {
    bail(
      "bad-label",
      `Unknown label "${invalid}" (use important|later|news)`,
      "escalation labels",
    );
  }
  const row = await requireEnabledRow(user, "escalation labels");
  await lib.updateRow(user, {
    escalation: { ...row.escalation, labelTriggers: triggers },
  });
  emit({
    ok: true,
    subcommand: "escalation labels",
    summary: `Label triggers set to: ${triggers.join(", ")}`,
  });
}

async function escalationMode(args) {
  const user = requireUser(args, "escalation mode");
  const [, mode] = requirePositional(args, 2, "escalation mode");
  if (!ESCALATION_MODES.includes(mode)) {
    bail(
      "bad-mode",
      `mode must be one of: ${ESCALATION_MODES.join(", ")} (got "${mode}")`,
      "escalation mode",
    );
  }
  await requireEnabledRow(user, "escalation mode");
  await lib.updateRow(user, { escalationMode: mode });
  const description = {
    all: "every Important classification pings you (default).",
    "high-confidence": "only rule matches and confident LLM calls ping you.",
    "rules-only":
      "only your VIP/escalation-rule matches ping you; plain LLM Important never does.",
    none: "nothing pings you — the daily digest is the only surface.",
  }[mode];
  emit({
    ok: true,
    subcommand: "escalation mode",
    summary: `Escalation mode set to "${mode}" — ${description}`,
    data: { escalationMode: mode },
  });
}

async function escalationThreshold(args) {
  const user = requireUser(args, "escalation threshold");
  const [, raw] = requirePositional(args, 2, "escalation threshold");
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    bail(
      "bad-threshold",
      `threshold must be a number between 0 and 1 (got "${raw}")`,
      "escalation threshold",
    );
  }
  await requireEnabledRow(user, "escalation threshold");
  await lib.updateRow(user, { escalationConfidenceThreshold: value });
  emit({
    ok: true,
    subcommand: "escalation threshold",
    summary: `high-confidence escalation threshold set to ${value} (only used in "high-confidence" mode).`,
    data: { escalationConfidenceThreshold: value },
  });
}

const ESCALATION_COMMANDS = {
  list: escalationList,
  "add-sender": escalationAddSender,
  "add-keyword": escalationAddKeyword,
  remove: escalationRemove,
  labels: escalationLabels,
  mode: escalationMode,
  threshold: escalationThreshold,
};

async function cmd_escalation(args) {
  const verb = args._positional[0];
  const handler = ESCALATION_COMMANDS[verb];
  if (!handler) {
    bail("bad-verb", `Unknown escalation subcommand: ${verb}`, "escalation");
  }
  await handler(args);
}

// ---------------------------------------------------------------------
// training.*
// ---------------------------------------------------------------------

async function trainingRecent(args) {
  const user = requireUser(args, "training recent");
  const row = await requireEnabledRow(user, "training recent");
  const limit = parseInt(args.limit || "20", 10);
  const decisions = (row.recentDecisions || []).slice(-limit).reverse();
  emit({
    ok: true,
    subcommand: "training recent",
    summary: `${decisions.length} recent decision(s)`,
    data: {
      decisions,
      corrections: (row.recentCorrections || []).slice(-limit).reverse(),
    },
  });
}

async function trainingCorrect(args) {
  const user = requireUser(args, "training correct");
  const [, messageId, newLabel] = requirePositional(
    args,
    3,
    "training correct",
  );
  if (!["important", "later", "news"].includes(newLabel)) {
    bail(
      "bad-label",
      `newLabel must be important|later|news (got "${newLabel}")`,
      "training correct",
    );
  }
  const row = await requireEnabledRow(user, "training correct");
  const prior = (row.recentDecisions || []).find(
    (decision) => decision.messageId === messageId,
  );
  const fromLabel = prior ? prior.label : "unknown";
  const accessToken = await lib.getUserAccessToken(user);
  const trustedLabelIds = await lib.ensureLabels(
    accessToken,
    lib.DEFAULT_LABELS,
  );
  const newLabelId = trustedLabelIds[newLabel];
  if (!newLabelId) {
    bail(
      "missing-label",
      `Gmail label for "${newLabel}" not configured`,
      "training correct",
    );
  }
  const removeLabelIds = Object.entries(trustedLabelIds)
    .filter(([key]) => key !== newLabel)
    .map(([, id]) => id);
  removeLabelIds.push("INBOX");
  await lib.modifyMessage(accessToken, messageId, [newLabelId], removeLabelIds);
  const correction = {
    messageId,
    fromLabel,
    toLabel: newLabel,
    ts: new Date().toISOString(),
    source: "user-correction",
    fromEmail: prior ? prior.fromEmail : undefined,
    fromDomain: prior?.fromEmail ? prior.fromEmail.split("@")[1] : undefined,
  };
  const corrections = [...(row.recentCorrections || []), correction].slice(-50);
  await lib.updateRow(user, { recentCorrections: corrections });
  emit({
    ok: true,
    subcommand: "training correct",
    summary: `Re-labeled message ${messageId}: ${fromLabel} → ${newLabel}`,
    data: { correction },
  });
}

const TRAINING_COMMANDS = {
  recent: trainingRecent,
  correct: trainingCorrect,
};

async function cmd_training(args) {
  const verb = args._positional[0];
  const handler = TRAINING_COMMANDS[verb];
  if (!handler) {
    bail("bad-verb", `Unknown training subcommand: ${verb}`, "training");
  }
  await handler(args);
}

// ---------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------

// `--external` forces an outside sender so external-only rules can be
// exercised from an internal test address.
function simulatedIsInternal(args, fromEmail, internalDomain) {
  if (args.external === true) return false;
  return (
    (fromEmail.split("@")[1] || "").toLowerCase() ===
    internalDomain.toLowerCase()
  );
}

async function cmd_simulate(args) {
  const user = requireUser(args, "simulate");
  const row = await requireEnabledRow(user, "simulate");
  const fromEmail = (args.from || "").toLowerCase();
  if (!fromEmail)
    bail("missing-from", "--from <email> is required", "simulate");
  const internalDomain = row.internalDomain || user.split("@")[1];
  const features = {
    fromEmail,
    fromDomain: fromEmail.split("@")[1] || "",
    isInternal: simulatedIsInternal(args, fromEmail, internalDomain),
    subject: args.subject || "",
    subjectLower: (args.subject || "").toLowerCase(),
    snippetLower: (args.snippet || "").toLowerCase(),
    hasUserReply: args["has-user-reply"] === true,
  };
  // Derived unconditionally so the answer to "which signal fired?" is in
  // the output even when the user's own rules settle the label (#1861).
  const signals = lib.detectContentSignals({
    subject: args.subject || "",
    body: args.snippet || "",
    headers: {
      to: args.to,
      cc: args.cc,
      listUnsubscribe: args["list-unsubscribe"],
    },
    userEmail: user,
    hasUserReply: features.hasUserReply,
    fromEmail,
  });
  const firedSignals = lib.firedContentSignals(signals);
  const firedText = firedSignals.length > 0 ? firedSignals.join(", ") : "none";

  const decision = lib.applyRules(features, row.rules);
  if ("label" in decision) {
    emit({
      ok: true,
      subcommand: "simulate",
      summary:
        `Would label as ${decision.label} (${decision.reason}). ` +
        `Content signals that fired: ${firedText} ` +
        `(not consulted — the rule decided first).`,
      data: { features, signals, firedSignals, decision, stage: "rules" },
    });
    return;
  }

  // Mirror the Lambda's second stage so simulate doesn't claim "Bedrock
  // decides" for a message the deterministic content stage settles.
  const contentDecision = lib.classifyByContent(signals);
  emit({
    ok: true,
    subcommand: "simulate",
    summary:
      (contentDecision
        ? `Would label as ${contentDecision.label} (${contentDecision.reason}).`
        : "Rules and content signals are both undecided — the classifier would ask Bedrock Nova Micro.") +
      ` Content signals that fired: ${firedText}.`,
    data: {
      features,
      signals,
      firedSignals,
      decision: contentDecision || decision,
      stage: contentDecision ? "content" : "llm",
    },
  });
}

// ---------------------------------------------------------------------
// labels.*
// ---------------------------------------------------------------------

async function cmd_labels(args) {
  const verb = args._positional[0];
  if (verb === "list") {
    const user = requireUser(args, "labels list");
    const row = await requireEnabledRow(user, "labels list");
    emit({
      ok: true,
      subcommand: "labels list",
      summary: "Current labels",
      data: { labels: row.labels, labelIdsByKey: row.labelIdsByKey },
    });
    return;
  }
  if (verb === "rename") {
    bail(
      "fixed-labels",
      "Triage label names are fixed so scheduled classification can verify them safely.",
      "labels rename",
    );
  }
  bail("bad-verb", `Unknown labels subcommand: ${verb}`, "labels");
}

// ---------------------------------------------------------------------
// digest.*
// ---------------------------------------------------------------------

async function cmd_digest(args) {
  const verb = args._positional[0];
  const user = requireUser(args, `digest ${verb}`);
  const row = await requireEnabledRow(user, `digest ${verb}`);
  if (verb === "enable") {
    const arn = await lib.upsertDigestSchedule(
      user,
      row.digestTime || "08:00",
      row.digestTz || "America/Los_Angeles",
    );
    await lib.updateRow(user, { digestEnabled: true, digestScheduleArn: arn });
    emit({
      ok: true,
      subcommand: "digest enable",
      summary: `Daily digest scheduled for ${row.digestTime || "08:00"} ${row.digestTz || ""}.`,
    });
    return;
  }
  if (verb === "disable") {
    try {
      await lib.deleteDigestSchedule(user);
    } catch {
      // The persisted disabled state is authoritative if cleanup is already done.
    }
    await lib.updateRow(user, { digestEnabled: false });
    emit({
      ok: true,
      subcommand: "digest disable",
      summary: "Daily digest disabled.",
    });
    return;
  }
  if (verb === "time") {
    const [, time] = requirePositional(args, 2, "digest time");
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) {
      bail(
        "bad-time",
        `Time must be HH:MM 24-hour (got "${time}")`,
        "digest time",
      );
    }
    if (row.digestEnabled) {
      await lib.upsertDigestSchedule(
        user,
        time,
        row.digestTz || "America/Los_Angeles",
      );
    }
    await lib.updateRow(user, { digestTime: time });
    emit({
      ok: true,
      subcommand: "digest time",
      summary: `Digest time set to ${time}`,
    });
    return;
  }
  bail("bad-verb", `Unknown digest subcommand: ${verb}`, "digest");
}

// ---------------------------------------------------------------------
// tasks.* — Phase 1.5 user-gesture task creation
// ---------------------------------------------------------------------

async function tasksMode(args, user, row) {
  const [, mode] = requirePositional(args, 2, "tasks mode");
  if (mode !== "none" && mode !== "invoke-agent") {
    bail(
      "bad-mode",
      `mode must be 'none' or 'invoke-agent' (got "${mode}")`,
      "tasks mode",
    );
  }
  let labelCreated = false;
  if (mode === "invoke-agent") {
    const accessToken = await lib.getUserAccessToken(user);
    await lib.ensureLabels(accessToken, lib.DEFAULT_LABELS);
    labelCreated = !row.labelIdsByKey?.task;
  }
  await lib.updateRow(user, { tasksMode: mode });
  const createdNote = labelCreated ? " Created the @psd/Task Gmail label." : "";
  emit({
    ok: true,
    subcommand: "tasks mode",
    summary:
      mode === "invoke-agent"
        ? `Task gestures will now invoke your agent to create tasks per your MEMORY.md instructions.${createdNote}`
        : "Task gestures will be ignored — emails labeled @psd/Task just sit there. No automation.",
    data: { tasksMode: mode, labelCreated },
  });
}

async function tasksNotifySuccess(args, user) {
  const [, flag] = requirePositional(args, 2, "tasks notify-success");
  const on = ["on", "true", "1"].includes(flag);
  await lib.updateRow(user, { tasksNotifySuccess: on });
  emit({
    ok: true,
    subcommand: "tasks notify-success",
    summary: on
      ? "Success notifications enabled — Chat card will confirm each task creation."
      : "Success notifications disabled — task creations will be silent (failures still notify).",
  });
}

async function tasksStatus(_args, _user, row) {
  const recent = row.recentTaskCreations || [];
  emit({
    ok: true,
    subcommand: "tasks status",
    summary:
      `Task mode: ${row.tasksMode || "none"} · ` +
      `Success notify: ${row.tasksNotifySuccess ? "on" : "off"} · ` +
      `${recent.length} recent task(s) created`,
    data: {
      tasksMode: row.tasksMode || "none",
      tasksNotifySuccess: Boolean(row.tasksNotifySuccess),
      recentTaskCreations: recent.slice(-10).reverse(),
      taskLabelName: row.labels?.task || "@psd/Task",
    },
  });
}

const TASK_COMMANDS = {
  mode: tasksMode,
  "notify-success": tasksNotifySuccess,
  status: tasksStatus,
};

async function cmd_tasks(args) {
  const verb = args._positional[0];
  const handler = TASK_COMMANDS[verb];
  if (!handler) {
    bail(
      "bad-verb",
      `Unknown tasks subcommand: ${verb} (try 'mode', 'notify-success', 'status')`,
      "tasks",
    );
  }
  const user = requireUser(args, `tasks ${verb}`);
  const row = await requireEnabledRow(user, `tasks ${verb}`);
  await handler(args, user, row);
}

// ---------------------------------------------------------------------
// sweep — initial-inbox backfill (#1172)
// ---------------------------------------------------------------------

async function cmd_sweep(args) {
  const user = requireUser(args, "sweep");
  const row = await requireEnabledRow(user, "sweep");
  const current = row.sweep;
  if (
    current &&
    (current.status === "pending" || current.status === "running")
  ) {
    emit({
      ok: true,
      subcommand: "sweep",
      summary:
        `A sweep is already ${current.status} for ${user} ` +
        `(${current.processed || 0} processed, ${current.labeled || 0} labeled). ` +
        `It continues on the next tick.`,
      data: { sweep: current },
    });
    return;
  }
  const sweep = newSweepState();
  await lib.updateRow(user, { sweep });
  emit({
    ok: true,
    subcommand: "sweep",
    summary:
      `Queued an inbox sweep for ${user} — backfilling the last ${SWEEP_WINDOW_DAYS} days ` +
      `of INBOX (up to ${SWEEP_CAP} messages) through the normal rules→LLM pipeline. ` +
      `No Chat pings during the sweep. It starts on the next 5-minute tick.`,
    data: { sweep },
  });
}

// ---------------------------------------------------------------------
// suggestions — approve/dismiss learned rule suggestions (#1172)
// ---------------------------------------------------------------------

function rulesWithSuggestion(rules, suggestion, id) {
  const next = { ...rules };
  const target = String(suggestion.target).toLowerCase();
  if (suggestion.kind === "vip") {
    next.vipSenders = Array.from(new Set([...(next.vipSenders || []), target]));
    return next;
  }
  if (suggestion.kind === "mute") {
    next.muteSenders = Array.from(
      new Set([...(next.muteSenders || []), target]),
    );
    return next;
  }
  bail(
    "bad-kind",
    `Suggestion "${id}" has unknown kind "${suggestion.kind}"`,
    "suggestions apply",
  );
}

async function applySuggestion(args, user, row, pending) {
  const [, id] = requirePositional(args, 2, "suggestions apply");
  const suggestion = pending.find((candidate) => candidate.id === id);
  if (!suggestion) {
    bail(
      "not-found",
      `No pending suggestion with id "${id}"`,
      "suggestions apply",
    );
  }
  // A mute silently drops mail. The learner no longer proposes one
  // against a person, but a suggestion stored before #1855 still can, and
  // so can a hand-typed id — so the write itself refuses without an
  // explicit confirmation (#1855 item 3).
  if (
    suggestion.kind === "mute" &&
    !lib.isAutomatedSender(String(suggestion.target)) &&
    args["confirm-human"] !== true
  ) {
    bail(
      "needs-human-confirmation",
      `"${suggestion.target}" looks like a person, and muting silently ` +
        `auto-archives everything they send you. Re-run with ` +
        `--confirm-human if that is really what you want.`,
      "suggestions apply",
    );
  }
  const rules = rulesWithSuggestion(row.rules, suggestion, id);
  await lib.updateRow(user, {
    rules,
    pendingSuggestions: pending.filter((candidate) => candidate.id !== id),
    appliedSuggestions: Array.from(
      new Set([...(row.appliedSuggestions || []), id]),
    ),
  });
  emit({
    ok: true,
    subcommand: "suggestions apply",
    summary:
      suggestion.kind === "vip"
        ? `Applied: ${suggestion.target} is now a VIP (always Important).`
        : `Applied: muting ${suggestion.target} — future mail from them auto-archives to Later.`,
    data: { applied: suggestion, rules },
  });
}

async function dismissSuggestion(args, user, row, pending) {
  const [, id] = requirePositional(args, 2, "suggestions dismiss");
  const exists =
    pending.some((candidate) => candidate.id === id) ||
    (row.dismissedSuggestions || []).includes(id);
  if (!exists) {
    bail(
      "not-found",
      `No suggestion with id "${id}" to dismiss`,
      "suggestions dismiss",
    );
  }
  await lib.updateRow(user, {
    pendingSuggestions: pending.filter((candidate) => candidate.id !== id),
    dismissedSuggestions: Array.from(
      new Set([...(row.dismissedSuggestions || []), id]),
    ),
  });
  emit({
    ok: true,
    subcommand: "suggestions dismiss",
    summary: `Dismissed suggestion "${id}" — it won't be raised again.`,
    data: { dismissedId: id },
  });
}

async function cmd_suggestions(args) {
  const verb = args._positional[0] || "list";
  const user = requireUser(args, `suggestions ${verb}`);
  const row = await requireEnabledRow(user, `suggestions ${verb}`);
  const pending = row.pendingSuggestions || [];

  if (verb === "list") {
    emit({
      ok: true,
      subcommand: "suggestions list",
      summary:
        pending.length > 0
          ? `${pending.length} pending suggestion(s) from your recent corrections`
          : "No pending suggestions.",
      data: { suggestions: pending },
    });
    return;
  }

  if (verb === "apply") {
    await applySuggestion(args, user, row, pending);
    return;
  }

  if (verb === "dismiss") {
    await dismissSuggestion(args, user, row, pending);
    return;
  }

  bail(
    "bad-verb",
    `Unknown suggestions subcommand: ${verb} (try 'list', 'apply <id>', 'dismiss <id>')`,
    "suggestions",
  );
}

// ---------------------------------------------------------------------
// prefs — the user's plain-language preference profile (#1855)
// ---------------------------------------------------------------------

/** Cap on the stored profile. Long enough for a paragraph of guidance. */
const PREFERENCES_MAX_CHARS = 2000;

function renderContentPreferences(contentPreferences) {
  return (contentPreferences || []).map((pref) => ({
    shape: pref.shape,
    lean: pref.lean,
    count: pref.count,
    weight: pref.weight,
    inPlainWords:
      pref.lean === "later"
        ? `You usually move "${pref.shape}" mail out of the way (${pref.count} correction(s)).`
        : `You usually want "${pref.shape}" mail in front of you (${pref.count} correction(s)).`,
  }));
}

async function prefsShow(args, user, row) {
  void args;
  void user;
  const stated = row.preferences?.text || "";
  const learned = renderContentPreferences(row.contentPreferences);
  emit({
    ok: true,
    subcommand: "prefs show",
    summary: stated
      ? `Your stated preferences (${stated.length} chars) plus ${learned.length} learned pattern(s).`
      : `No stated preferences yet. ${learned.length} pattern(s) learned from your corrections.`,
    data: {
      stated,
      updatedAt: row.preferences?.updatedAt || null,
      learned,
      peopleSuggestions: row.suggestPeopleRules !== false,
    },
  });
}

async function prefsSet(args, user) {
  const [, ...rest] = requirePositional(args, 2, "prefs set");
  const text = rest.join(" ").trim();
  if (!text) {
    bail("missing-args", "Give the preference text to store", "prefs set");
  }
  if (text.length > PREFERENCES_MAX_CHARS) {
    bail(
      "too-long",
      `Preferences are capped at ${PREFERENCES_MAX_CHARS} characters (got ${text.length})`,
      "prefs set",
    );
  }
  await lib.updateRow(user, {
    preferences: { text, updatedAt: new Date().toISOString() },
  });
  emit({
    ok: true,
    subcommand: "prefs set",
    summary:
      "Saved. The classifier reads this with every message, and it outranks " +
      "the built-in heuristics when they disagree.",
    data: { stated: text },
  });
}

async function prefsClear(args, user) {
  void args;
  await lib.updateRow(user, {
    preferences: { text: "", updatedAt: new Date().toISOString() },
  });
  emit({
    ok: true,
    subcommand: "prefs clear",
    summary: "Cleared your stated preferences. Learned patterns are untouched.",
  });
}

async function prefsPeopleSuggestions(args, user) {
  const [, flag] = requirePositional(args, 2, "prefs people-suggestions");
  if (!["on", "off"].includes(flag)) {
    bail(
      "bad-value",
      `Expected 'on' or 'off' (got "${flag}")`,
      "prefs people-suggestions",
    );
  }
  const on = flag === "on";
  await lib.updateRow(user, { suggestPeopleRules: on });
  emit({
    ok: true,
    subcommand: "prefs people-suggestions",
    summary: on
      ? "Suggestions about individual people are enabled. Mute suggestions for people stay blocked either way."
      : "Suggestions about individual people are off. Only automated senders will be suggested.",
    data: { suggestPeopleRules: on },
  });
}

const PREFS_COMMANDS = {
  show: prefsShow,
  set: prefsSet,
  clear: prefsClear,
  "people-suggestions": prefsPeopleSuggestions,
};

async function cmd_prefs(args) {
  const verb = args._positional[0] || "show";
  const handler = PREFS_COMMANDS[verb];
  if (!handler) {
    bail(
      "bad-verb",
      `Unknown prefs subcommand: ${verb} (try 'show', 'set "<text>"', 'clear', 'people-suggestions on|off')`,
      "prefs",
    );
  }
  const user = requireUser(args, `prefs ${verb}`);
  const row = await requireEnabledRow(user, `prefs ${verb}`);
  await handler(args, user, row);
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
  sweep: cmd_sweep,
  suggestions: cmd_suggestions,
  prefs: cmd_prefs,
};

async function main() {
  const args = parseArgs(process.argv);
  if (!args._subcmd || args.help === true) {
    process.stdout.write(
      "Usage: psd-email-triage <subcommand> --user <email> [args]\n" +
        "Subcommands: " +
        Object.keys(COMMANDS).join(", ") +
        "\n" +
        "See /opt/psd-skills/psd-email-triage/SKILL.md for full reference.\n",
    );
    process.exit(args.help === true ? 0 : 2);
  }
  try {
    const fn = COMMANDS[args._subcmd];
    if (!fn) {
      bail(
        "unknown-subcommand",
        `Unknown subcommand: ${args._subcmd}`,
        args._subcmd,
      );
    }
    await fn(args);
  } catch (err) {
    const code = (err && err.code) || "unexpected-error";
    const msg = err && err.message ? err.message : String(err);
    const subcommand =
      err instanceof BailError && err.subcommand
        ? err.subcommand
        : args._subcmd;
    emit({ ok: false, subcommand, error: msg, code });
    process.exit(1);
  }
}

module.exports = {
  BailError,
  PREFERENCES_MAX_CHARS,
  flagList,
  flagValue,
  keywordRuleFromArgs,
  keywordRuleSelector,
  parseArgs,
  // Subcommands exercised end-to-end in run.test.js with a stubbed lib.
  rulesAddKeyword,
  rulesRemove,
  cmd_prefs,
  cmd_simulate,
  cmd_suggestions,
};

// Only run the CLI when invoked as a program; `require()` from the test
// suite must not execute a subcommand.
if (require.main === module) {
  main();
}
