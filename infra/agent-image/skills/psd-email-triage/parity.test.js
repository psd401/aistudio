/**
 * lib.js ↔ Lambda parity (#1855 review).
 *
 * lib.js hand-ports the classifier Lambda's rules engine (rules.ts) and
 * content stage (content-features.ts), because the skill ships in the
 * agent image and cannot import the Lambda's code. The port is what
 * `simulate` and the `suggestions apply --confirm-human` gate run on, so
 * drift means the CLI tells the user something the classifier will not
 * do. This runs both copies over the same fixture corpus and fails on any
 * difference.
 *
 * Run: bun test parity.test.js  (part of `bun run test:skill:email-triage`)
 */

'use strict';

const { test, expect, describe } = require('bun:test');

const lib = require('./lib');
const tsRules = require('../../../lambdas/agent-triage-poll/rules.ts');
const tsContent = require('../../../lambdas/agent-triage-poll/content-features.ts');

const USER = 'user@psd401.net';

const SENDERS = [
  'jsmith@psd401.net',
  'dave.stitt@psd401.net',
  'health@aws.com',
  'UPPER@Example.COM',
  'noreply@vendor.com',
  'no-reply@vendor.io',
  'notifications@github.com',
  'mailer-daemon@googlemail.com',
  'bounce+abc@lists.example.org',
  'serv_payroll@psd401.net',
  'svc-backup@psd401.net',
  'tsd-helpdesk@psd401.net',
  '',
];

const MANY = Array.from({ length: 10 }, (_, i) => `p${i}@psd401.net`).join(', ');
// `n` recipients in total, the user included — straddles the broadcast threshold.
const recipients = (n) =>
  [USER, ...Array.from({ length: n - 1 }, (_, i) => `r${i}@psd401.net`)].join(', ');

const HEADERS = [
  {},
  { to: USER },
  { to: `"User Name" <User@psd401.net>`, inReplyTo: '<a@b>' },
  { to: 'someone@psd401.net', cc: USER },
  { to: `${USER}, ${MANY}` },
  { to: recipients(7) },
  { to: recipients(8) },
  { to: recipients(4), cc: recipients(5) },
  { to: USER, listUnsubscribe: '<mailto:unsub@x.com>' },
  { to: USER, autoSubmitted: 'auto-generated' },
  { to: USER, precedence: 'bulk' },
  { to: USER, references: '<x@y>' },
];

const TEXTS = [
  { subject: '', body: '' },
  { subject: 'Approval needed: PO 4411', body: 'Please approve the attached purchase order.' },
  { subject: 'Quick question', body: 'Can you send me the agenda?' },
  { subject: 'Please review', body: 'Please review the draft and let me know.' },
  { subject: 'Board packet', body: 'Need this by Friday, no later than 5pm.' },
  { subject: 'FYI', body: 'No action needed — just a status update for your records.' },
  { subject: 'Weekly digest', body: 'Here is your weekly summary of activity.' },
  { subject: 'Confirm', body: 'Please approve your subscription to keep receiving emails.' },
  { subject: 'Long thread', body: `${'filler text '.repeat(60)} can you call me?` },
  { subject: 'AWS Health Event', body: 'Your EC2 instance is scheduled for retirement. Action required.' },
  // #1861: rhetorical marketing question + bulk footer boilerplate.
  {
    subject: 'Congrats on reaching 50 clicks in 28 days!',
    body: 'Your site is getting noticed. Think this is awesome? Go ahead and share it.',
  },
  { subject: 'Want to see more?', body: 'Unsubscribe at any time.' },
  { subject: 'Any update on your section?', body: 'Let me know where it landed.' },
  { subject: 'Great news!', body: 'Isn’t it time? Act now. You are receiving this because you signed up.' },
];

function contentCases() {
  const cases = [];
  for (const fromEmail of SENDERS) {
    for (const headers of HEADERS) {
      for (const text of TEXTS) {
        for (const hasUserReply of [false, true]) {
          cases.push({
            subject: text.subject,
            body: text.body,
            headers,
            userEmail: USER,
            hasUserReply,
            fromEmail: fromEmail.toLowerCase(),
          });
        }
      }
    }
  }
  return cases;
}

const RULES = {
  vipSenders: ['boss@psd401.net'],
  muteSenders: ['noreply@*', '*.vendor.io', 'notifications@github.com', 'a*a'],
  keywordRules: [
    { id: 'k1', subject_contains: 'invoice', label: 'later' },
    { id: 'k2', snippet_contains: 'action required', external: true, label: 'important' },
    { id: 'k3', from_domain: 'aws.com', subject_any: ['health', 'billing'], label: 'news' },
    { id: 'k4', from_address: 'jsmith@psd401.net', subject_contains: 'board', label: 'important' },
    { id: 'k5', snippet_any: ['digest', 'summary'], label: 'news' },
    // Malformed legacy shapes: bare `--from` stored `true`, empty lists.
    { from_domain: true, label: 'later' },
    { subject_any: [], label: 'later' },
    { label: 'news' },
  ],
};

