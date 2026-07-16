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

// Container layout (overridable so the unit tests can point at fakes).
const SKILLS_DIR = process.env.PSD_SKILLS_DIR || '/opt/psd-skills';
const VENV_PY = process.env.PSD_VENV_PYTHON || '/opt/agentcore-venv/bin/python3';
const APP_BASE_URL = process.env.APP_BASE_URL || '';

const MAX_VIDEO_SECONDS = 60; // psd-hyperframes hard cap
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

// Reject `/` because the email is interpolated into skill S3 key paths.
function validateEmail(email) {
  const RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (typeof email !== 'string' || !RE.test(email)) return false;
  if (email.includes('/')) return false;
  return true;
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
    // A denied export (drive.file 404 / consent) must surface psd-workspace's
    // "share it with my agent account" guidance verbatim — never crash, and
    // never tell the user to share it with their own address.
    const out = lastJson(res.stdout);
    const denied =
      res.code === 12 ||
      res.code === 14 ||
      (out && (out.status === 'account-provisioning' || /40[34]|consent|share/i.test(out.message || '')));
    if (denied) {
      const guidance =
        (out && (out.message || out.guidance)) ||
        `Couldn't read that Google Doc. Share it with your agent account ` +
          `(agnt_<your-uniqname>@psd401.net, Reader is enough) and try again.`;
      fail(guidance, 'gdoc_denied', 2);
    }
    // markdown export unsupported → retry as plain text before giving up
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
  const re = /^(#{1,3})\s+(.+?)\s*#*$/gm;
  let m;
  while ((m = re.exec(markdown))) {
    const text = stripMarkdown(m[2]);
    if (text) out.push({ level: m[1].length, text });
  }
  return out;
}

function extractParagraphs(markdown) {
  return String(markdown || '')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b && !/^#{1,6}\s/.test(b)) // drop pure-heading blocks
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
    (overrides && Array.isArray(overrides.summary) && overrides.summary.length && overrides.summary) ||
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
    (overrides && Array.isArray(overrides.learningTargets) && overrides.learningTargets.length && overrides.learningTargets) ||
    (headingTargets.length >= 2
      ? headingTargets.slice(0, 4).map((h) => `Understand ${h}.`)
      : [`Understand the key points of ${title}.`, `Explain why ${title} matters and when it applies.`]);

  const quizItems =
    (overrides && Array.isArray(overrides.quiz) && overrides.quiz.length && normalizeAuthoredQuiz(overrides.quiz)) ||
    buildDeterministicQuiz(summaryBullets, learningTargets, title);

  const narration =
    (overrides && overrides.narration && typeof overrides.narration.script === 'string' && overrides.narration) ||
    buildNarration(title, learningTargets, summaryBullets);

  return { learningTargets, summaryBullets, quizItems, narration };
}

function normalizeAuthoredQuiz(quiz) {
  return quiz
    .map((q, i) => {
      const options = Array.isArray(q.options) ? q.options.map(String) : [];
      let correctIndex = Number.isInteger(q.answer) ? q.answer : Number.isInteger(q.correctIndex) ? q.correctIndex : 0;
      if (correctIndex < 0 || correctIndex >= options.length) correctIndex = 0;
      return {
        stem: String(q.question || q.stem || `Question ${i + 1}`),
        options,
        correctIndex,
        explanation: String(q.rationale || q.explanation || ''),
      };
    })
    .filter((q) => q.options.length >= 2);
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
  // Segment on sentences for caption timing.
  const sentences = splitSentences(script);
  let t = 0;
  const segments = sentences.map((text) => {
    const words = text.split(/\s+/).filter(Boolean).length;
    const dur = Math.max(2, Math.round(words / WORDS_PER_SECOND));
    const seg = { text, start: t, end: t + dur };
    t += dur;
    return seg;
  });
  return { script, segments, transcript: script };
}

function estimateNarrationSeconds(narration) {
  if (narration.segments && narration.segments.length) {
    return Math.min(MAX_VIDEO_SECONDS, narration.segments[narration.segments.length - 1].end);
  }
  const words = String(narration.script || '').split(/\s+/).filter(Boolean).length;
  return Math.min(MAX_VIDEO_SECONDS, Math.max(2, Math.round(words / WORDS_PER_SECOND)));
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
      return [
        `<fieldset class="lp-q" data-correct="${q.correctIndex}" data-explanation="${escapeHtml(q.explanation)}">`,
        `  <legend>${qi + 1}. ${escapeHtml(q.stem)}</legend>`,
        options,
        `  <button type="button" class="lp-check">Check answer</button>`,
        `  <p class="lp-feedback" role="status" aria-live="polite"></p>`,
        `</fieldset>`,
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
  var quiz = document.getElementById('lp-quiz');
  if (!quiz) return;
  var questions = Array.prototype.slice.call(quiz.querySelectorAll('.lp-q'));
  questions.forEach(function (q) {
    var btn = q.querySelector('.lp-check');
    var fb = q.querySelector('.lp-feedback');
    var correct = parseInt(q.getAttribute('data-correct'), 10);
    var expl = q.getAttribute('data-explanation') || '';
    btn.addEventListener('click', function () {
      var chosen = q.querySelector('input[type=radio]:checked');
      if (!chosen) {
        fb.className = 'lp-feedback lp-unanswered';
        fb.textContent = 'Select an answer first.';
        return;
      }
      var ok = parseInt(chosen.value, 10) === correct;
      fb.className = 'lp-feedback ' + (ok ? 'lp-correct' : 'lp-incorrect');
      // More than colour: a word + a symbol carry the result, not hue alone.
      fb.textContent = (ok ? '\\u2713 Correct. ' : '\\u2717 Not quite. ') + expl;
      q.setAttribute('data-answered', ok ? 'correct' : 'incorrect');
    });
  });
  var scoreBtn = document.getElementById('lp-score-btn');
  var scoreOut = document.getElementById('lp-score');
  if (scoreBtn && scoreOut) {
    scoreBtn.addEventListener('click', function () {
      var total = questions.length, right = 0, answered = 0;
      questions.forEach(function (q) {
        var st = q.getAttribute('data-answered');
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
    .split(/\n{2,}/)
    .map((b) => b.replace(/\s+$/g, ''))
    .filter((b) => b.trim().length);
  if (!blocks.length) return '<p>(No source content.)</p>';
  return blocks
    .map((b) => `<p>${escapeHtml(b).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// ── page assembly ──────────────────────────────────────────────────────────────

function section(id, heading, inner) {
  return [
    `<section aria-labelledby="${id}-h">`,
    `  <h2 id="${id}-h">${escapeHtml(heading)}</h2>`,
    inner,
    `</section>`,
  ].join('\n');
}

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
    `<details class="lp-source">\n  <summary>Read the full document</summary>\n  <div class="lp-source-body">\n${renderSourceHtml(
      sourceMarkdown
    )}\n  </div>\n</details>`
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Learning page</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #ffffff; --fg: #14181f; --muted: #4a5462;
      --card: #f4f6f9; --border: #c8cfd8; --accent: #0b5cad;
      --ok-bg: #e7f4ea; --ok-fg: #0f5323; --no-bg: #fdecec; --no-fg: #7a1220;
      --measure: 68ch;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1319; --fg: #eef2f7; --muted: #aab4c2;
        --card: #171d26; --border: #333d4a; --accent: #7fb4f0;
        --ok-bg: #10331c; --ok-fg: #b6e8c4; --no-bg: #3a1418; --no-fg: #f4b7bd;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--bg); color: var(--fg);
      font: 1rem/1.6 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      -webkit-text-size-adjust: 100%;
    }
    .lp-wrap { max-width: 960px; margin: 0 auto; padding: clamp(1rem, 2vw, 2rem); }
    header.lp-header { border-bottom: 3px solid var(--accent); padding-bottom: 1rem; margin-bottom: 1.5rem; }
    h1 { font-size: clamp(1.6rem, 1.2rem + 2vw, 2.4rem); line-height: 1.15; margin: 0 0 .25rem; text-wrap: balance; }
    h2 { font-size: clamp(1.25rem, 1.1rem + 1vw, 1.6rem); margin: 0 0 .75rem; }
    .lp-subtitle { color: var(--muted); margin: 0; max-width: var(--measure); }
    main > section { margin: 0 0 2.5rem; }
    p, li { max-width: var(--measure); text-wrap: pretty; }
    ul { padding-left: 1.25rem; }
    a { color: var(--accent); }
    :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
    .lp-video, .lp-audio { width: 100%; max-width: 100%; background: #000; border-radius: 6px; }
    .lp-audio { background: var(--card); }
    .lp-note { color: var(--muted); font-size: .95rem; }
    .lp-transcript, .lp-source { margin-top: 1rem; border: 1px solid var(--border); border-radius: 6px; padding: .5rem .9rem; background: var(--card); }
    .lp-transcript summary, .lp-source summary { cursor: pointer; font-weight: 600; }
    .lp-source-body { max-height: 60vh; overflow: auto; margin-top: .75rem; }
    .lp-q { border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.1rem; margin: 0 0 1.1rem; background: var(--card); }
    .lp-q legend { font-weight: 600; padding: 0 .3rem; }
    .lp-option { display: flex; align-items: flex-start; gap: .5rem; padding: .35rem 0; cursor: pointer; }
    .lp-option input { margin-top: .3rem; }
    .lp-check, #lp-score-btn {
      margin-top: .6rem; font: inherit; font-weight: 600; cursor: pointer;
      color: #fff; background: var(--accent); border: 2px solid transparent;
      border-radius: 6px; padding: .5rem .9rem;
    }
    .lp-feedback { margin: .6rem 0 0; font-weight: 600; min-height: 1.2em; }
    .lp-feedback.lp-correct { color: var(--ok-fg); background: var(--ok-bg); padding: .4rem .6rem; border-radius: 6px; }
    .lp-feedback.lp-incorrect { color: var(--no-fg); background: var(--no-bg); padding: .4rem .6rem; border-radius: 6px; }
    .lp-feedback.lp-unanswered { color: var(--no-fg); }
    .lp-score-row { border-top: 1px solid var(--border); padding-top: 1rem; }
    #lp-score { font-weight: 600; }
    footer.lp-footer { border-top: 1px solid var(--border); margin-top: 2rem; padding-top: 1rem; color: var(--muted); font-size: .9rem; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
    }
  </style>
</head>
<body>
  <div class="lp-wrap">
    <header class="lp-header">
      <h1>${escapeHtml(title)}</h1>
      <p class="lp-subtitle">${escapeHtml(subtitle || 'A multi-modal learning page — watch, listen, read, and check your understanding.')}</p>
    </header>
    <main>
${[targetsHtml, videoSection, audioSection, quizSection, summarySection, sourceSection].join('\n')}
    </main>
    <footer class="lp-footer">
      <p>Generated learning page (UDL 3.0 · WCAG 2.2 AA). Watch, listen, read, and self-test — pick the path that works for you.</p>
    </footer>
  </div>
  <script>${QUIZ_SCRIPT}</script>
</body>
</html>
`;
}

// ── media resolution (supply URL, generate, degrade, or dry-run placeholder) ───

async function resolveAudio(args, narration, deps, dryRunPlaceholders) {
  const run = deps.runSkill || runSkill;
  if (typeof args.audio_url === 'string') {
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
  let scenePath;
  try {
    scenePath = path.join(require('node:os').tmpdir(), `lp-scene-${Date.now()}.html`);
    fs.writeFileSync(scenePath, composition);
  } catch (err) {
    return { media: null, omission: `could not write composition: ${err.message}` };
  }
  const vArgs = ['--user', String(args.user), '--file', scenePath, '--duration', String(duration), '--width', '1280', '--height', '720'];
  if (audioUrl && /^https:\/\//.test(audioUrl)) vArgs.push('--audio-url', audioUrl);
  const res = run({ skill: 'hyperframes', args: vArgs });
  try {
    fs.rmSync(scenePath, { force: true });
  } catch {
    /* best-effort cleanup */
  }
  const out = lastJson(res.stdout);
  if (res.code !== 0 || !out || !out.url) {
    return { media: null, omission: (out && out.error) || 'psd-hyperframes failed' };
  }
  return { media: { url: out.url }, omission: null };
}

// ── publish ────────────────────────────────────────────────────────────────────

function publishToAtrium(html, title, deps) {
  const run = deps.runSkill || runSkill;
  const createRes = run({
    skill: 'atrium',
    args: ['create-artifact', '--title', title, '--code', html, '--body-format', 'html'],
  });
  const created = lastJson(createRes.stdout);
  if (createRes.code !== 0 || !created || !created.id) {
    fail(
      `Atrium create-artifact failed: ${(created && created.message) || createRes.stderr || 'unknown error'}`,
      'publish_failed',
      2
    );
  }
  const pubRes = run({
    skill: 'atrium',
    args: ['publish', '--id', String(created.id), '--destination', 'intranet'],
  });
  const published = lastJson(pubRes.stdout);
  if (pubRes.code !== 0) {
    fail(
      `Atrium publish failed: ${(published && published.message) || pubRes.stderr || 'unknown error'}`,
      'publish_failed',
      2
    );
  }
  const readerUrl = APP_BASE_URL ? `${APP_BASE_URL.replace(/\/$/, '')}/atrium/${created.id}/view` : null;
  return { artifact: created, publish: published, readerUrl };
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

  // 1. Ingest → markdown.
  const { markdown, sourceLabel } = await ingestSource(args, deps);

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
  const vttDataUri = toVttDataUri(buildVtt(content.narration.segments || []));

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
    fullSource: markdown.length > 0,
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
