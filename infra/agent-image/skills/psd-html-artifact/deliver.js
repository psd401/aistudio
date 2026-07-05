#!/usr/bin/env node
/**
 * deliver.js — psd-html-artifact.deliver
 * Usage:
 *   node deliver.js --user <email> --file <path-to-.html>
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
 */

'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

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
// Reject `/` because the email is interpolated into the S3 key path.
function validateEmail(email) {
  const RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (typeof email !== 'string' || !RE.test(email)) return false;
  if (email.includes('/')) return false;
  return true;
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

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: deliver.js --user <email> --file <path-to-.html>');
    process.exit(0);
  }
  if (!validateEmail(args.user)) {
    fail('--user is required and must be a valid email', 'bad_args');
  }
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
  // Validate bucket before reading the file so we fail fast on misconfig.
  if (!WORKSPACE_BUCKET) {
    fail('WORKSPACE_BUCKET env var not set — cannot upload HTML artifact', 'misconfigured');
  }

  const bytes = fs.readFileSync(file);
  const { url, key } = await uploadAndShare(bytes, args.user);

  emit({
    url,
    s3Key: key,
    bytes: stat.size,
    contentType: 'text/html; charset=utf-8',
    // Unsigned and non-expiring — anyone with the link can fetch until the
    // object is deleted (manual lifecycle policy may be added later).
    sharing: 'public-by-link',
  });
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err), 'error');
});
