/**
 * psd-email-triage CLI tests (#1855).
 *
 * The two bugs this pins are both "the CLI said it worked and it did
 * not":
 *   1. `rules add-keyword <kw> --from` stored the boolean `true`, and
 *      `rules remove keyword <value>` then reported "Removed keyword"
 *      while removing nothing — the rule was undeletable through the CLI.
 *   2. `suggestions dismiss` failed for every id because the broker's
 *      update-state allowlist had no `pendingSuggestions`.
 *
 * Run: bun test run.test.js  (or `bun run test:skill:email-triage`)
 */

'use strict';

const { test, expect, describe, beforeEach, mock } = require('bun:test');

const lib = require('./lib');

// Stub the broker. Every subcommand reads through getRow and writes
// through updateRow, so the pair is the whole I/O surface.
let currentRow;
let writes;
lib.getRow = mock(async () => currentRow);
lib.updateRow = mock(async (_user, attrs) => {
  writes.push(attrs);
  currentRow = { ...currentRow, ...attrs };
});

const run = require('./run');

const USER = 'hagelk@psd401.net';

function baseRow(over = {}) {
  return {
    userEmail: USER,
    enabled: true,
    rules: { vipSenders: [], muteSenders: [], keywordRules: [] },
    escalation: { senders: [], keywords: [], labelTriggers: ['important'] },
    ...over,
  };
}

/** Run a subcommand, capturing the JSON line it emits. */
async function invoke(fn, argv) {
  const args = run.parseArgs(['node', 'run.js', ...argv]);
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn(args);
  } finally {
    process.stdout.write = original;
  }
  return chunks.length > 0 ? JSON.parse(chunks.join('')) : null;
}

/** Run a subcommand expected to refuse; returns the BailError. */
async function invokeExpectingBail(fn, argv) {
  try {
    await invoke(fn, argv);
  } catch (err) {
    if (err instanceof run.BailError) return err;
    throw err;
  }
  throw new Error('expected the subcommand to bail, but it succeeded');
}

beforeEach(() => {
  currentRow = baseRow();
  writes = [];
});

describe('parseArgs', () => {
  test('a flag with no value is the boolean true — the trap behind bug 1', () => {
    const args = run.parseArgs(['node', 'run.js', 'rules', 'add-keyword', 'x', '--from']);
    expect(args.from).toBe(true);
  });

  test('a flag with a value keeps the value', () => {
    const args = run.parseArgs([
      'node', 'run.js', 'rules', 'add-keyword', 'x', '--from', 'vendor.com',
    ]);
    expect(args.from).toBe('vendor.com');
  });
});

describe('rules add-keyword', () => {
  test('refuses --from with no value instead of storing a boolean', () => {
    const args = run.parseArgs(['node', 'run.js', 'x', '--from']);
    expect(() => run.flagValue(args, 'from', 'rules add-keyword')).toThrow(
      /--from requires a value/,
    );
  });

  test('--label with no value is refused too', () => {
    const args = run.parseArgs(['node', 'run.js', 'x', '--label']);
    expect(() => run.flagValue(args, 'label', 'rules add-keyword')).toThrow(
      /--label requires a value/,
    );
  });

  test('every rule gets a stable, unique id', async () => {
    const first = await invoke(run.rulesAddKeyword, [
      'rules', 'add-keyword', 'newsletter', '--label', 'news', '--user', USER,
    ]);
    const second = await invoke(run.rulesAddKeyword, [
      'rules', 'add-keyword', 'invoice', '--label', 'later', '--user', USER,
    ]);
    expect(first.data.rule.id).toMatch(/^kw-/);
    expect(second.data.rule.id).not.toBe(first.data.rule.id);
  });

  test('sender and subject can live on one rule', async () => {
    const result = await invoke(run.rulesAddKeyword, [
      'rules', 'add-keyword', 'invoice',
      '--from-address', 'Vendor@Example.com',
      '--label', 'important',
      '--user', USER,
    ]);
    expect(result.data.rule).toMatchObject({
      from_address: 'vendor@example.com',
      subject_contains: 'invoice',
      label: 'important',
    });
  });

  test('--subject-any stores a list', async () => {
    const result = await invoke(run.rulesAddKeyword, [
      'rules', 'add-keyword', 'ignored',
      '--subject-any', 'invoice, receipt ,statement',
      '--label', 'news',
      '--user', USER,
    ]);
    expect(result.data.rule.subject_any).toEqual(['invoice', 'receipt', 'statement']);
  });

  test('the stored rule is always well-formed', async () => {
    const result = await invoke(run.rulesAddKeyword, [
      'rules', 'add-keyword', 'urgent', '--label', 'later', '--external', '--user', USER,
    ]);
    expect(lib.isWellFormedKeywordRule(result.data.rule)).toBe(true);
  });
});

