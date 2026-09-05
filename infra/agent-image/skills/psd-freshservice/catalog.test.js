/**
 * psd-freshservice Service Catalog command tests.
 *
 * Run: node --test   (from infra/agent-image/skills/psd-freshservice/)
 *
 * These drive the REAL CLIs as subprocesses with real arguments. The failure
 * these commands exist to fix — the agent searched the catalog, found nothing,
 * and offered a plain ticket instead — was a MISSING capability, so the tests
 * that matter here are about what the commands accept, what they refuse, and
 * whether their refusals tell the caller what to do next.
 *
 * The Freshservice hop itself is not exercised: every command reaches it only
 * through the owner-bound broker, whose (method, path) allowlist is pinned
 * separately in tests/unit/lib/agent-credentials/freshservice-broker.test.ts.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CREATE = path.join(__dirname, 'create_catalog_item.js');
const LIST = path.join(__dirname, 'list_catalog_categories.js');
const USER = 'hagelk@psd401.net';

function run(script, args) {
  const result = spawnSync('node', [script, ...args], { encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(String(result.stdout || '').trim());
  } catch {
    /* help output is not JSON */
  }
  return { code: result.status, stdout: result.stdout || '', json };
}

// assert.ok alone reports "false == true", which says nothing about which
// substring was missing from what. Every containment check here is load-bearing
// wording, so the message has to name both sides.
function assertContains(haystack, needle, label) {
  const text = String(haystack);
  assert.ok(
    text.includes(needle),
    `${label} must contain ${JSON.stringify(needle)} — got: ${text}`
  );
}

describe('create_catalog_item', () => {
  test('--help lists every settable field', () => {
    const result = run(CREATE, ['--help']);
    assert.strictEqual(result.code, 0);
    for (const field of ['name', 'category_id', 'custom_fields']) {
      assertContains(result.stdout, field, '--help output');
    }
  });

  test('requires an identity', () => {
    const result = run(CREATE, ['--data', '{"name":"x","category_id":1}']);
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.json.error, 'bad_args');
  });

  test('requires a name', () => {
    const result = run(CREATE, ['--user', USER, '--data', '{"category_id":12}']);
    assert.strictEqual(result.code, 1);
    assertContains(result.json.message, 'name', 'refusal message');
  });

  for (const [data, label] of [
    ['{"name":"Hotel"}', 'missing'],
    ['{"name":"Hotel","category_id":"12"}', 'string'],
    ['{"name":"Hotel","category_id":0}', 'zero'],
    ['{"name":"Hotel","category_id":-3}', 'negative'],
  ]) {
    test(`refuses a ${label} category_id and says where to find one`, () => {
      const result = run(CREATE, ['--user', USER, '--data', data]);
      assert.strictEqual(result.code, 1);
      assert.strictEqual(result.json.error, 'bad_args');
      // The refusal has to name the command that produces the id, or the caller
      // is stuck exactly where the original request was.
      assertContains(
        result.json.message,
        'list_catalog_categories.js',
        'refusal message'
      );
    });
  }

  test('names an unsettable field instead of silently dropping it', () => {
    const result = run(CREATE, [
      '--user',
      USER,
      '--data',
      '{"name":"Hotel","category_id":12,"workspace_admin":true}',
    ]);
    assert.strictEqual(result.code, 1);
    assertContains(result.json.message, 'workspace_admin', 'refusal message');
  });

  test('rejects custom_fields that is not an object', () => {
    const result = run(CREATE, [
      '--user',
      USER,
      '--data',
      '{"name":"Hotel","category_id":12,"custom_fields":["a"]}',
    ]);
    assert.strictEqual(result.code, 1);
    assertContains(result.json.message, 'custom_fields', 'refusal message');
  });

  test('a 403 is reported as a role gap, never as a bad key', () => {
    // Read the source rather than forcing a live 403: the load-bearing property
    // is the WORDING. Four callers were sent to re-issue perfectly good keys by
    // the generic 403 message (2026-08-17), and this endpoint 403s for almost
    // everyone because catalog admin is rare.
    // Concatenation is collapsed first so the assertions test the MESSAGE the
    // caller reads, not the source's line wrapping.
    const source = fs.readFileSync(CREATE, 'utf8').replace(/'\s*\+\s*'/g, '');
    assertContains(source, 'catalog_admin_required', 'create_catalog_item.js');
    assertContains(source, 'does NOT need to be re-issued', 'create_catalog_item.js');
    assertContains(source, 'catalog-admin', 'create_catalog_item.js');
  });
});

describe('list_catalog_categories', () => {
  test('--help explains the categories/items split', () => {
    const result = run(LIST, ['--help']);
    assert.strictEqual(result.code, 0);
    assertContains(result.stdout, 'CATEGORIES', '--help output');
    assertContains(result.stdout, 'ITEMS', '--help output');
  });

  test('requires an identity', () => {
    const result = run(LIST, []);
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.json.error, 'bad_args');
  });

  for (const id of ['1;DROP', 'abc', '../12', '1 OR 1=1']) {
    test(`refuses a non-numeric --category-id ${id}`, () => {
      const result = run(LIST, ['--user', USER, '--category-id', id]);
      assert.strictEqual(result.code, 1);
      assertContains(result.json.message, 'numeric', 'refusal message');
    });
  }

  for (const term of ['a/b', 'x'.repeat(101), 'drop<table>']) {
    test(`refuses a --search value the broker query grammar would reject: ${term}`, () => {
      const result = run(LIST, ['--user', USER, '--search', term]);
      assert.strictEqual(result.code, 1);
      assert.strictEqual(result.json.error, 'bad_args');
    });
  }
});

describe('SKILL.md documents the capability honestly', () => {
  const skill = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');

  test('distinguishes a catalog item from a ticket', () => {
    assertContains(skill, '## Service Catalog', 'SKILL.md');
    assert.match(skill, /offering a ticket instead does not do it/i);
  });

  test('states the two real limits rather than letting them surprise', () => {
    assert.match(skill, /No icon and no attachments/i);
    assert.match(skill, /No editing or deleting/i);
  });

  test('states that a 403 means catalog-admin, not a bad key', () => {
    assert.match(skill, /403 here means catalog-admin, not a bad key/i);
    assertContains(skill, 'catalog_admin_required', 'SKILL.md');
  });

  test('is discoverable by the words a caller would use', () => {
    // skills.search matches NAME and SUMMARY only — never description — so
    // "catalog" has to be in the summary line or this capability is
    // unreachable by search, which is how it went unnoticed in the first place.
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter, 'SKILL.md must open with a YAML frontmatter block');
    const summary = frontmatter[1].match(/^summary:\s*(.+)$/m);
    assert.ok(summary, 'SKILL.md frontmatter must carry a summary: line');
    assertContains(summary[1].toLowerCase(), 'catalog', 'SKILL.md summary line');
  });
});
