#!/usr/bin/env node

/**
 * publish.js — psd-publish-file.publish
 * Usage:
 *   node publish.js --file <path> [--content-type <type>]
 *
 * Turns a file the agent just produced into a shareable HTTPS link.
 *
 * WHY THIS EXISTS. A user asked for "a link to this PDF" and there was no way
 * to give them one. `drive +upload <path>` looks like the answer and cannot
 * work: the Workspace CLI runs in a fresh empty mkdtemp on the WEB tier, so a
 * container path does not exist there, and its `--*-file` flags inline their
 * target as utf8 text rather than uploading bytes. The request dead-ended on a
 * bare `operation_not_allowed` (command-executor.ts now refuses it with a
 * pointer here instead).
 *
 * The bytes path already existed — `_shared/artifact-publisher.js` is what
 * psd-image-gen and chat-chart use — it simply had no entry point for "a file
 * on disk". This is that entry point and nothing more: it does not generate,
 * convert, or rename anything.
 *
 * NOT for HTML. `.html` is not an accepted public artifact type: HTML pages are
 * district documents and go to Atrium, where they carry an owner, a visibility
 * level and a publication record. Use psd-html-artifact.
 *
 * Exit codes:
 *   0  published (JSON with the URL on stdout)
 *   1  bad arguments / unsupported type / upload failure (JSON error on stdout)
 */

'use strict';
const { validatedFs } = require("../../../validated-fs.cjs");

const path = require('node:path');

const { publishArtifact } = require('../_shared/artifact-publisher');

// Mirrors PUBLIC_EXTENSIONS / PUBLIC_CONTENT_TYPES in
// lib/agent-workspace/storage-broker.ts, which is the real gate. Checking here
// too turns a broker rejection into a specific, actionable message that names
// the extension and lists what IS publishable.
//
// `.html` is deliberately absent — see the header.
const PUBLISHABLE_TYPES = new Map([
  ['.csv', 'text/csv'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain'],
  ['.webp', 'image/webp'],
]);

// MAX_PUBLIC_ARTIFACT_BYTES in storage-broker.ts. Checked here so an oversized
// file fails immediately with its own size in the message, rather than after a
// full read and a broker round trip.
const MAX_PUBLIC_ARTIFACT_BYTES = 100 * 1024 * 1024;

// Pasted verbatim into the result. A trailing backtick percent-encodes to %60
// and the link 404s — that has happened in production.
const BARE_URL_INSTRUCTION =
  'Paste this URL BARE on its own line — no backticks, no markdown link, ' +
  'no trailing punctuation. A trailing backtick becomes %60 and 404s.';

function fail(message, code = 'error') {
  process.stderr.write(`Error: ${message}\n`);
  process.stdout.write(JSON.stringify({ error: code, message }) + '\n');
  process.exit(1);
}

function emit(obj) {
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

/**
 * Resolve the content type for a file, or fail with a message that says what
 * to do instead.
 *
 * An explicit --content-type is accepted only when it matches the extension's
 * own type: the broker enforces the pairing anyway, and letting the caller
 * disagree with it would just move the rejection somewhere less legible.
 */
function resolveContentType(file, requested) {
  const extension = path.extname(file).toLowerCase();
  const known = PUBLISHABLE_TYPES.get(extension);
  if (!known) {
    if (extension === '.html' || extension === '.htm') {
      fail(
        'HTML pages are not published as public files — they go to Atrium, ' +
          'where they get an owner, a visibility level and a publication ' +
          'record. Use: node /opt/psd-skills/psd-html-artifact/deliver.js ' +
          '--user <caller-email> --file ' + file,
        'html_goes_to_atrium'
      );
    }
    fail(
      `Cannot publish ${extension || '(no extension)'} — publishable types are ` +
        `${[...PUBLISHABLE_TYPES.keys()].join(', ')}. Convert the file first, ` +
        'or attach it to the reply instead of linking it.',
      'unsupported_type'
    );
  }
  if (
    typeof requested === 'string' &&
    requested !== true &&
    requested.split(';')[0].trim().toLowerCase() !== known
  ) {
    fail(
      `--content-type ${requested} does not match ${extension} (${known}). ` +
        'The storage broker enforces this pairing; omit the flag.',
      'bad_args'
    );
  }
  return { extension, contentType: known };
}

function readPublishableFile(file) {
  let stat;
  try {
    stat = validatedFs.statSync(file);
  } catch (err) {
    fail(`--file not found or unreadable: ${file} (${err.message})`, 'bad_args');
  }
  if (!stat.isFile()) fail(`--file is not a file: ${file}`, 'bad_args');
  if (stat.size === 0) fail(`--file is empty: ${file}`, 'bad_args');
  if (stat.size > MAX_PUBLIC_ARTIFACT_BYTES) {
    fail(
      `--file is ${stat.size} bytes; the maximum publishable size is ` +
        `${MAX_PUBLIC_ARTIFACT_BYTES}. Split it, compress it, or share it ` +
        'through Drive instead.',
      'too_large'
    );
  }
  // RAW bytes. Decoding as utf8 would corrupt every binary type in the list
  // above and would upload different bytes than the file holds.
  return validatedFs.readFileSync(file);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: publish.js --file <path> [--content-type <type>]\n' +
        '\n' +
        'Publishes a local file and prints a shareable HTTPS URL.\n' +
        `Publishable: ${[...PUBLISHABLE_TYPES.keys()].join(', ')}\n` +
        'HTML pages go to Atrium instead — use psd-html-artifact.'
    );
    process.exit(0);
  }

  const file = args.file && args.file !== true ? String(args.file) : null;
  if (!file) fail('--file is required (path to the file to publish)', 'bad_args');

  const { extension, contentType } = resolveContentType(file, args.content_type);
  const bytes = readPublishableFile(file);
  const { url, key } = await publishArtifact(bytes, extension, contentType);

  emit({
    url,
    s3Key: key,
    fileName: path.basename(file),
    bytes: bytes.length,
    contentType,
    // Unsigned and non-expiring: anyone who receives the link can fetch it.
    sharing: 'public-by-link',
    instruction: BARE_URL_INSTRUCTION,
  });
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err), 'error');
});
