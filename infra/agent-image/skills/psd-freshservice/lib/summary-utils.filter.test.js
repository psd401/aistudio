'use strict';
// Tests for searchClosedTickets date-only query + client-side filtering (#1228).
//
// Freshservice's /tickets/filter rejects full ISO timestamps on updated_at
// (unconditional 400) and only accepts 'yyyy-mm-dd'. searchClosedTickets must:
//   1. build a DATE-ONLY query (no 'T...Z' timestamp), widened on each side, and
//   2. re-apply the exact time-of-day boundaries client-side on the results.
//
// fsFetch is mocked on the ./api module BEFORE summary-utils is required, so
// summary-utils captures the mock in its destructured `require('./api')`.
// `node --test` runs each test file in its own process, so this cache surgery
// is isolated from the sibling summary-utils.test.js.
//
// Run: node --test   (from infra/agent-image/skills/psd-freshservice/)

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const apiPath = require.resolve('./api');
require(apiPath); // ensure the module is cached before we patch it

let capturedUrls = [];
let ticketPages = [];
let forceError = null;
require.cache[apiPath].exports.fsFetch = async (_apiKey, url) => {
  capturedUrls.push(url);
  if (forceError) return { __ok: false, error: forceError };
  if (url.startsWith('/tickets/filter')) {
    const m = url.match(/page=(\d+)/);
    const page = m ? Number(m[1]) : 1;
    return { __ok: true, data: { tickets: ticketPages[page - 1] || [] } };
  }
  return { __ok: false, error: `unexpected path ${url}` };
};

const { searchClosedTickets } = require('./summary-utils');

// A single Pacific business day (2026-07-09) expressed with local Date
// constructors — the exact shape get_daily_summary.js produces.
const dayStart = () => new Date(2026, 6, 9, 0, 0, 0);
const dayEnd = () => new Date(2026, 6, 9, 23, 59, 59);

beforeEach(() => {
  capturedUrls = [];
  ticketPages = [];
  forceError = null;
});

test('query uses date-only yyyy-mm-dd boundaries, never a full ISO timestamp', async () => {
  ticketPages = [[]];
  await searchClosedTickets('key', dayStart(), dayEnd(), 2);
  const decoded = decodeURIComponent(capturedUrls[0]);
  assert.ok(/updated_at:>'\d{4}-\d{2}-\d{2}'/.test(decoded), `expected date-only lower bound: ${decoded}`);
  assert.ok(/updated_at:<'\d{4}-\d{2}-\d{2}'/.test(decoded), `expected date-only upper bound: ${decoded}`);
  // Regression: the bug shipped a full timestamp (…T07:00:00.000Z) which 400s.
  assert.ok(!/updated_at:[<>]'[^']*T[^']*'/.test(decoded), `boundary must not include a time component: ${decoded}`);
  assert.ok(!decoded.includes('.000Z'), `must not include a full ISO timestamp: ${decoded}`);
});

test('widened query window brackets the requested range by 2 days each side', async () => {
  ticketPages = [[]];
  await searchClosedTickets('key', dayStart(), dayEnd(), 2);
  const decoded = decodeURIComponent(capturedUrls[0]);
  const lower = decoded.match(/updated_at:>'(\d{4}-\d{2}-\d{2})'/)[1];
  const upper = decoded.match(/updated_at:<'(\d{4}-\d{2}-\d{2})'/)[1];
  assert.strictEqual(lower, '2026-07-07'); // start - 2 days
  assert.strictEqual(upper, '2026-07-11'); // end + 2 days
});

test('client-side filter drops tickets outside the exact [start, end] instants', async () => {
  const inRange1 = new Date(2026, 6, 9, 8, 0, 0).toISOString();
  const inRange2 = new Date(2026, 6, 9, 22, 30, 0).toISOString();
  const before = new Date(2026, 6, 8, 12, 0, 0).toISOString();   // day before
  const after = new Date(2026, 6, 10, 1, 0, 0).toISOString();    // day after
  ticketPages = [[
    { id: 1, updated_at: inRange1, responder_id: 5 },
    { id: 2, updated_at: inRange2, responder_id: 6 },
    { id: 3, updated_at: before, responder_id: 7 },
    { id: 4, updated_at: after, responder_id: 8 },
    { id: 5, updated_at: undefined, responder_id: 9 }, // unparseable -> dropped
  ]];
  const res = await searchClosedTickets('key', dayStart(), dayEnd(), 2);
  assert.deepStrictEqual(res.tickets.map((t) => t.id), [1, 2]);
  assert.strictEqual(res.truncated, false);
});

test('boundary instants (exactly start and end) are inclusive', async () => {
  ticketPages = [[
    { id: 1, updated_at: dayStart().toISOString(), responder_id: 1 },
    { id: 2, updated_at: dayEnd().toISOString(), responder_id: 2 },
  ]];
  const res = await searchClosedTickets('key', dayStart(), dayEnd(), 2);
  assert.deepStrictEqual(res.tickets.map((t) => t.id), [1, 2]);
});

test('pagination continues on full pages and stops on a short page', async () => {
  const inRangeTs = new Date(2026, 6, 9, 10, 0, 0).toISOString();
  const mk = (n, base) => Array.from({ length: n }, (_, i) => ({ id: base + i, updated_at: inRangeTs, responder_id: 1 }));
  ticketPages = [mk(100, 0), mk(50, 100)];
  const res = await searchClosedTickets('key', dayStart(), dayEnd(), 2);
  assert.strictEqual(res.tickets.length, 150);
  assert.ok(capturedUrls.some((u) => u.includes('page=1')), 'should request page 1');
  assert.ok(capturedUrls.some((u) => u.includes('page=2')), 'should request page 2');
});

test('upstream error is surfaced without throwing', async () => {
  forceError = 'boom';
  const res = await searchClosedTickets('key', dayStart(), dayEnd(), 2);
  assert.strictEqual(res.error, 'boom');
});
