#!/usr/bin/env node

/**
 * deliver.js — psd-html-artifact.deliver
 * Usage:
 *   node deliver.js --user <email> --file <path-to-.html> [--title <t>]
 *   node deliver.js --audit-only --file <path-to-.html>   # a11y gate, no publish
 *
 * Publishes a finished, self-contained HTML artifact into ATRIUM and returns
 * the intranet reader URL.
 *
 * WHY NOT S3 ANY MORE. This was the last HTML -> S3 path in the platform:
 * chat-chart and psd-image-gen publish .png, psd-learning-page already went to
 * Atrium, and only this skill still dropped a `text/html` object into the
 * unsigned, public-by-link `public-images/` prefix. HTML pages are documents,
 * and PSD documents belong in Atrium, where they carry an owner, a visibility
 * level, a publication record and an audit trail rather than an unguessable
 * URL that is public to anyone who ever receives it. `.html` has now been
 * removed from PUBLIC_EXTENSIONS/PUBLIC_CONTENT_TYPES in
 * lib/agent-workspace/storage-broker.ts, so the rule is enforced by the broker
 * rather than merely documented here. Every OTHER file type still goes to S3.
 *
 * Delivery mirrors psd-learning-page/run.js: `create-artifact --code-file
 * <path> --body-format html --visibility internal`, then `publish --id <id>
 * --destination intranet`, returning the completed publication's reader URL.
 *
 * Three Atrium behaviours are load-bearing here:
 *   - create starts PRIVATE + DRAFT, so a /c/{slug} link 404s until publish
 *     succeeds. This never reports a URL from a create that was not published.
 *   - the body goes through --code-file, never argv: a 128 KiB MAX_ARG_STRLEN
 *     makes an inline page E2BIG, and pages routinely exceed it.
 *   - the returned URL must be pasted BARE on its own line. A trailing backtick
 *     percent-encodes to %60 and 404s (agent_failures 7167, 7299), so the JSON
 *     result carries an explicit instruction saying so.
 *
 * Accessibility gate (Issue #1245): EVERY delivery runs the shared WCAG 2.2 AA
 * axe-core audit (a11y-audit.js) FIRST and REFUSES to publish any artifact with
 * critical/serious violations (exit 3, error `a11y_violations`). This is the
 * same gate psd-learning-page runs, so "all HTML artifacts are accessible" is
 * enforced centrally rather than per-skill. `--audit-only` runs just that check
 * (no publish, no `--user` needed) so any caller can pre-validate a file with
 * the identical gate.
 */

'use strict';
const { validatedFs } = require("../../../validated-fs.cjs");



const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Shared WCAG 2.2 AA gate — the single audit both this skill and
// psd-learning-page run (Issue #1245).
const { auditHtml } = require('./a11y-audit');

// Container layout (overridable so the unit tests can point at fakes).
const SKILLS_DIR = process.env.PSD_SKILLS_DIR || '/opt/psd-skills';
const APP_BASE_URL = process.env.APP_BASE_URL || '';

// HTML artifacts are text; even data-URI-heavy pages rarely exceed a few MB.
// Cap at 25 MB so a runaway file fails fast instead of pushing a huge object.
const MAX_HTML_BYTES = 25 * 1024 * 1024;

// Pasted verbatim into the result so the model does not wrap the link. A
// trailing backtick percent-encodes to %60 and the reader 404s.
const BARE_URL_INSTRUCTION =
  'Paste this URL BARE on its own line — no backticks, no markdown link, ' +
  'no trailing punctuation. A trailing backtick becomes %60 and 404s.';

function fail(message, code = 'error') {
  process.stderr.write(`Error: ${message}\n`);
  process.stdout.write(JSON.stringify({ error: code, message }) + '\n');
  process.exit(1);
}

