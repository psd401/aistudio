#!/usr/bin/env node
/**
 * run.js — psd-learning-page skill entrypoint (Issue #1245).
 *
 * Turns a document (board policy/procedure, PDF, Google Doc, or markdown) into a
 * single, self-contained, WCAG 2.2 AA HTML **learning page** that teaches the
 * concept through multiple redundant modalities (UDL 3.0): an explainer video
 * with captions, a narrated audio intro with transcript, an interactive
 * retrieval-practice quiz, a bullet summary with learning targets, and the full
 * source document. It then publishes the page into Atrium.
 *
 * It COMPOSES existing agent-image skills — it does not re-implement them:
 *   ingest  → psd-pdf-to-markdown (PDF) / psd-workspace (Google Docs export)
 *   audio   → psd-tts               (narration MP3, public-by-link)
 *   video   → psd-hyperframes       (HTML/CSS → MP4, muxes the narration audio)
 *   a11y    → psd-html-artifact/a11y-audit.js  (the SAME shared gate)
 *   publish → psd-atrium            (create-artifact + publish --destination intranet)
 *
 * Usage (dry-run — assemble locally, no Atrium):
 *   node run.js --user <email> --source-file <md> --title "T" --dry-run --out /tmp/lp.html
 *
 * Usage (full pipeline — generate media + publish to Atrium):
 *   node run.js --user <email> --pdf-url <https> --title "T"
 *   node run.js --user <email> --gdoc-url <https://docs.google.com/document/d/ID/…> --title "T"
 *
 * Media is embedded by URL (small HTML), never inlined bytes — except in
 * --dry-run with no supplied URL, where tiny labeled placeholder clips keep the
 * page playable + self-contained offline (see placeholder-media.js).
 *
 * Exit codes:
 *   0  success (JSON on stdout)
 *   1  usage / config error (bad_args, misconfigured)
 *   2  an upstream compose step failed hard (ingest/publish)
 *   3  the assembled page fails the WCAG 2.2 AA gate (a11y_violations) — never
 *      written/published
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { MP4_DATA_URI, MP3_DATA_URI } = require('./placeholder-media');
const { PSD_LOGO_WHITE_DATA_URI } = require('./brand-assets');

// Container layout (overridable so the unit tests can point at fakes).
const SKILLS_DIR = process.env.PSD_SKILLS_DIR || '/opt/psd-skills';
const VENV_PY = process.env.PSD_VENV_PYTHON || '/opt/agentcore-venv/bin/python3';
const APP_BASE_URL = process.env.APP_BASE_URL || '';

const MAX_VIDEO_SECONDS = 180; // psd-hyperframes cap (3 min) — video runs the full narration
// Title-card videos are near-static, so a low fps keeps the render within the
// hyperframes frame budget (fps × duration ≤ 3600): 20 × 180 = 3600 exactly, and
// fewer frames for any shorter narration. Bumping this without lowering the cap
// would blow the budget for a full 3-minute video.
const VIDEO_FPS = 20;
const WORDS_PER_SECOND = 2.6; // rough narration pace for caption timing

// ── output contract ──────────────────────────────────────────────────────────

function fail(message, code = 'error', exit = 1) {
  process.stderr.write(`Error: ${message}\n`);
  process.stdout.write(JSON.stringify({ error: code, message }) + '\n');
  process.exit(exit);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      fail(`Unexpected positional argument: ${arg}`, 'bad_args');
    }
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

// Reject `/` because the email is interpolated into skill S3 key paths. Validated
// with linear string ops (indexOf/slice/includes) rather than a single regex —
// the classic `[^\s@]+@[^\s@]+\.[^\s@]+` pattern backtracks polynomially on
// adversarial input (ReDoS).
function validateEmail(email) {
  if (typeof email !== 'string' || email.length === 0 || email.length > 254) return false;
  if (email.includes('/') || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false; // exactly one '@', not leading
  const domain = email.slice(at + 1);
  if (domain.length === 0 || domain.startsWith('.') || domain.endsWith('.')) return false;
  return domain.includes('.'); // domain needs a dot (e.g. psd401.net)
}

// ── escaping (defense-in-depth: NOTHING from the document reaches the DOM raw) ─

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Create a private (mode 0700), unpredictable scratch directory. A predictable
// os.tmpdir()+Date.now() filename is an insecure-temp-file pattern (a local
// actor can pre-create a symlink at the known path, or two same-millisecond runs
// can collide); mkdtempSync gives an exclusive, random-suffixed directory.
function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(require('node:os').tmpdir(), prefix));
}

// ── shared WCAG 2.2 AA gate (the SAME module psd-html-artifact/deliver.js runs) ─

function loadAuditHtml() {
  const candidates = [
    path.join(SKILLS_DIR, 'psd-html-artifact', 'a11y-audit.js'),
    path.join(__dirname, '..', 'psd-html-artifact', 'a11y-audit.js'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return require(p).auditHtml;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'shared a11y gate not found — psd-html-artifact/a11y-audit.js must be installed alongside this skill'
  );
}

// ── external-skill runner (default; unit tests inject deps.runSkill) ───────────

/**
 * @param {{skill:string, args:string[], input?:string}} spec
 * @returns {{code:number, stdout:string, stderr:string}}
 */
