/**
 * Unit tests for psd-workspace command parsing + payload-file transport
 * (#1138 follow-up: splitCommand has no escape syntax, so arbitrary text
 * must travel via --json-file / --body-file).
 *
 * Run: bun test common.test.js (from this directory, after bun install).
 */

'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  splitCommand,
  resolvePayloadFiles,
  extractJsonArg,
  injectMarkers,
  enforcePhase1Gates,
} = require('./common');

function tmpFile(content, ext = '.json') {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'psdws-test-')),
    `payload${ext}`
  );
  fs.writeFileSync(p, content);
  return p;
}

describe('splitCommand (documenting the limitation payload files solve)', () => {
  test('quoted segments hold multi-word values', () => {
    expect(splitCommand("gmail list --query 'is:unread from:bob'")).toEqual([
      'gmail', 'list', '--query', 'is:unread from:bob',
    ]);
  });

  test('an apostrophe inside single-quoted text breaks tokenization', () => {
    // "it's" terminates the quote at the apostrophe — this is WHY payload
    // files exist; if this ever starts passing, splitCommand grew escaping
    // and the payload-file docs should be revisited.
    const tokens = splitCommand("docs write --json '{\"text\":\"it's fine\"}'");
    expect(tokens).not.toContain('{"text":"it\'s fine"}');
  });
});

describe('resolvePayloadFiles', () => {
  test('returns null when no file flags present', () => {
    expect(resolvePayloadFiles('gmail users messages list --params x')).toBeNull();
    expect(resolvePayloadFiles('')).toBeNull();
  });

  test('--json-file: minifies, inlines into synthetic, placeholder into exec', () => {
    const payload = {
      requests: [{ insertText: { text: "Multi word — with 'quotes' and \"both\" kinds.\nAnd a newline." } }],
    };
    const p = tmpFile(JSON.stringify(payload, null, 2));
    const resolved = resolvePayloadFiles(
      `docs documents batchUpdate --params '{"documentId":"d1"}' --json-file ${p}`
    );
    expect(resolved).not.toBeNull();
    const minified = JSON.stringify(payload);
    expect(resolved.payloads['@@PSD_PAYLOAD_JSON@@']).toBe(minified);
    expect(resolved.syntheticCommand).toContain(`--json ${minified}`);
    expect(resolved.execCommand).toContain('--json @@PSD_PAYLOAD_JSON@@');
    expect(resolved.execCommand).not.toContain('--json-file');
    // The exec command stays tokenizable: the placeholder is one token.
    expect(splitCommand(resolved.execCommand)).toContain('@@PSD_PAYLOAD_JSON@@');
  });

  test('--body-file: raw text (not JSON-parsed) rides as body payload', () => {
    const body = "Hi Bill,\n\nHere's the plan — \"phase one\" starts Monday.\n";
    const p = tmpFile(body, '.txt');
    const resolved = resolvePayloadFiles(
      `gmail +draft --to bill@psd401.net --subject Update --body-file ${p}`
    );
    expect(resolved.payloads['@@PSD_PAYLOAD_BODY@@']).toBe(body);
    expect(resolved.execCommand).toContain('--body @@PSD_PAYLOAD_BODY@@');
    expect(resolved.syntheticCommand).toContain(body);
  });

  test('gates see the real payload through the synthetic command', () => {
    // An explicit share via --json-file: the gate's payload validation must
    // be able to read type/role/emailAddress through the file indirection.
    const p = tmpFile(JSON.stringify({
      fileId: 'f1', type: 'user', role: 'reader', emailAddress: 'hagelk@psd401.net',
    }));
    const resolved = resolvePayloadFiles(
      `drive permissions create --json-file ${p}`
    );
    const gate = enforcePhase1Gates(resolved.syntheticCommand, {
      scope: 'agent_account',
      ownerEmail: 'hagelk@psd401.net',
    });
    expect(gate.allowed).toBe(true);
    // External recipients must stay blocked even through a file payload.
    const p2 = tmpFile(JSON.stringify({
      fileId: 'f1', type: 'user', role: 'reader', emailAddress: 'evil@outside.com',
    }));
    const resolved2 = resolvePayloadFiles(`drive permissions create --json-file ${p2}`);
    const gate2 = enforcePhase1Gates(resolved2.syntheticCommand, {
      scope: 'agent_account',
      ownerEmail: 'hagelk@psd401.net',
    });
    expect(gate2.allowed).toBe(false);
  });

  test('markers land in file-based calendar payloads via the synthetic path', () => {
    const p = tmpFile(JSON.stringify({ summary: 'Standup', description: 'Daily sync' }));
    const resolved = resolvePayloadFiles(
      `calendar events insert --params '{"calendarId":"primary"}' --json-file ${p}`
    );
    const marked = injectMarkers(resolved.syntheticCommand);
    const mutated = extractJsonArg(marked);
    expect(mutated).toContain('Created by your agent');
    expect(JSON.parse(mutated).description).toContain('Daily sync');
  });
});

