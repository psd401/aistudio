'use strict';

const { validatedFs } = require("../../../validated-fs.cjs");

/**
 * Shared transport for the three media skills (#1738).
 *
 * Two hops, and the split matters:
 *
 *   1. BYTES go through the workspace-storage broker into the owner's own
 *      private prefix, under `.media-scratch/`.
 *   2. WORK is requested through the root-owned loopback relay, which injects
 *      the web-verified owner and workspace prefix and invokes the media
 *      Lambda. The skill never names an owner, a bucket or a function.
 *
 * Why `.media-scratch/` specifically. It is listed in
 * lib/agent-workspace/workspace-policy.json under `checkpointExclusions`, so it
 * is invisible to the workspace generation hash. That is not tidiness — an
 * ad-hoc upload into a checkpoint-MANAGED path is deleted by the next
 * `ensureWorkspaceCheckpoint`, which rolls the workspace back to its manifest
 * and delete-markers anything unexpected. Scratch objects would silently
 * vanish mid-turn. Being excluded also means they are never synced down into
 * the container, which is what we want: they are a transport, not history.
 */

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { requestAgentBroker } = require('./agent-broker');

const AWS_RELAY_HOST = '127.0.0.1';
const AWS_RELAY_PORT = 18791;
const AWS_RELAY_PATH = '/aws-skill/media/invoke';
const SCRATCH_PREFIX = '.media-scratch/';

// Mirrors the Lambda's own ceilings — see infra/agent-media/README.md. Checked
// here so an oversized file fails before it is uploaded rather than after.
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_RELAY_RESPONSE_BYTES = 8 * 1024 * 1024;
// The Lambda may spend 780s; the relay then needs its identity round-trip and
// transport margin on top. Matches the arithmetic in psd-hyperframes/render.js.
const RELAY_TIMEOUT_MS = 825_000;

function fail(message, code) {
  const error = new Error(message);
  error.code = code || 'media_failed';
  throw error;
}

/** One scratch path, in the excluded prefix, with the extension preserved. */
function scratchPath(extension) {
  const clean = String(extension || '').toLowerCase();
  if (clean && !/^\.[a-z0-9]{1,8}$/.test(clean)) {
    fail(`unsupported file extension: ${extension}`, 'bad_args');
  }
  return `${SCRATCH_PREFIX}${randomUUID()}${clean}`;
}

/**
 * Put a local file into the owner's private scratch prefix.
 *
 * Deliberately NOT generation-fenced: `complete-upload`'s generation argument is
 * optional, and a mid-turn skill upload must not participate in the turn's
 * finalization protocol. Because the target is checkpoint-excluded, an unfenced
 * write here cannot desync the workspace generation either way.
 */
async function uploadScratch(localPath) {
  let stat;
  try {
    stat = validatedFs.statSync(localPath);
  } catch (error) {
    fail(`cannot read ${localPath}: ${error.message}`, 'bad_args');
  }
  if (!stat.isFile()) fail(`${localPath} is not a file`, 'bad_args');
  if (stat.size === 0) fail(`${localPath} is empty`, 'bad_args');
  if (stat.size > MAX_UPLOAD_BYTES) {
    fail(
      `${localPath} is ${stat.size} bytes, over the ${MAX_UPLOAD_BYTES}-byte limit`,
      'too_large',
    );
  }

  const workspacePath = scratchPath(path.extname(localPath));
  const prepared = await requestAgentBroker('/api/agent/workspace-storage', {
    operation: 'upload',
    path: workspacePath,
    contentLength: stat.size,
    idempotencyKey: randomUUID(),
  });
  if (typeof prepared?.uploadUrl !== 'string' || typeof prepared?.reservationId !== 'string') {
    fail('workspace upload was not prepared');
  }

  const response = await fetch(prepared.uploadUrl, {
    method: 'PUT',
    headers: prepared.requiredHeaders || {},
    body: validatedFs.readFileSync(localPath),
    redirect: 'error',
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) fail(`workspace upload failed: HTTP ${response.status}`);

  await requestAgentBroker('/api/agent/workspace-storage', {
    operation: 'complete-upload',
    reservationId: prepared.reservationId,
  });
  return workspacePath;
}

/** Pull a scratch object back down to a local path. */
async function downloadScratch(workspacePath, localPath) {
  const prepared = await requestAgentBroker('/api/agent/workspace-storage', {
    operation: 'download',
    path: workspacePath,
  });
  if (typeof prepared?.downloadUrl !== 'string') {
    fail('workspace download was not prepared');
  }
  const response = await fetch(prepared.downloadUrl, {
    headers: prepared.requiredHeaders || {},
    redirect: 'error',
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) fail(`workspace download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  validatedFs.writeFileSync(localPath, bytes);
  return bytes.length;
}

/**
 * Remove a scratch object. Best-effort by contract: a retained scratch object
 * is untidy, never a failure, and must not turn a completed conversion into an
 * error the user sees.
 */
async function deleteScratch(workspacePath) {
  try {
    await requestAgentBroker('/api/agent/workspace-storage', {
      operation: 'delete',
      path: workspacePath,
    });
  } catch {
    /* the workspace lifecycle reaps it */
  }
}

/** Ask the root relay to run one media operation. */
function callMediaRelay(payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: AWS_RELAY_HOST,
        port: AWS_RELAY_PORT,
        path: AWS_RELAY_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: RELAY_TIMEOUT_MS,
      },
      (response) => {
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_RELAY_RESPONSE_BYTES) {
            request.destroy(new Error('media relay response exceeded the limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode !== 200) {
            reject(new Error(`media relay returned HTTP ${response.statusCode || 502}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error('media relay returned invalid JSON'));
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('media relay timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

/** Run one operation and surface a Lambda-reported error as a thrown Error. */
async function runMedia(payload) {
  const result = await callMediaRelay(payload);
  if (!result || typeof result !== 'object') fail('media relay returned no result');
  if (result.status !== 'ok') {
    const error = new Error(result.message || 'the media operation failed');
    error.code = result.error || 'media_failed';
    throw error;
  }
  return result;
}

module.exports = {
  runMedia,
  uploadScratch,
  downloadScratch,
  deleteScratch,
  scratchPath,
  SCRATCH_PREFIX,
  MAX_UPLOAD_BYTES,
};
