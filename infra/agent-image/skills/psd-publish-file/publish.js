#!/usr/bin/env node

/**
 * publish.js — psd-publish-file.publish
 * Usage:
 *   node publish.js --file <path> [--to drive|public] [--content-type <type>]
 *
 * Hands a file the agent just produced to the person who asked for it.
 *
 * WHY THIS EXISTS. A user asked for "a link to this PDF" and there was no way
 * to give them one. `drive +upload <path>` looks like the answer and cannot
 * work: the Workspace CLI runs in a fresh empty mkdtemp on the WEB tier, so a
 * container path does not exist there, and its `--*-file` flags inline their
 * target as utf8 text rather than uploading bytes. The request dead-ended on a
 * bare `operation_not_allowed` (command-executor.ts now refuses it with a
 * pointer here instead).
 *
 * TWO DESTINATIONS, AND THE DEFAULT IS THE PRIVATE ONE (#1885).
 *
 *   --to drive   (default)  The file is created in the agent account's own
 *                           Drive and shared with the caller alone, as a
 *                           writer. Nothing is public. Word, Excel and
 *                           PowerPoint files can only go this way.
 *   --to public             An unsigned, public-by-link S3 object. Anyone with
 *                           the URL can open it, with no sign-in, and the
 *                           object is deleted 30 days after it is written.
 *                           For content that is genuinely meant to be public.
 *
 * Drive is the default because the old default was wrong: the only outbound
 * path used to be the public one, so files with student and staff data in them
 * went onto public links because nothing else existed.
 *
 * NOT for HTML. `.html` is accepted by neither destination: HTML pages are
 * district documents and go to Atrium, where they carry an owner, a visibility
 * level and a publication record. Use psd-html-artifact.
 *
 * Exit codes:
 *   0  delivered (JSON with the link on stdout)
 *   1  bad arguments / unsupported type / delivery failure (JSON error on stdout)
 */

'use strict';
const { validatedFs } = require("../../../validated-fs.cjs");

const path = require('node:path');

const { publishArtifact } = require('../_shared/artifact-publisher');
const {
  DRIVE_DELIVERABLE_TYPES,
  MAX_DRIVE_DELIVERY_BYTES,
  deliverFileToDrive,
} = require('../_shared/drive-deliverer');

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

const DESTINATIONS = new Map([
  [
    'drive',
    {
      types: DRIVE_DELIVERABLE_TYPES,
      maxBytes: MAX_DRIVE_DELIVERY_BYTES,
      label: 'Drive (shared with you only)',
    },
  ],
  [
    'public',
    {
      types: PUBLISHABLE_TYPES,
      maxBytes: MAX_PUBLIC_ARTIFACT_BYTES,
      label: 'public link',
    },
  ],
]);

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

/** Which destination to use. Drive unless `--to public` was asked for. */
function resolveDestination(requested) {
  if (requested === undefined) return 'drive';
  const name = requested === true ? '' : String(requested).trim().toLowerCase();
  if (!DESTINATIONS.has(name)) {
    fail(
      `--to ${name || '(no value)'} is not a destination. Use --to drive ` +
        '(private, shared with you only — the default) or --to public ' +
        '(unsigned public link, deleted after 30 days).',
      'bad_args'
    );
  }
  return name;
}

/**
 * Resolve the content type for a file, or fail with a message that says what
 * to do instead.
 *
 * An explicit --content-type is accepted only when it matches the extension's
 * own type: the broker enforces the pairing anyway, and letting the caller
 * disagree with it would just move the rejection somewhere less legible.
 */
