'use strict';
const { validatedFs } = require("../../../validated-fs.cjs");


/**
 * Unit tests for psd-hyperframes/render.js (#1175).
 *
 * Covers CLI arg parsing + payload validation and the root-owned Lambda-relay
 * path with an injected relay so no AWS is touched.
 *
 * Run: cd infra/agent-image/skills/psd-hyperframes && bun test
 */

const { test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgs,
  buildPayload,
  findCompositionRootOpenTagEnd,
  injectAudioElement,
  invokeRender,
  validateEmail,
  main,
} = require('./render');

const HTML =
  '<div data-composition-id="demo" data-duration="3">hi</div>';

// fail() calls process.exit(1); stub it to throw so validation branches are
// observable. Stdout/stderr are captured so the emitted JSON can be asserted.
class ExitError extends Error {
  constructor(code) {
    super(`exit(${code})`);
    this.code = code;
  }
}

let originalExit;
let originalStdout;
let originalStderr;
let stdout;

beforeEach(() => {
  stdout = '';
  originalExit = process.exit;
  originalStdout = process.stdout.write;
  originalStderr = process.stderr.write;
  process.exit = (code) => { throw new ExitError(code); };
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = () => true;
});

afterEach(() => {
  process.exit = originalExit;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
});

function lastJson() {
  const lines = stdout.trim().split('\n');
  return JSON.parse(lines.join('\n'));
}

function argv(...rest) {
  return ['node', 'render.js', ...rest];
}

// ── validateEmail / parseArgs ────────────────────────────────────────────────

test('validateEmail accepts real emails, rejects junk and path separators', () => {
  expect(validateEmail('person@psd401.net')).toBe(true);
  expect(validateEmail('nope')).toBe(false);
  expect(validateEmail('a/b@psd401.net')).toBe(false);
});

test('parseArgs maps --dashed-flags to underscore keys and boolean flags', () => {
  const args = parseArgs(argv('--user', 'x@y.z', '--css-file', '/tmp/a.css', '--dry-run'));
  expect(args.user).toBe('x@y.z');
  expect(args.css_file).toBe('/tmp/a.css');
  expect(args.dry_run).toBe(true);
});

// ── buildPayload validation ──────────────────────────────────────────────────

test('buildPayload assembles a valid payload with defaults', () => {
  const p = buildPayload(parseArgs(argv('--user', 'p@psd401.net', '--html', HTML, '--duration', '3')));
  expect(p.userEmail).toBe('p@psd401.net');
  expect(p.html).toBe(HTML);
  expect(p.durationSeconds).toBe(3);
  expect(p.fps).toBe(30);
  expect(p.width).toBe(1920);
  expect(p.height).toBe(1080);
  expect(p.css).toBeUndefined();
});

