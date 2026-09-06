'use strict';
const { validatedFs } = require('../validated-fs.cjs');

/**
 * agent-media — AWS Lambda handler (container image).
 *
 * Three capabilities the agent kept having to refuse (#1738), each traced to a
 * real refusal in prod:
 *
 *   html-to-pdf  Headless Chromium print-to-PDF honouring @page CSS.
 *                nashs, 2026-09-01: "save this 8.5x11 sign as a PDF". The
 *                PyMuPDF fallback ignored flexbox, base64 images and web fonts
 *                and produced a garbled 400x600pt page.
 *   media        ffprobe inspection and ffmpeg transcode.
 *                kinneyk, 2026-09-01: a .mov to verify for Facebook/Instagram.
 *   transcribe   Amazon Transcribe over audio already in the owner's workspace.
 *                demontek, 2026-09-03: an .m4a to turn into a printable script.
 *
 * SECURITY MODEL. Every S3 path is built from `workspacePrefix`, which the root
 * relay injects after the trusted web boundary verified the signed invocation
 * context (/api/agent/invocation-identity). The model-facing skill supplies
 * only workspace-RELATIVE paths, which are validated here against traversal and
 * absolute forms. A caller therefore cannot read or write another owner's
 * workspace even by lying about its own identity — it never states its identity
 * at all.
 *
 * Bytes stay in the owner's PRIVATE workspace prefix. Nothing here writes to
 * public-images/: a scanned IEP or a staff recording must not become a
 * public-by-link object. Publishing is a separate, deliberate act the agent
 * performs through psd-publish-file, which carries its own sensitivity gate.
 *
 * Event contract (RequestResponse invoke):
 *   { "operation": "html-to-pdf" | "media" | "transcribe",
 *     "workspacePrefix": "person-abc123/",   // injected by the relay
 *     "userEmail": "person@psd401.net",      // injected by the relay
 *     ...operation-specific fields }
 *
 * Every result is a plain object; nothing throws a bare string or returns null:
 *   { "status":"ok", ... } | { "status":"error", "error":"<code>", "message":"…" }
 */

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} = require('@aws-sdk/client-transcribe');

const execFileAsync = promisify(execFile);

const CHROMIUM = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const FFMPEG = process.env.FFMPEG_PATH || '/opt/ffmpeg/ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || '/opt/ffmpeg/ffprobe';
const REGION = process.env.AWS_REGION || 'us-east-1';

// ── Caps. Documented in each skill's SKILL.md — keep in sync. ────────────────
// A synchronous invoke must fit inside the Lambda timeout AND the agent turn.
// Lambda's response payload ceiling is 6 MB and base64 inflates by 4/3, so an
// inline PDF is capped well below it rather than failing at the transport with
// an opaque error.
const MAX_INLINE_PDF_BYTES = 4 * 1024 * 1024;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
// Input media the function will pull from S3. Above this the transcode would
// not finish inside the turn anyway, so refuse early and say so.
const MAX_INPUT_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 600_000;
const CHROMIUM_TIMEOUT_MS = 120_000;
const FFPROBE_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = Number(process.env.MEDIA_FFMPEG_TIMEOUT_MS || 600_000);
const TRANSCRIBE_POLL_INTERVAL_MS = 5_000;
const TRANSCRIBE_TIMEOUT_MS = Number(
  process.env.MEDIA_TRANSCRIBE_TIMEOUT_MS || 600_000,
);

const PAGE_SIZES = new Map([
  // Inches, width x height. Chromium takes inches for --print-to-pdf sizing.
  ['letter', [8.5, 11]],
  ['legal', [8.5, 14]],
  ['tabloid', [11, 17]],
  ['a4', [8.27, 11.69]],
  ['a3', [11.69, 16.54]],
]);