describe('user-scope file creation is impersonation — hard blocked (2026-07-07)', () => {
  const USER_CTX = { scope: 'user_account', ownerEmail: 'hagelk@psd401.net' };
  const AGENT_CTX = { scope: 'agent_account', ownerEmail: 'hagelk@psd401.net' };

  test('drive/docs/sheets/slides creation blocked on the user slot', () => {
    for (const cmd of [
      `drive files create --json '{"name":"[Agent] x"}'`,
      `drive files copy --params '{"fileId":"f1"}'`,
      `docs documents create --json '{"title":"Summary"}'`,
      `sheets spreadsheets create --json '{"properties":{"title":"x"}}'`,
      `slides presentations create --json '{"title":"x"}'`,
      'drive.files.create --json \'{"name":"x"}\'',
    ]) {
      const gate = enforcePhase1Gates(cmd, USER_CTX);
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toContain('owned by the user');
    }
  });

  test('same creations are allowed on the agent slot', () => {
    for (const cmd of [
      `drive files create --json '{"name":"[Agent] x"}'`,
      `drive files copy --params '{"fileId":"f1"}'`,
      `docs documents create --json '{"title":"Summary"}'`,
      `sheets spreadsheets create --json '{"properties":{"title":"x"}}'`,
      `slides presentations create --json '{"title":"x"}'`,
    ]) {
      expect(enforcePhase1Gates(cmd, AGENT_CTX).allowed).toBe(true);
    }
  });

  test('missing/unknown scope fails closed to the user-slot rules', () => {
    expect(enforcePhase1Gates(`docs documents create --json '{"title":"x"}'`, undefined).allowed).toBe(false);
    expect(enforcePhase1Gates(`docs documents create --json '{"title":"x"}'`, { scope: 'weird' }).allowed).toBe(false);
  });

  test('user-slot reads and non-file writes are unaffected', () => {
    for (const cmd of [
      'drive files list --params \'{"q":"name contains x"}\'',
      `calendar events insert --json '{"summary":"Standup"}'`,
      `gmail +draft --to a@psd401.net --subject Hi --body ok`,
      `tasks tasks insert --json '{"title":"x"}'`,
    ]) {
      expect(enforcePhase1Gates(cmd, USER_CTX).allowed).toBe(true);
    }
  });
});

describe('explicit in-district sharing (widened gate, 2026-07-07)', () => {
  const CTX = { scope: 'agent_account', ownerEmail: 'hagelk@psd401.net' };
  const share = (perm) =>
    enforcePhase1Gates(
      `drive permissions create --json '${JSON.stringify(perm)}'`,
      CTX
    ).allowed;

  test('named district colleague (not the caller) is now allowed', () => {
    expect(share({ fileId: 'f', type: 'user', role: 'reader', emailAddress: 'songstadw@psd401.net' })).toBe(true);
    expect(share({ fileId: 'f', type: 'user', role: 'commenter', emailAddress: 'colleague@psd401.net' })).toBe(true);
  });

  test('domain-wide reader for psd401.net is allowed', () => {
    expect(share({ fileId: 'f', type: 'domain', role: 'reader', domain: 'psd401.net' })).toBe(true);
  });

  test('domain shares are reader-only and our-domain-only', () => {
    expect(share({ fileId: 'f', type: 'domain', role: 'commenter', domain: 'psd401.net' })).toBe(false);
    expect(share({ fileId: 'f', type: 'domain', role: 'writer', domain: 'psd401.net' })).toBe(false);
    expect(share({ fileId: 'f', type: 'domain', role: 'reader', domain: 'gmail.com' })).toBe(false);
  });

  test('external, anyone, group, and writer stay blocked', () => {
    expect(share({ fileId: 'f', type: 'user', role: 'reader', emailAddress: 'evil@outside.com' })).toBe(false);
    expect(share({ fileId: 'f', type: 'anyone', role: 'reader' })).toBe(false);
    expect(share({ fileId: 'f', type: 'group', role: 'reader', emailAddress: 'staff@psd401.net' })).toBe(false);
    expect(share({ fileId: 'f', type: 'user', role: 'writer', emailAddress: 'hagelk@psd401.net' })).toBe(false);
  });

  test('user scope and update/delete remain fully blocked', () => {
    const userScope = enforcePhase1Gates(
      `drive permissions create --json '{"fileId":"f","type":"user","role":"reader","emailAddress":"hagelk@psd401.net"}'`,
      { scope: 'user_account', ownerEmail: 'hagelk@psd401.net' }
    );
    expect(userScope.allowed).toBe(false);
    const update = enforcePhase1Gates(
      `drive permissions update --json '{"fileId":"f","type":"domain","role":"reader","domain":"psd401.net"}'`,
      CTX
    );
    expect(update.allowed).toBe(false);
  });

  test('a subtly-external email that merely CONTAINS the domain is blocked', () => {
    expect(share({ fileId: 'f', type: 'user', role: 'reader', emailAddress: 'x@psd401.net.evil.com' })).toBe(false);
    expect(share({ fileId: 'f', type: 'user', role: 'reader', emailAddress: 'psd401.net@gmail.com' })).toBe(false);
  });
});

