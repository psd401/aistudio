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

  test('writer allowed for explicitly NAMED district users (2026-07-08)', () => {
    expect(share({ fileId: 'f', type: 'user', role: 'writer', emailAddress: 'hagelk@psd401.net' })).toBe(true);
    expect(share({ fileId: 'f', type: 'user', role: 'writer', emailAddress: 'songstadw@psd401.net' })).toBe(true);
    // Writer never crosses the district boundary or widens to domain/owner.
    expect(share({ fileId: 'f', type: 'user', role: 'writer', emailAddress: 'evil@outside.com' })).toBe(false);
    expect(share({ fileId: 'f', type: 'domain', role: 'writer', domain: 'psd401.net' })).toBe(false);
    expect(share({ fileId: 'f', type: 'user', role: 'owner', emailAddress: 'hagelk@psd401.net' })).toBe(false);
  });

  test('external, anyone, and group stay blocked', () => {
    expect(share({ fileId: 'f', type: 'user', role: 'reader', emailAddress: 'evil@outside.com' })).toBe(false);
    expect(share({ fileId: 'f', type: 'anyone', role: 'reader' })).toBe(false);
    expect(share({ fileId: 'f', type: 'group', role: 'reader', emailAddress: 'staff@psd401.net' })).toBe(false);
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

describe('tokenization hardening (REV-COR-346) — gate matches the executed argv', () => {
  const USER_CTX = { scope: 'user_account', ownerEmail: 'hagelk@psd401.net' };

  test('quote-split forbidden verbs are refused', () => {
    // splitCommand strips quotes, so these all execute the blocked argv; the
    // gate must see the same tokenization instead of the raw string.
    expect(enforcePhase1Gates("gmail users messages 'send' --json '{}'", USER_CTX).allowed).toBe(false);
    expect(enforcePhase1Gates("gmail users messages se'nd", USER_CTX).allowed).toBe(false);
    expect(enforcePhase1Gates('gmail users messages "send"', USER_CTX).allowed).toBe(false);
    expect(enforcePhase1Gates("drive files 'delete' --fileId x", USER_CTX).allowed).toBe(false);
    expect(enforcePhase1Gates('calendar events dele"te" --eventId x', USER_CTX).allowed).toBe(false);
  });

  test('dot-separated invocation style still matches', () => {
    expect(enforcePhase1Gates('gmail.users.messages.send --json {}', USER_CTX).allowed).toBe(false);
  });

  test('user-scope creation rules also see through quote-split verbs', () => {
    expect(enforcePhase1Gates('docs documents \'create\' --json \'{"title":"x"}\'', USER_CTX).allowed).toBe(false);
  });

  test('positive control — legitimate quoted --query values still pass', () => {
    expect(enforcePhase1Gates("gmail users messages list --query 'is:unread'", USER_CTX).allowed).toBe(true);
    expect(enforcePhase1Gates("gmail users messages list --query 'reply'", USER_CTX).allowed).toBe(true);
  });
});

describe('gmail helper send forms (REV-COR-350) — prefixes cannot dodge the anchors', () => {
  const USER_CTX = { scope: 'user_account', ownerEmail: 'hagelk@psd401.net' };

  test('+send/+reply/+forward refused with a gws prefix or flags before the verb', () => {
    expect(enforcePhase1Gates('gws gmail +send --to x@y', USER_CTX).allowed).toBe(false);
    expect(enforcePhase1Gates('gmail --to x@y +send', USER_CTX).allowed).toBe(false);
    expect(enforcePhase1Gates('gmail +reply --thread t', USER_CTX).allowed).toBe(false);
    expect(enforcePhase1Gates('gws gmail +reply-all --thread t', USER_CTX).allowed).toBe(false);
    expect(enforcePhase1Gates('gmail --to x +forward', USER_CTX).allowed).toBe(false);
  });

  test('"gmail send" as bare query content on another service is not blocked', () => {
    // `gmail` deep in the argv is argument content, not the service selector.
    expect(enforcePhase1Gates('drive files list --query gmail send', USER_CTX).allowed).toBe(true);
  });
});

// ============================================================================
// #1305 — user-slot Drive read + organize
// ============================================================================
//
// The user slot gained drive.readonly + drive.metadata on 2026-07-25 so the
// agent can read and ORGANIZE the user's Drive. These tests pin the boundary:
// what "organize" newly permits, and that the impersonation and destruction
// bans it sits next to are unchanged. Both carve-outs are ALLOWLISTS, so the
// most important cases here are the ones that must still be REFUSED.

const {
  missingScopesForCommand,
  DRIVE_FOLDER_MIME,
  DRIVE_READ_SCOPE,
  DRIVE_METADATA_SCOPE,
} = require('./common');

describe('#1305 user-slot Drive: folder creation is the ONLY permitted create', () => {
  const USER_CTX = { scope: 'user_account', ownerEmail: 'hagelk@psd401.net' };
  const create = (resource, extra = '') =>
    enforcePhase1Gates(
      `drive files create --json '${JSON.stringify(resource)}'${extra}`,
      USER_CTX
    );

  test('creating a folder is allowed', () => {
    expect(create({ name: 'Budget 2026', mimeType: DRIVE_FOLDER_MIME }).allowed).toBe(true);
  });

  test('creating a folder inside another folder is allowed', () => {
    expect(
      create({ name: 'Q3', mimeType: DRIVE_FOLDER_MIME, parents: ['abc123'] }).allowed
    ).toBe(true);
  });

  test('the folder mimeType is matched exactly, not as a prefix or substring', () => {
    // A shortcut, a Doc, and a lookalike must all still refuse.
    for (const mimeType of [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.shortcut',
      'application/vnd.google-apps.folder.evil',
      'text/plain',
      'application/vnd.google-apps.folderx',
    ]) {
      expect(create({ name: 'x', mimeType }).allowed).toBe(false);
    }
  });

  test('a create with no mimeType is refused — absence of proof is not proof', () => {
    expect(create({ name: 'notes.txt' }).allowed).toBe(false);
  });

  test('a create with no parseable payload at all is refused', () => {
    expect(enforcePhase1Gates('drive files create', USER_CTX).allowed).toBe(false);
    expect(
      enforcePhase1Gates('drive files create --json not-json', USER_CTX).allowed
    ).toBe(false);
  });

  test('a folder mimeType cannot smuggle content in alongside it', () => {
    for (const flag of [
      ' --media /tmp/payload.bin',
      ' --upload-type multipart',
      ' --media-file /tmp/x',
      " --params '{\"uploadType\":\"resumable\"}'",
    ]) {
      expect(create({ name: 'x', mimeType: DRIVE_FOLDER_MIME }, flag).allowed).toBe(false);
    }
  });

  test('copy stays banned even for a folder — the carve-out is create-only', () => {
    expect(
      enforcePhase1Gates(
        `drive files copy --json '{"mimeType":"${DRIVE_FOLDER_MIME}"}'`,
        USER_CTX
      ).allowed
    ).toBe(false);
  });

  test('docs/sheets/slides creation is untouched by the carve-out', () => {
    for (const cmd of [
      `docs documents create --json '{"title":"x","mimeType":"${DRIVE_FOLDER_MIME}"}'`,
      `sheets spreadsheets create --json '{"mimeType":"${DRIVE_FOLDER_MIME}"}'`,
      `slides presentations create --json '{"mimeType":"${DRIVE_FOLDER_MIME}"}'`,
    ]) {
      expect(enforcePhase1Gates(cmd, USER_CTX).allowed).toBe(false);
    }
  });
});

describe('#1305 user-slot Drive: files.update is metadata-only', () => {
  const USER_CTX = { scope: 'user_account', ownerEmail: 'hagelk@psd401.net' };
  const update = (resource, extra = '') =>
    enforcePhase1Gates(
      `drive files update --params '{"fileId":"f1"}' --json '${JSON.stringify(resource)}'${extra}`,
      USER_CTX
    );

  test('rename, star, describe and recolour are allowed', () => {
    expect(update({ name: 'Renamed.pdf' }).allowed).toBe(true);
    expect(update({ starred: true }).allowed).toBe(true);
    expect(update({ description: 'filed by the agent' }).allowed).toBe(true);
    expect(update({ name: 'Q3', folderColorRgb: '#8f8f8f' }).allowed).toBe(true);
  });

  test('moving a file (addParents/removeParents ride --params) is allowed', () => {
    expect(
      enforcePhase1Gates(
        `drive files update --params '{"fileId":"f1","addParents":"folder2","removeParents":"folder1"}' --json '{"name":"Q3 report"}'`,
        USER_CTX
      ).allowed
    ).toBe(true);
  });

  test('TRASHING is refused — the destructive ban survives the new scopes', () => {
    // drive.metadata makes `trashed` a metadata write, so this would otherwise
    // have become reachable across the user's whole Drive.
    expect(update({ trashed: true }).allowed).toBe(false);
    expect(update({ name: 'x', trashed: true }).allowed).toBe(false);
  });

  test('trashing is refused on the AGENT slot too (Phase 1: never destructive)', () => {
    const AGENT_CTX = { scope: 'agent_account', ownerEmail: 'hagelk@psd401.net' };
    expect(
      enforcePhase1Gates(
        `drive files update --params '{"fileId":"f1"}' --json '{"trashed":true}'`,
        AGENT_CTX
      ).allowed
    ).toBe(false);
    expect(
      enforcePhase1Gates(`drive files untrash --params '{"fileId":"f1"}'`, AGENT_CTX).allowed
    ).toBe(false);
  });

  test('a JSON-escaped `trashed` key cannot dodge the ban on either slot (codex P1)', () => {
    // `{"tr\u0061shed":true}` never matches the raw-string PHASE1 pattern,
    // but gws's JSON.parse decodes the key straight back to `trashed` and
    // executes the trash. The gate must judge the DECODED payload. The raw
    // command below carries the literal backslash-u escape, exactly as an
    // adversarial model would emit it.
    const AGENT_CTX = { scope: 'agent_account', ownerEmail: 'hagelk@psd401.net' };
    const escaped = `drive files update --params '{"fileId":"f1"}' --json '{"tr\\u0061shed":true}'`;
    const agentVerdict = enforcePhase1Gates(escaped, AGENT_CTX);
    expect(agentVerdict.allowed).toBe(false);
    expect(agentVerdict.reason).toContain('trash');
    expect(enforcePhase1Gates(escaped, USER_CTX).allowed).toBe(false);
  });

  test('untrash smuggled as `trashed:false` in the body is refused on both slots', () => {
    // `files.untrash` is blocked as a verb; the body form must not be a way
    // around it — the agent does not manage the trash in either direction.
    const AGENT_CTX = { scope: 'agent_account', ownerEmail: 'hagelk@psd401.net' };
    const untrash = `drive files update --params '{"fileId":"f1"}' --json '{"trashed":false}'`;
    expect(enforcePhase1Gates(untrash, AGENT_CTX).allowed).toBe(false);
    expect(enforcePhase1Gates(untrash, USER_CTX).allowed).toBe(false);
  });

  test('a pre-trashed folder create is refused even though the mimeType is permitted', () => {
    // isPermittedFolderCreate only proves mimeType; without the parsed-payload
    // trash check a folder create carrying an escaped `trashed` key would ride
    // the #1305 carve-out through USER_SCOPE_FORBIDDEN.
    expect(
      enforcePhase1Gates(
        `drive files create --json '{"mimeType":"application/vnd.google-apps.folder","name":"x","tr\\u0061shed":true}'`,
        USER_CTX
      ).allowed
    ).toBe(false);
  });

  test('any field outside the metadata allowlist refuses the whole call', () => {
    // One unknown key poisons the payload — the allowlist is all-or-nothing.
    expect(update({ name: 'ok', contentHints: { indexableText: 'x' } }).allowed).toBe(false);
    expect(update({ capabilities: { canEdit: true } }).allowed).toBe(false);
    expect(update({ owners: [{ emailAddress: 'someone@psd401.net' }] }).allowed).toBe(false);
  });

  test('content/media flags refuse regardless of how benign the body looks', () => {
    for (const flag of [
      ' --media /tmp/new-content.docx',
      ' --media-body /tmp/x',
      ' --upload-type media',
      ' --content-file /tmp/x',
    ]) {
      expect(update({ name: 'still just a rename' }, flag).allowed).toBe(false);
    }
  });

  test('an update with an empty or unparseable body is refused', () => {
    expect(update({}).allowed).toBe(false);
    expect(
      enforcePhase1Gates(
        `drive files update --params '{"fileId":"f1"}'`,
        USER_CTX
      ).allowed
    ).toBe(false);
  });

  test('permanent delete and emptyTrash remain blocked', () => {
    expect(
      enforcePhase1Gates(`drive files delete --params '{"fileId":"f1"}'`, USER_CTX).allowed
    ).toBe(false);
    expect(enforcePhase1Gates('drive files emptyTrash', USER_CTX).allowed).toBe(false);
  });

  test('reads are allowed and always were', () => {
    expect(
      enforcePhase1Gates(`drive files get --params '{"fileId":"f1"}'`, USER_CTX).allowed
    ).toBe(true);
    expect(
      enforcePhase1Gates(`drive files export --params '{"fileId":"f1","mimeType":"text/markdown"}'`, USER_CTX).allowed
    ).toBe(true);
  });
});

describe('#1305 lazy scope upgrade detection', () => {
  const OLD = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/drive.file',
  ].join(' ');
  const NEW = `${OLD} ${DRIVE_READ_SCOPE} ${DRIVE_METADATA_SCOPE}`;

  test('a pre-#1305 token is flagged for the new Drive reads', () => {
    const gap = missingScopesForCommand(`drive files list --params '{"q":"x"}'`, OLD);
    expect(gap).not.toBeNull();
    expect(gap.scopes).toEqual([DRIVE_READ_SCOPE]);
    expect(gap.capability).toContain('read');
  });

  test('a pre-#1305 token is flagged for metadata updates', () => {
    const gap = missingScopesForCommand(`drive files update --json '{"name":"x"}'`, OLD);
    expect(gap.scopes).toEqual([DRIVE_METADATA_SCOPE]);
  });

  test('a re-consented token is never flagged', () => {
    expect(missingScopesForCommand(`drive files list --params '{}'`, NEW)).toBeNull();
    expect(missingScopesForCommand(`drive files update --json '{"name":"x"}'`, NEW)).toBeNull();
  });

  test('operations that predate #1305 never prompt, even on an old token', () => {
    // No forced migration: everything the slot could already do keeps working.
    for (const cmd of [
      `gmail users messages list --query 'is:unread'`,
      `calendar events insert --json '{"summary":"x"}'`,
      `tasks tasks insert --json '{"title":"x"}'`,
      `drive files create --json '{"mimeType":"${DRIVE_FOLDER_MIME}"}'`,
    ]) {
      expect(missingScopesForCommand(cmd, OLD)).toBeNull();
    }
  });

  test('fails OPEN on a missing scope string rather than blocking every call', () => {
    // Google always returns `scope` on a refresh; if it ever did not, refusing
    // all Drive work would be a self-inflicted outage. Google still 403s a
    // genuinely missing scope — this check only improves the error.
    expect(missingScopesForCommand(`drive files list --params '{}'`, undefined)).toBeNull();
    expect(missingScopesForCommand(`drive files list --params '{}'`, '')).toBeNull();
  });

  test('dot-form invocations are detected the same as space-form', () => {
    expect(missingScopesForCommand('drive.files.list', OLD)).not.toBeNull();
  });
});

describe('#1305 marker injection on folders', () => {
  test('a folder keeps the name the user asked for, but still gets the audit marker', () => {
    const out = injectMarkers(
      `drive files create --json '{"name":"Budget 2026","mimeType":"${DRIVE_FOLDER_MIME}"}'`
    );
    const obj = JSON.parse(extractJsonArg(out));
    expect(obj.name).toBe('Budget 2026');
    expect(obj.appProperties.psdAgentCreated).toBe('true');
  });

  test('non-folder creations still get the visible [Agent] prefix', () => {
    const out = injectMarkers(`drive files create --json '{"name":"Report.pdf"}'`);
    const obj = JSON.parse(extractJsonArg(out));
    expect(obj.name).toBe('[Agent] Report.pdf');
    expect(obj.appProperties.psdAgentCreated).toBe('true');
  });
});

describe('#1305 uploadType is caught in --params without false-refusing renames', () => {
  const USER_CTX = { scope: 'user_account', ownerEmail: 'hagelk@psd401.net' };

  test('uploadType in --params refuses (an upload in query-parameter clothing)', () => {
    expect(
      enforcePhase1Gates(
        `drive files update --params '{"fileId":"f1","uploadType":"media"}' --json '{"name":"x"}'`,
        USER_CTX
      ).allowed
    ).toBe(false);
  });

  test('a filename that merely contains "uploadType" is still a rename', () => {
    expect(
      enforcePhase1Gates(
        `drive files update --params '{"fileId":"f1"}' --json '{"name":"uploadType notes.txt"}'`,
        USER_CTX
      ).allowed
    ).toBe(true);
  });
});

describe('#1305 marker injection marks the nested resource, not the envelope', () => {
  // gws accepts the file resource at top level or wrapped under `resource` /
  // `requestBody`, and the gate unwraps all three. The marker must unwrap the
  // same way or a wrapped payload sails through the gate with NO audit marker
  // on the object Google actually creates.
  const shapes = [
    ['top level', (r) => r],
    ['resource wrapper', (r) => ({ resource: r })],
    ['requestBody wrapper', (r) => ({ requestBody: r })],
  ];

  for (const [label, wrap] of shapes) {
    test(`${label}: a folder keeps its name and gets the marker on the resource`, () => {
      const payload = wrap({ name: 'Budget 2026', mimeType: DRIVE_FOLDER_MIME });
      const out = injectMarkers(`drive files create --json '${JSON.stringify(payload)}'`);
      const parsed = JSON.parse(extractJsonArg(out));
      const resource = parsed.resource || parsed.requestBody || parsed;
      expect(resource.name).toBe('Budget 2026');
      expect(resource.appProperties.psdAgentCreated).toBe('true');
      // The envelope itself must NOT be marked when it is only an envelope.
      if (parsed !== resource) expect(parsed.appProperties).toBeUndefined();
    });

    test(`${label}: a non-folder gets the [Agent] prefix on the resource`, () => {
      const payload = wrap({ name: 'Report.pdf' });
      const out = injectMarkers(`drive files create --json '${JSON.stringify(payload)}'`);
      const parsed = JSON.parse(extractJsonArg(out));
      const resource = parsed.resource || parsed.requestBody || parsed;
      expect(resource.name).toBe('[Agent] Report.pdf');
      expect(resource.appProperties.psdAgentCreated).toBe('true');
    });

    test(`${label}: the gate and the marker agree on what the resource is`, () => {
      const USER_CTX = { scope: 'user_account', ownerEmail: 'hagelk@psd401.net' };
      const folder = wrap({ name: 'Q3', mimeType: DRIVE_FOLDER_MIME });
      const doc = wrap({ name: 'Q3', mimeType: 'application/vnd.google-apps.document' });
      const cmd = (p) => `drive files create --json '${JSON.stringify(p)}'`;
      expect(enforcePhase1Gates(cmd(folder), USER_CTX).allowed).toBe(true);
      expect(enforcePhase1Gates(cmd(doc), USER_CTX).allowed).toBe(false);
    });
  }
});