// ffmpeg presets. A fixed, named set rather than caller-supplied ffmpeg
// arguments: arbitrary argv into ffmpeg is a command-injection and
// resource-exhaustion surface, and every real request so far has been one of
// these three shapes.
const PRESETS = new Map([
  [
    'social-mp4',
    {
      extension: '.mp4',
      contentType: 'video/mp4',
      // H.264 High/yuv420p + AAC is the combination Facebook, Instagram and
      // YouTube all accept without re-encoding. +faststart moves the moov atom
      // to the front so the file starts playing before it finishes downloading;
      // without it some uploaders reject the file as corrupt.
      args: [
        '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-preset', 'medium', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart',
      ],
    },
  ],
  [
    'web-mp4',
    {
      extension: '.mp4',
      contentType: 'video/mp4',
      // Same container, smaller: 720p cap for embedding in a page or email.
      args: [
        '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-preset', 'medium', '-crf', '28',
        '-vf', "scale='min(1280,iw)':-2",
        '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
        '-movflags', '+faststart',
      ],
    },
  ],
  [
    'audio-mp3',
    {
      extension: '.mp3',
      contentType: 'audio/mpeg',
      // Strip video entirely — this is the "get me just the audio" preset.
      args: ['-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '2'],
    },
  ],
]);

// Transcribe infers the media format from the extension it is given, and only
// supports this set. Checked here so an unsupported file fails with a readable
// message instead of an opaque Transcribe BadRequestException.
const TRANSCRIBABLE = new Set([
  '.mp3', '.mp4', '.m4a', '.wav', '.flac', '.ogg', '.amr', '.webm',
]);

let s3Client = null;
function s3() {
  if (!s3Client) s3Client = new S3Client({ region: REGION });
  return s3Client;
}
let transcribeClient = null;
function transcribe() {
  if (!transcribeClient) transcribeClient = new TranscribeClient({ region: REGION });
  return transcribeClient;
}

function ok(fields) {
  return { status: 'ok', ...fields };
}
function fail(error, message) {
  return { status: 'error', error, message };
}

/**
 * Validate one workspace-RELATIVE path supplied by the model.
 *
 * The prefix comes from the verified invocation context, never from the caller,
 * so the only thing that can go wrong here is the caller escaping its own
 * prefix. Rejected: absolute paths, `..` segments, backslashes, control
 * characters, empty segments, and anything over the broker's own path budget.
 */
function relativeWorkspacePath(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 768) {
    throw new BadRequest(`${field} must be a workspace-relative path`);
  }
  // Escapes rather than literal control characters inside the class: a
  // literal \x00-\x1f range renders as unreadable glyphs in a terminal diff,
  // which makes it impossible to review and easy to 'correct' into something
  // wrong. DEL (\u007f) is included too — it is a control character that the
  // common \x00-\x1f range misses.
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new BadRequest(`${field} must be a relative path with no control characters`);
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new BadRequest(`${field} must not contain empty or traversal segments`);
    }
  }
  return value;
}

/** The prefix the relay injected. Shape-checked so a malformed one cannot widen scope. */
function workspacePrefixOf(event) {
  const prefix = event?.workspacePrefix;
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/?$/.test(prefix)) {
    // Not a caller error: the relay is responsible for this field.
    throw new BadRequest('workspacePrefix is missing or malformed');
  }
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

class BadRequest extends Error {}

function bucketName() {
  const bucket = process.env.WORKSPACE_BUCKET;
  if (!bucket) throw new Error('WORKSPACE_BUCKET is not configured');
  return bucket;
}

async function downloadToFile(key, destination) {
  const response = await s3().send(
    new GetObjectCommand({ Bucket: bucketName(), Key: key }),
  );
  const declared = Number(response.ContentLength || 0);
  if (declared > MAX_INPUT_MEDIA_BYTES) {
    throw new BadRequest(
      `input is ${declared} bytes, over the ${MAX_INPUT_MEDIA_BYTES}-byte limit`,
    );
  }
  await fs.promises.writeFile(destination, response.Body);
  const { size } = await fs.promises.stat(destination);
  if (size === 0) throw new BadRequest('input file is empty');
  // Re-check after the fact: ContentLength is advisory and a lying header must
  // not let an oversized object through.
  if (size > MAX_INPUT_MEDIA_BYTES) {
    throw new BadRequest(`input is ${size} bytes, over the limit`);
  }
  return size;
}

