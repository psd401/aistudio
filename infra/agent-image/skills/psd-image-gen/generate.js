#!/usr/bin/env node

/**
 * generate.js — psd-image-gen.generate
 * Usage:
 *   node generate.js --user <email> --prompt "<text>"
 *                    [--size 1024x1024|1024x1536|1536x1024|auto]
 *                    [--quality low|medium|high|auto]
 *                    [--background opaque|transparent|auto]
 *                    [--name "<Drive file name>"]
 *                    [--to drive|file|public] [--out <path.png>] [--public-confirmed]
 *
 * Calls the image broker (gpt-image-2.5-flare) and delivers the PNG PRIVATELY
 * by default (#2034): the file is created in the agent account's Drive and
 * shared with the requester alone.
 *
 *   --to drive   (default) private Drive file, shared with the caller only.
 *   --to file    write the PNG to --out and upload nothing (for embedding in
 *                another deliverable the agent is building).
 *   --to public  unsigned public-by-link URL, deleted after 30 days. Refused
 *                with `public_needs_confirmation` unless --public-confirmed is
 *                also passed: the agent must ask the user and get a yes.
 */

'use strict';
const { validatedFs } = require("../../../validated-fs.cjs");


const { execFileSync } = require('node:child_process');

const path = require('node:path');

const { publishArtifact } = require('../_shared/artifact-publisher');
const { requestAgentBroker } = require('../_shared/agent-broker');
const { deliverFileToDrive } = require('../_shared/drive-deliverer');
const {
  DeliveryChoiceError,
  driveFileName,
  resolveDelivery,
} = require('../_shared/delivery-choice');

// Output is PRIVATE by default (#2034): a Drive file shared with the caller
// alone. Only `--to public --public-confirmed` writes to the unsigned
// `public-images/` prefix, which the workspace bucket policy makes readable by
// anyone with the URL (deleted after 30 days by `expire-public-artifacts`).
// The unversioned alias rather than a dated snapshot. The dated form
// (`gpt-image-2-2026-04-21`) is gated by an OpenAI per-project allowlist
// and silently 404s for projects that don't have that snapshot enabled —
// observed in dev on 2026-05-03, broke image-gen end-to-end. The alias
// resolves to whatever the project has access to and rolls forward
// automatically as OpenAI publishes new versions. We trade pin-style
// reproducibility for actually working; if a future OpenAI release
// changes output meaningfully, we'll re-pin to the new dated version.
// Also update SKILL.md when changing this value.
//
// 2026-10-26: OpenAI stopped serving `gpt-image-2` to the district project
// (403 model_not_found), so the alias no longer resolves. The broker
// (AGENT_IMAGE_MODEL_ID in lib/agent-credentials/owner-operation-broker.ts)
// picks the model; this value is only reported back and must match it.
const MODEL_ID = 'gpt-image-2.5-flare';
const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);
const ALLOWED_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
const ALLOWED_BACKGROUNDS = new Set(['opaque', 'transparent', 'auto']);
// Reference-image input — psd-brand-guidelines drops logo files in the
// workspace, then the agent passes one via --image to compose branded
// outputs through OpenAI's /v1/images/edits endpoint. The endpoint expects
// each image as a data URL inside an `images: [{ image_url }]` array.
const ALLOWED_IMAGE_EXTS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);
// OpenAI's edits endpoint accepts up to ~20MB per image. Cap at 8MB to keep
// JSON payload reasonable (base64 inflates 33%, so 8MB → ~11MB on the wire).
const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;

const CREDENTIALS_CHECK_CAPABILITY = path.resolve(
  __dirname,
  '..',
  'psd-credentials',
  'check_capability.js',
);
const REQUIRED_CAPABILITY = 'skill.image-gen';

function fail(message, code = 'error') {
  process.stderr.write(`Error: ${message}\n`);
  process.stdout.write(JSON.stringify({ error: code, message }) + '\n');
  process.exit(1);
}

