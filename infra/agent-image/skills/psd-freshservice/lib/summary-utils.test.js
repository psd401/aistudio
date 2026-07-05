'use strict';
// Tests for fetchAgentMap empty-array gating (REV-COR-332).
//
// An empty responder list (weekend/holiday with zero closed tickets) must NOT
// trigger the full-roster pagination fallback — it should be a no-op. Targeted
// and omitted (full-roster) paths must behave as before.
//
// fsFetch is mocked by replacing it on the ./api module's exports BEFORE
// summary-utils is required, so summary-utils captures the mock in its
// destructured `const { fsFetch } = require('./api')`. `node --test` runs each
// test file in its own process, so this cache surgery is isolated.
//
// Run: node --test   (from infra/agent-image/skills/psd-freshservice/)

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const apiPath = require.resolve('./api');
require(apiPath); // ensure the module is in the cache before we patch it

let calls = [];
require.cache[apiPath].exports.fsFetch = async (_apiKey, p) => {
  calls.push(p);
  if (p.startsWith('/agents/')) {
    const id = Number(p.slice('/agents/'.length));
    return { __ok: true, data: { agent: { id, first_name: 'First', last_name: `L${id}`, job_title: 'Tech' } } };
  }
  if (p.startsWith('/agents?')) {
    // Single short page (< 100) so pagination stops after one call.
    return { __ok: true, data: { agents: [{ id: 1, first_name: 'Ros', last_name: 'Ter' }] } };
  }
  return { __ok: false, error: `unexpected path ${p}` };
};

const { fetchAgentMap } = require('./summary-utils');

const agentKeys = (map) => Object.keys(map).filter((k) => k !== '__partialNames');

beforeEach(() => {
  calls = [];
});

test('empty array performs zero /agents calls and returns an empty map', async () => {
  const map = await fetchAgentMap('key', []);
  assert.strictEqual(calls.length, 0, `expected 0 API calls, saw ${JSON.stringify(calls)}`);
  assert.strictEqual(map.__partialNames, false);
  assert.deepStrictEqual(agentKeys(map), []);
});

test('targeted ids fetch only /agents/<id> — no roster pagination', async () => {
  const map = await fetchAgentMap('key', [123, 456]);
  assert.deepStrictEqual(new Set(calls), new Set(['/agents/123', '/agents/456']));
  assert.ok(!calls.some((p) => p.startsWith('/agents?')), 'must not paginate the roster');
  assert.ok(map[123] && map[456]);
  assert.strictEqual(map.__partialNames, false);
});

test('duplicate ids collapse to one call each', async () => {
  await fetchAgentMap('key', [7, 7, 7]);
  assert.deepStrictEqual(calls, ['/agents/7']);
});

test('undefined still paginates the full roster', async () => {
  const map = await fetchAgentMap('key', undefined);
  assert.ok(calls.some((p) => p.startsWith('/agents?per_page=100')), 'should page the roster');
  assert.ok(map[1], 'roster entry should be present');
});

test('non-array, non-null argument throws (type guard preserved)', async () => {
  await assert.rejects(() => fetchAgentMap('key', 123), /must be an array/);
});

test('null/undefined responder ids (unassigned tickets) are filtered out, not fetched (gemini-code-assist review)', async () => {
  const map = await fetchAgentMap('key', [123, null, undefined, 123]);
  assert.deepStrictEqual(calls, ['/agents/123'], `expected only /agents/123, saw ${JSON.stringify(calls)}`);
  assert.strictEqual(map.__partialNames, false);
});
