/**
 * psd-freshservice Service Catalog command tests.
 *
 * Run: bun test catalog.test.js   (from this directory)
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

const { test, expect, describe } = require('bun:test');
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

describe('create_catalog_item', () => {
  test('--help lists every settable field', () => {
    const result = run(CREATE, ['--help']);
    expect(result.code).toBe(0);
    for (const field of ['name', 'category_id', 'custom_fields']) {
      expect(result.stdout).toContain(field);
    }
  });

  test('requires an identity', () => {
    const result = run(CREATE, ['--data', '{"name":"x","category_id":1}']);
    expect(result.code).toBe(1);
    expect(result.json.error).toBe('bad_args');
  });

  test('requires a name', () => {
    const result = run(CREATE, ['--user', USER, '--data', '{"category_id":12}']);
    expect(result.code).toBe(1);
    expect(result.json.message).toContain('name');
  });

  test.each([
    ['{"name":"Hotel"}', 'missing'],
    ['{"name":"Hotel","category_id":"12"}', 'string'],
    ['{"name":"Hotel","category_id":0}', 'zero'],
    ['{"name":"Hotel","category_id":-3}', 'negative'],
  ])('refuses category_id %s and says where to find one', (data) => {
    const result = run(CREATE, ['--user', USER, '--data', data]);
    expect(result.code).toBe(1);
    expect(result.json.error).toBe('bad_args');
    // The refusal has to name the command that produces the id, or the caller
    // is stuck exactly where the original request was.
    expect(result.json.message).toContain('list_catalog_categories.js');
  });

  test('names an unsettable field instead of silently dropping it', () => {
    const result = run(CREATE, [
      '--user',
      USER,
      '--data',
      '{"name":"Hotel","category_id":12,"workspace_admin":true}',
    ]);
    expect(result.code).toBe(1);
    expect(result.json.message).toContain('workspace_admin');
  });

  test('rejects custom_fields that is not an object', () => {
    const result = run(CREATE, [
      '--user',
      USER,
      '--data',
      '{"name":"Hotel","category_id":12,"custom_fields":["a"]}',
    ]);
    expect(result.code).toBe(1);
    expect(result.json.message).toContain('custom_fields');
  });

  test('a 403 is reported as a role gap, never as a bad key', () => {
    // Read the source rather than forcing a live 403: the load-bearing property
    // is the WORDING. Four callers were sent to re-issue perfectly good keys by
    // the generic 403 message (2026-08-17), and this endpoint 403s for almost
    // everyone because catalog admin is rare.
    // Concatenation is collapsed first so the assertions test the MESSAGE the
    // caller reads, not the source's line wrapping.
    const source = fs
      .readFileSync(CREATE, 'utf8')
      .replace(/'\s*\+\s*'/g, '');
    expect(source).toContain('catalog_admin_required');
    expect(source).toContain('does NOT need to be re-issued');
    expect(source).toContain('catalog-admin');
  });
});

describe('list_catalog_categories', () => {
  test('--help explains the categories/items split', () => {
    const result = run(LIST, ['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('CATEGORIES');
    expect(result.stdout).toContain('ITEMS');
  });

  test('requires an identity', () => {
    const result = run(LIST, []);
    expect(result.code).toBe(1);
    expect(result.json.error).toBe('bad_args');
  });

  test.each(['1;DROP', 'abc', '../12', '1 OR 1=1'])(
    'refuses a non-numeric --category-id %s',
    (id) => {
      const result = run(LIST, ['--user', USER, '--category-id', id]);
      expect(result.code).toBe(1);
      expect(result.json.message).toContain('numeric');
    }
  );

  test.each(['a/b', 'x'.repeat(101), 'drop<table>'])(
    'refuses a --search value the broker query grammar would reject: %s',
    (term) => {
      const result = run(LIST, ['--user', USER, '--search', term]);
      expect(result.code).toBe(1);
      expect(result.json.error).toBe('bad_args');
    }
  );
});

describe('SKILL.md documents the capability honestly', () => {
  const skill = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');

  test('distinguishes a catalog item from a ticket', () => {
    expect(skill).toContain('## Service Catalog');
    expect(skill).toMatch(/offering a ticket instead does not do it/i);
  });

  test('states the two real limits rather than letting them surprise', () => {
    expect(skill).toMatch(/No icon and no attachments/i);
    expect(skill).toMatch(/No editing or deleting/i);
  });

  test('states that a 403 means catalog-admin, not a bad key', () => {
    expect(skill).toMatch(/403 here means catalog-admin, not a bad key/i);
    expect(skill).toContain('catalog_admin_required');
  });

  test('is discoverable by the words a caller would use', () => {
    // skills.search matches NAME and SUMMARY only — never description — so
    // "catalog" has to be in the summary line or this capability is
    // unreachable by search, which is how it went unnoticed in the first place.
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatter).not.toBeNull();
    const summary = frontmatter[1].match(/^summary:\s*(.+)$/m);
    expect(summary).not.toBeNull();
    expect(summary[1].toLowerCase()).toContain('catalog');
  });
});
