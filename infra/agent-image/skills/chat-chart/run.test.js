'use strict';
// Tests for chat-chart's fail-closed engine selection (REV-INFRA-002).
//
// The local (on-host matplotlib) engine is disabled in this build, so the only
// render engine is QuickChart, which transmits chart data to third-party
// quickchart.io. chooseEngine() must therefore REFUSE (never return
// 'quickchart') for --sensitive or PII-matching data in auto mode, while still
// allowing genuinely public data through.
//
// Run: node --test   (from infra/agent-image/skills/chat-chart/)

const { test } = require('node:test');
const assert = require('node:assert');

const { chooseEngine } = require('./run.js');

test('--sensitive data is refused, not routed to quickchart', () => {
  const r = chooseEngine({ '--sensitive': true }, 'apples 5, oranges 3');
  assert.strictEqual(r.engine, 'refuse');
  assert.notStrictEqual(r.engine, 'quickchart');
});

test('no quickchart.io URL is produced for --sensitive input', () => {
  // engine==='refuse' means main() calls fail() before renderQuickChart(), so
  // no quickchart.io URL is ever constructed. Assert the load-bearing decision.
  const r = chooseEngine({ '--sensitive': true }, 'anything');
  assert.strictEqual(r.engine, 'refuse');
  assert.ok(!String(r.reason).includes('https://quickchart.io'));
});

test('PII-matching data is refused in auto mode', () => {
  const r = chooseEngine({}, 'contact a@b.com for details');
  assert.strictEqual(r.engine, 'refuse');
});

test('each PII pattern (email/ssn/phone/student-id) triggers refusal', () => {
  const samples = {
    email: 'reach me at a@b.com',
    ssn: 'ssn 123-45-6789',
    'us-phone': 'call (206) 555-1212 today',
    'psd-student-id': 'student 2123456 enrolled',
  };
  for (const [label, data] of Object.entries(samples)) {
    assert.strictEqual(
      chooseEngine({}, data).engine,
      'refuse',
      `expected refusal for ${label}: "${data}"`,
    );
  }
});

test('genuinely public data still renders via quickchart', () => {
  const r = chooseEngine({}, 'apples 5, oranges 3, pears 7');
  assert.strictEqual(r.engine, 'quickchart');
});

test('explicit --engine quickchart for public data is unchanged', () => {
  const r = chooseEngine({ '--engine': 'quickchart' }, 'apples 5');
  assert.strictEqual(r.engine, 'quickchart');
  assert.strictEqual(r.reason, 'explicit');
});