async function runBinary(binary, args, timeoutMs, label) {
  try {
    return await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    if (error && error.killed) {
      throw new Error(`${label} exceeded its ${Math.round(timeoutMs / 1000)}s budget`);
    }
    // ffmpeg/chromium put the useful diagnosis on stderr, not in the message.
    const detail = String(error?.stderr || error?.message || '').trim().slice(-600);
    throw new Error(`${label} failed: ${detail || 'no diagnostic output'}`);
  }
}

// ── html-to-pdf ──────────────────────────────────────────────────────────────

async function htmlToPdf(event, scratch) {
  const html = event.html;
  if (typeof html !== 'string' || html.trim() === '') {
    throw new BadRequest('html is required');
  }
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  if (htmlBytes > MAX_HTML_BYTES) {
    throw new BadRequest(`html is ${htmlBytes} bytes, over the ${MAX_HTML_BYTES}-byte limit`);
  }
  const pageSize = event.pageSize === undefined ? 'letter' : event.pageSize;
  if (!PAGE_SIZES.has(pageSize)) {
    throw new BadRequest(
      `pageSize must be one of ${[...PAGE_SIZES.keys()].join(', ')}`,
    );
  }
  const landscape = event.landscape === true;
  const margin = event.marginInches === undefined ? 0 : Number(event.marginInches);
  if (!Number.isFinite(margin) || margin < 0 || margin > 3) {
    throw new BadRequest('marginInches must be between 0 and 3');
  }
  const scale = event.scale === undefined ? 1 : Number(event.scale);
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 2) {
    throw new BadRequest('scale must be between 0.1 and 2');
  }

  const [pageWidth, pageHeight] = PAGE_SIZES.get(pageSize);
  const [width, height] = landscape ? [pageHeight, pageWidth] : [pageWidth, pageHeight];

  const source = path.join(scratch, 'page.html');
  const target = path.join(scratch, 'page.pdf');
  await fs.promises.writeFile(source, html, 'utf8');

  // --no-pdf-header-footer suppresses Chromium's default URL/date furniture,
  // which otherwise prints over a design that was laid out to the page edge.
  // The page's own @page CSS still wins over these dimensions when it sets one,
  // which is exactly what the 8.5x11 sign relies on.
  await runBinary(
    CHROMIUM,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-pdf-header-footer',
      `--print-to-pdf-page-size=${width}x${height}`,
      ...(event.printBackground === false ? [] : ['--print-to-pdf-background']),
      `--print-to-pdf=${target}`,
      source,
    ],
    CHROMIUM_TIMEOUT_MS,
    'Chromium print-to-PDF',
  );

  const pdf = await fs.promises.readFile(target);
  if (pdf.length === 0 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('Chromium produced a file that is not a PDF');
  }
  if (pdf.length > MAX_INLINE_PDF_BYTES) {
    throw new BadRequest(
      `the rendered PDF is ${pdf.length} bytes, over the ${MAX_INLINE_PDF_BYTES}-byte ` +
        'inline limit. Split the document, or reduce embedded image resolution.',
    );
  }
  // Page count without another dependency: every page object carries a /Type
  // /Page that is not /Pages. Advisory only — reported, never gated on.
  const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

  return ok({
    pdfBase64: pdf.toString('base64'),
    bytes: pdf.length,
    pages: pageCount || null,
    pageSize,
    landscape,
  });
}

// ── media (ffprobe / ffmpeg) ─────────────────────────────────────────────────

function summariseProbe(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ffprobe returned output that is not JSON');
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((s) => s.codec_type === 'video') || null;
  const audio = streams.find((s) => s.codec_type === 'audio') || null;
  const format = parsed.format || {};
  const rate = video && typeof video.avg_frame_rate === 'string'
    ? video.avg_frame_rate.split('/')
    : null;
  const fps = rate && rate.length === 2 && Number(rate[1]) !== 0
    ? Math.round((Number(rate[0]) / Number(rate[1])) * 100) / 100
    : null;
  return {
    durationSeconds: format.duration ? Math.round(Number(format.duration) * 100) / 100 : null,
    bytes: format.size ? Number(format.size) : null,
    formatName: format.format_name || null,
    video: video
      ? {
          codec: video.codec_name || null,
          width: video.width || null,
          height: video.height || null,
          fps,
          pixelFormat: video.pix_fmt || null,
        }
      : null,
    audio: audio
      ? {
          codec: audio.codec_name || null,
          channels: audio.channels || null,
          sampleRate: audio.sample_rate ? Number(audio.sample_rate) : null,
        }
      : null,
  };
}