describe('extractJsonArg', () => {
  test('returns the raw --json object', () => {
    expect(extractJsonArg("x --json '{\"a\":1}' --other y")).toBe('{"a":1}');
    expect(extractJsonArg('x --json {"a":{"b":2}}')).toBe('{"a":{"b":2}}');
  });

  test('returns null when absent or malformed', () => {
    expect(extractJsonArg('gmail list')).toBeNull();
    expect(extractJsonArg('x --json {unclosed')).toBeNull();
    expect(extractJsonArg(null)).toBeNull();
  });
});

describe('resolvePayloadFiles error paths (fail() exits — run via subprocess)', () => {
  const runResolve = (command) =>
    spawnSync(
      process.execPath,
      ['-e', `require('${__dirname}/common.js').resolvePayloadFiles(process.argv[1])`, command],
      { encoding: 'utf8' }
    );

  test('relative path is rejected', () => {
    const r = runResolve('docs write --json-file relative/path.json');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('absolute path');
  });

  test('unreadable file is rejected', () => {
    const r = runResolve('docs write --json-file /nonexistent/nope.json');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot read');
  });

  test('invalid JSON in --json-file is rejected', () => {
    const p = tmpFile('not json at all');
    const r = runResolve(`docs write --json-file ${p}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not valid JSON');
  });

  test('--json and --json-file together are rejected', () => {
    const p = tmpFile('{}');
    const r = runResolve(`docs write --json '{}' --json-file ${p}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not both');
  });

  test('--body and --body-file together are rejected (review finding 1)', () => {
    const p = tmpFile('hello', '.txt');
    const r = runResolve(`gmail +draft --body 'stale text' --body-file ${p}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not both');
  });
});

describe('--text-file (chat +send message text)', () => {
  test('resolves like --body-file with its own placeholder', () => {
    const msg = "Team — two docs from the 7/1 meeting:\n1) Summary\n2) Todos ('74 items')";
    const p = tmpFile(msg, '.txt');
    const resolved = resolvePayloadFiles(
      `chat +send --space spaces/XXXX --text-file ${p}`
    );
    expect(resolved.payloads['@@PSD_PAYLOAD_TEXT@@']).toBe(msg);
    expect(resolved.execCommand).toContain('--text @@PSD_PAYLOAD_TEXT@@');
    expect(resolved.execCommand).not.toContain('--text-file');
  });

  test('--text and --text-file together are rejected', () => {
    const p = tmpFile('hi', '.txt');
    const r = spawnSync(
      process.execPath,
      ['-e', `require('${__dirname}/common.js').resolvePayloadFiles(process.argv[1])`,
        `chat +send --text 'inline' --text-file ${p}`],
      { encoding: 'utf8' }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not both');
  });
});

describe('quoted file paths (review finding 2)', () => {
  test('a quoted absolute path resolves like an unquoted one', () => {
    const payload = { a: 1 };
    const p = tmpFile(JSON.stringify(payload));
    for (const quoted of [`'${p}'`, `"${p}"`]) {
      const resolved = resolvePayloadFiles(`docs write --json-file ${quoted}`);
      expect(resolved).not.toBeNull();
      expect(resolved.payloads['@@PSD_PAYLOAD_JSON@@']).toBe(JSON.stringify(payload));
    }
  });
});