function featureCases() {
  const cases = [];
  for (const fromEmail of [...SENDERS, 'boss@psd401.net', 'x@a.vendor.io', 'aa']) {
    const lower = fromEmail.toLowerCase();
    const fromDomain = lower.split('@')[1] || '';
    for (const text of [...TEXTS, { subject: 'Invoice #22', body: '' }, { subject: 'Board vote', body: '' }]) {
      for (const hasUserReply of [false, true]) {
        cases.push({
          fromEmail: lower,
          fromDomain,
          isInternal: fromDomain === 'psd401.net',
          subject: text.subject,
          subjectLower: text.subject.toLowerCase(),
          snippetLower: text.body.toLowerCase(),
          hasUserReply,
        });
      }
    }
  }
  return cases;
}

// A labelled pair so a failure names the exact input that diverged.
function same(name, input, jsOut, tsOut) {
  expect({ name, input, out: jsOut }).toEqual({ name, input, out: tsOut });
}

describe('content stage parity', () => {
  const cases = contentCases();

  test('corpus is non-trivial', () => {
    expect(cases.length).toBeGreaterThan(2000);
    // Every branch of classifyByContent is reached, so agreement means something.
    const labels = new Set(cases.map((c) => tsContent.classifyByContent(tsContent.detectContentSignals(c))?.label ?? 'llm'));
    expect([...labels].sort()).toEqual(['important', 'later', 'llm']);
  });

  test('detectContentSignals / hasAsk / classifyByContent agree', () => {
    for (const input of cases) {
      const js = lib.detectContentSignals(input);
      const ts = tsContent.detectContentSignals(input);
      same('detectContentSignals', input, js, ts);
      same('hasAsk', input, lib.hasAsk(js), tsContent.hasAsk(ts));
      same('classifyByContent', input, lib.classifyByContent(js), tsContent.classifyByContent(ts));
      // #1861: `simulate` prints firedContentSignals, so a drift here
      // would have the CLI name a different signal than the classifier.
      same(
        'firedContentSignals',
        input,
        lib.firedContentSignals(js),
        tsContent.firedContentSignals(ts),
      );
    }
  });

  test('the marketing-footer phrase lists are identical (#1861)', () => {
    // The one duplicated DATA structure across the two copies. The corpus
    // below cannot catch a phrase added to only one side, so pin it here.
    expect(lib.MARKETING_FOOTER_PHRASES).toEqual(
      tsContent.MARKETING_FOOTER_PHRASES,
    );
  });

  test('hasDirectQuestion agrees (#1861)', () => {
    const texts = [
      '',
      'no question here',
      '?',
      'Think this is awesome?',
      'Can you confirm the budget line for this?',
      'Thoughts?',
      'Want to see your top queries?',
      'Think this is awesome? Go ahead and share your success.',
      'Great news! Are you ready?',
      'Why does this matter? Because your data says so.',
      'line one\nis this yours?',
      'Nope. Not for you. Right?',
    ];
    for (const text of texts) {
      same(
        'hasDirectQuestion',
        { text },
        lib.hasDirectQuestion(text),
        tsContent.hasDirectQuestion(text),
      );
    }
  });

  test('isAutomatedSender agrees, with and without headers', () => {
    for (const fromEmail of SENDERS) {
      same('isAutomatedSender', { fromEmail }, lib.isAutomatedSender(fromEmail), tsContent.isAutomatedSender(fromEmail));
      for (const headers of HEADERS) {
        same(
          'isAutomatedSender',
          { fromEmail, headers },
          lib.isAutomatedSender(fromEmail, headers),
          tsContent.isAutomatedSender(fromEmail, headers),
        );
      }
    }
  });

  test('parseAddressList agrees', () => {
    for (const value of [undefined, '', USER, `"A, B" <a@b.com>, c@d.com`, `${USER}, ${MANY}`, 'not an address']) {
      same('parseAddressList', { value }, lib.parseAddressList(value), tsContent.parseAddressList(value));
    }
  });
});

describe('rules engine parity', () => {
  test('applyRules agrees', () => {
    for (const features of featureCases()) {
      same('applyRules', features, lib.applyRules(features, RULES), tsRules.applyRules(features, RULES));
    }
  });

  test('keyword rule helpers agree', () => {
    for (const rule of RULES.keywordRules) {
      same('isWellFormedKeywordRule', rule, lib.isWellFormedKeywordRule(rule), tsRules.isWellFormedKeywordRule(rule));
      same('describeKeywordRule', rule, lib.describeKeywordRule(rule), tsRules.describeKeywordRule(rule));
    }
  });

  test('wildcardMatch agrees', () => {
    const patterns = ['*', 'a*a', 'aa*aa', 'noreply@*', '*.vendor.io', 'exact@x.com', '*@*', ''];
    const values = ['', 'a', 'aa', 'aaa', 'aaaa', 'noreply@x.com', 'x.vendor.io', 'exact@x.com', 'EXACT@X.COM'];
    for (const pattern of patterns) {
      for (const value of values) {
        same('wildcardMatch', { pattern, value }, lib.wildcardMatch(pattern, value), tsRules.wildcardMatch(pattern, value));
      }
    }
  });
});
