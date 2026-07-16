'use strict';
/**
 * Unit tests for psd-learning-page/run.js (Issue #1245).
 *
 * Covers: arg parsing, Google-Docs id parsing, deterministic content derivation,
 * quiz interactivity (feedback + rationale + score), WebVTT captions, HTML
 * escaping (no injection from document text), each modality's presence, graceful
 * degradation when psd-tts/psd-hyperframes fail, the stubbed Google-Docs ingest +
 * denied-export guidance, and the pre-publish WCAG 2.2 AA gate refusing to
 * publish an inaccessible page.
 *
 * Run: cd infra/agent-image/skills/psd-learning-page && bun test
 */

const { test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const R = require('./run');

// A single private (0700) temp dir for the whole file — avoids the insecure
// os.tmpdir()+predictable-name pattern (CodeQL js/insecure-temporary-file).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-test-'));
function tmpPath(name) {
  return path.join(TMP_DIR, name);
}

const SAMPLE_MD = [
  '# Procedure 3520P: Student Technology',
  '',
  '## Purpose',
  '',
  'This procedure explains how students may use district devices and networks safely.',
  '',
  '## Scope',
  '',
  'It applies to all enrolled students using district devices, the network, or accounts.',
  '',
  '## Acceptable Use',
  '',
  'Students use technology for instructional purposes and protect their credentials.',
  '',
  '## Privacy',
  '',
  'The district may monitor its systems to keep students safe.',
].join('\n');

// ── process.exit / stream stubbing so fail() branches are observable ──────────

class ExitError extends Error {
  constructor(code) {
    super(`exit(${code})`);
    this.code = code;
  }
}
let origExit;
let origOut;
let origErr;
let stdout;

beforeEach(() => {
  stdout = '';
  origExit = process.exit;
  origOut = process.stdout.write;
  origErr = process.stderr.write;
  process.exit = (code) => {
    throw new ExitError(code);
  };
  process.stdout.write = (c) => {
    stdout += c;
    return true;
  };
  process.stderr.write = () => true;
});
afterEach(() => {
  process.exit = origExit;
  process.stdout.write = origOut;
  process.stderr.write = origErr;
});

function argv(...rest) {
  return ['node', 'run.js', ...rest];
}

const PASS_AUDIT = async () => ({
  pass: true,
  blocking: [],
  violations: [],
  counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
  standard: 'stub',
});

// ── pure helpers ──────────────────────────────────────────────────────────────

test('validateEmail accepts real emails, rejects junk and path separators', () => {
  expect(R.validateEmail('a@psd401.net')).toBe(true);
  expect(R.validateEmail('nope')).toBe(false);
  expect(R.validateEmail('a/b@psd401.net')).toBe(false);
});

test('parseGdocId extracts an id from a share URL or accepts a bare id', () => {
  expect(R.parseGdocId('https://docs.google.com/document/d/1AbC_dEf-123/edit')).toBe('1AbC_dEf-123');
  expect(R.parseGdocId('1AbC_dEf-1234567890')).toBe('1AbC_dEf-1234567890');
  expect(R.parseGdocId('not a doc')).toBeNull();
});

test('escapeHtml neutralizes markup-significant characters', () => {
  expect(R.escapeHtml('<script>"&\'')).toBe('&lt;script&gt;&quot;&amp;&#39;');
});

test('deriveContent produces learning targets, summary, quiz, and narration', () => {
  const c = R.deriveContent(SAMPLE_MD, 'Student Technology', null);
  expect(c.learningTargets.length).toBeGreaterThanOrEqual(2);
  expect(c.summaryBullets.length).toBeGreaterThanOrEqual(2);
  expect(c.quizItems.length).toBeGreaterThanOrEqual(1);
  expect(c.narration.script.length).toBeGreaterThan(0);
  expect(c.narration.segments.length).toBeGreaterThan(0);
});

test('deterministic quiz points its correctIndex at a real document point, not a distractor', () => {
  const c = R.deriveContent(SAMPLE_MD, 'Student Technology', null);
  for (const q of c.quizItems) {
    expect(q.options.length).toBeGreaterThanOrEqual(2);
    expect(q.correctIndex).toBeGreaterThanOrEqual(0);
    expect(q.correctIndex).toBeLessThan(q.options.length);
    expect(q.options[q.correctIndex]).not.toMatch(/outside the scope|does not make this claim|contradicts what/);
    expect(q.explanation.length).toBeGreaterThan(0);
  }
});

test('--content-json overrides derivation with authored quiz + summary', () => {
  const c = R.deriveContent(SAMPLE_MD, 'T', {
    summary: ['Authored point one.', 'Authored point two.'],
    learningTargets: ['Do X.'],
    quiz: [{ question: 'Q?', options: ['a', 'b', 'c'], answer: 2, rationale: 'because c' }],
  });
  expect(c.summaryBullets).toEqual(['Authored point one.', 'Authored point two.']);
  expect(c.quizItems[0].correctIndex).toBe(2);
  expect(c.quizItems[0].explanation).toBe('because c');
});

test('extractParagraphs keeps body glued to a heading with no blank line', () => {
  // "## Purpose\nThis explains..." (no blank line) must NOT drop the body.
  const md = '## Purpose\nThis procedure explains the safe use of district devices.\n\n## Scope\nIt applies to all students.';
  const paras = R.extractParagraphs(md);
  expect(paras.join(' ')).toContain('This procedure explains');
  expect(paras.join(' ')).toContain('It applies to all students');
  // The heading text itself is stripped, not surfaced as body.
  expect(paras.some((p) => p === 'Purpose' || p === 'Scope')).toBe(false);
});

test('extractParagraphs handles CRLF-encoded documents', () => {
  const md = '# Title\r\n\r\nFirst real paragraph.\r\n\r\nSecond real paragraph.';
  const paras = R.extractParagraphs(md);
  expect(paras).toContain('First real paragraph.');
  expect(paras).toContain('Second real paragraph.');
});

test('deriveContent falls back to a real quiz when every authored item is invalid', () => {
  // Both items fail options.length >= 2 → normalized quiz is [] → must fall back
  // to the deterministic quiz, not ship a zero-question section.
  const c = R.deriveContent(SAMPLE_MD, 'T', {
    quiz: [{ question: 'Q1?', options: ['only-one'] }, { question: 'Q2?' }],
  });
  expect(c.quizItems.length).toBeGreaterThan(0);
  for (const q of c.quizItems) expect(q.options.length).toBeGreaterThanOrEqual(2);
});

test('normalizeAuthoredQuiz accepts a string-typed answer index', () => {
  const c = R.deriveContent(SAMPLE_MD, 'T', {
    quiz: [{ question: 'Q?', options: ['a', 'b', 'c'], answer: '2', rationale: 'c is right' }],
  });
  expect(c.quizItems[0].correctIndex).toBe(2);
  expect(c.quizItems[0].options[c.quizItems[0].correctIndex]).toBe('c');
});

test('deriveContent coerces non-string summary/target entries instead of throwing', () => {
  // A bare number in an authored summary must not throw inside buildNarration.
  expect(() =>
    R.deriveContent(SAMPLE_MD, 'T', { summary: [123, 'A valid point.'], learningTargets: [456] })
  ).not.toThrow();
  const c = R.deriveContent(SAMPLE_MD, 'T', { summary: [123, 'A valid point.'] });
  expect(c.narration.script).toContain('123');
});

test('authored narration with a script but no segments still gets caption cues', () => {
  const c = R.deriveContent(SAMPLE_MD, 'T', {
    narration: { script: 'First sentence here. Second sentence here. Third one too.' },
  });
  expect(c.narration.segments.length).toBeGreaterThan(0);
  expect(c.narration.transcript).toContain('First sentence');
});

test('authored narration with a blank script falls back to deterministic narration', () => {
  // `typeof "" === "string"` — a blank authored script must NOT ship empty
  // captions/transcript; it falls back like an absent narration key.
  for (const blank of ['', '   \n\t ']) {
    const c = R.deriveContent(SAMPLE_MD, 'Student Technology', { narration: { script: blank } });
    expect(c.narration.script.trim().length).toBeGreaterThan(0);
    expect(c.narration.segments.length).toBeGreaterThan(0);
  }
});

test('resolveAudio/resolveVideo reject an unsafe supplied media URL scheme (noted omission)', async () => {
  const noRun = () => { throw new Error('should not run'); };
  const a = await R.resolveAudio(
    R.parseArgs(argv('--user', 'a@b.net', '--audio-url', 'javascript:alert(1)')),
    { script: 's' },
    { runSkill: noRun },
    false
  );
  expect(a.media).toBeNull();
  expect(a.omission).toMatch(/rejected/i);
  // A data:audio/ URI is allowed (matches psd-hyperframes' contract).
  const ok = await R.resolveAudio(
    R.parseArgs(argv('--user', 'a@b.net', '--audio-url', 'data:audio/mpeg;base64,AAAA')),
    { script: 's' },
    { runSkill: noRun },
    false
  );
  expect(ok.media.url).toBe('data:audio/mpeg;base64,AAAA');
});

test('buildQuizHtml renders keyboard-operable inputs, per-item feedback + rationale, and a score control', () => {
  const html = R.buildQuizHtml([
    { stem: 'Stem one', options: ['A', 'B'], correctIndex: 1, explanation: 'B is right because reasons.' },
  ]);
  expect(html).toContain('type="radio"');
  expect(html).toContain('data-correct="1"');
  expect(html).toContain('data-explanation="B is right because reasons."');
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('Check answer');
  expect(html).toContain('id="lp-score-btn"');
});

test('buildVtt emits a valid WEBVTT track with sequential cues', () => {
  const vtt = R.buildVtt([
    { text: 'First cue.', start: 0, end: 4 },
    { text: 'Second cue.', start: 4, end: 8 },
  ]);
  expect(vtt.startsWith('WEBVTT')).toBe(true);
  expect(vtt).toContain('00:00:00.000 --> 00:00:04.000');
  expect(vtt).toContain('00:00:04.000 --> 00:00:08.000');
  expect(R.toVttDataUri(vtt).startsWith('data:text/vtt;base64,')).toBe(true);
});

// ── assembly + escaping ─────────────────────────────────────────────────────────

function assembleWith(sourceMarkdown, extra = {}) {
  const content = R.deriveContent(sourceMarkdown, 'Title', null);
  const vtt = R.toVttDataUri(R.buildVtt(content.narration.segments));
  return R.assemblePage({
    title: 'Title',
    subtitle: 'sub',
    learningTargets: content.learningTargets,
    summaryBullets: content.summaryBullets,
    quizItems: content.quizItems,
    media: {
      audio: { url: 'https://example.com/a.mp3' },
      video: { url: 'https://example.com/v.mp4' },
      ...extra.media,
    },
    narration: content.narration,
    vttDataUri: vtt,
    sourceMarkdown,
    omissions: { audio: null, video: null, ...extra.omissions },
  });
}

test('assemblePage includes all five modalities, one h1, lang, captions track, and audio transcript', () => {
  const html = assembleWith(SAMPLE_MD);
  expect(html).toContain('<html lang="en">');
  expect((html.match(/<h1/g) || []).length).toBe(1);
  expect(html).toContain('<video');
  expect(html).toContain('<track kind="captions" srclang="en"');
  expect(html).toContain('<audio');
  expect(html).toContain('Read the narration transcript');
  expect(html).toContain('id="lp-quiz"');
  expect(html).toContain('class="lp-summary"');
  expect(html).toContain('Read the full document');
  // Captions inlined as a data URI (self-contained).
  expect(html).toContain('src="data:text/vtt;base64,');
});

test('document text is HTML-escaped — no injection from the source', () => {
  const malicious = [
    '# Title <script>alert(1)</script>',
    '',
    'A paragraph with <img src=x onerror=alert(2)> and "quotes" & ampersands.',
  ].join('\n');
  const html = assembleWith(malicious);
  expect(html).not.toContain('<script>alert(1)</script>');
  expect(html).not.toContain('<img src=x onerror=alert(2)>');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
});

test('omitted video renders a noted omission instead of a broken element', () => {
  const html = assembleWith(SAMPLE_MD, {
    media: { video: null },
    omissions: { video: 'psd-hyperframes failed' },
  });
  expect(html).not.toContain('<video');
  expect(html).toContain('Explainer video unavailable');
  expect(html).toContain('psd-hyperframes failed');
  // Transcript/captions for the surviving audio remain valid.
  expect(html).toContain('<audio');
});

// ── media resolution + graceful degradation ─────────────────────────────────────

test('resolveAudio/resolveVideo use supplied URLs without generating', async () => {
  const runSkill = () => {
    throw new Error('should not be called when URLs are supplied');
  };
  const a = await R.resolveAudio(
    R.parseArgs(argv('--user', 'a@b.net', '--audio-url', 'https://x/a.mp3')),
    { script: 's' },
    { runSkill },
    false
  );
  expect(a.media.url).toBe('https://x/a.mp3');
  const v = await R.resolveVideo(
    R.parseArgs(argv('--user', 'a@b.net', '--video-url', 'https://x/v.mp4')),
    'https://x/a.mp3',
    'T',
    ['p'],
    { segments: [{ text: 'x', start: 0, end: 2 }], script: 's' },
    { runSkill },
    false
  );
  expect(v.media.url).toBe('https://x/v.mp4');
});

test('resolveAudio degrades gracefully when psd-tts fails', async () => {
  const runSkill = () => ({ code: 1, stdout: JSON.stringify({ error: 'upstream_error' }), stderr: '' });
  const a = await R.resolveAudio(
    R.parseArgs(argv('--user', 'a@b.net')),
    { script: 'read me aloud' },
    { runSkill },
    false
  );
  expect(a.media).toBeNull();
  expect(a.omission).toBeTruthy();
});

test('resolveVideo degrades gracefully when psd-hyperframes fails', async () => {
  const runSkill = () => ({ code: 1, stdout: JSON.stringify({ error: 'render_failed' }), stderr: '' });
  const v = await R.resolveVideo(
    R.parseArgs(argv('--user', 'a@b.net')),
    'https://x/a.mp3',
    'T',
    ['point one'],
    { segments: [{ text: 'x', start: 0, end: 2 }], script: 's' },
    { runSkill },
    false
  );
  expect(v.media).toBeNull();
  expect(v.omission).toBeTruthy();
});

test('main --dry-run --generate-media still emits a valid page (with notes) when BOTH media steps fail', async () => {
  const src = tmpPath(`lp-src-${Date.now()}.md`);
  fs.writeFileSync(src, SAMPLE_MD);
  const out = tmpPath(`lp-out-${Date.now()}.html`);
  const runSkill = () => ({ code: 1, stdout: JSON.stringify({ error: 'boom' }), stderr: '' });
  try {
    await R.main(argv('--user', 'a@b.net', '--source-file', src, '--title', 'T', '--dry-run', '--out', out, '--generate-media'), {
      runSkill,
      auditHtml: PASS_AUDIT,
    });
    const res = JSON.parse(stdout.trim());
    expect(res.status).toBe('ok');
    expect(res.modalities.video).toBe(false);
    expect(res.modalities.audio).toBe(false);
    const html = fs.readFileSync(out, 'utf8');
    expect(html).toContain('Explainer video unavailable');
    expect(html).toContain('Narration audio unavailable');
    // Full source + quiz + summary survive.
    expect(html).toContain('id="lp-quiz"');
    expect(html).toContain('Read the full document');
  } finally {
    fs.rmSync(src, { force: true });
    fs.rmSync(out, { force: true });
  }
});

test('resolveVideo notes the 60s cap when the narration is longer than the video', async () => {
  // A narration whose last cue ends well past MAX_VIDEO_SECONDS (60): the video
  // is trimmed to fit, so the page must say so via the note hook.
  const longNarration = { script: 'x', segments: [{ text: 'a', start: 0, end: 30 }, { text: 'b', start: 30, end: 90 }] };
  const runSkill = () => ({ code: 0, stdout: JSON.stringify({ url: 'https://x/v.mp4' }), stderr: '' });
  const v = await R.resolveVideo(
    R.parseArgs(argv('--user', 'a@b.net')),
    'https://x/a.mp3',
    'T',
    ['point'],
    longNarration,
    { runSkill },
    false
  );
  expect(v.media.url).toBe('https://x/v.mp4');
  expect(v.media.note).toMatch(/60 seconds|capped/i);
});

test('assemblePage wires a change listener that clears stale quiz feedback + result', () => {
  const html = assembleWith(SAMPLE_MD);
  expect(html).toContain("addEventListener('change'");
  expect(html).toContain("removeAttribute('data-answered')");
});

test('main reports fullSource:false for a whitespace-only source', async () => {
  const out = tmpPath(`lp-blank-${Date.now()}.html`);
  try {
    await R.main(argv('--user', 'a@b.net', '--text', '   \n\n  ', '--title', 'T', '--dry-run', '--out', out), {
      auditHtml: PASS_AUDIT,
    });
    const res = JSON.parse(stdout.trim());
    expect(res.modalities.fullSource).toBe(false);
  } finally {
    fs.rmSync(out, { force: true });
  }
});

// ── Google Docs ingest ──────────────────────────────────────────────────────────

test('exportGoogleDoc returns the doc body from the stubbed psd-workspace call', () => {
  const calls = [];
  const run = (spec) => {
    calls.push(spec);
    return { code: 0, stdout: '# Exported Doc\n\nBody text.', stderr: '' };
  };
  const md = R.exportGoogleDoc('FILEID123', 'a@b.net', run);
  expect(md).toContain('Exported Doc');
  expect(calls[0].skill).toBe('workspace');
  expect(calls[0].args.join(' ')).toContain('drive files export');
  expect(calls[0].args.join(' ')).toContain('--scope agent');
  expect(calls[0].args.join(' ')).toContain('FILEID123');
});

test('exportGoogleDoc surfaces share-with-agent guidance on a genuine permission denial', () => {
  // A doc not shared with the agent account: gws exits non-zero and (per its
  // stdio: inherit) prints the Drive 404/403 on the captured stderr — stdout is
  // NOT structured JSON here.
  const run = () => ({
    code: 2,
    stdout: '',
    stderr: 'gws: drive files export: Error 404: File not found: FILEID',
  });
  expect(() => R.exportGoogleDoc('FILEID', 'a@b.net', run)).toThrow(ExitError);
  const out = JSON.parse(stdout.trim());
  expect(out.error).toBe('gdoc_denied');
  expect(out.message).toMatch(/agent account/i);
});

test('exportGoogleDoc treats a transport error (exit 12) as transient — NOT a sharing problem', () => {
  // psd-workspace exit 12 = broker/network failure; fail() writes to stderr only,
  // stdout is empty. This must NOT tell the user to re-share the doc.
  const run = () => ({
    code: 12,
    stdout: '',
    stderr: 'psd-workspace: Unable to fetch agent workspace token: broker timeout',
  });
  expect(() => R.exportGoogleDoc('FILEID', 'a@b.net', run)).toThrow(ExitError);
  const out = JSON.parse(stdout.trim());
  expect(out.error).toBe('ingest_failed');
  expect(out.message).not.toMatch(/share it with your agent account/i);
  expect(out.message).toMatch(/transient|try again/i);
});

test('exportGoogleDoc treats account-provisioning (exit 14) as "wait", not "share"', () => {
  const run = () => ({
    code: 14,
    stdout: JSON.stringify({
      status: 'account-provisioning',
      message: 'Your agent Workspace account is being set up automatically — try again in about 30 minutes.',
    }),
    stderr: '',
  });
  expect(() => R.exportGoogleDoc('FILEID', 'a@b.net', run)).toThrow(ExitError);
  const out = JSON.parse(stdout.trim());
  expect(out.error).toBe('gdoc_provisioning');
  expect(out.message).toMatch(/30 minutes|being set up/i);
  expect(out.message).not.toMatch(/share it with your agent account/i);
});

test('ingestSource routes --gdoc-url through psd-workspace export', async () => {
  const run = (spec) => {
    if (spec.skill === 'workspace') return { code: 0, stdout: '# GDoc\n\nHello from the doc.', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const { markdown, sourceLabel } = await R.ingestSource(
    R.parseArgs(argv('--user', 'a@b.net', '--gdoc-url', 'https://docs.google.com/document/d/ABCdef123456/edit')),
    { runSkill: run }
  );
  expect(markdown).toContain('Hello from the doc');
  expect(sourceLabel).toBe('Google Doc');
});

// ── pre-publish a11y gate ───────────────────────────────────────────────────────

test('main REFUSES to publish when the assembled page fails the shared a11y gate', async () => {
  const src = tmpPath(`lp-src2-${Date.now()}.md`);
  fs.writeFileSync(src, SAMPLE_MD);
  const failingAudit = async () => ({
    pass: false,
    blocking: [{ id: 'image-alt', impact: 'critical' }],
    violations: [{ id: 'image-alt', impact: 'critical' }],
    counts: { critical: 1, serious: 0, moderate: 0, minor: 0 },
    standard: 'stub',
  });
  const atriumCalls = [];
  const runSkill = (spec) => {
    atriumCalls.push(spec);
    return { code: 0, stdout: JSON.stringify({ id: 'art-1' }), stderr: '' };
  };
  try {
    // NOT dry-run → would publish, but the gate must block first.
    await expect(
      R.main(argv('--user', 'a@b.net', '--source-file', src, '--title', 'T', '--video-url', 'https://x/v.mp4', '--audio-url', 'https://x/a.mp3'), {
        runSkill,
        auditHtml: failingAudit,
      })
    ).rejects.toThrow(ExitError);
    const out = JSON.parse(stdout.trim());
    expect(out.error).toBe('a11y_violations');
    // Never reached Atrium.
    expect(atriumCalls.length).toBe(0);
  } finally {
    fs.rmSync(src, { force: true });
  }
});

test('main publishes to Atrium (create + publish intranet) and returns the artifact + reader URL', async () => {
  const src = tmpPath(`lp-src3-${Date.now()}.md`);
  fs.writeFileSync(src, SAMPLE_MD);
  const calls = [];
  const runSkill = (spec) => {
    calls.push(spec);
    if (spec.args[0] === 'create-artifact') {
      return { code: 0, stdout: JSON.stringify({ id: 'art-42', slug: 'tech', url: 'https://studio.example/c/tech', visibilityLevel: 'internal' }), stderr: '' };
    }
    if (spec.args[0] === 'publish') return { code: 0, stdout: JSON.stringify({ status: 'published', destination: 'intranet' }), stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  try {
    await R.main(argv('--user', 'a@b.net', '--source-file', src, '--title', 'T', '--video-url', 'https://x/v.mp4', '--audio-url', 'https://x/a.mp3'), {
      runSkill,
      auditHtml: PASS_AUDIT,
    });
    const res = JSON.parse(stdout.trim());
    expect(res.status).toBe('ok');
    expect(res.mode).toBe('published');
    expect(res.artifact.id).toBe('art-42');
    // Reader URL is the published intranet reader (/c/{slug}), from the API's
    // absolute deep link — NOT the /atrium/{id}/view draft editor route.
    expect(res.readerUrl).toBe('https://studio.example/c/tech');
    expect(res.readerUrl).not.toContain('/atrium/');
    const create = calls.find((c) => c.args[0] === 'create-artifact');
    const publish = calls.find((c) => c.args[0] === 'publish');
    expect(create.args).toContain('--body-format');
    // Code goes via a temp file (avoids the argv-size limit), not inline --code.
    expect(create.args).toContain('--code-file');
    expect(create.args).not.toContain('--code');
    // Must be created 'internal' or the published page is invisible to staff/students.
    expect(create.args.join(' ')).toContain('--visibility internal');
    expect(publish.args.join(' ')).toContain('--destination intranet');
  } finally {
    fs.rmSync(src, { force: true });
  }
});

test('main REFUSES to report "published" when Atrium silently downgrades visibility (§26.4)', async () => {
  const src = tmpPath(`lp-src3b-${Date.now()}.md`);
  fs.writeFileSync(src, SAMPLE_MD);
  const calls = [];
  const runSkill = (spec) => {
    calls.push(spec);
    if (spec.args[0] === 'create-artifact') {
      // psd-atrium's emitCreated(): requested "internal", not authorized, so it
      // was silently created "private" with approvalRequired: true (exit 0).
      return {
        code: 0,
        stdout: JSON.stringify({
          id: 'art-77',
          slug: 'oops',
          visibilityLevel: 'private',
          requestedVisibilityLevel: 'internal',
          approvalRequired: true,
          visibilityNote: 'Requested visibility "internal" was not applied — the object was created "private".',
        }),
        stderr: '',
      };
    }
    return { code: 1, stdout: '', stderr: 'unexpected: publish should never be called' };
  };
  try {
    await expect(
      R.main(argv('--user', 'a@b.net', '--source-file', src, '--title', 'T', '--video-url', 'https://x/v.mp4', '--audio-url', 'https://x/a.mp3'), {
        runSkill,
        auditHtml: PASS_AUDIT,
      })
    ).rejects.toThrow(ExitError);
    const out = JSON.parse(stdout.trim());
    expect(out.error).toBe('visibility_denied');
    expect(out.message).toContain('art-77');
    expect(out.message).toContain('private');
    // Must never call publish on top of a silently-downgraded (still private) draft.
    expect(calls.some((c) => c.args[0] === 'publish')).toBe(false);
  } finally {
    fs.rmSync(src, { force: true });
  }
});

test('publish failure surfaces the orphaned draft id for a targeted retry (no re-run)', async () => {
  const src = tmpPath(`lp-src4-${Date.now()}.md`);
  fs.writeFileSync(src, SAMPLE_MD);
  const runSkill = (spec) => {
    if (spec.args[0] === 'create-artifact') return { code: 0, stdout: JSON.stringify({ id: 'art-99', slug: 'oops' }), stderr: '' };
    if (spec.args[0] === 'publish') return { code: 2, stdout: JSON.stringify({ message: 'destination unavailable' }), stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  try {
    await expect(
      R.main(argv('--user', 'a@b.net', '--source-file', src, '--title', 'T', '--video-url', 'https://x/v.mp4', '--audio-url', 'https://x/a.mp3'), {
        runSkill,
        auditHtml: PASS_AUDIT,
      })
    ).rejects.toThrow(ExitError);
    const out = JSON.parse(stdout.trim());
    expect(out.error).toBe('publish_failed');
    expect(out.message).toContain('art-99');
    expect(out.message).toMatch(/publish --id art-99/);
  } finally {
    fs.rmSync(src, { force: true });
  }
});

// ── integration: real gate, real assembly, no network (placeholders) ─────────────

test('main --dry-run with only a source file produces an accessible five-modality page offline', async () => {
  const src = tmpPath(`lp-int-${Date.now()}.md`);
  fs.writeFileSync(src, SAMPLE_MD);
  const out = tmpPath(`lp-int-${Date.now()}.html`);
  try {
    // deps={} → the REAL shared a11y gate (sibling psd-html-artifact) runs, and
    // dry-run placeholders mean NO psd-tts/psd-hyperframes/Atrium calls.
    await R.main(argv('--user', 'test@example.com', '--source-file', src, '--title', 'Student Technology', '--dry-run', '--out', out), {});
    const res = JSON.parse(stdout.trim());
    expect(res.status).toBe('ok');
    expect(res.a11y.pass).toBe(true);
    expect(res.a11y.counts.critical).toBe(0);
    expect(res.a11y.counts.serious).toBe(0);
    expect(res.modalities.video).toBe(true);
    expect(res.modalities.audio).toBe(true);
    expect(res.modalities.quiz).toBeGreaterThan(0);
    const html = fs.readFileSync(out, 'utf8');
    expect(html).toContain('data:video/mp4;base64,');
    expect(html).toContain('data:audio/mpeg;base64,');
  } finally {
    fs.rmSync(src, { force: true });
    fs.rmSync(out, { force: true });
  }
});