function emit(obj) {
  // Match psd-image-gen/generate.js:emit — pretty JSON so the agent receives a
  // uniform format regardless of which skill produced it.
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

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
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

// Duplicated from psd-image-gen/generate.js — skills are standalone packages
// with no cross-skill require(). Source of truth: psd-credentials/common.js.
// Reject `/` because the email is interpolated into the S3 key path. Validated
// with linear string ops rather than a backtracking-prone email regex (ReDoS).
function validateEmail(email) {
  if (typeof email !== 'string' || email.length === 0 || email.length > 254) return false;
  if (email.includes('/') || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  if (domain.length === 0 || domain.startsWith('.') || domain.endsWith('.')) return false;
  return domain.includes('.');
}

// ── Atrium publication ────────────────────────────────────────────────────────

// The JSON object a composed skill printed on stdout, or null when stdout is
// not JSON. psd-atrium emits single-line JSON as the only thing on stdout, so
// the whole-string parse is the normal path; the suffix scan tolerates a log
// line printed before the JSON block.
function lastJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to suffix scan */
  }
  const lines = text.split('\n');
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

function runAtrium(args) {
  const res = spawnSync(
    'node',
    [path.join(SKILLS_DIR, 'psd-atrium', 'run.js'), ...args],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.error) return { code: 1, stdout: '', stderr: res.error.message };
  return {
    code: res.status == null ? 1 : res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

// The shareable intranet reader URL. Prefer the absolute deep link the API
// returns, then build /c/{slug} from APP_BASE_URL, then fall back to whatever
// url the API gave. NOT /atrium/{id}/view — that is the author's draft editor.
function buildReaderUrl(created) {
  if (typeof created.url === 'string' && /^https?:\/\//i.test(created.url)) {
    return created.url;
  }
  if (APP_BASE_URL && created.slug) {
    return `${APP_BASE_URL.replace(/\/$/, '')}/c/${created.slug}`;
  }
  if (typeof created.url === 'string' && created.url) return created.url;
  return null;
}

// A title Atrium can show. Derived from <title> when the page has one, so the
// caller does not have to pass --title for the common case.
function deriveTitle(html, file, explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const match = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html);
  const fromDocument = match && match[1].replace(/\s+/g, ' ').trim();
  if (fromDocument) return fromDocument;
  return path.basename(file, path.extname(file)) || 'HTML artifact';
}

function createAtriumArtifact(buffer, title, run) {
  const codeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-artifact-'));
  const codePath = path.join(codeDir, 'artifact.html');
  let createRes;
  try {
    // --code-file, never argv: MAX_ARG_STRLEN is 128 KiB and an inline page
    // that exceeds it fails with E2BIG rather than a readable error.
    validatedFs.writeFileSync(codePath, buffer);
    createRes = run([
      'create-artifact',
      '--title',
      title,
      '--code-file',
      codePath,
      '--body-format',
      'html',
      // Without this the artifact stays PRIVATE even after publish, so the page
      // would be invisible to exactly the audience it was made for.
      '--visibility',
      'internal',
    ]);
  } catch (err) {
    fail(`could not stage the artifact for publish: ${err.message}`, 'publish_failed');
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
      `Atrium create-artifact failed: ${
        (created && created.message) || createRes.stderr || 'unknown error'
      }`,
      'publish_failed'
    );
  }
  return created;
}

// A widen-to-internal that needs admin approval leaves the page invisible. Say
// so instead of handing back a link the intended audience cannot open.
function requireAtriumVisibility(created) {
  if (created.approvalRequired) {
    fail(
      `Atrium created artifact ${created.id}${
        created.slug ? ` (slug ${created.slug})` : ''
      } as "${created.visibilityLevel}" instead of the requested "internal" — ${
        created.visibilityNote ||
        'a visibility widen-to-internal request is pending admin approval'
      }. The page is NOT visible to its intended audience yet; do not report it ` +
        `as published. Retry after the widen is approved: psd-atrium publish ` +
        `--id ${created.id} --destination intranet.`,
      'visibility_denied'
    );
  }
}

function publishAtriumArtifact(created, run) {
  const pubRes = run([
    'publish',
    '--id',
    String(created.id),
    '--destination',
    'intranet',
  ]);
  const published = lastJson(pubRes.stdout);
  if (pubRes.code !== 0) {
    // The draft already exists; surface its id/slug so the caller retries the
    // publish step rather than re-running and creating a duplicate draft.
    fail(
      `Atrium publish failed for draft artifact ${created.id}${
        created.slug ? ` (slug ${created.slug})` : ''
      } — the draft was created but not published. Retry with: psd-atrium ` +
        `publish --id ${created.id} --destination intranet. Cause: ${
          (published && published.message) || pubRes.stderr || 'unknown error'
        }`,
      'publish_failed'
    );
  }
  return published;
}

function publishToAtrium(buffer, title, deps = {}) {
  const run = deps.runAtrium || runAtrium;
  const created = createAtriumArtifact(buffer, title, run);
  requireAtriumVisibility(created);
  const published = publishAtriumArtifact(created, run);
  return { artifact: created, publish: published, readerUrl: buildReaderUrl(created) };
}

// Refuse an inaccessible artifact. Exit 3 (distinct from bad_args=1) so callers
// and CI can tell "you gave me bad flags" apart from "the page is inaccessible".
function failA11y(report) {
  const ids = report.blocking.map((v) => `${v.id} (${v.impact})`);
  process.stderr.write(
    `Error: refusing to deliver — ${report.blocking.length} critical/serious ` +
      `accessibility violation(s): ${ids.join(', ')}\n`
  );
  process.stdout.write(
    JSON.stringify(
      {
        error: 'a11y_violations',
        message:
          'Artifact has critical/serious WCAG 2.2 AA violations; fix them and ' +
          're-run. Contrast/reflow are not checked here — verify those in a browser.',
        ...report,
      },
      null,
      2
    ) + '\n'
  );
  process.exit(3);
}

// Read a --file argument, validating it is a non-empty .html under the size cap.
function readHtmlFile(args) {
  const file = args.file && args.file !== true ? String(args.file) : null;
  if (!file) {
    fail('--file is required (path to the .html artifact)', 'bad_args');
  }
  let stat;
  try {
    stat = validatedFs.statSync(file);
  } catch (err) {
    fail(`--file not found or unreadable: ${file} (${err.message})`, 'bad_args');
  }
  if (!stat.isFile()) {
    fail(`--file is not a file: ${file}`, 'bad_args');
  }
  if (stat.size === 0) {
    fail(`--file is empty: ${file}`, 'bad_args');
  }
  if (stat.size > MAX_HTML_BYTES) {
    fail(`--file is ${stat.size} bytes; maximum is ${MAX_HTML_BYTES}`, 'bad_args');
  }
  if (path.extname(file).toLowerCase() !== '.html') {
    fail(`--file must be a .html file (got ${path.extname(file) || '(none)'})`, 'bad_args');
  }
  // Read the RAW bytes. Decoding as 'utf8' here would replace any invalid byte
  // with U+FFFD and re-encoding would upload DIFFERENT bytes than the file held
  // (and the reported size would be stale). The audit gets a utf8 view; the
  // upload uses the exact original bytes.
  const buffer = validatedFs.readFileSync(file);
  return { file, size: buffer.length, buffer };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: deliver.js --user <email> --file <path-to-.html> [--title <t>]\n' +
        '       deliver.js --audit-only --file <path-to-.html>\n' +
        '\n' +
        'Publishes the page into Atrium (internal visibility) and prints the\n' +
        'intranet reader URL. --title defaults to the page <title>.'
    );
    process.exit(0);
  }

  // --audit-only: run just the shared WCAG 2.2 AA gate and report. No upload,
  // no --user, no bucket — this is the pre-flight check any skill can call.
  if (args.audit_only) {
    const { buffer } = readHtmlFile(args);
    const report = await auditHtml(buffer.toString('utf8'));
    if (!report.pass) failA11y(report);
    emit({ status: 'ok', audit: report });
    return;
  }

  if (!validateEmail(args.user)) {
    fail('--user is required and must be a valid email', 'bad_args');
  }
  const { file, size, buffer } = readHtmlFile(args);
  // HARD GATE: never publish an artifact that fails the accessibility floor.
  const html = buffer.toString('utf8');
  const report = await auditHtml(html);
  if (!report.pass) failA11y(report);

  const title = deriveTitle(html, file, args.title);
  // Publish the exact original bytes (not a utf8 round-trip).
  const { artifact, readerUrl } = publishToAtrium(buffer, title);

  emit({
    url: readerUrl,
    artifactId: artifact.id,
    slug: artifact.slug ?? null,
    title,
    bytes: size,
    destination: 'atrium-intranet',
    visibility: artifact.visibilityLevel ?? 'internal',
    // Authenticated PSD readers only — this is the whole reason HTML no longer
    // goes to the unsigned public S3 prefix.
    sharing: 'psd-internal',
    instruction: BARE_URL_INSTRUCTION,
    a11y: { pass: true, standard: report.standard, counts: report.counts },
  });
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err), 'error');
});
