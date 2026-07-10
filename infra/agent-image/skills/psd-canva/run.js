#!/usr/bin/env node
/**
 * psd-canva — act on the caller's OWN Canva account via Canva's Connect REST
 * API, authenticated per-user with an OAuth refresh token.
 *
 * Usage:
 *   node run.js --user <email> <subcommand> [flags]
 *
 * Subcommands (Canva Connect REST):
 *   whoami                                  (the connected Canva user's profile)
 *   list-designs  [--query kw] [--ownership any|owned|shared]
 *                 [--sort-by relevance|modified_descending|modified_ascending|
 *                            title_ascending|title_descending] [--continuation tok]
 *   create-design [--title T]
 *                 (--design-type doc|whiteboard|presentation  OR  --width N --height N)
 *   export        --design-id <id> --format pdf|png [--pages 1,2,3]
 *   upload-asset  --file <local-path> [--name N]
 *
 * Exit codes: 0 ok · 1 usage · 10 needs-auth · 12 canva/upstream error · 14 rate-limited.
 *
 * Notes:
 *  - The refresh token is single-use and rotates on every call; the skill
 *    writes the rotated token back to Secrets Manager before making any API
 *    call. Run one turn at a time per user to avoid double-spending the grant.
 *  - Paid-gated PNG options (transparent background, custom resize) are Pro+
 *    and are NOT requested — the district is on Canva for Education. `export`
 *    degrades to a plain render; a plan error surfaces as a canva-error.
 */

'use strict';

const {
  fail, emit, validateUserEmail, parseArgs, authorizeUser,
  canvaFetch, startAndPollJob, pollJob, failFromCanvaError, emitNeedsAuthAndExit,
} = require('./common');

/**
 * Resolve an access token, run `fn(accessToken)`, and normalize failures:
 * a mid-call 401 → needs-auth (the stored grant was revoked between refresh
 * and use); anything else → structured canva-error / rate-limited.
 */
async function withAuth(userEmail, tool, fn) {
  const accessToken = await authorizeUser(userEmail);
  try {
    return await fn(accessToken);
  } catch (err) {
    if (err && err.code === 'unauthorized') {
      await emitNeedsAuthAndExit(userEmail, 'Canva rejected the access token mid-request (401)');
    }
    failFromCanvaError(err, tool);
  }
}

function ok(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const sub = args._[0];

  if (args.help || !sub) {
    process.stdout.write(
      'Usage: run.js --user <email> <whoami|list-designs|create-design|export|upload-asset> [flags]\n'
    );
    process.exit(sub ? 0 : 1);
  }

  const userEmail = args.user;
  validateUserEmail(userEmail);

  switch (sub) {
    case 'whoami': {
      const result = await withAuth(userEmail, 'whoami', async (token) => {
        // /v1/users/me needs no scope; /v1/users/me/profile (display_name)
        // needs profile:read — enrich when available, never fail whoami on
        // the profile call alone (scope may have been narrowed on refresh).
        const me = await canvaFetch(token, 'GET', '/v1/users/me');
        try {
          const profile = await canvaFetch(token, 'GET', '/v1/users/me/profile');
          return { ...me, ...profile };
        } catch {
          return me;
        }
      });
      ok(result);
      break;
    }

    case 'list-designs': {
      const query = {};
      if (args.query && args.query !== true) query.query = args.query;
      if (args.ownership && args.ownership !== true) query.ownership = args.ownership;
      if (args.sort_by && args.sort_by !== true) query.sort_by = args.sort_by;
      if (args.continuation && args.continuation !== true) query.continuation = args.continuation;
      const result = await withAuth(userEmail, 'list-designs', (token) =>
        canvaFetch(token, 'GET', '/v1/designs', { query }));
      ok(result);
      break;
    }

    case 'create-design': {
      // POST /v1/designs requires the top-level "type" discriminator alongside
      // design_type/asset_id; at least one of the two must be set.
      const body = { type: 'type_and_asset' };
      if (args.title && args.title !== true) body.title = args.title;
      if (args.asset_id && args.asset_id !== true) body.asset_id = String(args.asset_id);
      const preset = args.design_type;
      const width = args.width && args.width !== true ? Number(args.width) : null;
      const height = args.height && args.height !== true ? Number(args.height) : null;
      if (preset && preset !== true) {
        body.design_type = { type: 'preset', name: preset };
      } else if (width && height && !Number.isNaN(width) && !Number.isNaN(height)) {
        body.design_type = { type: 'custom', width, height };
      } else if (!body.asset_id) {
        fail('create-design requires --design-type <doc|whiteboard|presentation>, --width N --height N, or --asset-id <id>');
      }
      const result = await withAuth(userEmail, 'create-design', (token) =>
        canvaFetch(token, 'POST', '/v1/designs', { body }));
      ok(result);
      break;
    }

    case 'export': {
      if (!args.design_id || args.design_id === true) fail('export requires --design-id <id>');
      const format = (args.format && args.format !== true ? String(args.format) : '').toLowerCase();
      if (format !== 'pdf' && format !== 'png') fail('export requires --format pdf|png');
      const body = { design_id: args.design_id, format: { type: format } };
      if (args.pages && args.pages !== true) {
        const pages = String(args.pages).split(',').map((p) => Number(p.trim())).filter((n) => Number.isInteger(n) && n > 0);
        // A supplied-but-unusable page list must fail loudly — silently
        // dropping it would export ALL pages against the caller's intent.
        if (!pages.length) fail('export --pages must be a comma-separated list of positive page numbers (e.g. 1,2,3)');
        // "pages" lives INSIDE the format object, not at the body top level.
        body.format.pages = pages;
      }
      const job = await withAuth(userEmail, 'export', (token) =>
        startAndPollJob(token, '/v1/exports', '/v1/exports', body));
      ok(job);
      break;
    }

    case 'upload-asset': {
      if (!args.file || args.file === true) fail('upload-asset requires --file <local-path>');
      const fs = require('node:fs');
      const path = require('node:path');
      let bytes;
      try { bytes = fs.readFileSync(args.file); }
      catch (err) { fail(`cannot read --file "${args.file}": ${err.message}`); }
      const name = args.name && args.name !== true ? String(args.name) : path.basename(String(args.file));
      // Canva asset upload: RAW BINARY body + Asset-Upload-Metadata header
      // (name_base64), NOT a JSON url-based upload. Returns an async job.
      const meta = JSON.stringify({ name_base64: Buffer.from(name, 'utf8').toString('base64') });
      const job = await withAuth(userEmail, 'upload-asset', async (token) => {
        const start = await canvaFetch(token, 'POST', '/v1/asset-uploads', {
          rawBody: bytes,
          headers: { 'Content-Type': 'application/octet-stream', 'Asset-Upload-Metadata': meta },
        });
        const j = start && start.job;
        if (!j || !j.id) {
          throw Object.assign(new Error('Canva asset-upload response missing job.id'), { code: 'bad_job', status: 502 });
        }
        if (j.status === 'success') return j;
        return pollJob(token, '/v1/asset-uploads', j.id);
      });
      ok(job);
      break;
    }

    default:
      fail(`Unknown subcommand "${sub}". Try: whoami, list-designs, create-design, export, upload-asset.`);
  }
}

if (require.main === module) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}

module.exports = { main };
