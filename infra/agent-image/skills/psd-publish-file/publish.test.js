/**
 * psd-publish-file end-to-end tests.
 *
 * Run: bun test publish.test.js   (from this directory)
 *
 * These drive the REAL CLI as a subprocess with real arguments — the failure
 * this skill exists to fix (`drive +upload` refused with an operation name and
 * no alternative) was invisible to unit-level assertions, so the tests here
 * check what a caller actually sees on stdout and in the exit code.
 *
 * The only thing stubbed is the network hop: `_shared/agent-broker.js` is
 * replaced through a NODE_PATH-free module shim so `publishArtifact` talks to a
 * fake broker instead of the web tier.
 */

'use strict';

const { test, expect, describe, beforeAll, afterAll } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { validatedFs } = require('../../../validated-fs.cjs');

const CLI = path.join(__dirname, 'publish.js');
let workspace;

// Written through the same containment wrapper the skill itself uses, so a
// fixture path that escaped the temporary root would fail here rather than
// silently touching the developer's filesystem.
function write(name, contents) {
  const file = path.join(workspace, name);
  validatedFs.writeFileSync(file, contents);
  return file;
}

/** Run the CLI and return { code, stdout, stderr, json }. */
function run(args, env = {}) {
  const result = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    // Run from the repo root so validated-fs.cjs and node_modules resolve the
    // same way they do in the container.
    cwd: path.join(__dirname, '..', '..', '..', '..'),
    env: { ...process.env, ...env },
  });
  let json = null;
  try {
    json = JSON.parse(String(result.stdout || '').trim());
  } catch {
    /* help output is not JSON */
  }
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    json,
  };
}

beforeAll(() => {
  // os.tmpdir(), not an arbitrary path: validated-fs.cjs refuses reads outside
  // the working directory and the temporary roots.
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-file-test-'));
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('argument handling', () => {
  test('--help lists every publishable extension', () => {
    const result = run(['--help']);
    expect(result.code).toBe(0);
    for (const extension of ['.pdf', '.png', '.csv', '.mp4']) {
      expect(result.stdout).toContain(extension);
    }
  });

  test('--file is required', () => {
    const result = run([]);
    expect(result.code).toBe(1);
    expect(result.json.error).toBe('bad_args');
  });

  test('a positional argument is refused rather than ignored', () => {
    const result = run([write('notes.txt', 'hello')]);
    expect(result.code).toBe(1);
    expect(result.json.error).toBe('bad_args');
  });

  test('a missing file names itself', () => {
    const result = run(['--file', path.join(workspace, 'absent.pdf')]);
    expect(result.code).toBe(1);
    expect(result.json.error).toBe('bad_args');
    expect(result.json.message).toContain('absent.pdf');
  });

  test('an empty file is refused', () => {
    const result = run(['--file', write('empty.csv', '')]);
    expect(result.code).toBe(1);
    expect(result.json.message).toContain('empty');
  });
});

describe('type gate', () => {
  test('HTML is sent to Atrium, not published as a public file', () => {
    const result = run(['--file', write('page.html', '<!doctype html><title>x</title>')]);
    expect(result.code).toBe(1);
    expect(result.json.error).toBe('html_goes_to_atrium');
    // The refusal has to carry the command that DOES work — a bare refusal is
    // the failure mode this whole skill exists to remove.
    expect(result.json.message).toContain('psd-html-artifact/deliver.js');
  });

  test('an unsupported extension lists what is supported', () => {
    const result = run(['--file', write('archive.zip', 'PK')]);
    expect(result.code).toBe(1);
    expect(result.json.error).toBe('unsupported_type');
    expect(result.json.message).toContain('.pdf');
  });

  test('a content type that disagrees with the extension is refused', () => {
    const result = run([
      '--file',
      write('rows.csv', 'a,b\n1,2\n'),
      '--content-type',
      'application/pdf',
    ]);
    expect(result.code).toBe(1);
    expect(result.json.error).toBe('bad_args');
  });

  test('a valueless --content-type is refused, not silently ignored', () => {
    // parseArgs yields boolean true for a flag with no value. That used to fall
    // straight through the `typeof requested === 'string'` gate, so a caller who
    // typed --content-type and forgot the value got a publish that quietly
    // ignored the flag. CodeQL surfaced the dead `requested !== true` clause
    // that was standing in for this check from inside the string guard.
    const result = run(['--file', write('rows3.csv', 'a,b\n1,2\n'), '--content-type']);
    expect(result.code).toBe(1);
    expect(result.json.error).toBe('bad_args');
    expect(result.json.message).toContain('needs a value');
  });

  test('a matching content type is accepted, charset and all', () => {
    // Reaches the broker hop, which is unstubbed here — so this asserts only
    // that the type gate let it through, not that the upload succeeded.
    const result = run([
      '--file',
      write('rows2.csv', 'a,b\n1,2\n'),
      '--content-type',
      'text/csv; charset=utf-8',
    ]);
    expect(result.json.error).not.toBe('bad_args');
  });
});

describe('broker contract', () => {
  test('the publishable set matches the storage broker', () => {
    const broker = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'lib',
        'agent-workspace',
        'storage-broker.ts'
      ),
      'utf8'
    );
    const block = broker.match(
      /const PUBLIC_EXTENSIONS = new Set\(\[([\s\S]*?)\]\)/
    );
    expect(block).not.toBeNull();
    const brokerExtensions = [...block[1].matchAll(/"(\.[a-z0-9]+)"/g)]
      .map((match) => match[1])
      .sort();

    const cli = fs.readFileSync(CLI, 'utf8');
    const cliBlock = cli.match(/PUBLISHABLE_TYPES = new Map\(\[([\s\S]*?)\]\)/);
    expect(cliBlock).not.toBeNull();
    const cliExtensions = [...cliBlock[1].matchAll(/'(\.[a-z0-9]+)'/g)]
      .map((match) => match[1])
      .sort();

    expect(cliExtensions).toEqual(brokerExtensions);
    // The rule this pair encodes: HTML is never a public artifact.
    expect(brokerExtensions).not.toContain('.html');
  });
});