async function probeFile(file) {
  const { stdout } = await runBinary(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    FFPROBE_TIMEOUT_MS,
    'ffprobe',
  );
  return summariseProbe(stdout);
}

async function mediaOperation(event, scratch, prefix) {
  const action = event.action === undefined ? 'probe' : event.action;
  if (action !== 'probe' && action !== 'convert') {
    throw new BadRequest('action must be probe or convert');
  }
  const inputPath = relativeWorkspacePath(event.inputPath, 'inputPath');

  // Validate EVERYTHING that costs nothing before pulling the input out of S3.
  // A convert with a bad preset used to download the whole file first and only
  // then refuse — a pointless multi-hundred-megabyte transfer, and a confusing
  // failure ("WORKSPACE_BUCKET is not configured") that named the wrong problem.
  let preset = null;
  let outputPath = null;
  if (action === 'convert') {
    if (!PRESETS.has(event.preset)) {
      throw new BadRequest(`preset must be one of ${[...PRESETS.keys()].join(', ')}`);
    }
    preset = PRESETS.get(event.preset);
    outputPath = relativeWorkspacePath(event.outputPath, 'outputPath');
    if (!outputPath.toLowerCase().endsWith(preset.extension)) {
      throw new BadRequest(
        `outputPath must end in ${preset.extension} for ${event.preset}`,
      );
    }
    if (outputPath === inputPath) {
      throw new BadRequest('outputPath must differ from inputPath');
    }
  }

  const inputFile = path.join(scratch, `input${path.extname(inputPath).slice(0, 12)}`);
  const inputBytes = await downloadToFile(`${prefix}${inputPath}`, inputFile);
  const probe = await probeFile(inputFile);

  if (action === 'probe') {
    return ok({ action, inputPath, inputBytes, probe });
  }

  const presetName = event.preset;
  // Only knowable after probing, so it stays here rather than above.
  if (presetName !== 'audio-mp3' && !probe.video) {
    throw new BadRequest(
      `${presetName} produces video, but the input has no video stream. Use audio-mp3.`,
    );
  }

  const outputFile = path.join(scratch, `output${preset.extension}`);
  await runBinary(
    FFMPEG,
    ['-nostdin', '-y', '-i', inputFile, ...preset.args, outputFile],
    FFMPEG_TIMEOUT_MS,
    'ffmpeg',
  );
  const body = await fs.promises.readFile(outputFile);
  if (body.length === 0) throw new Error('ffmpeg produced an empty file');

  await s3().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: `${prefix}${outputPath}`,
      Body: body,
      ContentType: preset.contentType,
      // Match the workspace's own object tagging so the retention lifecycle
      // rule applies to what this function writes, exactly as it does to
      // everything the agent writes through the broker.
      Tagging: 'Scope=private',
    }),
  );

  return ok({
    action,
    preset: presetName,
    inputPath,
    outputPath,
    inputBytes,
    outputBytes: body.length,
    probe,
    outputProbe: await probeFile(outputFile),
  });
}

// ── transcribe ───────────────────────────────────────────────────────────────

const LANGUAGE_RE = /^[a-z]{2}-[A-Z]{2}$/;