test('buildPayload rejects a missing user', () => {
  expect(() => buildPayload(parseArgs(argv('--html', HTML, '--duration', '3')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
});

test('buildPayload rejects a missing composition', () => {
  expect(() => buildPayload(parseArgs(argv('--user', 'p@psd401.net', '--duration', '3')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
});

test('buildPayload rejects a missing / non-positive / over-cap duration', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML];
  expect(() => buildPayload(parseArgs(argv(...base)))).toThrow(ExitError);
  expect(() => buildPayload(parseArgs(argv(...base, '--duration', '0')))).toThrow(ExitError);
  expect(() => buildPayload(parseArgs(argv(...base, '--duration', '181')))).toThrow(ExitError); // > 180s (3 min) cap
});

test('buildPayload allows up to the 3-minute cap at a budget-safe fps', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML];
  // 180s at 20fps = 3600 frames = exactly the render budget.
  expect(() => buildPayload(parseArgs(argv(...base, '--duration', '180', '--fps', '20')))).not.toThrow();
});

test('buildPayload rejects an over-budget frame count (fps × duration > 3600)', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML];
  // 120s at 60fps = 7200 frames — over the budget even though each is in range.
  expect(() => buildPayload(parseArgs(argv(...base, '--duration', '120', '--fps', '60')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
});

test('buildPayload rejects fps and dimensions out of range', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML, '--duration', '3'];
  expect(() => buildPayload(parseArgs(argv(...base, '--fps', '61')))).toThrow(ExitError);
  expect(() => buildPayload(parseArgs(argv(...base, '--width', '9')))).toThrow(ExitError);
});

test('buildPayload fails on a valueless --css-file / --js-file instead of silently dropping it', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML, '--duration', '3'];
  // --css-file as the last token parses to boolean true — must be a hard error.
  expect(() => buildPayload(parseArgs(argv(...base, '--css-file')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
  stdout = ''; // reset so lastJson() reads only the second fail's JSON
  expect(() => buildPayload(parseArgs(argv(...base, '--js-file')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
});

test('buildPayload rejects a --dry-run given a value', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML, '--duration', '3'];
  expect(() => buildPayload(parseArgs(argv(...base, '--dry-run', 'true')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
});

test('buildPayload caps the combined html+css+js size', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-skill-big-'));
  const cssPath = path.join(dir, 'big.css');
  validatedFs.writeFileSync(cssPath, 'a'.repeat(5 * 1024 * 1024));
  try {
    expect(() => buildPayload(parseArgs(argv(
      '--user', 'p@psd401.net', '--html', HTML, '--duration', '3', '--css-file', cssPath,
    )))).toThrow(ExitError);
    expect(lastJson().error).toBe('bad_args');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPayload reads css/js from files and carries dryRun', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-skill-'));
  const cssPath = path.join(dir, 'a.css');
  validatedFs.writeFileSync(cssPath, 'body{color:red}');
  try {
    const p = buildPayload(parseArgs(argv(
      '--user', 'p@psd401.net', '--html', HTML, '--duration', '3',
      '--css-file', cssPath, '--dry-run',
    )));
    expect(p.css).toBe('body{color:red}');
    expect(p.dryRun).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPayload injects an <audio> track from --audio-url into the composition root', () => {
  const url = 'https://psd-agents-dev.s3.us-east-1.amazonaws.com/public-images/p@psd401.net/n.mp3';
  const p = buildPayload(parseArgs(argv(
    '--user', 'p@psd401.net', '--html', HTML, '--duration', '3', '--audio-url', url,
  )));
  expect(p.html).toContain(`<audio src="${url}"`);
  expect(p.html).toContain('data-duration="3"');
  expect(p.html).toContain('data-track-index="0"');
  // Injected as the first child of the data-composition-id root element.
  expect(p.html).toMatch(/data-composition-id="demo"[^>]*>\s*<audio /);
});

test('composition-root lookup is linear and ignores attribute-like quoted text', () => {
  const html =
    `<div title="data-composition-id > ${'<A'.repeat(50_000)}">decoy</div>` +
    '<main title="1 > 0" data-composition-id="real">content</main>';
  const end = findCompositionRootOpenTagEnd(html);

  expect(end).toBe(html.indexOf('>content') + 1);
  const injected = injectAudioElement(
    html,
    'https://example.com/audio.mp3',
    3,
  );
  expect(injected.indexOf('<audio')).toBeGreaterThan(
    injected.indexOf('data-composition-id="real"'),
  );
  expect(injected.indexOf('<audio')).toBeLessThan(injected.indexOf('content'));
});

test('buildPayload rejects an unsafe / non-https --audio-url', () => {
  const base = ['--user', 'p@psd401.net', '--html', HTML, '--duration', '3'];
  expect(() => buildPayload(parseArgs(argv(...base, '--audio-url', 'http://insecure.example/n.mp3')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
  stdout = ''; // reset so lastJson() reads only the second failure
  expect(() => buildPayload(parseArgs(argv(...base, '--audio-url', 'https://x/a" onerror=1')))).toThrow(ExitError);
  expect(lastJson().error).toBe('bad_args');
});

// ── invokeRender (mocked root relay) ─────────────────────────────────────────

function fakeRelay(responder) {
  const calls = [];
  const relay = async (payload) => {
    calls.push(payload);
    return responder(payload);
  };
  relay.calls = calls;
  return relay;
}

function okResult(extra = {}) {
  return {
    status: 'ok',
    url: 'https://psd-agents-dev.s3.us-east-1.amazonaws.com/public-images/p@psd401.net/uuid.mp4',
    s3Key: 'public-images/p@psd401.net/uuid.mp4',
    bytes: 12345,
    fps: 30,
    durationSeconds: 3,
    width: 1920,
    height: 1080,
    sharing: 'public-by-link',
    ...extra,
  };
}

test('invokeRender sends the validated payload through the fixed-operation relay', async () => {
  const relay = fakeRelay(() => okResult());
  const payload = { html: HTML, durationSeconds: 3 };
  const result = await invokeRender(payload, { relay });
  expect(result.status).toBe('ok');
  expect(result.s3Key).toBe('public-images/p@psd401.net/uuid.mp4');
  expect(relay.calls).toEqual([payload]);
});

test('invokeRender surfaces a structured render error (status:error) as an exit', async () => {
  const relay = fakeRelay(() => ({
    status: 'error',
    error: 'render_failed',
    message: 'chromium crashed',
  }));
  await expect(invokeRender({ html: HTML }, { relay })).rejects.toThrow(ExitError);
  expect(lastJson().error).toBe('render_failed');
  expect(lastJson().message).toContain('chromium crashed');
});

test('invokeRender surfaces a relay or Lambda transport failure without credentials', async () => {
  const relay = fakeRelay(() => {
    throw new Error('HyperFrames relay returned HTTP 502');
  });
  await expect(invokeRender({ html: HTML }, { relay })).rejects.toThrow(ExitError);
  expect(lastJson().error).toBe('invoke_failed');
  expect(lastJson().message).toContain('HTTP 502');
});

test('invokeRender needs no AWS credential variables in the exec subprocess', async () => {
  const credentialKeys = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  ];
  const saved = Object.fromEntries(credentialKeys.map((key) => [key, process.env[key]]));
  for (const key of credentialKeys) delete process.env[key];
  try {
    const relay = fakeRelay(() => okResult());
    const result = await invokeRender({ html: HTML, durationSeconds: 3 }, { relay });
    expect(result.status).toBe('ok');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ── main end-to-end (mocked relay) ───────────────────────────────────────────

test('main emits the bare result JSON with the url on relay success', async () => {
  const relay = fakeRelay(() => okResult());
  await main(argv('--user', 'p@psd401.net', '--html', HTML, '--duration', '3'), { relay });
  const out = lastJson();
  expect(out.url).toContain('/public-images/');
  expect(out.s3Key).toBe('public-images/p@psd401.net/uuid.mp4');
  expect(out.sharing).toBe('public-by-link');
});


// ── injectAudioElement / composition-root lookup (#1298) ─────────────────────
//
// The root lookup used to be /<[a-zA-Z][^>]*\bdata-composition-id\b[^>]*>/,
// whose two unbounded [^>]* runs make matching quadratic in the input
// (CodeQL js/polynomial-redos). `html` comes straight from --html/--file, so
// these cover both that the linear replacement kept the old semantics and that
// the quadratic blow-up is gone.

const AUDIO_URL = 'https://example.com/a.mp3';

test('injectAudioElement inserts the audio tag just after the composition root', () => {
  const out = injectAudioElement('<div data-composition-id="demo">hi</div>', AUDIO_URL, 3);
  expect(out).toBe(
    '<div data-composition-id="demo">\n' +
      `<audio src="${AUDIO_URL}" data-start="0" data-duration="3" data-track-index="0" data-volume="1"></audio>` +
      'hi</div>'
  );
});

test('injectAudioElement finds a composition root that is not the first tag', () => {
  const out = injectAudioElement('<html><body><section data-composition-id="d">x</section></body></html>', AUDIO_URL, 2);
  expect(out.indexOf('<audio')).toBe('<html><body><section data-composition-id="d">\n'.length);
});

test('injectAudioElement respects word boundaries around the attribute name', () => {
  // `data-composition-ids` and `xdata-composition-id` are NOT the attribute;
  // both fall through to the </body> branch, exactly as the old \b regex did.
  for (const attr of ['data-composition-ids', 'xdata-composition-id']) {
    const out = injectAudioElement(`<div ${attr}="d">x</div><body>y</body>`, AUDIO_URL, 1);
    expect(out.indexOf('<audio')).toBeLessThan(out.indexOf('</body>'));
    expect(out.indexOf('<audio')).toBeGreaterThan(out.indexOf('<div'));
  }
});

test('injectAudioElement falls back to before </body> when there is no root', () => {
  const out = injectAudioElement('<html><body>hi</body></html>', AUDIO_URL, 1);
  expect(out).toContain('hi<audio');
  expect(out.indexOf('<audio')).toBeLessThan(out.indexOf('</body>'));
});

test('injectAudioElement falls back to appending when there is no body either', () => {
  const out = injectAudioElement('plain text', AUDIO_URL, 1);
  expect(out.startsWith('plain text\n<audio')).toBe(true);
});

test('injectAudioElement ignores tags whose name does not start with a letter', () => {
  // <!-- ... --> and <1foo ...> are not element open tags; the old regex
  // required [a-zA-Z] after '<' and so does the linear scan.
  const out = injectAudioElement('<!-- data-composition-id --><body>x</body>', AUDIO_URL, 1);
  expect(out.indexOf('<audio')).toBeLessThan(out.indexOf('</body>'));
  expect(out.indexOf('<audio')).toBeGreaterThan(out.indexOf('-->'));
});

test('injectAudioElement handles an unterminated tag without matching', () => {
  const out = injectAudioElement('<div data-composition-id="d"', AUDIO_URL, 1);
  expect(out).toBe(`<div data-composition-id="d"\n<audio src="${AUDIO_URL}" data-start="0" data-duration="1" data-track-index="0" data-volume="1"></audio>`);
});

test('injectAudioElement handles one long unterminated tag', () => {
  // '<a' + a long run with no '>'. Measured honestly: the OLD regex was already
  // fast here (~1 ms at n=100k) because V8's literal prefilter for
  // "data-composition-id" skips the run, so this is a correctness regression
  // test, not a ReDoS witness. The real witness is the next test.
  const out = injectAudioElement('<a' + 'a'.repeat(200000), AUDIO_URL, 1);
  expect(out.endsWith('</audio>')).toBe(true);
});

test('injectAudioElement is linear on the quadratic witness (many unclosed tags)', () => {
  // '<a' repeated is the shape that actually blew up. Measured on the old
  // regex, node 22: n=20k 365 ms, n=50k 1753 ms, n=100k 4497 ms — 5x input for
  // ~12x time, i.e. quadratic, and a real DoS lever because `html` comes
  // straight from --html/--file. The linear scan: n=100k 2 ms, n=400k 4 ms.
  // The 1 s bound below therefore fails loudly against the old implementation
  // (4497 ms) while leaving ~500x headroom for the new one on slow CI.
  const witness = '<a'.repeat(50000); // 100k chars
  const started = Date.now();
  const out = injectAudioElement(witness, AUDIO_URL, 1);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(out.endsWith('</audio>')).toBe(true);
});

// ── findCompositionRootOpenTagEnd: parity with the regex it replaced (#1298) ──
//
// The scanner must agree with /<[a-zA-Z][^>]*\bdata-composition-id\b[^>]*>/ on
// everything except the one case where that regex was itself wrong (a quoted
// '>' inside an attribute value, which its [^>]* could not cross).

function oldRegexFind(html) {
  const m = html.match(/<[a-zA-Z][^>]*\bdata-composition-id\b[^>]*>/);
  return m ? m.index + m[0].length : -1;
}

const PARITY_CASES = [
  ['plain root', '<div data-composition-id="demo">hi</div>'],
  ['root not first', '<html><body><section data-composition-id="d">x</section></body></html>'],
  // '<' inside a quoted attribute value: [^>]* crossed it happily, so a scanner
  // that treats every '<' as a restart would lose the root and silently drop
  // the narration track.
  ['quoted <', '<div title="a < b" data-composition-id="root"><p>s</p></div>'],
  ['attr suffix', '<div data-composition-ids="d">x</div>'],
  ['attr prefix', '<div xdata-composition-id="d">x</div>'],
  // No whitespace before the attribute — \b accepts '"' as the boundary.
  ['quote, no space', '<div class="x"data-composition-id>y</div>'],
  ['nested <', '<<a data-composition-id>'],
  ['comment first', '<!-- data-composition-id --><div data-composition-id>x</div>'],
  // An apostrophe inside a comment is not an attribute quote. Quote-tracking a
  // non-element `<` let `don't` open a quote that never closed, so every later
  // `>` was swallowed, the scan hit end-of-input and returned -1 — the audio
  // was then appended outside the composition root and silently dropped from
  // the MP4. Only `<` + ASCII letter starts a tag, exactly as the old regex.
  ['apostrophe in comment', "<!-- don't inject here --><div data-composition-id=\"root\">x</div>"],
  ['apostrophe in text', "it's here <div data-composition-id=\"r\">x</div>"],
  ['doctype before root', '<!DOCTYPE html><div data-composition-id="r">x</div>'],
  ['closing tag before root', '</p><div data-composition-id="r">x</div>'],
  // <data-composition-id> is a legal custom-element name. The old regex could
  // never match it (its mandatory [a-zA-Z] ate the name's first character), so
  // an element *named* this must not be mistaken for one *carrying* the attr.
  ['element named attr', '<data-composition-id>hi</data-composition-id>'],
  ['unterminated', '<div data-composition-id="d"'],
  ['empty', ''],
  ['bare <', '<'],
  ['no attr', '<a>'],
];

for (const [name, html] of PARITY_CASES) {
  test(`findCompositionRootOpenTagEnd matches the old regex: ${name}`, () => {
    expect(findCompositionRootOpenTagEnd(html)).toBe(oldRegexFind(html));
  });
}

test('findCompositionRootOpenTagEnd crosses a quoted > that the old regex could not', () => {
  // The one intentional divergence: [^>]* stopped at the quoted '>', so the old
  // regex found no root and the audio was appended outside the composition.
  const html = '<div title="a>b" data-composition-id="z">x</div>';
  expect(oldRegexFind(html)).toBe(-1);
  expect(findCompositionRootOpenTagEnd(html)).toBe(40 + 1);
  expect(injectAudioElement(html, AUDIO_URL, 1)).toContain('">\n<audio');
});

test('findCompositionRootOpenTagEnd stays linear on quote-heavy witnesses', () => {
  // Quote tracking must not reintroduce rescanning. Each shape is 400k chars;
  // measured 2-10 ms each, against a 1 s bound.
  const shapes = [
    '<a'.repeat(200000), // unclosed tags
    '<"'.repeat(200000), // quote open/close churn
    '<a x="' + 'a'.repeat(400000), // one never-closed quote
    '<!--' + "'".repeat(400000), // apostrophe churn inside a non-element token
    '<a ' + 'data-composition-idz '.repeat(19047) + '>', // many near-misses in one tag
  ];
  for (const html of shapes) {
    const started = Date.now();
    findCompositionRootOpenTagEnd(html);
    expect(Date.now() - started).toBeLessThan(1000);
  }
});