function runSkill(spec) {
  const map = {
    pdf: { cmd: VENV_PY, base: [path.join(SKILLS_DIR, 'psd-pdf-to-markdown', 'scripts', 'convert.py')] },
    workspace: { cmd: 'node', base: [path.join(SKILLS_DIR, 'psd-workspace', 'run.js')] },
    tts: { cmd: VENV_PY, base: [path.join(SKILLS_DIR, 'psd-tts', 'scripts', 'synthesize.py')] },
    hyperframes: { cmd: 'node', base: [path.join(SKILLS_DIR, 'psd-hyperframes', 'render.js')] },
    atrium: { cmd: 'node', base: [path.join(SKILLS_DIR, 'psd-atrium', 'run.js')] },
  };
  const entry = map[spec.skill];
  if (!entry) throw new Error(`unknown skill: ${spec.skill}`);
  const res = spawnSync(entry.cmd, [...entry.base, ...spec.args], {
    input: spec.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) return { code: 1, stdout: '', stderr: res.error.message };
  return { code: res.status == null ? 1 : res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// The JSON object a composed skill printed on stdout, or null when stdout is not
// JSON (e.g. psd-workspace passing through a raw exported document body).
// Composed skills emit either single-line JSON (atrium/pdf) or pretty multi-line
// JSON (tts/hyperframes) as the ONLY thing on stdout, so the whole-string parse
// is the normal path; the suffix scan tolerates an accidental log line printed
// before the JSON block (single- or multi-line).
function lastJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to suffix scan */
  }
  const lines = text.split('\n');
  // Earliest start index whose suffix (to end) parses = the trailing JSON block,
  // even when it spans multiple pretty-printed lines after some preamble.
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines.slice(i).join('\n').trim();
    if (!candidate || (candidate[0] !== '{' && candidate[0] !== '[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* keep scanning down */
    }
  }
  return null;
}

// ── ingest ─────────────────────────────────────────────────────────────────────

// Pull the Google Docs file id out of a share URL or accept a bare id.
function parseGdocId(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const s = input.trim();
  const m = s.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s; // looks like a bare file id
  return null;
}

function readStdin() {
  // Only read piped/redirected stdin. On an interactive terminal, fs.readFileSync(0)
  // blocks waiting for EOF — return empty so the "no source provided" error fires
  // immediately instead of hanging.
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Normalize whichever source flag was given to markdown. Returns
 * { markdown, sourceLabel }. Throws (via fail) on hard errors.
 */
async function ingestSource(args, deps) {
  const run = deps.runSkill || runSkill;

  if (typeof args.text === 'string') {
    return { markdown: args.text, sourceLabel: 'inline text' };
  }
  if (typeof args.source_file === 'string') {
    let md;
    try {
      md = fs.readFileSync(args.source_file, 'utf8');
    } catch (err) {
      fail(`--source-file not readable: ${err.message}`, 'bad_args');
    }
    return { markdown: md, sourceLabel: path.basename(args.source_file) };
  }

  // PDF → psd-pdf-to-markdown
  if (args.pdf_url || args.pdf_s3_key || args.pdf_path) {
    const pdfArgs = [];
    if (args.pdf_url) pdfArgs.push('--url', String(args.pdf_url));
    else if (args.pdf_s3_key) pdfArgs.push('--user', String(args.user), '--s3-key', String(args.pdf_s3_key));
    else pdfArgs.push('--path', String(args.pdf_path));
    const res = run({ skill: 'pdf', args: pdfArgs });
    const out = lastJson(res.stdout);
    if (res.code !== 0 || !out || out.status !== 'ok') {
      fail(
        `PDF ingest failed: ${(out && out.message) || res.stderr || 'unknown error'}`,
        'ingest_failed',
        2
      );
    }
    // Large PDFs inline only a preview; read the full markdown from output_path.
    let md = typeof out.markdown === 'string' ? out.markdown : '';
    if ((!md || out.preview) && out.output_path) {
      try {
        md = fs.readFileSync(out.output_path, 'utf8');
      } catch {
        /* fall back to whatever inline text we have */
      }
    }
    return { markdown: md, sourceLabel: 'PDF document' };
  }

  // Google Docs → psd-workspace `drive files export` on the AGENT scope
  if (args.gdoc_url || args.gdoc_id) {
    const id = parseGdocId(String(args.gdoc_url || args.gdoc_id));
    if (!id) {
      fail('could not parse a Google Docs file id from --gdoc-url/--gdoc-id', 'bad_args');
    }
    const md = exportGoogleDoc(id, String(args.user), run);
    return { markdown: md, sourceLabel: 'Google Doc' };
  }

  // stdin fallback
  const piped = readStdin();
  if (piped && piped.trim()) {
    return { markdown: piped, sourceLabel: 'piped text' };
  }

  fail(
    'no source provided — pass one of --source-file / --text / stdin / --pdf-url|--pdf-s3-key|--pdf-path / --gdoc-url|--gdoc-id',
    'bad_args'
  );
  return { markdown: '', sourceLabel: '' }; // unreachable (fail exits)
}

// Export a Google Doc to markdown as the agent identity; markdown → text/plain fallback.
function exportGoogleDoc(fileId, userEmail, run) {
  const tryExport = (mimeType) =>
    run({
      skill: 'workspace',
      args: [
        '--user',
        userEmail,
        '--scope',
        'agent',
        '--command',
        `drive files export --params '{"fileId":"${fileId}","mimeType":"${mimeType}"}'`,
      ],
    });

  let res = tryExport('text/markdown');
  if (res.code !== 0) {
    const out = lastJson(res.stdout);
    // Classify the failure by psd-workspace's documented exit codes (run.js:45-54)
    // — NOT everything non-zero is a sharing problem, and telling the user to
    // re-share a doc that is already shared (or whose account is still being
    // provisioned) sends them down the wrong path.
    //
    // 14 = agent Workspace account still being auto-provisioned. Wait, don't
    // re-share. psd-workspace emits its own "try again in ~30 min" message.
    if (res.code === 14 || (out && out.status === 'account-provisioning')) {
      fail(
        (out && out.message) ||
          'Your agent Workspace account is still being set up automatically — no action needed. Try again in about 30 minutes.',
        'gdoc_provisioning',
        2
      );
    }
    // 12 = transport/broker/network failure reaching Google. Transient — retry,
    // don't re-share. The real diagnostic is on stderr (psd-workspace's fail()
    // writes there); surface it rather than the sharing guidance.
    if (res.code === 12) {
      fail(
        `Couldn't reach Google Workspace to read that document — a transient network/broker error. Try again shortly.${
          res.stderr ? ` (${res.stderr.trim()})` : ''
        }`,
        'ingest_failed',
        2
      );
    }
    // A genuine permission/consent denial: Drive returns 403/404 for a doc the
    // agent account can't see (the drive.file scope masks unshared files as 404).
    // gws prints that error to the inherited stderr, so match on stdout JSON OR
    // stderr. THIS is the case where re-sharing with the agent account fixes it.
    const deniedText = (out && (out.message || out.guidance)) || res.stderr || '';
    if (/40[34]|permission|consent|not shared|access denied|share/i.test(deniedText)) {
      fail(
        (out && (out.message || out.guidance)) ||
          `Couldn't read that Google Doc. Share it with your agent account ` +
            `(agnt_<your-uniqname>@psd401.net, Reader is enough) and try again.`,
        'gdoc_denied',
        2
      );
    }
    // Otherwise the markdown export may just be unsupported for this doc → retry
    // as plain text before giving up.
    res = tryExport('text/plain');
  }
  if (res.code !== 0) {
    const out = lastJson(res.stdout);
    fail(
      `Google Docs export failed: ${(out && out.message) || res.stderr || 'unknown error'}`,
      'ingest_failed',
      2
    );
  }
  // gws prints the exported document body on stdout. If it wrapped the payload
  // in JSON, pull the text field; otherwise treat stdout as the doc content.
  const out = lastJson(res.stdout);
  if (out && typeof out.content === 'string') return out.content;
  if (out && typeof out.markdown === 'string') return out.markdown;
  if (out && typeof out.text === 'string') return out.text;
  return String(res.stdout || '');
}

// ── content derivation (deterministic fallback; --content-json overrides) ──────

function stripMarkdown(s) {
  return String(s || '')
    .replace(/`{1,3}[^`]*`{1,3}/g, (m) => m.replace(/`/g, '')) // inline/fenced code ticks
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
    .replace(/[*_~]{1,3}/g, '') // emphasis
    .replace(/^#{1,6}\s+/gm, '') // heading marks
    .replace(/^\s*[-*+]\s+/gm, '') // list bullets
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/\|/g, ' ') // table pipes
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractHeadings(markdown) {
  const out = [];
  // Level + required whitespace + heading text captured as `\S.*` (starts with a
  // non-space). Making the separator (`[ \t]+`) and the text disjoint removes the
  // overlapping quantifiers that make `[ \t]+(.+)` / `(.+?)\s*#*$` backtrack
  // polynomially (ReDoS). Trailing whitespace is trimmed in code (linear); a rare
  // explicit ATX closing `###` is left to the authored-content override rather
  // than a backtracking regex.
  const re = /^(#{1,3})[ \t]+(\S.*)$/gm;
  let m;
  while ((m = re.exec(markdown))) {
    const text = stripMarkdown(m[2].trimEnd());
    if (text) out.push({ level: m[1].length, text });
  }
  return out;
}

function extractParagraphs(markdown) {
  // Normalize CRLF first: a stray \r breaks up the \n{2,} block split, which
  // would otherwise collapse a whole CRLF-encoded doc into one block.
  return String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    // Drop only the heading LINE(S) inside a block, keeping any body text glued
    // to a heading with no blank line between them (a very common real-world
    // pattern) — previously the whole block was dropped, silently discarding the
    // body and degrading the derived summary/quiz.
    .map((b) =>
      b
        .split('\n')
        .filter((line) => !/^\s*#{1,6}\s/.test(line))
        .join('\n')
        .trim()
    )
    .map((b) => stripMarkdown(b))
    .filter((b) => b.length > 0);
}

const GENERIC_DISTRACTORS = [
  'This is outside the scope of what this document covers.',
  'The document does not make this claim.',
  'This contradicts what the document actually states.',
];

/**
 * Derive learning targets, a bullet summary, quiz items, and a narration script
 * from the source markdown. Deterministic (no model call) so the dry-run works
 * fully offline; a caller can override any part via --content-json.
 */
function deriveContent(markdown, title, overrides) {
  const headings = extractHeadings(markdown);
  const paragraphs = extractParagraphs(markdown);

  const summaryBullets =
    // Coerce authored entries to strings — a bare number/object from LLM-authored
    // JSON must not reach buildNarration (`b.endsWith`) and throw an uncaught
    // TypeError that degrades to a generic exit(2) instead of a clean bad_args.
    (overrides && Array.isArray(overrides.summary) && overrides.summary.length && overrides.summary.map((s) => String(s))) ||
    paragraphs.slice(0, 6).map((p) => {
      const first = splitSentences(p)[0] || p;
      return first.length > 220 ? first.slice(0, 217).trimEnd() + '…' : first;
    });

  // Guarantee at least one bullet so the page is never empty.
  if (!summaryBullets.length) {
    summaryBullets.push(`Key points from ${title}.`);
  }

  // Prefer section headings (## / ###) for targets — these are the topics, not
  // the doc title (already shown as the <h1>). Fall back to any non-title
  // heading, then to title-derived defaults.
  const titleLc = String(title).toLowerCase().trim();
  const level2 = headings.filter((h) => h.level >= 2).map((h) => h.text);
  const nonTitle = headings.filter((h) => h.text.toLowerCase().trim() !== titleLc).map((h) => h.text);
  const headingTargets = level2.length >= 2 ? level2 : nonTitle;
  const learningTargets =
    (overrides && Array.isArray(overrides.learningTargets) && overrides.learningTargets.length && overrides.learningTargets.map((t) => String(t))) ||
    (headingTargets.length >= 2
      ? headingTargets.slice(0, 4).map((h) => `Understand ${h}.`)
      : [`Understand the key points of ${title}.`, `Explain why ${title} matters and when it applies.`]);

  // Normalize FIRST, then check the normalized length: an authored quiz whose
  // every item fails validation (e.g. <2 options) yields []; `[] || fallback`
  // would keep the truthy empty array, shipping a zero-question quiz. Bind it so
  // the deterministic fallback actually runs when nothing survives.
  const authoredQuiz =
    overrides && Array.isArray(overrides.quiz) && overrides.quiz.length
      ? normalizeAuthoredQuiz(overrides.quiz)
      : null;
  const quizItems =
    (authoredQuiz && authoredQuiz.length && authoredQuiz) ||
    buildDeterministicQuiz(summaryBullets, learningTargets, title);

  const narration =
    // Require a NON-BLANK script — `typeof "" === "string"` is true, so a blank
    // authored script would otherwise ship empty captions/transcript instead of
    // falling back to the deterministic narration the way an absent key does.
    (overrides && overrides.narration && typeof overrides.narration.script === 'string' &&
      overrides.narration.script.trim() &&
      normalizeAuthoredNarration(overrides.narration)) ||
    buildNarration(title, learningTargets, summaryBullets);

  return { learningTargets, summaryBullets, quizItems, narration };
}

// Coerce an answer index that may arrive as a real number OR a quoted numeric
// string ("2") from LLM-authored JSON. Number.isInteger("2") is false, so the
// old check silently defaulted a string index to 0 — marking the WRONG option
// correct while the rationale described a different one.
function toAnswerIndex(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

function normalizeAuthoredQuiz(quiz) {
  return quiz
    .map((q, i) => {
      const options = Array.isArray(q.options) ? q.options.map(String) : [];
      let correctIndex = toAnswerIndex(q.answer);
      if (correctIndex === null) correctIndex = toAnswerIndex(q.correctIndex);
      // A MISSING index defaults to the first option. An explicitly-authored
      // out-of-range index is left as-is so the filter below DROPS the item —
      // coercing it to 0 would silently mark the wrong option correct while the
      // authored explanation describes a different one (a mis-graded quiz item).
      if (correctIndex === null) correctIndex = 0;
      return {
        stem: String(q.question || q.stem || `Question ${i + 1}`),
        options,
        correctIndex,
        explanation: String(q.rationale || q.explanation || ''),
      };
    })
    // Drop items that can't render a valid single-answer question: fewer than 2
    // options, or a correct index outside the options. All-invalid → [] → the
    // deterministic quiz fallback runs (see deriveContent).
    .filter((q) => q.options.length >= 2 && q.correctIndex >= 0 && q.correctIndex < q.options.length);
}

// A recognition/retrieval item per learning target: the correct option is a real
// key point from the document; distractors are generic and clearly not-stated
// (so we never invent facts). Immediate feedback + rationale is added at render.
function buildDeterministicQuiz(summaryBullets, learningTargets, title) {
  const n = Math.min(4, Math.max(1, summaryBullets.length));
  const items = [];
  for (let i = 0; i < n; i++) {
    const target = learningTargets[i % learningTargets.length] || `the key ideas in ${title}`;
    const correct = summaryBullets[i];
    // Rotate the distractor pool so options are not identical across items.
    const distractors = [
      GENERIC_DISTRACTORS[i % 3],
      GENERIC_DISTRACTORS[(i + 1) % 3],
      GENERIC_DISTRACTORS[(i + 2) % 3],
    ];
    const options = [correct, ...distractors];
    // Deterministically rotate the correct answer's position by item index.
    const pos = i % options.length;
    const rotated = options.slice();
    rotated.splice(pos, 0, rotated.splice(0, 1)[0]);
    items.push({
      stem: `Which statement is supported by this document (${target.replace(/\.$/, '')})?`,
      options: rotated,
      correctIndex: pos,
      explanation:
        'Correct answers restate a key point the document actually makes; the ' +
        'other options are not supported by the text. Re-read the summary or the ' +
        'full document to confirm.',
    });
  }
  return items;
}

function buildNarration(title, learningTargets, summaryBullets) {
  const parts = [];
  parts.push(`Welcome. In this short lesson, we'll walk through ${title}, and why it matters to you.`);
  if (learningTargets.length) {
    parts.push(`By the end, you should be able to: ${learningTargets.join(' ')}`);
  }
  parts.push('Here are the key points.');
  for (const b of summaryBullets) parts.push(b.endsWith('.') ? b : `${b}.`);
  parts.push(
    'Take a moment to check your understanding with the quiz below, and revisit the full document any time you need the details.'
  );
  const script = parts.join(' ');
  return { script, segments: segmentScript(script), transcript: script };
}

// Segment a narration script into timed caption cues (sentence-per-cue at the
// rough narration pace). Shared by the deterministic narration and by an
// authored --content-json narration that supplies a `script` but no `segments`.
function segmentScript(script) {
  const sentences = splitSentences(script);
  let t = 0;
  return sentences.map((text) => {
    const words = text.split(/\s+/).filter(Boolean).length;
    const dur = Math.max(2, Math.round(words / WORDS_PER_SECOND));
    const seg = { text, start: t, end: t + dur };
    t += dur;
    return seg;
  });
}

// Accept an authored narration (--content-json) and guarantee it has caption
// `segments`. The pedagogy-rubric's own example authors `{ script }` with no
// segments; without this the caption track would be built from [] — an empty
// WEBVTT the structural a11y gate can't catch, shipping a captions track that
// declares captions but renders no text.
function normalizeAuthoredNarration(narr) {
  const script = String(narr.script || '');
  const segments =
    Array.isArray(narr.segments) && narr.segments.length ? narr.segments : segmentScript(script);
  return { ...narr, script, segments, transcript: narr.transcript || script };
}

// Unclamped narration length in seconds (may exceed the hyperframes video cap).
function fullNarrationSeconds(narration) {
  if (narration.segments && narration.segments.length) {
    return narration.segments[narration.segments.length - 1].end;
  }
  const words = String(narration.script || '').split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.round(words / WORDS_PER_SECOND));
}

// The rendered video's duration — clamped to the hyperframes hard cap. When the
// full narration is longer than this, the muxed audio is trimmed to fit (see
// resolveVideo's note) and the caption track is capped to match.
function estimateNarrationSeconds(narration) {
  return Math.min(MAX_VIDEO_SECONDS, fullNarrationSeconds(narration));
}

// Trim caption cues to the (clamped) video duration so the track never lists
// cues that extend past the video's real end — dead, unreachable captions.
function capSegments(segments, maxSeconds) {
  const out = [];
  for (const seg of segments || []) {
    if (seg.start >= maxSeconds) break;
    out.push(seg.end > maxSeconds ? { ...seg, end: maxSeconds } : seg);
  }
  return out;
}

// ── WebVTT captions (inlined as a data URI so the page stays self-contained) ───

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function vttTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.000`;
}

function buildVtt(segments) {
  const lines = ['WEBVTT', ''];
  segments.forEach((seg, i) => {
    lines.push(String(i + 1));
    lines.push(`${vttTime(seg.start)} --> ${vttTime(seg.end)}`);
    // VTT is plain text; escape the cue payload's markup-significant chars.
    lines.push(escapeHtml(seg.text));
    lines.push('');
  });
  return lines.join('\n');
}

function toVttDataUri(vtt) {
  return `data:text/vtt;base64,${Buffer.from(vtt, 'utf8').toString('base64')}`;
}

// ── quiz HTML (interactive, keyboard, aria-live, feedback + rationale, score) ──

function buildQuizHtml(quizItems) {
  const questions = quizItems
    .map((q, qi) => {
      const options = q.options
        .map(
          (opt, oi) =>
            `<label class="lp-option"><input type="radio" name="lp-q${qi}" value="${oi}"> <span>${escapeHtml(
              opt
            )}</span></label>`
        )
        .join('\n');
      // role="group" + aria-labelledby is the ARIA equivalent of fieldset/legend
      // (a labelled group of the radios) WITHOUT the native <fieldset> border
      // rendering, whose legend "notch" pierces a rounded card border and leaves
      // artifacts even with float/flex workarounds. The radio-group semantics
      // (arrow-key navigation) come from the shared `name`, not the fieldset.
      return [
        `<div class="lp-q" role="group" aria-labelledby="lp-q${qi}-label" data-correct="${q.correctIndex}" data-explanation="${escapeHtml(q.explanation)}">`,
        `  <p class="lp-q-legend" id="lp-q${qi}-label">${qi + 1}. ${escapeHtml(q.stem)}</p>`,
        `  <div class="lp-q-body">`,
        options,
        `    <button type="button" class="lp-check">Check answer</button>`,
        `    <p class="lp-feedback" role="status" aria-live="polite"></p>`,
        `  </div>`,
        `</div>`,
      ].join('\n');
    })
    .join('\n');

  return [
    `<div id="lp-quiz">`,
    questions,
    `  <div class="lp-score-row">`,
    `    <button type="button" id="lp-score-btn">See my score</button>`,
    `    <p id="lp-score" role="status" aria-live="polite"></p>`,
    `  </div>`,
    `</div>`,
  ].join('\n');
}

const QUIZ_SCRIPT = `
(function () {
  const quiz = document.getElementById('lp-quiz');
  if (!quiz) return;
  const questions = Array.prototype.slice.call(quiz.querySelectorAll('.lp-q'));
  questions.forEach(function (q) {
    const btn = q.querySelector('.lp-check');
    const fb = q.querySelector('.lp-feedback');
    const correct = parseInt(q.getAttribute('data-correct'), 10);
    const expl = q.getAttribute('data-explanation') || '';
    btn.addEventListener('click', function () {
      const chosen = q.querySelector('input[type=radio]:checked');
      if (!chosen) {
        fb.className = 'lp-feedback lp-unanswered';
        fb.textContent = 'Select an answer first.';
        return;
      }
      const ok = parseInt(chosen.value, 10) === correct;
      fb.className = 'lp-feedback ' + (ok ? 'lp-correct' : 'lp-incorrect');
      // More than colour: a word + a symbol carry the result, not hue alone.
      fb.textContent = (ok ? '\\u2713 Correct. ' : '\\u2717 Not quite. ') + expl;
      q.setAttribute('data-answered', ok ? 'correct' : 'incorrect');
    });
    // Changing the selected answer AFTER checking must invalidate the stale
    // feedback and the recorded result — otherwise "See my score" would score
    // the previously-checked option, not the one now selected.
    q.addEventListener('change', function (e) {
      if (e.target && e.target.type === 'radio') {
        fb.className = 'lp-feedback';
        fb.textContent = '';
        q.removeAttribute('data-answered');
      }
    });
  });
  const scoreBtn = document.getElementById('lp-score-btn');
  const scoreOut = document.getElementById('lp-score');
  if (scoreBtn && scoreOut) {
    scoreBtn.addEventListener('click', function () {
      const total = questions.length;
      let right = 0;
      let answered = 0;
      questions.forEach(function (q) {
        const st = q.getAttribute('data-answered');
        if (st) { answered++; if (st === 'correct') right++; }
      });
      if (answered < total) {
        scoreOut.textContent = 'Check all ' + total + ' questions to see your score (' + answered + ' of ' + total + ' checked).';
        return;
      }
      scoreOut.textContent = 'You scored ' + right + ' out of ' + total + '.';
    });
  }
})();
`;

// ── full-source rendering (escape FIRST, then add our own paragraph tags) ──────

function renderSourceHtml(markdown) {
  // Everything from the document is escaped before any tag is added, so no
  // markup in the source can inject into the page. We add only <p>/<br> around
  // already-escaped text for basic readability.
  const blocks = String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.replace(/\s+$/g, ''))
    .filter((b) => b.trim().length);
  if (!blocks.length) return '<p>(No source content.)</p>';
  return blocks
    .map((b) => `<p>${escapeHtml(b).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// ── page assembly ──────────────────────────────────────────────────────────────

// Inline line-icons (decorative — the adjacent heading/label carries the meaning,
// so they are aria-hidden and exempt from WCAG 1.4.11). Inline SVG is CSP-safe
// (no img-src) and inherits its color via `currentColor`.
const ICONS = {
  target:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
  video:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M15.5 10l6-3v10l-6-3z"/></svg>',
  audio:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4" height="6" rx="1.5"/><rect x="17" y="13" width="4" height="6" rx="1.5"/></svg>',
  quiz:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.2 9.3a2.8 2.8 0 0 1 5.4 1c0 1.9-2.6 2.3-2.6 3.9"/><circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none"/></svg>',
  summary:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.3" fill="currentColor" stroke="none"/></svg>',
  source:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2.5h8l4 4V21a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 21z"/><path d="M14 2.5V6.5h4"/><path d="M9 12h6M9 16h6"/></svg>',
};

// Section order + short nav labels + heading icon. Every section always renders
// (video/audio show a noted omission when their media is unavailable), so the
// section nav is stable.
const SECTION_ORDER = ['targets', 'video', 'audio', 'quiz', 'summary', 'source'];
const SECTION_META = {
  targets: { nav: 'Overview', icon: 'target' },
  video: { nav: 'Watch', icon: 'video' },
  audio: { nav: 'Listen', icon: 'audio' },
  quiz: { nav: 'Check understanding', icon: 'quiz' },
  summary: { nav: 'Key points', icon: 'summary' },
  source: { nav: 'Full document', icon: 'source' },
};

function section(id, heading, inner) {
  const icon = SECTION_META[id] ? ICONS[SECTION_META[id].icon] : '';
  return [
    `<section id="${id}" aria-labelledby="${id}-h">`,
    `  <h2 id="${id}-h" class="lp-h2"><span class="lp-h2-icon" aria-hidden="true">${icon}</span>${escapeHtml(heading)}</h2>`,
    inner,
    `</section>`,
  ].join('\n');
}

// Sticky in-page section nav. Short labels + icons; the in-view section is
// highlighted at runtime (IntersectionObserver in the page script).
function buildNav() {
  const items = SECTION_ORDER.map((id) => {
    const m = SECTION_META[id];
    return `    <li><a class="lp-nav-link" href="#${id}" data-nav="${id}"><span class="lp-nav-icon" aria-hidden="true">${ICONS[m.icon]}</span><span>${escapeHtml(m.nav)}</span></a></li>`;
  }).join('\n');
  return `<nav class="lp-nav" aria-label="Sections on this page">\n  <p class="lp-nav-title" aria-hidden="true">On this page</p>\n  <ul>\n${items}\n  </ul>\n</nav>`;
}

// Progress bar + section-nav in-view highlight. Presentation-only, degrades
// gracefully (no IntersectionObserver → nav stays a plain anchor list).
const PAGE_SCRIPT = `
(function () {
  var doc = document.documentElement;
  var bar = document.getElementById('lp-progress-bar');
  function progress() {
    if (!bar) return;
    var max = doc.scrollHeight - doc.clientHeight;
    var y = window.pageYOffset || doc.scrollTop || 0;
    bar.style.width = (max > 0 ? Math.min(100, Math.max(0, (y / max) * 100)) : 0) + '%';
  }
  window.addEventListener('scroll', progress, { passive: true });
  window.addEventListener('resize', progress);
  progress();

  var links = {};
  Array.prototype.forEach.call(document.querySelectorAll('.lp-nav-link'), function (a) {
    links[a.getAttribute('data-nav')] = a;
  });
  var sections = Array.prototype.slice.call(document.querySelectorAll('main > section[id]'));
  function setActive(id) {
    Object.keys(links).forEach(function (key) {
      var on = key === id;
      links[key].classList.toggle('active', on);
      if (on) links[key].setAttribute('aria-current', 'true');
      else links[key].removeAttribute('aria-current');
    });
  }
  if (sections.length) setActive(sections[0].id);
  if ('IntersectionObserver' in window && sections.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) setActive(e.target.id); });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
    sections.forEach(function (s) { io.observe(s); });
  }
})();
`;

/**
 * Assemble the single self-contained WCAG 2.2 AA page. `media.video` /
 * `media.audio` are { url, note } or null (omitted → a noted omission).
 */
function assemblePage(opts) {
  const { title, subtitle, learningTargets, summaryBullets, quizItems, media, narration, vttDataUri, sourceMarkdown, omissions } = opts;

  const targetsHtml = section(
    'targets',
    'What you will be able to do',
    `<ul class="lp-targets">\n${learningTargets.map((t) => `  <li>${escapeHtml(t)}</li>`).join('\n')}\n</ul>`
  );

  const videoInner = media.video
    ? [
        `<video class="lp-video" controls preload="metadata" aria-label="Explainer video for ${escapeHtml(title)}">`,
        `  <source src="${escapeHtml(media.video.url)}" type="video/mp4">`,
        `  <track kind="captions" srclang="en" label="English" default src="${vttDataUri}">`,
        `  Your browser does not support the video element. The narration transcript is below.`,
        `</video>`,
        media.video.note ? `<p class="lp-note">${escapeHtml(media.video.note)}</p>` : '',
      ].join('\n')
    : `<p class="lp-note" role="note">Explainer video unavailable for this page${
        omissions.video ? ` (${escapeHtml(omissions.video)})` : ''
      }. The same content is covered by the narration, summary, and full document below.</p>`;
  const videoSection = section('video', 'Watch: explainer video', videoInner);

  const audioInner = media.audio
    ? [
        `<audio class="lp-audio" controls preload="metadata" aria-label="Narrated summary for ${escapeHtml(title)}">`,
        `  <source src="${escapeHtml(media.audio.url)}" type="audio/mpeg">`,
        `  Your browser does not support the audio element. The transcript is below.`,
        `</audio>`,
        media.audio.note ? `<p class="lp-note">${escapeHtml(media.audio.note)}</p>` : '',
        `<details class="lp-transcript">`,
        `  <summary>Read the narration transcript</summary>`,
        `  <p>${escapeHtml(narration.transcript || narration.script || '')}</p>`,
        `</details>`,
      ].join('\n')
    : `<p class="lp-note" role="note">Narration audio unavailable for this page${
        omissions.audio ? ` (${escapeHtml(omissions.audio)})` : ''
      }.</p>\n<details class="lp-transcript" open>\n  <summary>Narration transcript</summary>\n  <p>${escapeHtml(
        narration.transcript || narration.script || ''
      )}</p>\n</details>`;
  const audioSection = section('audio', 'Listen: narrated intro', audioInner);

  const quizSection = section(
    'quiz',
    'Check your understanding',
    `<p>Answer each question, then select <strong>Check answer</strong> for immediate feedback and the reasoning. Your progress is not saved.</p>\n${buildQuizHtml(
      quizItems
    )}`
  );

  const summarySection = section(
    'summary',
    'Key points',
    `<ul class="lp-summary">\n${summaryBullets.map((b) => `  <li>${escapeHtml(b)}</li>`).join('\n')}\n</ul>`
  );

  const sourceSection = section(
    'source',
    'The full document',
    // tabindex="0" + role/label so the scrollable region is reachable and
    // operable by keyboard — a native scrollable <div> is not in the tab order,
    // so without this a keyboard-only user cannot scroll a long document.
    `<details class="lp-source">\n  <summary>Read the full document</summary>\n  <div class="lp-source-body" tabindex="0" role="region" aria-label="Full document text">\n${renderSourceHtml(
      sourceMarkdown
    )}\n  </div>\n</details>`
  );

  const sectionsHtml = [targetsHtml, videoSection, audioSection, quizSection, summarySection, sourceSection].join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Learning page</title>
  <style>
    /* Peninsula School District brand (Pacific Northwest palette). Josefin Sans/
       Slab are the brand faces; they load only where a font host is allowed, so
       the page ships the brand fallbacks (Arial / Georgia) — no external fonts,
       images, or scripts, so it renders identically inside the Atrium sandbox CSP. */
    :root {
      color-scheme: light dark;
      --font-head: 'Josefin Sans', 'Segoe UI', system-ui, Arial, sans-serif;
      --font-body: 'Josefin Slab', Georgia, 'Times New Roman', serif;
      --paper: #fffaec;        /* skylight body background */
      --ink: #22353b;          /* body text on paper */
      --header-bg: #25424c;    /* Pacific header band */
      --heading: #25424c;      /* Pacific heading text (light on dark page in dark mode) */
      --pacific-fg: #fdf7e8;   /* text on the Pacific header */
      --eyebrow: #bcd6c8;      /* eyebrow label on Pacific */
      --subtitle-fg: #dbe6de;  /* subtitle on Pacific */
      --accent: #6ca18a;       /* sea glass — decorative bars/bullets */
      --icon: #3f6b57;         /* cedar green — icons (kept visible, >=3:1) */
      --link: #2e5f78;         /* whulge — links */
      --muted: #55675f;        /* muted text (>=4.5:1 on paper) */
      --card: #ffffff;
      --card-2: #f4efdf;       /* nav / hover surface */
      --border: #e5decb;
      --border-strong: #cdc4ad;
      --progress: #25424c;     /* scroll-progress fill */
      --ok-bg: #e7f4ea; --ok-fg: #14562a; --no-bg: #fdecec; --no-fg: #7a1220;
      --btn-bg: #3f6b57; --btn-fg: #ffffff;  /* cedar button, white text >=4.5:1 */
      --measure: 66ch;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --paper: #0f1f1e; --ink: #e7eee9;
        --header-bg: #0a1719; --heading: #bfe0d0; --pacific-fg: #f2f7f0;
        --eyebrow: #8fc0aa; --subtitle-fg: #c7d6cd;
        --accent: #6ca18a; --icon: #86c1a5; --link: #8fc3e2; --muted: #a6b7b0;
        --card: #172928; --card-2: #12201f; --border: #2c4140; --border-strong: #3a4f4e;
        --progress: #6ca18a;
        --ok-bg: #12331e; --ok-fg: #bce8c8; --no-bg: #3a1519; --no-fg: #f4b7bd;
        --btn-bg: #4f8a70; --btn-fg: #08130f;  /* light green fill, dark text >=4.5:1 */
      }
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; scroll-padding-top: 4.5rem; }
    body {
      margin: 0; background: var(--paper); color: var(--ink);
      font: 1.05rem/1.65 var(--font-body); -webkit-text-size-adjust: 100%;
    }
    .lp-accent { height: 5px; background: var(--accent); }
    .lp-progress { position: sticky; top: 0; height: 4px; background: transparent; z-index: 20; }
    .lp-progress > span { display: block; height: 100%; width: 0; background: var(--progress); }
    .lp-header { background: var(--header-bg); color: var(--pacific-fg); }
    .lp-header-inner { max-width: 1120px; margin: 0 auto; padding: clamp(1.5rem, 3vw, 2.4rem) clamp(1.1rem, 4vw, 2.5rem) clamp(1.6rem, 3vw, 2.3rem); }
    .lp-logo { height: 46px; width: auto; display: block; margin: 0 0 1.3rem; }
    .lp-eyebrow { font-family: var(--font-head); text-transform: uppercase; letter-spacing: .13em; font-size: .78rem; font-weight: 700; color: var(--eyebrow); margin: 0 0 .5rem; }
    .lp-header h1 { font-family: var(--font-head); font-weight: 700; font-size: clamp(1.9rem, 1.25rem + 3vw, 3rem); line-height: 1.1; margin: 0 0 .55rem; text-wrap: balance; color: var(--pacific-fg); }
    .lp-subtitle { margin: 0; max-width: var(--measure); color: var(--subtitle-fg); font-size: 1.05rem; }
    .lp-body { max-width: 1120px; margin: 0 auto; padding: clamp(1.5rem, 3vw, 2.5rem) clamp(1.1rem, 4vw, 2.5rem); display: grid; gap: clamp(1.4rem, 4vw, 3rem); grid-template-columns: 1fr; }
    @media (min-width: 900px) { .lp-body { grid-template-columns: 208px minmax(0, 1fr); align-items: start; } }
    .lp-nav { position: sticky; top: 1.4rem; font-family: var(--font-head); }
    @media (max-width: 899px) { .lp-nav { position: static; top: auto; } }
    .lp-nav-title { text-transform: uppercase; letter-spacing: .09em; font-size: .72rem; font-weight: 700; color: var(--muted); margin: 0 0 .55rem .25rem; }
    .lp-nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .12rem; }
    @media (max-width: 899px) { .lp-nav ul { flex-direction: row; flex-wrap: wrap; gap: .4rem; } }
    .lp-nav-link { display: flex; align-items: center; gap: .55rem; padding: .5rem .7rem; border-radius: 9px; text-decoration: none; color: var(--ink); font-weight: 600; font-size: .93rem; border: 1px solid transparent; }
    .lp-nav-link:hover { background: var(--card-2); }
    .lp-nav-link.active { background: var(--card); border-color: var(--border-strong); color: var(--heading); }
    .lp-nav-icon { display: inline-flex; color: var(--icon); flex: none; }
    .lp-nav-icon svg { width: 18px; height: 18px; }
    main { min-width: 0; }
    main > section { margin: 0 0 clamp(2rem, 4vw, 3.1rem); scroll-margin-top: 4.5rem; }
    .lp-h2 { font-family: var(--font-head); font-weight: 700; color: var(--heading); font-size: clamp(1.4rem, 1.15rem + 1.1vw, 1.85rem); line-height: 1.2; margin: 0 0 1rem; display: flex; align-items: center; gap: .6rem; }
    .lp-h2-icon { display: inline-flex; color: var(--icon); flex: none; }
    .lp-h2-icon svg { width: 26px; height: 26px; }
    p, li { text-wrap: pretty; }
    main p { max-width: var(--measure); }
    a { color: var(--link); }
    :focus-visible { outline: 3px solid var(--icon); outline-offset: 2px; border-radius: 4px; }
    .lp-targets, .lp-summary { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .65rem; }
    .lp-targets li, .lp-summary li { position: relative; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: .85rem 1rem .85rem 2.4rem; max-width: var(--measure); }
    .lp-targets li::before, .lp-summary li::before { content: ""; position: absolute; left: 1rem; top: 1.35rem; width: .6rem; height: .6rem; border-radius: 50%; background: var(--icon); }
    .lp-video, .lp-audio { width: 100%; max-width: 100%; border-radius: 12px; }
    .lp-video { background: #0b1a1c; border: 1px solid var(--border); }
    .lp-audio { background: var(--card); border: 1px solid var(--border); }
    .lp-note { color: var(--muted); font-size: .95rem; max-width: var(--measure); }
    .lp-transcript, .lp-source { margin-top: 1rem; border: 1px solid var(--border); border-radius: 12px; padding: .7rem 1rem; background: var(--card); }
    .lp-transcript summary, .lp-source summary { cursor: pointer; font-weight: 700; font-family: var(--font-head); color: var(--heading); }
    .lp-source-body { max-height: 60vh; overflow: auto; margin-top: .75rem; }
    #lp-quiz { display: flex; flex-direction: column; gap: 1rem; margin-top: .5rem; }
    /* .lp-q is a role="group" <div> (not a <fieldset>), so the question header is
       a plain block and the rounded card border has no legend notch/artifacts. */
    .lp-q { border: 1px solid var(--border); border-radius: 14px; background: var(--card); padding: 1.1rem 1.25rem; }
    .lp-q-legend { margin: 0 0 .9rem; padding: 0; font-family: var(--font-head); font-weight: 700; color: var(--heading); font-size: 1.05rem; line-height: 1.4; }
    .lp-option { display: flex; align-items: flex-start; gap: .6rem; padding: .5rem .55rem; border-radius: 9px; cursor: pointer; }
    .lp-option:hover { background: var(--card-2); }
    .lp-option input { margin-top: .3rem; flex: none; width: 1.05rem; height: 1.05rem; accent-color: var(--icon); }
    .lp-option span { display: block; }
    .lp-check, #lp-score-btn { margin-top: .9rem; font-family: var(--font-head); font-weight: 700; font-size: .98rem; cursor: pointer; color: var(--btn-fg); background: var(--btn-bg); border: 2px solid transparent; border-radius: 9px; padding: .6rem 1.1rem; }
    .lp-check:hover, #lp-score-btn:hover { filter: brightness(1.07); }
    .lp-feedback { margin: .85rem 0 0; font-weight: 700; min-height: 1.2em; }
    .lp-feedback.lp-correct { color: var(--ok-fg); background: var(--ok-bg); padding: .5rem .7rem; border-radius: 9px; }
    .lp-feedback.lp-incorrect { color: var(--no-fg); background: var(--no-bg); padding: .5rem .7rem; border-radius: 9px; }
    .lp-feedback.lp-unanswered { color: var(--no-fg); }
    .lp-score-row { margin-top: 1.25rem; border-top: 1px solid var(--border); padding-top: 1.1rem; }
    #lp-score { font-weight: 700; margin: .5rem 0 0; }
    .lp-footer { max-width: 1120px; margin: 0 auto; padding: 1.4rem clamp(1.1rem, 4vw, 2.5rem) 2.6rem; border-top: 1px solid var(--border); color: var(--muted); font-size: .9rem; }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
    }
  </style>
</head>
<body>
  <div class="lp-accent" aria-hidden="true"></div>
  <div class="lp-progress" aria-hidden="true"><span id="lp-progress-bar"></span></div>
  <header class="lp-header">
    <div class="lp-header-inner">
      <img class="lp-logo" src="${PSD_LOGO_WHITE_DATA_URI}" alt="Peninsula School District" width="150" height="46">
      <p class="lp-eyebrow">Learning Page</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="lp-subtitle">${escapeHtml(subtitle || 'A multi-modal learning page — watch, listen, read, and check your understanding.')}</p>
    </div>
  </header>
  <div class="lp-body">
    ${buildNav()}
    <main>
${sectionsHtml}
    </main>
  </div>
  <footer class="lp-footer">
    <p>Peninsula School District learning page (UDL 3.0 · WCAG 2.2 AA). Watch, listen, read, and self-test — pick the path that works for you.</p>
  </footer>
  <script>${PAGE_SCRIPT}${QUIZ_SCRIPT}</script>
</body>
</html>
`;
}

// ── media resolution (supply URL, generate, degrade, or dry-run placeholder) ───

// Only http(s) and a matching data: media URL may be embedded in <source src>.
// Mirrors psd-hyperframes' own --audio-url contract (https:// or data:audio/)
// and refuses a javascript:/other-scheme URL rather than embedding it verbatim.
function isSafeMediaUrl(url, kind) {
  if (typeof url !== 'string') return false;
  if (/^https?:\/\//i.test(url)) return true;
  return new RegExp(`^data:${kind}\\/`, 'i').test(url);
}

async function resolveAudio(args, narration, deps, dryRunPlaceholders) {
  const run = deps.runSkill || runSkill;
  if (typeof args.audio_url === 'string') {
    if (!isSafeMediaUrl(args.audio_url, 'audio')) {
      return { media: null, omission: 'supplied --audio-url rejected (must be http(s):// or data:audio/)' };
    }
    return { media: { url: args.audio_url }, omission: null };
  }
  const shouldGenerate = !args.dry_run || args.generate_media;
  if (!shouldGenerate) {
    return dryRunPlaceholders
      ? { media: { url: MP3_DATA_URI, note: 'Dry-run preview (silent placeholder). The published page uses generated narration.' }, omission: null }
      : { media: null, omission: 'not generated (dry-run)' };
  }
  const res = run({
    skill: 'tts',
    args: ['--user', String(args.user), '--engine', 'long-form', '--voice', 'Ruth'],
    input: narration.script,
  });
  const out = lastJson(res.stdout);
  if (res.code !== 0 || !out || out.status !== 'ok' || !out.url) {
    return { media: null, omission: (out && out.error) || 'psd-tts failed' };
  }
  return { media: { url: out.url }, omission: null };
}

function buildComposition(title, points, durationSeconds) {
  const clips = points
    .slice(0, 4)
    .map((p, i) => {
      const start = Math.min(durationSeconds - 1, i * Math.max(2, Math.floor(durationSeconds / (points.length + 1))));
      return `      <div class="clip" data-start="${start}" data-duration="3"><p>${escapeHtml(p)}</p></div>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1280, height=720">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1280px; height:720px; overflow:hidden; background:#0b1f3a; font-family: system-ui, sans-serif; }
  #stage { position:relative; width:1280px; height:720px; background:linear-gradient(135deg,#0b1f3a,#1d5aa8); color:#fff; }
  #title { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:0 8%; font-size:64px; font-weight:800; animation: fade 3s ease-out both; }
  .clip { position:absolute; inset:auto 8% 12% 8%; visibility:hidden; font-size:40px; line-height:1.3; }
  @keyframes fade { 0%{opacity:0} 30%{opacity:1} 100%{opacity:1} }
</style></head>
<body>
  <div id="stage" data-composition-id="learning" data-duration="${durationSeconds}" data-width="1280" data-height="720">
    <div id="title" class="clip" data-start="0" data-duration="3">${escapeHtml(title)}</div>
${clips}
  </div>
</body></html>`;
}

async function resolveVideo(args, audioUrl, title, points, narration, deps, dryRunPlaceholders) {
  const run = deps.runSkill || runSkill;
  if (typeof args.video_url === 'string') {
    if (!isSafeMediaUrl(args.video_url, 'video')) {
      return { media: null, omission: 'supplied --video-url rejected (must be http(s):// or data:video/)' };
    }
    return { media: { url: args.video_url }, omission: null };
  }
  const shouldGenerate = !args.dry_run || args.generate_media;
  if (!shouldGenerate) {
    return dryRunPlaceholders
      ? { media: { url: MP4_DATA_URI, note: 'Dry-run preview (2-second placeholder). The published page uses a generated explainer video.' }, omission: null }
      : { media: null, omission: 'not generated (dry-run)' };
  }
  const duration = estimateNarrationSeconds(narration);
  const composition = buildComposition(title, points, duration);
  let sceneDir;
  let scenePath;
  try {
    sceneDir = makeScratchDir('lp-scene-');
    scenePath = path.join(sceneDir, 'scene.html');
    fs.writeFileSync(scenePath, composition);
  } catch (err) {
    if (sceneDir) {
      try { fs.rmSync(sceneDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    return { media: null, omission: `could not write composition: ${err.message}` };
  }
  let res;
  try {
    const vArgs = ['--user', String(args.user), '--file', scenePath, '--duration', String(duration), '--fps', String(VIDEO_FPS), '--width', '1280', '--height', '720'];
    // psd-hyperframes accepts https:// or data:audio/ for the muxed narration track.
    if (audioUrl && (/^https:\/\//i.test(audioUrl) || /^data:audio\//i.test(audioUrl))) {
      vArgs.push('--audio-url', audioUrl);
    }
    res = run({ skill: 'hyperframes', args: vArgs });
  } finally {
    // Always clean up the staged composition dir, even if run() throws.
    try {
      fs.rmSync(sceneDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  const out = lastJson(res.stdout);
  if (res.code !== 0 || !out || !out.url) {
    return { media: null, omission: (out && out.error) || 'psd-hyperframes failed' };
  }
  const media = { url: out.url };
  // The video runs the full narration up to the MAX_VIDEO_SECONDS (3 min) cap;
  // only a narration longer than that is trimmed by hyperframes. Note it (via the
  // existing hook) and point to the full audio + transcript so a trimmed video is
  // not reported as if it carried the whole narration.
  if (fullNarrationSeconds(narration) > MAX_VIDEO_SECONDS) {
    const mins = Math.round(MAX_VIDEO_SECONDS / 60);
    media.note =
      `This explainer video is capped at ${mins} minutes; the complete narration ` +
      `continues in the audio player and transcript below.`;
  }
  return { media, omission: null };
}

// ── publish ────────────────────────────────────────────────────────────────────

// Build the shareable intranet reader URL for a published artifact. Prefer the
// absolute deep link the API returns (created.url = ATRIUM_PUBLIC_BASE_URL/c/{slug}),
// then build /c/{slug} from APP_BASE_URL, then fall back to whatever url the API
// gave (may be relative). NOT /atrium/{id}/view — that is the author's draft
// editor viewer, not the published intranet reader.
function buildReaderUrl(created) {
  if (typeof created.url === 'string' && /^https?:\/\//i.test(created.url)) return created.url;
  if (APP_BASE_URL && created.slug) return `${APP_BASE_URL.replace(/\/$/, '')}/c/${created.slug}`;
  if (typeof created.url === 'string' && created.url) return created.url;
  return null;
}

function publishToAtrium(html, title, deps) {
  const run = deps.runSkill || runSkill;

  // Pass the artifact code via a temp file, not a --code argv. A real board
  // policy rendered with the full source inlined can exceed Linux's per-arg
  // MAX_ARG_STRLEN (128 KB) and fail spawn with an opaque E2BIG. --code-file
  // sidesteps the argv limit entirely.
  const codeDir = makeScratchDir('lp-artifact-');
  const codePath = path.join(codeDir, 'artifact.html');
  try {
    fs.writeFileSync(codePath, html);
  } catch (err) {
    try { fs.rmSync(codeDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    fail(`could not stage the artifact for publish: ${err.message}`, 'publish_failed', 2);
  }

  let createRes;
  try {
    createRes = run({
      skill: 'atrium',
      // --visibility internal so any authenticated PSD user (staff/student) can
      // read the published page. Creating without it leaves the object PRIVATE
      // (owner/admin only) even after publish — the page would be invisible to
      // exactly the audience it's for.
      args: ['create-artifact', '--title', title, '--code-file', codePath, '--body-format', 'html', '--visibility', 'internal'],
    });
  } finally {
    try {
      fs.rmSync(codeDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  const created = lastJson(createRes.stdout);
  if (createRes.code !== 0 || !created || !created.id) {
    fail(
      `Atrium create-artifact failed: ${(created && created.message) || createRes.stderr || 'unknown error'}`,
      'publish_failed',
      2
    );
  }
  // psd-atrium's own §26.4 signal: an unauthorized "internal" create is silently
  // created PRIVATE with approvalRequired: true (exit 0, real id — see emitCreated
  // in psd-atrium/run.js). Publishing on top of that would still leave the page
  // private, invisible to the staff/student audience it's for. Surface this
  // instead of reporting unconditional success.
  if (created.approvalRequired) {
    fail(
      `Atrium created artifact ${created.id}${created.slug ? ` (slug ${created.slug})` : ''} as ` +
        `"${created.visibilityLevel}" instead of the requested "internal" — ${
          created.visibilityNote || 'a visibility widen-to-internal request is pending admin approval'
        }. The page is NOT visible to its intended audience yet; do not report it as published. ` +
        `Retry after the widen is approved: psd-atrium publish --id ${created.id} --destination intranet.`,
      'visibility_denied',
      2
    );
  }
  const pubRes = run({
    skill: 'atrium',
    args: ['publish', '--id', String(created.id), '--destination', 'intranet'],
  });
  const published = lastJson(pubRes.stdout);
  if (pubRes.code !== 0) {
    // The draft artifact already exists; surface its id/slug so the caller can
    // retry the publish step directly instead of re-running the whole pipeline
    // (which would create a duplicate draft each time).
    fail(
      `Atrium publish failed for draft artifact ${created.id}` +
        `${created.slug ? ` (slug ${created.slug})` : ''} — the draft was created but not published. ` +
        `Retry with: psd-atrium publish --id ${created.id} --destination intranet. Cause: ${
          (published && published.message) || pubRes.stderr || 'unknown error'
        }`,
      'publish_failed',
      2
    );
  }
  return { artifact: created, publish: published, readerUrl: buildReaderUrl(created) };
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      [
        'Usage: node run.js --user <email> --title "<t>" <source> [media] [--dry-run --out <path>]',
        '  source:  --source-file <md> | --text <s> | stdin',
        '           | --pdf-url|--pdf-s3-key|--pdf-path <pdf>',
        '           | --gdoc-url|--gdoc-id <google-doc>',
        '  media:   --video-url <mp4> --audio-url <mp3> (else generated via psd-tts/psd-hyperframes)',
        '  content: --content-json <path> (agent-authored learning targets/summary/quiz/narration)',
        '  --dry-run --out <path>  assemble locally (no Atrium); embeds tiny placeholder media',
        '  --generate-media        force real media generation even in --dry-run',
      ].join('\n') + '\n'
    );
    return;
  }

  if (!validateEmail(args.user)) {
    fail('--user <caller-email> is required and must be a valid email', 'bad_args');
  }
  const title = typeof args.title === 'string' ? args.title : null;
  if (!title) {
    fail('--title "<title>" is required', 'bad_args');
  }
  if (args.dry_run && typeof args.out !== 'string') {
    fail('--dry-run requires --out <path> to write the assembled HTML', 'bad_args');
  }

  const auditHtml = deps.auditHtml || loadAuditHtml();

  // Optional agent-authored content overrides.
  let overrides = null;
  if (typeof args.content_json === 'string') {
    try {
      overrides = JSON.parse(fs.readFileSync(args.content_json, 'utf8'));
    } catch (err) {
      fail(`--content-json not readable/parseable: ${err.message}`, 'bad_args');
    }
  }

  // 1. Ingest → markdown. Normalize CRLF once so every downstream consumer
  // (heading/paragraph extraction, block splitting, full-source render) sees LF.
  const ingested = await ingestSource(args, deps);
  const markdown = String(ingested.markdown || '').replace(/\r\n?/g, '\n');
  const sourceLabel = ingested.sourceLabel;

  // 2. Derive (or accept) the pedagogy content.
  const content = deriveContent(markdown, title, overrides);

  // 3+4. Resolve media. Bare --dry-run (no URLs, no --generate-media) uses tiny
  // self-contained placeholders so all five modalities are present offline.
  const dryRunPlaceholders = Boolean(args.dry_run) && !args.generate_media;
  const audioRes = await resolveAudio(args, content.narration, deps, dryRunPlaceholders);
  const videoRes = await resolveVideo(
    args,
    audioRes.media && audioRes.media.url,
    title,
    content.summaryBullets,
    content.narration,
    deps,
    dryRunPlaceholders
  );

  const omissions = {
    audio: audioRes.omission,
    video: videoRes.omission,
  };

  // 5. Captions from the narration script (present whenever we have narration).
  // Only cap the cues to the 60s clamp when the video is HYPERFRAMES-GENERATED
  // (its muxed narration is trimmed to fit MAX_VIDEO_SECONDS). A caller-supplied
  // --video-url has an unknown, possibly-longer duration and its own audio track,
  // so capping the captions there would silently drop them past 60s. Use the full
  // (uncapped) segments for a supplied video.
  const captionMaxSeconds =
    typeof args.video_url === 'string' ? Infinity : estimateNarrationSeconds(content.narration);
  const vttDataUri = toVttDataUri(
    buildVtt(capSegments(content.narration.segments || [], captionMaxSeconds))
  );

  // 6. Assemble the self-contained page.
  const html = assemblePage({
    title,
    subtitle: `From ${sourceLabel}. Watch, listen, read, and check your understanding.`,
    learningTargets: content.learningTargets,
    summaryBullets: content.summaryBullets,
    quizItems: content.quizItems,
    media: { audio: audioRes.media, video: videoRes.media },
    narration: content.narration,
    vttDataUri,
    sourceMarkdown: markdown,
    omissions,
  });

  // 7. HARD GATE — the SAME shared WCAG 2.2 AA axe gate deliver.js runs. The page
  // is never written/published if it has critical/serious violations.
  const report = await auditHtml(html);
  if (!report.pass) {
    process.stderr.write(
      `Error: assembled page failed the WCAG 2.2 AA gate: ${report.blocking
        .map((v) => `${v.id} (${v.impact})`)
        .join(', ')}\n`
    );
    process.stdout.write(JSON.stringify({ error: 'a11y_violations', message: 'assembled learning page has critical/serious accessibility violations', ...report }, null, 2) + '\n');
    process.exit(3);
  }

  const modalities = {
    video: Boolean(videoRes.media),
    audio: Boolean(audioRes.media),
    quiz: content.quizItems.length,
    summary: content.summaryBullets.length,
    learningTargets: content.learningTargets.length,
    // Trim-check: a whitespace-only source renders the "(No source content.)"
    // placeholder, so it must not be reported as a present full-source modality.
    fullSource: markdown.trim().length > 0,
  };

  // 8. Dry-run: write locally. Otherwise publish to Atrium.
  if (args.dry_run) {
    fs.writeFileSync(args.out, html);
    emit({
      status: 'ok',
      mode: 'dry-run',
      outPath: args.out,
      bytes: Buffer.byteLength(html),
      modalities,
      omissions,
      a11y: { pass: true, standard: report.standard, counts: report.counts },
    });
    return;
  }

  const { artifact, publish, readerUrl } = publishToAtrium(html, title, deps);
  emit({
    status: 'ok',
    mode: 'published',
    artifact,
    publish,
    readerUrl,
    modalities,
    omissions,
    a11y: { pass: true, standard: report.standard, counts: report.counts },
  });
}

if (require.main === module) {
  main(process.argv, {}).catch((err) => {
    fail(err instanceof Error ? err.message : String(err), 'error', 2);
  });
}

module.exports = {
  parseArgs,
  validateEmail,
  escapeHtml,
  parseGdocId,
  stripMarkdown,
  splitSentences,
  extractHeadings,
  extractParagraphs,
  deriveContent,
  buildDeterministicQuiz,
  normalizeAuthoredQuiz,
  buildNarration,
  buildVtt,
  toVttDataUri,
  buildQuizHtml,
  renderSourceHtml,
  assemblePage,
  resolveAudio,
  resolveVideo,
  buildComposition,
  ingestSource,
  exportGoogleDoc,
  publishToAtrium,
  lastJson,
  loadAuditHtml,
  main,
};