describe('rules remove', () => {
  const malformed = { from_domain: true, label: 'later' };

  test('BUG 1: an undeletable boolean rule can be removed by index', async () => {
    currentRow = baseRow({
      rules: { vipSenders: [], muteSenders: [], keywordRules: [malformed] },
    });
    const result = await invoke(run.rulesRemove, [
      'rules', 'remove', 'keyword', '#0', '--user', USER,
    ]);
    expect(result.ok).toBe(true);
    expect(currentRow.rules.keywordRules).toEqual([]);
  });

  test('BUG 1: --malformed sweeps every unmatched entry and keeps the good ones', async () => {
    const good = { id: 'kw-good', subject_contains: 'invoice', label: 'news' };
    currentRow = baseRow({
      rules: { vipSenders: [], muteSenders: [], keywordRules: [malformed, good] },
    });
    const result = await invoke(run.rulesRemove, [
      'rules', 'remove', 'keyword', '--malformed', '--user', USER,
    ]);
    expect(result.data.removed).toBe(1);
    expect(currentRow.rules.keywordRules).toEqual([good]);
  });

  test('a rule can be removed by its id', async () => {
    const rule = { id: 'kw-abc', subject_contains: 'invoice', label: 'news' };
    currentRow = baseRow({
      rules: { vipSenders: [], muteSenders: [], keywordRules: [rule] },
    });
    await invoke(run.rulesRemove, ['rules', 'remove', 'keyword', 'kw-abc', '--user', USER]);
    expect(currentRow.rules.keywordRules).toEqual([]);
  });

  test('BUG 1: removing nothing reports not-found instead of claiming success', async () => {
    currentRow = baseRow({
      rules: {
        vipSenders: [],
        muteSenders: [],
        keywordRules: [{ id: 'kw-abc', subject_contains: 'invoice', label: 'news' }],
      },
    });
    const err = await invokeExpectingBail(run.rulesRemove, [
      'rules', 'remove', 'keyword', 'does-not-exist', '--user', USER,
    ]);
    expect(err.code).toBe('not-found');
    // Nothing was written: the rule list is untouched.
    expect(writes).toHaveLength(0);
  });

  test('a vip that is not configured reports not-found', async () => {
    const err = await invokeExpectingBail(run.rulesRemove, [
      'rules', 'remove', 'vip', 'nobody@psd401.net', '--user', USER,
    ]);
    expect(err.code).toBe('not-found');
  });

  test('a configured mute is removed and reported', async () => {
    currentRow = baseRow({
      rules: { vipSenders: [], muteSenders: ['noreply@x.com'], keywordRules: [] },
    });
    const result = await invoke(run.rulesRemove, [
      'rules', 'remove', 'mute', 'NoReply@X.com', '--user', USER,
    ]);
    expect(result.data.removed).toBe(1);
    expect(currentRow.rules.muteSenders).toEqual([]);
  });
});

describe('suggestions', () => {
  const humanMute = {
    id: 'mute:direct.report@psd401.net',
    kind: 'mute',
    target: 'direct.report@psd401.net',
    reason: 'you archived 3',
    count: 3,
    weight: 2.4,
    createdAt: '2026-10-01T00:00:00Z',
  };

  test('BUG 2: dismiss clears the suggestion and records the id', async () => {
    currentRow = baseRow({ pendingSuggestions: [humanMute] });
    const result = await invoke(run.cmd_suggestions, [
      'suggestions', 'dismiss', humanMute.id, '--user', USER,
    ]);
    expect(result.ok).toBe(true);
    // These are exactly the attributes the broker used to reject.
    expect(writes[0]).toMatchObject({
      pendingSuggestions: [],
      dismissedSuggestions: [humanMute.id],
    });
  });

  test('dismiss is idempotent for an already-dismissed id', async () => {
    currentRow = baseRow({
      pendingSuggestions: [],
      dismissedSuggestions: [humanMute.id],
    });
    const result = await invoke(run.cmd_suggestions, [
      'suggestions', 'dismiss', humanMute.id, '--user', USER,
    ]);
    expect(result.ok).toBe(true);
  });

  test('dismissing an unknown id reports not-found', async () => {
    currentRow = baseRow({ pendingSuggestions: [] });
    const err = await invokeExpectingBail(run.cmd_suggestions, [
      'suggestions', 'dismiss', 'mute:nobody@x.com', '--user', USER,
    ]);
    expect(err.code).toBe('not-found');
  });

  test('applying a mute against a person is refused without confirmation', async () => {
    currentRow = baseRow({ pendingSuggestions: [humanMute] });
    const err = await invokeExpectingBail(run.cmd_suggestions, [
      'suggestions', 'apply', humanMute.id, '--user', USER,
    ]);
    expect(err.code).toBe('needs-human-confirmation');
    expect(writes).toHaveLength(0);
  });

  test('--confirm-human lets the user override deliberately', async () => {
    currentRow = baseRow({ pendingSuggestions: [humanMute] });
    const result = await invoke(run.cmd_suggestions, [
      'suggestions', 'apply', humanMute.id, '--confirm-human', '--user', USER,
    ]);
    expect(result.ok).toBe(true);
    expect(currentRow.rules.muteSenders).toContain('direct.report@psd401.net');
  });

  test('a mute against an automated sender applies without ceremony', async () => {
    const machineMute = { ...humanMute, id: 'mute:noreply@x.com', target: 'noreply@x.com' };
    currentRow = baseRow({ pendingSuggestions: [machineMute] });
    const result = await invoke(run.cmd_suggestions, [
      'suggestions', 'apply', machineMute.id, '--user', USER,
    ]);
    expect(result.ok).toBe(true);
    expect(currentRow.rules.muteSenders).toContain('noreply@x.com');
  });
});

