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
const path = require('node:path');

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const REGION = process.env.AWS_REGION || 'us-east-1';
const WORKSPACE_BUCKET = process.env.WORKSPACE_BUCKET || '';
const PRESIGN_TTL_SECONDS = 3600;
// Pinned to a dated snapshot for reproducibility. OpenAI may deprecate this
// specific version without notice — if the skill starts returning upstream_error,
// update to the latest `gpt-image-2-YYYY-MM-DD` version (or the unversioned
// `gpt-image-2` alias if reproducibility is no longer a concern). Also update
// SKILL.md when changing this value.
const MODEL_ID = 'gpt-image-2-2026-04-21';
const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);
const ALLOWED_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
const ALLOWED_BACKGROUNDS = new Set(['opaque', 'transparent', 'auto']);

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
 * `tools`/`role_tools`/`user_roles` tables via psd-credentials and
 * refuses invocation if the caller lacks the grant. Database errors
 * are treated as denials.
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

async function uploadAndPresign(bytes, userEmail) {
  // Defense-in-depth guard — main() checks WORKSPACE_BUCKET before the OpenAI
  // call, so this is only reachable if the function is called from a new path.
  if (!WORKSPACE_BUCKET) {
    fail('WORKSPACE_BUCKET env var not set — cannot upload generated image', 'misconfigured');
  }
  const key = `images/${userEmail}/${randomUUID()}.png`;
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

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: WORKSPACE_BUCKET, Key: key }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );

  const expiresAt = new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString();
  return { url, key, expiresAt };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: generate.js --user <email> --prompt "<text>" [--size auto|1024x1024|1024x1536|1536x1024] [--quality auto|low|medium|high] [--background auto|opaque|transparent]');
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

  enforceCapability(args.user);
  const apiKey = readSharedOpenAIKey(args.user);
  const bytes = await generateImage(apiKey, { prompt: args.prompt, size, quality, background });
  const { url, key, expiresAt } = await uploadAndPresign(bytes, args.user);

  emit({
    url,
    s3Key: key,
    model: MODEL_ID,
    prompt: args.prompt,
    size,
    quality,
    background,
    expiresAt,
  });
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err), 'error');
});
