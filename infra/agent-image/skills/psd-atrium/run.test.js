
/**
 * Regression tests for run.js's CLI subcommand → Atrium content REST wiring.
 *
 * Confirms each subcommand hits the correct HTTP method + path + body:
 *   find            → GET    /            (kind/collection/tag/status/query)
 *   read            → GET    /<id>        (+ inline body extraction)
 *   create-document → POST   /            (kind=document, bodyFormat=markdown)
 *   create-artifact → POST   /            (kind=artifact, code→body)
 *   edit (replace)  → POST   /<id>/versions
 *   edit (append)   → GET /<id> then POST /<id>/versions (concatenated body)
 *   set-visibility  → PATCH  /<id>/visibility
 *   publish         → POST   /<id>/publish     (+ approval_required relay)
 *   unpublish       → DELETE /<id>/publish/<destination>
 *
 * common.js's restFetch/emit are overridden on the shared module.exports object
 * BEFORE run.js is required, so run.js's top-level destructure captures the stubs
 * instead of hitting the network / Secrets Manager. process.exit is stubbed to
 * throw so `fail()` (missing-flag validation) is observable.
 */

'use strict';
const { validatedFs } = require("../../../validated-fs.cjs");


// bun loads every *.test.js into ONE process and common.js reads these env vars at
// module-load time, so this file MUST set the SAME values as common.test.js — else
// whichever file requires common.js first fixes the module consts and the other's
// expectations drift. run.js's restFetch is stubbed here, so the actual credential
// values are irrelevant to these tests; only cross-file consistency matters.
process.env.AISTUDIO_CONTENT_API_URL = 'https://app.test/api/v1/content';
process.env.AISTUDIO_CONTENT_API_KEY = '';
process.env.AISTUDIO_CONTENT_API_KEY_SECRET_ID = 'psd-agent/dev/atrium-content-api-key';
process.env.APP_BASE_URL = '';

const { test, expect, beforeEach, afterEach } = require('bun:test');

const common = require('./common');

let restCalls;
let emitted;
let restResponder;

const originalRestFetch = common.restFetch;
const originalEmit = common.emit;

common.restFetch = async (method, path, opts) => {
  const call = { method, path, opts: opts || {} };
  restCalls.push(call);
  return restResponder(call);
};
common.emit = (obj) => {
  emitted.push(obj);
};

const { main } = require('./run');

common.restFetch = originalRestFetch;
common.emit = originalEmit;

class ExitError extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

let originalExit;
let originalArgv;
let originalStdoutWrite;
let originalStderrWrite;

function defaultResponder(call) {
  return { approvalRequired: false, status: 200, payload: { ok: true, echo: call.path } };
}

beforeEach(() => {
  restCalls = [];
  emitted = [];
  restResponder = defaultResponder;
  originalExit = process.exit;
  originalArgv = process.argv;
  originalStdoutWrite = process.stdout.write;
  originalStderrWrite = process.stderr.write;
  process.exit = (code) => {
    throw new ExitError(code);
  };
  process.stdout.write = () => true;
  process.stderr.write = () => true;
});

