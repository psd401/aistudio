#!/usr/bin/env node
/**
 * generate.js — psd-image-gen.generate
 * Usage:
 *   node generate.js --user <email> --prompt "<text>"
 *                    [--size 1024x1024|1024x1536|1536x1024|auto]
 *                    [--quality low|medium|high|auto]
 *                    [--background opaque|transparent|auto]
 *
 * Calls OpenAI v1/images/generations with model gpt-image-2-2026-04-21,
 * uploads the result to the agent workspace S3 bucket, and returns a
 * presigned URL valid for 1 hour. The shared OpenAI key is read from
 * Secrets Manager via the psd-credentials skill — never from env vars
 * or files.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const REGION = process.env.AWS_REGION || 'us-east-1';
const WORKSPACE_BUCKET = process.env.WORKSPACE_BUCKET || '';
// Skill output lives under `public-images/` which is granted public
// `s3:GetObject` by the workspace bucket's resource policy (see
// agent-platform-stack.ts:AgentWorkspaceBucket). Anyone who receives the
// returned URL can fetch the image — same security model as Google
// Drive "anyone with the link" sharing. The UUID in the key makes the
// path unguessable. Keep this prefix in sync with the bucket policy.
const PUBLIC_PREFIX = 'public-images';
// The unversioned alias rather than a dated snapshot. The dated form
// (`gpt-image-2-2026-04-21`) is gated by an OpenAI per-project allowlist
// and silently 404s for projects that don't have that snapshot enabled —
// observed in dev on 2026-05-03, broke image-gen end-to-end. The alias
// resolves to whatever the project has access to and rolls forward
// automatically as OpenAI publishes new versions. We trade pin-style
// reproducibility for actually working; if a future OpenAI release
// changes output meaningfully, we'll re-pin to the new dated version.
// Also update SKILL.md when changing this value.
const MODEL_ID = 'gpt-image-2';
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

const CREDENTIALS_GET = path.resolve(
  __dirname,
  '..',
  'psd-credentials',
  'get.js',
);
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
function enforceCapability(userEmail) {
  try {
    execFileSync('node', [
      CREDENTIALS_CHECK_CAPABILITY,
      '--user', userEmail,
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
    `User ${userEmail} lacks the ${REQUIRED_CAPABILITY} capability. ` +
    'Ask an administrator to grant it via the role assignments at /admin/roles.',
    'forbidden_capability',
  );
}

/**
 * Fetch the shared (district-funded) OpenAI API key from psd-credentials.
 * Uses --shared to skip user-scoped lookups — ensures a per-user key
 * cannot override the district-funded key. The skill is its own process
 * and cannot share the credential cache, so we shell out and parse one
 * JSON object from stdout. The value is held in a local variable and
 * never written elsewhere.
 */
function readSharedOpenAIKey(userEmail) {
  let stdout;
  try {
    stdout = execFileSync('node', [CREDENTIALS_GET, '--user', userEmail, '--shared', '--name', 'openai_api_key'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (err) {
    fail(`psd-credentials/get.js failed: ${err.message}`, 'shared_key_missing');
  }

  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    fail('psd-credentials returned no output', 'shared_key_missing');
  }
  const last = lines[lines.length - 1];
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch (err) {
    fail(`psd-credentials returned non-JSON: ${err.message}`, 'shared_key_missing');
  }
  if (parsed.error || !parsed.value) {
    fail('Shared OpenAI key not provisioned. Ask an admin to bootstrap psd-agent-creds/{env}/shared/openai_api_key.', 'shared_key_missing');
  }
  return parsed.value;
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
    stat = fs.statSync(imagePath);
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
  const base64 = fs.readFileSync(imagePath).toString('base64');
  return { dataUrl: `data:${mime};base64,${base64}`, mime };
}

async function editWithImage(apiKey, params, referenceDataUrl) {
  const body = {
    model: MODEL_ID,
    images: [{ image_url: referenceDataUrl }],
    prompt: params.prompt,
  };
  if (params.size && params.size !== 'auto') body.size = params.size;
  if (params.quality && params.quality !== 'auto') body.quality = params.quality;
  if (params.background && params.background !== 'auto') body.background = params.background;

  const resp = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    fail(`OpenAI API ${resp.status}: ${text.slice(0, 500)}`, 'upstream_error');
  }

  const data = await resp.json();
  const first = (data && Array.isArray(data.data)) ? data.data[0] : null;
  if (!first || !first.b64_json) {
    fail('OpenAI response missing b64_json image data', 'upstream_error');
  }
  return Buffer.from(first.b64_json, 'base64');
}

async function generateImage(apiKey, params) {
  const body = { model: MODEL_ID, prompt: params.prompt };
  if (params.size && params.size !== 'auto') body.size = params.size;
  if (params.quality && params.quality !== 'auto') body.quality = params.quality;
  if (params.background && params.background !== 'auto') body.background = params.background;

  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    fail(`OpenAI API ${resp.status}: ${text.slice(0, 500)}`, 'upstream_error');
  }

  const data = await resp.json();
  const first = (data && Array.isArray(data.data)) ? data.data[0] : null;
  if (!first || !first.b64_json) {
    fail('OpenAI response missing b64_json image data', 'upstream_error');
  }
  return Buffer.from(first.b64_json, 'base64');
}

