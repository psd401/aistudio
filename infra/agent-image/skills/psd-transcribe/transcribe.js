#!/usr/bin/env node

/**
 * psd-transcribe — turn a recording into text with Amazon Transcribe.
 *
 * The failure this exists to end (demontek, 2026-09-03): an .m4a from Drive was
 * downloaded successfully, and then nothing. No Whisper key, no Transcribe
 * permission on the execution role, and the configured Bedrock model takes text
 * and images but not audio. The self-report named the cause exactly.
 */

'use strict';

const { validatedFs } = require("../../../validated-fs.cjs");

const path = require('node:path');
const {
  runMedia,
  uploadScratch,
  deleteScratch,
  MAX_UPLOAD_BYTES,
} = require('../_shared/media-relay');

// What Transcribe itself accepts. Anything else needs psd-media first.
const TRANSCRIBABLE = ['.mp3', '.mp4', '.m4a', '.wav', '.flac', '.ogg', '.amr', '.webm'];
const LANGUAGE_RE = /^[a-z]{2}-[A-Z]{2}$/;

function emit(object) {
  process.stdout.write(`${JSON.stringify(object, null, 2)}\n`);
}

function fail(message, code = 'error') {
  process.stderr.write(`Error: ${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) fail(`Unexpected positional argument: ${arg}`, 'bad_args');
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

function valued(args, key, flag) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === true) fail(`${flag} needs a value`, 'bad_args');
  return String(value);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: transcribe.js --file <recording.m4a> [--language en-US] [--out transcript.txt]\n' +
        '\n' +
        `Accepts: ${TRANSCRIBABLE.join(', ')}\n` +
        'Anything else: convert it first with psd-media --preset audio-mp3.\n' +
        '\n' +
        'Prints the transcript as JSON. --out also writes it to a text file.',
    );
    return;
  }

  const file = valued(args, 'file', '--file');
  if (!file) fail('--file <recording> is required', 'bad_args');
  const extension = path.extname(file).toLowerCase();
  if (!TRANSCRIBABLE.includes(extension)) {
    fail(
      `${extension || '(no extension)'} cannot be transcribed. Accepted: ` +
        `${TRANSCRIBABLE.join(', ')}. Convert it first:\n` +
        `  node /opt/psd-skills/psd-media/media.js --convert --file ${file} ` +
        '--out /tmp/audio.mp3 --preset audio-mp3',
      'bad_args',
    );
  }

  let stat;
  try {
    stat = validatedFs.statSync(file);
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`, 'bad_args');
  }
  if (stat.size === 0) fail(`${file} is empty`, 'bad_args');
  if (stat.size > MAX_UPLOAD_BYTES) {
    fail(`${file} is ${stat.size} bytes, over the ${MAX_UPLOAD_BYTES}-byte limit`, 'too_large');
  }

  const language = valued(args, 'language', '--language') || 'en-US';
  if (!LANGUAGE_RE.test(language)) {
    fail('--language must look like en-US or es-US', 'bad_args');
  }
  const out = valued(args, 'out', '--out');

  let inputPath = null;
  try {
    inputPath = await uploadScratch(file);
    const result = await runMedia({
      operation: 'transcribe',
      inputPath,
      languageCode: language,
    });
    if (out) validatedFs.writeFileSync(out, `${result.transcript}\n`, 'utf8');
    emit({
      transcript: result.transcript,
      characters: result.characters,
      truncated: result.truncated,
      language: result.languageCode,
      ...(out ? { file: out } : {}),
    });
  } catch (error) {
    fail(error.message, error.code || 'transcribe_failed');
  } finally {
    // The recording is someone's voice. Remove the transport copy on every
    // path rather than leaving it in the bucket for a lifecycle rule.
    if (inputPath) await deleteScratch(inputPath);
  }
}

main().catch((error) => fail(error.message));
