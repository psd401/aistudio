#!/usr/bin/env node

/**
 * psd-media — inspect and convert audio/video with ffmpeg.
 *
 * The failure this exists to end (kinneyk, 2026-09-01): a .mov was uploaded and
 * the user asked whether it would work for Facebook and Instagram. There was no
 * ffmpeg and no ffprobe in the container, so the agent could neither answer nor
 * convert, and the turn ended with nothing delivered.
 *
 * Presets, not raw ffmpeg arguments. Arbitrary argv into ffmpeg is a
 * command-injection and resource-exhaustion surface, and every real request so
 * far has been one of these three shapes.
 */

'use strict';

const { validatedFs } = require("../../../validated-fs.cjs");

const path = require('node:path');
const {
  runMedia,
  uploadScratch,
  downloadScratch,
  deleteScratch,
  scratchPath,
  MAX_UPLOAD_BYTES,
} = require('../_shared/media-relay');

const PRESETS = {
  'social-mp4': '.mp4',
  'web-mp4': '.mp4',
  'audio-mp3': '.mp3',
};

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

/** Validate the --convert flags. Split out to keep main() flat. */
function convertOptions(args) {
  const preset = valued(args, 'preset', '--preset');
  const out = valued(args, 'out', '--out');
  if (!preset) fail('--preset is required with --convert', 'bad_args');
  if (!Object.hasOwn(PRESETS, preset)) {
    fail(`--preset must be one of ${Object.keys(PRESETS).join(', ')}`, 'bad_args');
  }
  if (!out) fail('--out <output> is required with --convert', 'bad_args');
  if (path.extname(out).toLowerCase() !== PRESETS[preset]) {
    fail(`--out must end in ${PRESETS[preset]} for ${preset}`, 'bad_args');
  }
  return { preset, out };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage:\n' +
        '  media.js --probe   --file <input>\n' +
        '  media.js --convert --file <input> --out <output> --preset <name>\n' +
        '\n' +
        `Presets: ${Object.keys(PRESETS).join(', ')}\n` +
        '  social-mp4  H.264/yuv420p + AAC, +faststart — Facebook, Instagram, YouTube\n' +
        '  web-mp4     same, capped at 720p — embedding in a page or email\n' +
        '  audio-mp3   audio only, video discarded\n',
    );
    return;
  }

  const file = valued(args, 'file', '--file');
  if (!file) fail('--file <input> is required', 'bad_args');
  const wantsConvert = args.convert === true;
  if (!wantsConvert && args.probe !== true) {
    fail('pass --probe or --convert', 'bad_args');
  }
  if (wantsConvert && args.probe === true) {
    fail('pass either --probe or --convert, not both', 'bad_args');
  }

  let stat;
  try {
    stat = validatedFs.statSync(file);
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`, 'bad_args');
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    fail(
      `${file} is ${stat.size} bytes, over the ${MAX_UPLOAD_BYTES}-byte limit`,
      'too_large',
    );
  }

  const { preset, out } = wantsConvert
    ? convertOptions(args)
    : { preset: null, out: null };

  // Upload, work, download, clean up. The scratch objects live in the owner's
  // own checkpoint-excluded prefix and are removed on every exit path so a
  // large video does not linger in the workspace bucket.
  const uploaded = [];
  try {
    const inputPath = await uploadScratch(file);
    uploaded.push(inputPath);

    if (!wantsConvert) {
      const result = await runMedia({ operation: 'media', action: 'probe', inputPath });
      emit({ action: 'probe', file, bytes: result.inputBytes, ...result.probe });
      return;
    }

    const outputPath = scratchPath(PRESETS[preset]);
    const result = await runMedia({
      operation: 'media',
      action: 'convert',
      inputPath,
      outputPath,
      preset,
    });
    uploaded.push(outputPath);
    const bytes = await downloadScratch(outputPath, out);
    emit({
      action: 'convert',
      preset,
      file: out,
      bytes,
      inputBytes: result.inputBytes,
      before: result.probe,
      after: result.outputProbe,
      sharing: 'local-file-not-published',
    });
  } catch (error) {
    fail(error.message, error.code || 'media_failed');
  } finally {
    for (const workspacePath of uploaded) {
      await deleteScratch(workspacePath);
    }
  }
}

main().catch((error) => fail(error.message));
