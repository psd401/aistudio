'use strict';
/**
 * Unit tests for the hyperframes-render Lambda handler (#1175).
 *
 * Covers request validation (the render-service DoD item), CSS/JS injection,
 * and the three handler outcomes (dryRun, S3 upload, render failure) with the
 * render + S3 I/O mocked so no Chromium/FFmpeg/AWS is touched.
 *
 * Run: cd infra/hyperframes-render && bun test
 */

const { test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  handler,
  validateRequest,
  buildComposition,
  injectBefore,
  childEnvWithoutCredentials,
  RenderError,
  MAX_DURATION_SECONDS,
  DEFAULT_FPS,
} = require('./handler');

const MINIMAL_HTML =
  '<!doctype html><html><head></head><body>' +
  '<div data-composition-id="demo" data-duration="3">hi</div></body></html>';

function validEvent(overrides = {}) {
  return {
    html: MINIMAL_HTML,
    durationSeconds: 3,
    fps: 30,
    width: 1920,
    height: 1080,
    userEmail: 'person@psd401.net',
    ...overrides,
  };
}

/** A fake render that writes a non-empty file to outPath (so statSync works). */
function fakeRender(bytes = 'MP4DATA') {
  return async (_html, { outPath }) => {
    fs.writeFileSync(outPath, bytes);
    return outPath;
  };
}

// ── validateRequest ──────────────────────────────────────────────────────────

test('validateRequest accepts a well-formed event and applies defaults', () => {
  const req = validateRequest(validEvent({ fps: undefined }));
  expect(req.durationSeconds).toBe(3);
  expect(req.fps).toBe(DEFAULT_FPS);
  expect(req.width).toBe(1920);
  expect(req.userEmail).toBe('person@psd401.net');
  expect(req.dryRun).toBe(false);
});

test('validateRequest rejects missing/empty html', () => {
  expect(() => validateRequest(validEvent({ html: undefined }))).toThrow(RenderError);
  expect(() => validateRequest(validEvent({ html: '   ' }))).toThrow(/html/);
});

test('validateRequest rejects oversized html', () => {
  const huge = '<div>' + 'x'.repeat(5 * 1024 * 1024) + '</div>';
  expect(() => validateRequest(validEvent({ html: huge }))).toThrow(/bytes/);
});

test('validateRequest requires a positive durationSeconds', () => {
  expect(() => validateRequest(validEvent({ durationSeconds: 0 }))).toThrow(/durationSeconds/);
  expect(() => validateRequest(validEvent({ durationSeconds: -1 }))).toThrow(/durationSeconds/);
  expect(() => validateRequest(validEvent({ durationSeconds: 'abc' }))).toThrow(/durationSeconds/);
});

test('validateRequest enforces the duration cap', () => {
  expect(() => validateRequest(validEvent({ durationSeconds: MAX_DURATION_SECONDS + 1 }))).toThrow(
    new RegExp(String(MAX_DURATION_SECONDS)),
  );
});

test('validateRequest rejects fps out of range', () => {
  expect(() => validateRequest(validEvent({ fps: 0 }))).toThrow(/fps/);
  expect(() => validateRequest(validEvent({ fps: 61 }))).toThrow(/fps/);
});

test('validateRequest rejects dimensions out of range', () => {
  expect(() => validateRequest(validEvent({ width: 8 }))).toThrow(/width/);
  expect(() => validateRequest(validEvent({ height: 5000 }))).toThrow(/height/);
});

test('validateRequest rejects an invalid email (incl. path separators)', () => {
  expect(() => validateRequest(validEvent({ userEmail: 'not-an-email' }))).toThrow(/userEmail/);
  expect(() => validateRequest(validEvent({ userEmail: 'a/b@psd401.net' }))).toThrow(/userEmail/);
});

test('validateRequest rejects a smuggled long data-duration in the composition', () => {
  const sneaky =
    '<div data-composition-id="x" data-duration="600">long</div>';
  expect(() => validateRequest(validEvent({ html: sneaky, durationSeconds: 5 }))).toThrow(/cap/);
});

test('validateRequest rejects non-string css/js', () => {
  expect(() => validateRequest(validEvent({ css: 123 }))).toThrow(/css/);
  expect(() => validateRequest(validEvent({ js: {} }))).toThrow(/js/);
});

test('validateRequest caps the combined html+css+js size, not html alone', () => {
  // A small html + oversized css must be rejected (the cap is the whole
  // composition, and the summed payload has to fit the Lambda invoke ceiling).
  const bigCss = 'a'.repeat(5 * 1024 * 1024);
  expect(() => validateRequest(validEvent({ css: bigCss }))).toThrow(/bytes/);
  const bigJs = 'b'.repeat(5 * 1024 * 1024);
  expect(() => validateRequest(validEvent({ js: bigJs }))).toThrow(/bytes/);
});

// ── childEnvWithoutCredentials ───────────────────────────────────────────────