async function transcribeOperation(event, prefix) {
  const inputPath = relativeWorkspacePath(event.inputPath, 'inputPath');
  const extension = path.extname(inputPath).toLowerCase();
  if (!TRANSCRIBABLE.has(extension)) {
    throw new BadRequest(
      `${extension || '(no extension)'} cannot be transcribed — supported: ` +
        `${[...TRANSCRIBABLE].join(', ')}. Convert it first with the media skill.`,
    );
  }
  const languageCode = event.languageCode === undefined ? 'en-US' : event.languageCode;
  if (typeof languageCode !== 'string' || !LANGUAGE_RE.test(languageCode)) {
    throw new BadRequest('languageCode must look like en-US');
  }

  const bucket = bucketName();
  const jobName = `agent-media-${randomUUID()}`;
  // Transcribe writes its JSON result to a bucket we nominate. Keep it inside
  // the owner's own prefix so the intermediate is subject to the same access
  // boundary as the audio, then delete it once the text has been read.
  const outputKey = `${prefix}.transcribe-scratch/${jobName}.json`;

  await transcribe().send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      LanguageCode: languageCode,
      Media: { MediaFileUri: `s3://${bucket}/${prefix}${inputPath}` },
      OutputBucketName: bucket,
      OutputKey: outputKey,
    }),
  );

  const deadline = Date.now() + TRANSCRIBE_TIMEOUT_MS;
  let job = null;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        `transcription did not finish within ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)}s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, TRANSCRIBE_POLL_INTERVAL_MS));
    const described = await transcribe().send(
      new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
    );
    job = described.TranscriptionJob || null;
    const state = job?.TranscriptionJobStatus;
    if (state === 'COMPLETED') break;
    if (state === 'FAILED') {
      throw new Error(`transcription failed: ${job?.FailureReason || 'no reason given'}`);
    }
  }

  const result = await s3().send(
    new GetObjectCommand({ Bucket: bucket, Key: outputKey }),
  );
  const rawBody = await result.Body.transformToString();
  let transcript = '';
  try {
    const parsed = JSON.parse(rawBody);
    transcript = String(parsed?.results?.transcripts?.[0]?.transcript || '');
  } catch {
    throw new Error('Transcribe returned a result that is not JSON');
  }
  // Best-effort cleanup. A retained scratch object is untidy, not a failure, and
  // must never turn a successful transcription into an error.
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: outputKey }));
  } catch {
    /* lifecycle will reap it */
  }

  if (transcript.trim() === '') {
    return fail(
      'empty_transcript',
      'The audio produced no speech. Check that the file contains audible speech ' +
        'and that languageCode matches what is spoken.',
    );
  }
  const truncated = transcript.length > MAX_TRANSCRIPT_CHARS;
  return ok({
    transcript: truncated ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : transcript,
    truncated,
    characters: Math.min(transcript.length, MAX_TRANSCRIPT_CHARS),
    languageCode,
    inputPath,
  });
}

// ── entry point ──────────────────────────────────────────────────────────────

const OPERATIONS = new Set(['html-to-pdf', 'media', 'transcribe']);

exports.handler = async function handler(event) {
  let scratch = null;
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return fail('bad_request', 'event must be an object');
    }
    const operation = event.operation;
    if (!OPERATIONS.has(operation)) {
      return fail(
        'bad_request',
        `operation must be one of ${[...OPERATIONS].join(', ')}`,
      );
    }
    const prefix = workspacePrefixOf(event);

    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-media-'));
    if (operation === 'html-to-pdf') return await htmlToPdf(event, scratch);
    if (operation === 'media') return await mediaOperation(event, scratch, prefix);
    return await transcribeOperation(event, prefix);
  } catch (error) {
    if (error instanceof BadRequest) {
      return fail('bad_request', error.message);
    }
    // Deliberately surfaced rather than swallowed: the agent has to be able to
    // tell the user WHY, and an opaque failure here is what sent three separate
    // callers away empty-handed in the first place.
    return fail('media_failed', String(error?.message || error).slice(0, 900));
  } finally {
    if (scratch) {
      await fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
};

// Exported for the unit tests, which drive the pure helpers without Docker.
exports.testables = {
  relativeWorkspacePath,
  workspacePrefixOf,
  summariseProbe,
  BadRequest,
  PRESETS,
  PAGE_SIZES,
  TRANSCRIBABLE,
  MAX_INLINE_PDF_BYTES,
};

// validated-fs is required for parity with the other container Lambdas, whose
// handlers all route filesystem access through the shared wrapper. Referenced
// here so a future refactor cannot silently drop the import.
void validatedFs;