afterEach(() => {
  process.exit = originalExit;
  process.argv = originalArgv;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

/** Run main() with the given argv (after `node run.js`). */
async function run(...argv) {
  process.argv = ['node', 'run.js', ...argv];
  await main();
}

test('find issues GET / with the filter query', async () => {
  restResponder = () => ({
    approvalRequired: false,
    status: 200,
    payload: [
      {
        id: 'obj-1',
        slug: 'field-trip',
        url: 'https://app.example/c/field-trip',
      },
    ],
  });

  await run(
    'find',
    '--kind',
    'document',
    '--status',
    'published',
    '--query',
    'trip',
    '--tag',
    'science',
    '--since',
    '2026-07-27T00:00:00Z'
  );

  expect(restCalls).toHaveLength(1);
  expect(restCalls[0].method).toBe('GET');
  expect(restCalls[0].path).toBe('');
  expect(restCalls[0].opts.query).toEqual({
    kind: 'document',
    status: 'published',
    collection: undefined,
    tag: 'science',
    query: 'trip',
    since: '2026-07-27T00:00:00Z',
  });
  expect(emitted[0][0].url).toBe('https://app.example/c/field-trip');
});

test('find rejects an invalid --kind (exit 1)', async () => {
  let code;
  try {
    await run('find', '--kind', 'spreadsheet');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('read GETs /<id> and surfaces the inline body', async () => {
  restResponder = () => ({
    approvalRequired: false,
    status: 200,
    payload: {
      id: 'obj-1',
      title: 'Doc',
      version: { id: 'v2', bodyFormat: 'markdown', bodyInline: '# Hi\n\nbody' },
    },
  });

  await run('read', '--id', 'obj-1');

  expect(restCalls[0]).toMatchObject({ method: 'GET', path: '/obj-1' });
  const out = emitted[0];
  expect(out.body).toBe('# Hi\n\nbody');
  expect(out.bodyAvailableInline).toBe(true);
});

test('read reports when the body is not inline (S3-offloaded)', async () => {
  restResponder = () => ({
    approvalRequired: false,
    status: 200,
    payload: { id: 'obj-1', version: { id: 'v2', bodyFormat: 'markdown', bodyInline: null, bodyLocation: 's3://x' } },
  });

  await run('read', '--id', 'obj-1');
  const out = emitted[0];
  expect(out.body).toBeNull();
  expect(out.bodyAvailableInline).toBe(false);
});

test('read reports the no-saved-version case (bodyless object) without claiming a body', async () => {
  restResponder = () => ({
    approvalRequired: false,
    status: 200,
    payload: { id: 'obj-1', title: 'Empty', version: null },
  });

  await run('read', '--id', 'obj-1');
  const out = emitted[0];
  expect(out.body).toBeNull();
  expect(out.bodyAvailableInline).toBe(false);
  expect(out.note).toMatch(/no saved version/i);
});

test('read requires --id (exit 1)', async () => {
  let code;
  try {
    await run('read');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('create-document POSTs / with kind=document and a base64-encoded markdown body', async () => {
  restResponder = () => ({ approvalRequired: false, status: 201, payload: { id: 'obj-9', slug: 'doc' } });

  await run('create-document', '--title', 'Sample', '--markdown', '# Hello', '--collection', 'lessons', '--tags', 'a,b');

  expect(restCalls[0].method).toBe('POST');
  expect(restCalls[0].path).toBe('');
  // Body is base64-encoded in transit with codeEncoding: 'base64' so the edge WAF
  // never inspects raw markup; the server decodes it before screening.
  expect(restCalls[0].opts.body).toEqual({
    kind: 'document',
    title: 'Sample',
    collectionId: 'lessons',
    body: Buffer.from('# Hello', 'utf8').toString('base64'),
    bodyFormat: 'markdown',
    codeEncoding: 'base64',
    visibility: undefined,
    tags: ['a', 'b'],
  });
});

test('create-document with no --markdown sends no body and no codeEncoding', async () => {
  await run('create-document', '--title', 'Empty');
  const body = restCalls[0].opts.body;
  expect(body.body).toBeUndefined();
  expect(body.codeEncoding).toBeUndefined();
});

test('create-document carries a visibility object built from --visibility/--grants', async () => {
  await run('create-document', '--title', 'T', '--visibility', 'group', '--grants', 'role:staff,building:GHS');
  expect(restCalls[0].opts.body.visibility).toEqual({
    level: 'group',
    grants: [
      { kind: 'role', value: 'staff' },
      { kind: 'building', value: 'GHS' },
    ],
  });
});

test('create-document flags the §26.4 create-as-private downgrade (requested public → private)', async () => {
  restResponder = () => ({
    approvalRequired: false,
    status: 201,
    payload: { id: 'obj-9', slug: 'doc', visibilityLevel: 'private' },
  });

  await run('create-document', '--title', 'T', '--visibility', 'public');

  const out = emitted[0];
  expect(out.approvalRequired).toBe(true);
  expect(out.requestedVisibilityLevel).toBe('public');
  expect(out.visibilityLevel).toBe('private');
  expect(typeof out.visibilityNote).toBe('string');
});

test('create-document does NOT add a downgrade note when the requested level is applied', async () => {
  restResponder = () => ({
    approvalRequired: false,
    status: 201,
    payload: { id: 'obj-9', slug: 'doc', visibilityLevel: 'internal' },
  });

  await run('create-document', '--title', 'T', '--visibility', 'internal');

  const out = emitted[0];
  expect(out.approvalRequired).toBeUndefined();
  expect(out.visibilityNote).toBeUndefined();
});

test('a value-less optional flag is a usage error (exit 1), not silently dropped', async () => {
  let code;
  try {
    // `--collection` with no value → parseArgs yields `true` → optStr fails.
    await run('find', '--collection');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('create-artifact POSTs / with kind=artifact, base64 code→body, and bodyFormat', async () => {
  await run('create-artifact', '--title', 'Chart', '--code', '<html></html>', '--body-format', 'html');
  const body = restCalls[0].opts.body;
  expect(body).toMatchObject({
    kind: 'artifact',
    title: 'Chart',
    bodyFormat: 'html',
    codeEncoding: 'base64',
  });
  expect(Buffer.from(body.body, 'base64').toString('utf8')).toBe('<html></html>');
});

test('create-artifact with <script>/<style> produces a WAF-opaque base64 body', async () => {
  const code =
    '<html><style>b{color:red}</style><script>alert(1)</script></html>';
  await run('create-artifact', '--title', 'X', '--code', code, '--body-format', 'html');
  const body = restCalls[0].opts.body;
  expect(body.codeEncoding).toBe('base64');
  // Canonical base64: no <, >, ", : — so the WAF's CrossSiteScripting_BODY rule
  // has no XSS signature to match. The server round-trips it back to the real code.
  expect(body.body).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  expect(body.body).not.toContain('<script');
  expect(Buffer.from(body.body, 'base64').toString('utf8')).toBe(code);
});

test('create-artifact requires --body-format (exit 1)', async () => {
  let code;
  try {
    await run('create-artifact', '--title', 'Chart', '--code', '<html></html>');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('create-artifact reads code from --code-file (avoids the argv-size limit)', async () => {
  const os = require('node:os');
  const path = require('node:path');
  // Private, unpredictable temp dir (not os.tmpdir()+predictable name).
  const dir = validatedFs.mkdtempSync(path.join(os.tmpdir(), 'atrium-test-'));
  const file = path.join(dir, 'code.html');
  const code = '<html><body><h1>From file</h1><script>x()</script></body></html>';
  validatedFs.writeFileSync(file, code);
  try {
    await run('create-artifact', '--title', 'Big', '--code-file', file, '--body-format', 'html');
    const body = restCalls[0].opts.body;
    expect(body).toMatchObject({ kind: 'artifact', title: 'Big', bodyFormat: 'html', codeEncoding: 'base64' });
    expect(Buffer.from(body.body, 'base64').toString('utf8')).toBe(code);
  } finally {
    validatedFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create-artifact with an unreadable --code-file fails with a clear config error (exit 1)', async () => {
  let code;
  try {
    await run('create-artifact', '--title', 'X', '--code-file', '/nonexistent/nope.html', '--body-format', 'html');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('create-artifact rejects passing both --code and --code-file (exit 1)', async () => {
  let code;
  try {
    await run('create-artifact', '--title', 'X', '--code', '<html></html>', '--code-file', '/tmp/x.html', '--body-format', 'html');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('edit (replace) POSTs a new version with the given body', async () => {
  restResponder = () => ({ approvalRequired: false, status: 201, payload: { id: 'obj-1', versionId: 'v3' } });

  await run('edit', '--id', 'obj-1', '--body', 'new text', '--summary', 'rev');

  expect(restCalls).toHaveLength(1);
  expect(restCalls[0]).toMatchObject({ method: 'POST', path: '/obj-1/versions' });
  expect(restCalls[0].opts.body).toEqual({
    body: Buffer.from('new text', 'utf8').toString('base64'),
    bodyFormat: undefined,
    summary: 'rev',
    codeEncoding: 'base64',
  });
  expect(emitted[0].mode).toBe('replace');
});

test('edit (append) reads the saved body then POSTs the concatenation', async () => {
  restResponder = (call) => {
    if (call.method === 'GET') {
      return {
        approvalRequired: false,
        status: 200,
        payload: { id: 'obj-1', version: { bodyFormat: 'markdown', bodyInline: 'first' } },
      };
    }
    return { approvalRequired: false, status: 201, payload: { id: 'obj-1', versionId: 'v4' } };
  };

  await run('edit', '--id', 'obj-1', '--body', 'second', '--mode', 'append');

  expect(restCalls[0]).toMatchObject({ method: 'GET', path: '/obj-1' });
  expect(restCalls[1]).toMatchObject({ method: 'POST', path: '/obj-1/versions' });
  // The concatenated body is base64-encoded in transit; it decodes to the join.
  expect(restCalls[1].opts.body.codeEncoding).toBe('base64');
  expect(Buffer.from(restCalls[1].opts.body.body, 'base64').toString('utf8')).toBe(
    'first\n\nsecond'
  );
  expect(restCalls[1].opts.body.bodyFormat).toBe('markdown');
});

test('edit (append) fails cleanly when the current body is not inline', async () => {
  restResponder = () => ({
    approvalRequired: false,
    status: 200,
    payload: { id: 'obj-1', version: { bodyFormat: 'markdown', bodyInline: null } },
  });

  let code;
  try {
    await run('edit', '--id', 'obj-1', '--body', 'second', '--mode', 'append');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
  // Only the GET happened; no version was written.
  expect(restCalls).toHaveLength(1);
});

test('archive PATCHes /<id> with status archived', async () => {
  restResponder = () => ({
    approvalRequired: false,
    status: 200,
    payload: { id: 'obj-1', slug: 'doc', status: 'archived' },
  });

  await run('archive', '--id', 'obj-1');

  expect(restCalls).toHaveLength(1);
  expect(restCalls[0]).toMatchObject({ method: 'PATCH', path: '/obj-1' });
  expect(restCalls[0].opts.body).toEqual({ status: 'archived' });
  expect(emitted[0].archived).toBe(true);
  expect(emitted[0].status).toBe('archived');
});

test('archive requires --id (exit 1)', async () => {
  let code;
  try {
    await run('archive');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('delete DELETEs /<id> and flags deleted', async () => {
  restResponder = () => ({
    approvalRequired: false,
    status: 200,
    payload: { id: 'obj-1', slug: 'doc', title: 'Doc', kind: 'document', versionsDeleted: 2 },
  });

  await run('delete', '--id', 'obj-1');

  expect(restCalls).toHaveLength(1);
  expect(restCalls[0]).toMatchObject({ method: 'DELETE', path: '/obj-1' });
  // No request body for a delete.
  expect(restCalls[0].opts.body).toBeUndefined();
  expect(emitted[0].deleted).toBe(true);
  expect(emitted[0].title).toBe('Doc');
  expect(emitted[0].versionsDeleted).toBe(2);
});

test('delete requires --id (exit 1)', async () => {
  let code;
  try {
    await run('delete');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('delete url-encodes the id', async () => {
  await run('delete', '--id', 'weird/id');
  expect(restCalls[0].path).toBe('/weird%2Fid');
});

test('set-visibility PATCHes /<id>/visibility with level + grants', async () => {
  await run('set-visibility', '--id', 'obj-1', '--level', 'group', '--grants', 'role:staff');
  expect(restCalls[0]).toMatchObject({ method: 'PATCH', path: '/obj-1/visibility' });
  expect(restCalls[0].opts.body).toEqual({ level: 'group', grants: [{ kind: 'role', value: 'staff' }] });
});

test('publish POSTs /<id>/publish with the destination (default intranet)', async () => {
  await run('publish', '--id', 'obj-1');
  expect(restCalls[0]).toMatchObject({ method: 'POST', path: '/obj-1/publish' });
  expect(restCalls[0].opts.body).toEqual({ destination: 'intranet' });
});

test('publish emits readerUrl when the broker returns it', async () => {
  restResponder = () => ({
    approvalRequired: false,
    status: 200,
    payload: {
      id: 'obj-1',
      destination: 'intranet',
      publishedVersionId: 'v7',
      readerUrl: 'https://app.example/c/field-trip',
    },
  });

  await run('publish', '--id', 'obj-1');

  expect(emitted[0].readerUrl).toBe(
    'https://app.example/c/field-trip'
  );
});

test('publish relays an approval_required outcome', async () => {
  restResponder = () => ({
    approvalRequired: true,
    status: 202,
    payload: { status: 'approval_required', message: 'Queued for approval.' },
  });

  await run('publish', '--id', 'obj-1', '--destination', 'public_web');

  const out = emitted[0];
  expect(out.approvalRequired).toBe(true);
  expect(out.status).toBe('approval_required');
  expect(out.message).toBe('Queued for approval.');
  expect(out.destination).toBe('public_web');
});

test('unpublish DELETEs /<id>/publish/<destination>', async () => {
  await run('unpublish', '--id', 'obj-1', '--destination', 'intranet');
  expect(restCalls[0]).toMatchObject({ method: 'DELETE', path: '/obj-1/publish/intranet' });
});

test('unpublish requires a valid --destination (exit 1)', async () => {
  let code;
  try {
    await run('unpublish', '--id', 'obj-1');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

test('an unknown subcommand fails (exit 1)', async () => {
  let code;
  try {
    await run('frobnicate');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
});

// ── read-source / assets ─────────────────────────────────────────────────────
//
// `read` deliberately cannot return a DOCUMENT's text (it lives in the
// collaborative store), and until #1284's assets reached this broker an agent
// could not put a real image in a document at all. These cover both.

const os = require('node:os');
const nodePath = require('node:path');
const crypto = require('node:crypto');

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  Buffer.from('fake-png-body'),
]);

function tmpFile(name, bytes) {
  const dir = validatedFs.mkdtempSync(nodePath.join(os.tmpdir(), 'psd-atrium-test-'));
  const p = nodePath.join(dir, name);
  validatedFs.writeFileSync(p, bytes);
  return p;
}

test('read-source GETs /<id>/source and flags the live-editor gap', async () => {
  restResponder = () => ({
    approvalRequired: false,
    status: 200,
    payload: { versionId: 'v3', bodyFormat: 'markdown', body: '## Title\nA procedure' },
  });

  await run('read-source', '--id', 'obj-1');

  expect(restCalls[0]).toMatchObject({ method: 'GET', path: '/obj-1/source' });
  expect(emitted[0].body).toBe('## Title\nA procedure');
  expect(emitted[0].note).toMatch(/ahead/i);
});

test('list-assets GETs /<id>/assets', async () => {
  restResponder = () => ({
    approvalRequired: false,
    status: 200,
    payload: [{ id: 'asset-1', state: 'ready' }],
  });

  await run('list-assets', '--id', 'obj-1');

  expect(restCalls[0]).toMatchObject({ method: 'GET', path: '/obj-1/assets' });
  expect(emitted[0]).toEqual([{ id: 'asset-1', state: 'ready' }]);
});

test('upload-asset reserves, PUTs the bytes, completes, and returns an alt-bearing directive', async () => {
  const file = tmpFile('screenshot.png', PNG_BYTES);
  const expectedSha = crypto.createHash('sha256').update(PNG_BYTES).digest('base64url');
  const puts = [];
  const originalPut = common._internals.putPresignedBytes;
  common._internals.putPresignedBytes = async (url, headers, bytes) => {
    puts.push({ url, headers, byteLength: bytes.length });
  };

  restResponder = (call) => {
    if (call.path === '/obj-1/assets') {
      return {
        approvalRequired: false,
        status: 201,
        payload: {
          id: 'asset-7',
          embedRef: '::atrium-asset{id="asset-7" alt="screenshot.png"}',
          upload: {
            method: 'PUT',
            url: 'https://s3.example/upload',
            headers: { 'content-type': 'image/png', 'x-amz-checksum-sha256': 'CHK' },
          },
        },
      };
    }
    return {
      approvalRequired: false,
      status: 200,
      payload: {
        id: 'asset-7',
        state: 'ready',
        embedRef: '::atrium-asset{id="asset-7" alt="screenshot.png"}',
      },
    };
  };

  try {
    await run('upload-asset', '--id', 'obj-1', '--file', file, '--alt', 'Printer control panel');
  } finally {
    common._internals.putPresignedBytes = originalPut;
  }

  expect(restCalls[0]).toMatchObject({ method: 'POST', path: '/obj-1/assets' });
  expect(restCalls[0].opts.body).toEqual({
    filename: 'screenshot.png',
    // Detected from MAGIC BYTES, not the .png suffix.
    contentType: 'image/png',
    byteLength: PNG_BYTES.length,
    sha256: expectedSha,
    purpose: 'document_image',
  });
  expect(puts).toEqual([
    {
      url: 'https://s3.example/upload',
      headers: { 'content-type': 'image/png', 'x-amz-checksum-sha256': 'CHK' },
      byteLength: PNG_BYTES.length,
    },
  ]);
  // The presigned PUT does NOT go through the broker, so `complete` is the
  // SECOND broker call, not the third.
  expect(restCalls[1]).toMatchObject({
    method: 'POST',
    path: '/obj-1/assets/asset-7/complete',
  });
  expect(restCalls[1].opts.body).toEqual({ sha256: expectedSha });
  // The caller's --alt wins over the server's filename-derived embedRef.
  expect(emitted[0].directive).toBe(
    '::atrium-asset{id="asset-7" alt="Printer control panel"}'
  );
});

test('upload-asset sanitizes quotes and braces out of --alt so the directive stays parseable', async () => {
  const file = tmpFile('shot.png', PNG_BYTES);
  const originalPut = common._internals.putPresignedBytes;
  common._internals.putPresignedBytes = async () => {};

  restResponder = (call) => {
    if (call.path === '/obj-1/assets') {
      return {
        approvalRequired: false,
        status: 201,
        payload: {
          id: 'asset-9',
          embedRef: '::atrium-asset{id="asset-9" alt="shot.png"}',
          upload: {
            method: 'PUT',
            url: 'https://s3.example/upload',
            headers: { 'content-type': 'image/png', 'x-amz-checksum-sha256': 'CHK' },
          },
        },
      };
    }
    return {
      approvalRequired: false,
      status: 200,
      payload: {
        id: 'asset-9',
        state: 'ready',
        embedRef: '::atrium-asset{id="asset-9" alt="shot.png"}',
      },
    };
  };

  try {
    // A "}" would end the {...} directive early; a quote would end alt="…".
    await run('upload-asset', '--id', 'obj-1', '--file', file, '--alt', 'Step 1} "done"');
  } finally {
    common._internals.putPresignedBytes = originalPut;
  }

  expect(emitted[0].directive).toBe('::atrium-asset{id="asset-9" alt="Step 1  \'done\'"}');
  // The whole directive still parses as a single {...} attribute block.
  expect(emitted[0].directive).toMatch(/^::atrium-asset\{[^{}]*\}$/);
});

test('upload-asset refuses a non-image regardless of its .png filename (exit 1)', async () => {
  const file = tmpFile('not-really.png', Buffer.from('%PDF-1.7 this is a pdf'));
  let code;
  try {
    await run('upload-asset', '--id', 'obj-1', '--file', file);
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
  expect(restCalls).toHaveLength(0);
});

test('upload-asset requires --id and --file (exit 1)', async () => {
  let code;
  try {
    await run('upload-asset', '--id', 'obj-1');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
  expect(restCalls).toHaveLength(0);
});

test('get-asset decodes the base64 payload to disk', async () => {
  const out = nodePath.join(
    validatedFs.mkdtempSync(nodePath.join(os.tmpdir(), 'psd-atrium-out-')),
    'copied.png'
  );
  restResponder = () => ({
    approvalRequired: false,
    status: 200,
    payload: {
      id: 'asset-7',
      objectId: 'obj-1',
      filename: 'screenshot.png',
      contentType: 'image/png',
      encoding: 'base64',
      data: PNG_BYTES.toString('base64'),
    },
  });

  await run('get-asset', '--id', 'obj-1', '--asset-id', 'asset-7', '--out', out);

  expect(restCalls[0]).toMatchObject({
    method: 'GET',
    path: '/obj-1/assets/asset-7/bytes',
  });
  expect(validatedFs.readFileSync(out).equals(PNG_BYTES)).toBe(true);
  expect(emitted[0].byteLength).toBe(PNG_BYTES.length);
});

test('get-asset refuses to write bytes that are not a real image', async () => {
  const out = nodePath.join(
    validatedFs.mkdtempSync(nodePath.join(os.tmpdir(), 'psd-atrium-bad-')),
    'evil.png'
  );
  restResponder = () => ({
    approvalRequired: false,
    status: 200,
    payload: {
      id: 'asset-9',
      objectId: 'obj-1',
      filename: 'evil.png',
      contentType: 'image/png',
      encoding: 'base64',
      // Not an image. Atrium normalizes and re-encodes every asset on
      // completion, so this cannot be a real stored asset — writing it would
      // put arbitrary response bytes on disk at a caller-named path.
      data: Buffer.from('<?php system($_GET[0]); ?>').toString('base64'),
    },
  });

  let code;
  try {
    await run('get-asset', '--id', 'obj-1', '--asset-id', 'asset-9', '--out', out);
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(12);
  expect(validatedFs.existsSync(out)).toBe(false);
});

test('create-document accepts a large body via --markdown-file', async () => {
  const dir = validatedFs.mkdtempSync(nodePath.join(os.tmpdir(), 'psd-atrium-md-'));
  const file = nodePath.join(dir, 'big.md');
  // Comfortably past MAX_ARG_STRLEN (128 KiB), which is exactly the case that
  // fails with E2BIG when passed as a single argv value.
  const big = `# Big\n\n${'x'.repeat(200_000)}\n`;
  validatedFs.writeFileSync(file, big);
  restResponder = () => ({
    approvalRequired: false,
    status: 201,
    payload: { id: 'obj-big', slug: 'big' },
  });

  await run('create-document', '--title', 'Big', '--markdown-file', file);

  const sent = restCalls[0].opts.body;
  expect(sent.codeEncoding).toBe('base64');
  expect(Buffer.from(sent.body, 'base64').toString('utf8')).toBe(big);
});

test('edit accepts --body-file, and refuses it combined with --body', async () => {
  const dir = validatedFs.mkdtempSync(nodePath.join(os.tmpdir(), 'psd-atrium-edit-'));
  const file = nodePath.join(dir, 'body.md');
  validatedFs.writeFileSync(file, '# Replacement');
  restResponder = () => ({
    approvalRequired: false,
    status: 201,
    payload: { id: 'v2' },
  });

  await run('edit', '--id', 'obj-1', '--body-file', file);
  expect(restCalls[0].path).toBe('/obj-1/versions');
  expect(Buffer.from(restCalls[0].opts.body.body, 'base64').toString('utf8')).toBe(
    '# Replacement'
  );

  restCalls = [];
  let code;
  try {
    await run('edit', '--id', 'obj-1', '--body-file', file, '--body', 'inline');
  } catch (err) {
    code = err.code;
  }
  expect(code).toBe(1);
  expect(restCalls).toHaveLength(0);
});