describe('prefs', () => {
  test('set stores the text and show reads it back', async () => {
    await invoke(run.cmd_prefs, [
      'prefs', 'set', 'FYI forwards are Later unless they ask me something.', '--user', USER,
    ]);
    expect(writes[0].preferences.text).toBe(
      'FYI forwards are Later unless they ask me something.',
    );
    const shown = await invoke(run.cmd_prefs, ['prefs', 'show', '--user', USER]);
    expect(shown.data.stated).toContain('FYI forwards are Later');
  });

  test('an over-long profile is refused rather than silently truncated', async () => {
    const err = await invokeExpectingBail(run.cmd_prefs, [
      'prefs', 'set', 'x'.repeat(run.PREFERENCES_MAX_CHARS + 1), '--user', USER,
    ]);
    expect(err.code).toBe('too-long');
  });

  test('people-suggestions off is persisted', async () => {
    await invoke(run.cmd_prefs, ['prefs', 'people-suggestions', 'off', '--user', USER]);
    expect(writes[0]).toEqual({ suggestPeopleRules: false });
  });

  test('show renders learned content preferences in plain words', async () => {
    currentRow = baseRow({
      contentPreferences: [{ shape: 'fyi', lean: 'later', weight: 2.1, count: 4 }],
    });
    const shown = await invoke(run.cmd_prefs, ['prefs', 'show', '--user', USER]);
    expect(shown.data.learned[0].inPlainWords).toContain('out of the way');
  });
});

/**
 * #1861 acceptance: "simulate shows which signal fired". Before this,
 * `simulate` emitted the raw ten-key boolean map and nothing at all on the
 * rules-decided branch, so the agent had to infer the deciding signal.
 */
describe('simulate (#1861)', () => {
  test('the reported Google Search Console blast would be labelled later', async () => {
    const out = await invoke(run.cmd_simulate, [
      'simulate',
      '--user', USER,
      '--from', 'sc-noreply@google.com',
      '--subject', 'Congrats on reaching 50 clicks in 28 days!',
      '--snippet', 'Your site is getting noticed. Think this is awesome? Go ahead and ',
      '--to', USER,
      '--list-unsubscribe', '<mailto:unsub@google.com>',
    ]);
    expect(out.data.stage).toBe('content');
    expect(out.data.decision).toEqual({
      label: 'later',
      reason: 'content:automated-notice-no-ask',
    });
    expect(out.data.signals.directQuestion).toBe(false);
    expect(out.data.firedSignals).toEqual([
      'addressedToUser',
      'broadcast',
      'informational',
      'automatedSender',
    ]);
    expect(out.summary).toContain('Content signals that fired:');
    expect(out.summary).toContain('automatedSender');
  });

  test('a colleague asking a direct question is important, and names the signal', async () => {
    const out = await invoke(run.cmd_simulate, [
      'simulate',
      '--user', USER,
      '--from', 'jsmith@psd401.net',
      '--subject', 'Chromebook refresh',
      '--snippet', 'Can you confirm the budget line for this?',
      '--to', USER,
    ]);
    expect(out.data.stage).toBe('content');
    expect(out.data.decision.reason).toBe('content:direct-question-addressed-to-you');
    expect(out.data.firedSignals).toContain('directQuestion');
  });

  test('the signals are reported even when a rule decides first', async () => {
    currentRow = baseRow({
      rules: { vipSenders: ['boss@psd401.net'], muteSenders: [], keywordRules: [] },
    });
    const out = await invoke(run.cmd_simulate, [
      'simulate',
      '--user', USER,
      '--from', 'boss@psd401.net',
      '--subject', 'Lunch',
      '--snippet', 'Nothing needed.',
      '--to', USER,
    ]);
    expect(out.data.stage).toBe('rules');
    expect(out.data.firedSignals).toEqual(['addressedToUser']);
    expect(out.summary).toContain('the rule decided first');
  });

  test('an undecided message says the model would decide, and still lists signals', async () => {
    const out = await invoke(run.cmd_simulate, [
      'simulate',
      '--user', USER,
      '--from', 'jsmith@psd401.net',
      '--subject', 'Thoughts on the vendor demo',
      '--snippet', 'That demo went about how I expected.',
      '--to', USER,
    ]);
    expect(out.data.stage).toBe('llm');
    expect(out.summary).toContain('Bedrock Nova Micro');
    expect(out.data.firedSignals).toEqual(['addressedToUser']);
  });

  test('--from is required', async () => {
    const err = await invokeExpectingBail(run.cmd_simulate, [
      'simulate', '--user', USER,
    ]);
    expect(err.code).toBe('missing-from');
  });
});