function resolveContentType(file, requested, destination) {
  const { types } = DESTINATIONS.get(destination);
  const extension = path.extname(file).toLowerCase();
  const known = types.get(extension);
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
    // Office files are Drive-only, and that is the common case worth naming:
    // a generated .docx/.xlsx/.pptx asked for with --to public used to dead-end
    // with no route at all.
    const otherDestination = destination === 'drive' ? 'public' : 'drive';
    const alsoTry = DESTINATIONS.get(otherDestination).types.has(extension)
      ? ` It can go to the other destination: add --to ${otherDestination}.`
      : ' Convert the file to one of those types first.';
    fail(
      `Cannot deliver ${extension || '(no extension)'} to ` +
        `${DESTINATIONS.get(destination).label} — accepted types are ` +
        `${[...types.keys()].join(', ')}.${alsoTry}`,
      'unsupported_type'
    );
  }
  // `parseArgs` yields boolean true for a valueless flag. Refuse that rather
  // than letting it fall through a `typeof === 'string'` guard, which silently
  // ignored a flag the caller deliberately typed. (The old guard also carried a
  // `requested !== true` clause that could never be reached from inside the
  // string check — CodeQL flagged it as a comparison between inconvertible
  // types, and it was hiding exactly this gap.)
  if (requested === true) {
    fail(
      '--content-type needs a value, e.g. --content-type application/pdf. ' +
        'Omit the flag entirely to use the type implied by the extension.',
      'bad_args'
    );
  }
  if (
    typeof requested === 'string' &&
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

function readDeliverableFile(file, destination) {
  const { maxBytes } = DESTINATIONS.get(destination);
  let stat;
  try {
    stat = validatedFs.statSync(file);
  } catch (err) {
    fail(`--file not found or unreadable: ${file} (${err.message})`, 'bad_args');
  }
  if (!stat.isFile()) fail(`--file is not a file: ${file}`, 'bad_args');
  if (stat.size === 0) fail(`--file is empty: ${file}`, 'bad_args');
  if (stat.size > maxBytes) {
    fail(
      `--file is ${stat.size} bytes; the maximum deliverable size is ` +
        `${maxBytes}. Split it or compress it.`,
      'too_large'
    );
  }
  // RAW bytes. Decoding as utf8 would corrupt every binary type in the list
  // above and would upload different bytes than the file holds.
  return validatedFs.readFileSync(file);
}

async function deliverToDrive(bytes, file, contentType) {
  const fileName = path.basename(file);
  const delivered = await deliverFileToDrive(bytes, fileName, contentType);
  emit({
    url: delivered.webViewLink,
    driveFileId: delivered.fileId,
    fileName: delivered.fileName,
    bytes: bytes.length,
    contentType,
    sharing: 'private-shared-with-caller',
    sharedWith: delivered.sharedWith,
    ...(delivered.ownedBy ? { ownedBy: delivered.ownedBy } : {}),
    // Drive files do not expire. Say so explicitly, because the public path
    // does and the agent must not carry one path's rule to the other.
    expires: 'never',
    instruction: BARE_URL_INSTRUCTION,
  });
}

async function publishPublicly(bytes, file, extension, contentType) {
  const { url, key } = await publishArtifact(bytes, extension, contentType);
  emit({
    url,
    s3Key: key,
    fileName: path.basename(file),
    bytes: bytes.length,
    contentType,
    // Unsigned: anyone who receives the link can fetch it, with no sign-in.
    sharing: 'public-by-link',
    // The `expire-public-artifacts` lifecycle rule deletes the object 30 days
    // after it is written. Tell the user if the link is meant to last.
    expires: '30 days after publication',
    instruction: BARE_URL_INSTRUCTION,
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: publish.js --file <path> [--to drive|public] [--content-type <type>]\n' +
        '\n' +
        '--to drive  (default) create the file in your agent\'s Drive and share\n' +
        '            it with you alone. Nothing becomes public.\n' +
        `            Deliverable: ${[...DRIVE_DELIVERABLE_TYPES.keys()].join(', ')}\n` +
        '--to public unsigned public-by-link URL, deleted after 30 days.\n' +
        `            Publishable: ${[...PUBLISHABLE_TYPES.keys()].join(', ')}\n` +
        '\n' +
        'HTML pages go to Atrium instead — use psd-html-artifact.'
    );
    process.exit(0);
  }

  const file = args.file && args.file !== true ? String(args.file) : null;
  if (!file) fail('--file is required (path to the file to deliver)', 'bad_args');

  const destination = resolveDestination(args.to);
  const { extension, contentType } = resolveContentType(
    file,
    args.content_type,
    destination
  );
  const bytes = readDeliverableFile(file, destination);

  if (destination === 'drive') {
    await deliverToDrive(bytes, file, contentType);
    return;
  }
  await publishPublicly(bytes, file, extension, contentType);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err), 'error');
});
