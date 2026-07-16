#!/usr/bin/env node
/**
 * deliver.js — psd-html-artifact.deliver
 * Usage:
 *   node deliver.js --user <email> --file <path-to-.html>
 *   node deliver.js --audit-only --file <path-to-.html>   # a11y gate, no upload
 *
 * Uploads a finished, self-contained HTML artifact to the agent workspace S3
 * bucket under the public `public-images/` prefix and returns an unsigned
 * HTTPS URL — anyone who receives the link can open the page in a browser.
 *
 * Delivery mirrors psd-image-gen/generate.js exactly: same bucket, same
 * `public-images/` prefix (granted public `s3:GetObject` by the bucket policy
 * in agent-platform-stack.ts), same unguessable-UUID key, same unsigned
 * path-style URL. No OpenAI/credentials/capability machinery — this skill only
 * moves bytes the agent already produced, so it spends no external quota.
 *
 * Accessibility gate (Issue #1245): EVERY delivery runs the shared WCAG 2.2 AA
 * axe-core audit (a11y-audit.js) FIRST and REFUSES to upload any artifact with
 * critical/serious violations (exit 3, error `a11y_violations`). This is the
 * same gate psd-learning-page runs before publishing to Atrium, so "all HTML
 * artifacts are accessible" is enforced centrally rather than per-skill.
 * `--audit-only` runs just that check (no S3, no `--user` needed) so any caller
 * can pre-validate a file with the identical gate.
 */

'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Shared WCAG 2.2 AA gate — the single audit both this skill and
// psd-learning-page run (Issue #1245).
const { auditHtml } = require('./a11y-audit');

const REGION = process.env.AWS_REGION || 'us-east-1';
const WORKSPACE_BUCKET = process.env.WORKSPACE_BUCKET || '';
// Keep this prefix in sync with the bucket policy (see psd-image-gen/generate.js
// and agent-platform-stack.ts:PublicReadOnPublicImagesPrefix). The UUID in the
// key makes the path unguessable — same security model as Google Drive
// "anyone with the link" sharing.
const PUBLIC_PREFIX = 'public-images';
// HTML artifacts are text; even data-URI-heavy pages rarely exceed a few MB.
// Cap at 25 MB so a runaway file fails fast instead of pushing a huge object.
const MAX_HTML_BYTES = 25 * 1024 * 1024;

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

async function uploadAndShare(bytes, userEmail) {
  if (!WORKSPACE_BUCKET) {
    fail('WORKSPACE_BUCKET env var not set — cannot upload HTML artifact', 'misconfigured');
  }
  const key = `${PUBLIC_PREFIX}/${userEmail}/${randomUUID()}.html`;
  const s3 = new S3Client({ region: REGION });

  await s3.send(new PutObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: key,
    Body: bytes,
    ContentType: 'text/html; charset=utf-8',
    Metadata: {
      generated_by: 'psd-html-artifact',
    },
  }));

  // Path-style URL with each segment encoded so emails with reserved
  // characters (`+`, `&`) survive the round-trip. randomUUID() is already
  // URL-safe.
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = `https://${WORKSPACE_BUCKET}.s3.${REGION}.amazonaws.com/${encodedKey}`;
  return { url, key };
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
    stat = fs.statSync(file);
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
  const buffer = fs.readFileSync(file);
  return { file, size: buffer.length, buffer };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: deliver.js --user <email> --file <path-to-.html>\n' +
        '       deliver.js --audit-only --file <path-to-.html>'
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
  const { size, buffer } = readHtmlFile(args);
  // Validate bucket before the (potentially slow) audit so we fail fast on misconfig.
  if (!WORKSPACE_BUCKET) {
    fail('WORKSPACE_BUCKET env var not set — cannot upload HTML artifact', 'misconfigured');
  }

  // HARD GATE: never upload an artifact that fails the accessibility floor.
  const report = await auditHtml(buffer.toString('utf8'));
  if (!report.pass) failA11y(report);

  // Upload the exact original bytes (not a utf8 round-trip).
  const { url, key } = await uploadAndShare(buffer, args.user);

  emit({
    url,
    s3Key: key,
    bytes: size,
    contentType: 'text/html; charset=utf-8',
    // Unsigned and non-expiring — anyone with the link can fetch until the
    // object is deleted (manual lifecycle policy may be added later).
    sharing: 'public-by-link',
    a11y: { pass: true, standard: report.standard, counts: report.counts },
  });
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err), 'error');
});