test('childEnvWithoutCredentials strips AWS creds but keeps render env', () => {
  const child = childEnvWithoutCredentials({
    AWS_ACCESS_KEY_ID: 'AKIA_SECRET',
    AWS_SECRET_ACCESS_KEY: 'shhh',
    AWS_SESSION_TOKEN: 'token',
    AWS_SECURITY_TOKEN: 'legacy',
    PATH: '/usr/bin',
    HOME: '/tmp',
    PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
    PRODUCER_HEADLESS_SHELL_PATH: '/opt/x',
  });
  expect(child.AWS_ACCESS_KEY_ID).toBeUndefined();
  expect(child.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(child.AWS_SESSION_TOKEN).toBeUndefined();
  expect(child.AWS_SECURITY_TOKEN).toBeUndefined();
  expect(child.PATH).toBe('/usr/bin');
  expect(child.HOME).toBe('/tmp');
  expect(child.PUPPETEER_EXECUTABLE_PATH).toBe('/usr/bin/chromium');
  expect(child.PRODUCER_HEADLESS_SHELL_PATH).toBe('/opt/x');
});

// ── buildComposition / injectBefore ──────────────────────────────────────────

test('injectBefore inserts before the marker, appends when absent', () => {
  expect(injectBefore('<head></head>', '</head>', 'X')).toBe('<head>X</head>');
  expect(injectBefore('nomarker', '</head>', 'X')).toBe('nomarker\nX');
});

test('buildComposition injects css before </head> and js before </body>', () => {
  const out = buildComposition({
    html: '<html><head></head><body></body></html>',
    css: 'body{color:red}',
    js: 'console.log(1)',
  });
  expect(out).toContain('<style>\nbody{color:red}\n</style>\n</head>');
  expect(out).toContain('<script>\nconsole.log(1)\n</script>\n</body>');
});

test('buildComposition passes html through untouched when no css/js', () => {
  const html = '<html><head></head><body>hi</body></html>';
  expect(buildComposition({ html, css: null, js: null })).toBe(html);
});

// ── handler outcomes ─────────────────────────────────────────────────────────

let outputDir;
beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-test-out-'));
  process.env.HYPERFRAMES_OUTPUT_DIR = outputDir;
});
afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
  delete process.env.HYPERFRAMES_OUTPUT_DIR;
  delete process.env.WORKSPACE_BUCKET;
});

test('handler dryRun renders and returns a local path without uploading', async () => {
  let uploaded = false;
  const s3 = { send: async () => { uploaded = true; } };
  const res = await handler(validEvent({ dryRun: true }), { s3, render: fakeRender('DRY') });
  expect(res.status).toBe('ok');
  expect(res.dryRun).toBe(true);
  expect(res.bytes).toBe(3);
  expect(fs.existsSync(res.localPath)).toBe(true);
  expect(uploaded).toBe(false);
});

test('handler dryRun without HYPERFRAMES_OUTPUT_DIR leaves no file behind', async () => {
  // Production has no HYPERFRAMES_OUTPUT_DIR, so a dry-run MP4 is written inside
  // workDir and removed by the finally cleanup — it must not accumulate in /tmp.
  delete process.env.HYPERFRAMES_OUTPUT_DIR;
  const res = await handler(validEvent({ dryRun: true }), {
    s3: { send: async () => {} },
    render: fakeRender('DRY'),
  });
  expect(res.status).toBe('ok');
  expect(res.dryRun).toBe(true);
  expect(res.bytes).toBe(3);
  expect(fs.existsSync(res.localPath)).toBe(false);
});

test('handler uploads to S3 and returns a public-by-link url', async () => {
  process.env.WORKSPACE_BUCKET = 'psd-agents-dev-123';
  const puts = [];
  const s3 = { send: async (cmd) => { puts.push(cmd.input); } };
  const res = await handler(validEvent(), { s3, render: fakeRender('MP4') });
  expect(res.status).toBe('ok');
  expect(res.sharing).toBe('public-by-link');
  expect(res.s3Key).toMatch(/^public-images\/person@psd401\.net\/[0-9a-f-]+\.mp4$/);
  expect(res.url).toContain('psd-agents-dev-123.s3.');
  expect(res.url).toContain('/public-images/');
  expect(puts).toHaveLength(1);
  expect(puts[0].ContentType).toBe('video/mp4');
});

test('handler returns misconfigured when WORKSPACE_BUCKET is unset (non-dryRun)', async () => {
  const s3 = { send: async () => {} };
  const res = await handler(validEvent(), { s3, render: fakeRender() });
  expect(res.status).toBe('error');
  expect(res.error).toBe('misconfigured');
});

test('handler surfaces a render failure as a structured error, never a throw', async () => {
  const failing = async () => { throw new RenderError('render_failed', 'boom'); };
  const res = await handler(validEvent({ dryRun: true }), { s3: { send: async () => {} }, render: failing });
  expect(res.status).toBe('error');
  expect(res.error).toBe('render_failed');
  expect(res.message).toContain('boom');
});

test('handler returns a bad_request error for an invalid event (no throw)', async () => {
  const res = await handler({ html: '' }, { s3: { send: async () => {} }, render: fakeRender() });
  expect(res.status).toBe('error');
  expect(res.error).toBe('bad_request');
});