function emit(obj) {
  // Pretty-print for consistency with psd-freshservice/lib/api.js:emit.
  // All skills should emit the same JSON format so the agent receives
  // uniform output regardless of which skill produced it.
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

// NOTE: parseArgs, fail, emit, validateEmail are intentionally duplicated from
// psd-credentials/common.js — skills are standalone packages with no cross-skill
// require(). The source of truth for these helpers is psd-credentials/common.js.
// Keep in sync with: psd-credentials/common.js and psd-freshservice/lib/api.js.
//
// Email regex divergence: psd-freshservice/lib/api.js uses /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/
// (blocks `/` inside the character classes), while this file uses a separate
// `.includes('/')` check. Both produce the same behavior — reject emails with `/`.
// Unifying into a shared helper is tracked for the planned cross-skill utility
// module (see psd-credentials SKILL.md).
function validateEmail(email) {
  const RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (typeof email !== 'string' || !RE.test(email)) return false;
  // Defense-in-depth: reject path separators — email is interpolated into S3
  // key paths (`images/{email}/{uuid}.png`) and slashes would create unexpected
  // key prefixes.
  if (email.includes('/')) return false;
  return true;
}

/**
 * Fail-closed capability gate. The skill folder is loaded into
 * OpenClaw's static catalog at container init, so users without the
 * `skill.image-gen` capability still see the tool advertised. This
 * check is the actual enforcement: it queries the AI Studio
 * `capabilities`/`role_capabilities`/`user_roles` tables via
 * psd-credentials and refuses invocation if the caller lacks the
 * grant. Database errors are treated as denials.
 *
 * Catalog-level filtering (so the skill is not even visible) is a
 * future change once OpenClaw exposes a per-session catalog hook.
 */
function enforceCapability() {
  try {
    execFileSync('node', [
      CREDENTIALS_CHECK_CAPABILITY,
      '--capability', REQUIRED_CAPABILITY,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    // Exit code 0 — capability granted, return without error.
    return;
  } catch {
    // Non-zero exit — fall through to fail-closed denial below.
  }

  // Fail-closed: any non-zero exit from check_capability.js means denied.
  // We do NOT trust stdout {granted: true} when the process exited non-zero
  // (e.g. signal, crash) — exit code is the sole source of truth for RBAC gates.
  fail(
    `The signed invocation owner lacks the ${REQUIRED_CAPABILITY} capability. ` +
    'Ask an administrator to grant it via the role assignments at /admin/roles.',
    'forbidden_capability',
  );
}

/**
 * Read a reference image from disk and return `{ dataUrl, mime }`.
 * Validates the extension is one OpenAI accepts and the file size is
 * under MAX_REFERENCE_IMAGE_BYTES so we fail fast with a clear message
 * rather than blowing up the JSON payload.
 */
function loadReferenceImage(imagePath) {
  let stat;
  try {
    stat = validatedFs.statSync(imagePath);
  } catch (err) {
    fail(`--image file not found or unreadable: ${imagePath} (${err.message})`, 'bad_args');
  }
  if (!stat.isFile()) {
    fail(`--image path is not a file: ${imagePath}`, 'bad_args');
  }
  if (stat.size > MAX_REFERENCE_IMAGE_BYTES) {
    fail(
      `--image file is ${stat.size} bytes; maximum is ${MAX_REFERENCE_IMAGE_BYTES}`,
      'bad_args',
    );
  }
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ALLOWED_IMAGE_EXTS.get(ext);
  if (!mime) {
    fail(
      `--image extension ${ext || '(none)'} not supported. Allowed: ${[...ALLOWED_IMAGE_EXTS.keys()].join(', ')}`,
      'bad_args',
    );
  }
  const base64 = validatedFs.readFileSync(imagePath).toString('base64');
  return { dataUrl: `data:${mime};base64,${base64}`, mime };
}

async function requestImage(params, referenceDataUrl) {
  const result = await requestAgentBroker(
    '/api/agent/credentials',
    {
      operation: 'openai-image',
      ...params,
      referenceDataUrl,
    },
    // Must stay above the broker's own 240s fetch timeout on the OpenAI image
    // call (lib/agent-credentials/owner-operation-broker.ts) so the server-side
    // timeout fires first and returns a reportable error, and below the ALB's
    // 300s idle timeout so the connection is not cut from underneath us.
    { timeoutMs: 250_000 },
  );
  if (
    typeof result.imageBase64 !== 'string' ||
    !/^[A-Za-z0-9+/=]+$/.test(result.imageBase64)
  ) {
    fail('Image broker returned invalid image data', 'upstream_error');
  }
  return Buffer.from(result.imageBase64, 'base64');
}

/**
 * Resolve where the PNG goes before any paid generation call, so a refused
 * public link or a bad --out costs nothing.
 */
function resolveImageDelivery(args) {
  let destination;
  try {
    destination = resolveDelivery(args, { allowed: ['drive', 'file', 'public'] });
  } catch (err) {
    if (err instanceof DeliveryChoiceError) fail(err.message, err.code);
    throw err;
  }
  const out = args.out && args.out !== true ? path.resolve(String(args.out)) : null;
  if (destination === 'file') {
    if (!out) fail('--to file needs --out <path.png>', 'bad_args');
    if (!out.toLowerCase().endsWith('.png')) fail('--out must end in .png', 'bad_args');
  } else if (args.out !== undefined) {
    fail('--out is only used with --to file', 'bad_args');
  }
  return { destination, out };
}

async function deliverImage(bytes, delivery, args) {
  if (delivery.destination === 'file') {
    validatedFs.writeFileSync(delivery.out, bytes);
    return { path: delivery.out, sharing: 'local-file' };
  }
  if (delivery.destination === 'public') {
    const { url, key } = await publishArtifact(bytes, '.png', 'image/png');
    return {
      url,
      s3Key: key,
      // Unsigned: anyone with the link can fetch it, with no sign-in.
      sharing: 'public-by-link',
      expires: '30 days after publication',
    };
  }
  const delivered = await deliverFileToDrive(
    bytes,
    driveFileName(args.name, '.png', 'Image'),
    'image/png',
  );
  return {
    url: delivered.webViewLink,
    driveFileId: delivered.fileId,
    fileName: delivered.fileName,
    sharing: 'private-shared-with-caller',
    sharedWith: delivered.sharedWith,
    expires: 'never',
  };
}

function optionalString(value, fallback) {
  return value && value !== true ? String(value) : fallback;
}

function validateGenerationOptions(args) {
  if (!validateEmail(args.user)) {
    fail('--user is required and must be a valid email', 'bad_args');
  }
  if (!args.prompt || args.prompt === true) {
    fail('--prompt is required', 'bad_args');
  }
  if (args.prompt.length > 4000) {
    fail('--prompt must be 4000 characters or fewer', 'bad_args');
  }

  const size = args.size > 0 ? optionalString(args.size, 'auto') : 'auto';
  const quality = optionalString(args.quality, 'auto');
  const background = optionalString(args.background, 'auto');
  if (!ALLOWED_SIZES.has(size)) {
    fail(`Invalid --size. Allowed: ${[...ALLOWED_SIZES].join(', ')}`, 'bad_args');
  }
  if (!ALLOWED_QUALITIES.has(quality)) {
    fail(`Invalid --quality. Allowed: ${[...ALLOWED_QUALITIES].join(', ')}`, 'bad_args');
  }
  if (!ALLOWED_BACKGROUNDS.has(background)) {
    fail(`Invalid --background. Allowed: ${[...ALLOWED_BACKGROUNDS].join(', ')}`, 'bad_args');
  }
  const imagePath = optionalString(args.image, null);
  return { size, quality, background, imagePath };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: generate.js --user <email> --prompt "<text>" [--image <path>] [--size auto|1024x1024|1024x1536|1536x1024] [--quality auto|low|medium|high] [--background auto|opaque|transparent] [--name "<Drive file name>"] [--to drive|file|public] [--out <path.png>] [--public-confirmed]');
    process.exit(0);
  }
  const { size, quality, background, imagePath } = validateGenerationOptions(args);
  const delivery = resolveImageDelivery(args);

  // --image is optional. When present it must be a real path (no `--image`
  // followed by another flag) and selects the /v1/images/edits endpoint so
  // the model composes the output around the reference image. Validate the
  // path up front — same tier as size/quality checks — so we fail fast
  // before the RBAC shell-out + API-key fetch.
  // Load + validate the reference image up front so a bad path fails fast,
  // before the RBAC shell-out and API-key fetch.
  const referenceImage = imagePath ? loadReferenceImage(imagePath) : null;

  enforceCapability();
  const params = { prompt: args.prompt, size, quality, background };
  const bytes = await requestImage(
    params,
    referenceImage ? referenceImage.dataUrl : null,
  );
  const delivered = await deliverImage(bytes, delivery, args);

  emit({
    ...delivered,
    model: MODEL_ID,
    prompt: args.prompt,
    size,
    quality,
    background,
    mode: referenceImage ? 'edit' : 'generate',
  });
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err), 'error');
});