async function uploadAndShare(bytes, userEmail) {
  // Defense-in-depth guard — main() checks WORKSPACE_BUCKET before the OpenAI
  // call, so this is only reachable if the function is called from a new path.
  if (!WORKSPACE_BUCKET) {
    fail('WORKSPACE_BUCKET env var not set — cannot upload generated image', 'misconfigured');
  }
  // Encode each path segment so emails with `+` (subaddressing) survive the
  // URL round-trip. randomUUID() returns RFC4122 hex with hyphens — already
  // URL-safe.
  const key = `${PUBLIC_PREFIX}/${userEmail}/${randomUUID()}.png`;
  const s3 = new S3Client({ region: REGION });

  await s3.send(new PutObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: key,
    Body: bytes,
    ContentType: 'image/png',
    Metadata: {
      generated_by: 'psd-image-gen',
      model: MODEL_ID,
    },
  }));

  // Path-style URL: avoids any DNS-vs-virtual-hosted-style ambiguity for
  // bucket names that contain dots. Path segments are URL-encoded so
  // emails with reserved characters (`+`, `/`, `&`) survive intact.
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = `https://${WORKSPACE_BUCKET}.s3.${REGION}.amazonaws.com/${encodedKey}`;
  return { url, key };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: generate.js --user <email> --prompt "<text>" [--image <path>] [--size auto|1024x1024|1024x1536|1536x1024] [--quality auto|low|medium|high] [--background auto|opaque|transparent]');
    process.exit(0);
  }
  if (!validateEmail(args.user)) {
    fail('--user is required and must be a valid email', 'bad_args');
  }
  if (!args.prompt || args.prompt === true) {
    fail('--prompt is required', 'bad_args');
  }
  // Cap prompt length to prevent sending excessively large payloads to OpenAI
  // and to give a clear client-side error instead of a raw upstream_error.
  if (args.prompt.length > 4000) {
    fail('--prompt must be 4000 characters or fewer', 'bad_args');
  }
  const size = args.size && args.size !== true ? String(args.size) : 'auto';
  const quality = args.quality && args.quality !== true ? String(args.quality) : 'auto';
  const background = args.background && args.background !== true ? String(args.background) : 'auto';

  if (!ALLOWED_SIZES.has(size)) {
    fail(`Invalid --size. Allowed: ${[...ALLOWED_SIZES].join(', ')}`, 'bad_args');
  }
  if (!ALLOWED_QUALITIES.has(quality)) {
    fail(`Invalid --quality. Allowed: ${[...ALLOWED_QUALITIES].join(', ')}`, 'bad_args');
  }
  if (!ALLOWED_BACKGROUNDS.has(background)) {
    fail(`Invalid --background. Allowed: ${[...ALLOWED_BACKGROUNDS].join(', ')}`, 'bad_args');
  }

  // Validate WORKSPACE_BUCKET early — before capability checks or OpenAI calls —
  // so we don't spend API quota only to fail on upload. (Review PR #934 feedback)
  if (!WORKSPACE_BUCKET) {
    fail('WORKSPACE_BUCKET env var not set — cannot upload generated image', 'misconfigured');
  }

  // --image is optional. When present it must be a real path (no `--image`
  // followed by another flag) and selects the /v1/images/edits endpoint so
  // the model composes the output around the reference image. Validate the
  // path up front — same tier as size/quality checks — so we fail fast
  // before the RBAC shell-out + API-key fetch.
  const imagePath = args.image && args.image !== true ? String(args.image) : null;
  // Load + validate the reference image up front so a bad path fails fast,
  // before the RBAC shell-out and API-key fetch.
  const referenceImage = imagePath ? loadReferenceImage(imagePath) : null;

  enforceCapability(args.user);
  const apiKey = readSharedOpenAIKey(args.user);
  const params = { prompt: args.prompt, size, quality, background };
  const bytes = referenceImage
    ? await editWithImage(apiKey, params, referenceImage.dataUrl)
    : await generateImage(apiKey, params);
  const { url, key } = await uploadAndShare(bytes, args.user);

  emit({
    url,
    s3Key: key,
    model: MODEL_ID,
    prompt: args.prompt,
    size,
    quality,
    background,
    mode: referenceImage ? 'edit' : 'generate',
    // The URL is unsigned and does not expire. Anyone with the link can fetch
    // until the object is deleted (manual lifecycle policy may be added later).
    sharing: 'public-by-link',
  });
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err), 'error');
});
