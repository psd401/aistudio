#!/usr/bin/env node

/**
 * run.js — psd-atrium skill entrypoint (Issue #1055, Atrium agent access Path 2).
 *
 * Gives the agent VERSION-BASED read/write access to Atrium — PSD's collaborative
 * document + live-artifact workspace with an intranet publishing flow — over the
 * owner-bound `/api/agent/atrium` broker. The broker resolves the signed request
 * owner to a Content Requester and calls the shared content services directly;
 * no reusable content key enters the workspace. Reads return the last saved
 * version; writes create a new version (the honest external equivalent of an
 * edit). The live collaborative rail
 * (comment/suggest, real-time Yjs) is session-only and NOT reachable here — see
 * SKILL.md.
 *
 * Usage:
 *   node run.js find [--kind document|artifact] [--collection <slug|id>]
 *                    [--tag <t>] [--status draft|published|archived] [--query <text>]
 *   node run.js read --id <idOrSlug>
 *   node run.js read-source --id <idOrSlug>
 *   node run.js list-assets --id <idOrSlug>
 *   node run.js upload-asset --id <id> --file <path> [--alt <text>]
 *                    [--filename <name>] [--purpose document_image|capture_step]
 *   node run.js get-asset --id <id> --asset-id <assetId> --out <path>
 *   node run.js create-document --title <t> [--markdown <md> | --markdown-file <path>]
 *                    [--collection <slug|id>]
 *                    [--tags a,b,c] [--visibility private|group|internal|public]
 *                    [--grants role:staff,building:GHS]
 *   node run.js create-artifact --title <t> (--code <src> | --code-file <path>)
 *                    --body-format html|jsx [--collection <slug|id>] [--tags a,b,c]
 *                    [--visibility <level>] [--grants ...]
 *   node run.js edit --id <id> (--body <text> | --body-file <path>) [--mode replace|append]
 *                    [--body-format markdown|html|jsx] [--summary <s>]
 *   node run.js archive --id <id>
 *   node run.js delete --id <id>
 *   node run.js set-visibility --id <id> --level private|group|internal|public
 *                    [--grants role:staff,building:GHS]
 *
 * Artifact code is HTML/JS/CSS (including <script>/<style>) and is FULLY
 * supported: run.js base64-encodes every write body automatically (codeEncoding:
 * "base64") so the code is opaque to the edge WAF and decoded server-side before
 * screening. Pass raw code — do not escape or strip tags.
 *   node run.js publish --id <id> [--destination intranet|public_web|schoology|google|okf]
 *   node run.js unpublish --id <id> --destination intranet|public_web|schoology|google
 *
 * Exit codes:
 *   0   success (JSON result printed to stdout; incl. approval_required outcomes)
 *   1   usage / config error
 *   2   internal / unexpected
 *   11  unauthorized (signed owner authority is unavailable)
 *   12  upstream content-API error (403/404/422/5xx) or network
 *   14  rate-limited
 */

'use strict';
const { validatedFs } = require("../../../validated-fs.cjs");




const path = require('node:path');

const common = require('./common');
const {
  fail,
  emit,
  parseArgs,
  parseList,
  parseGrants,
  restFetch,
  withEncodedBody,
  sha256Base64Url,
  detectImageContentType,
} = common;

const ASSET_PURPOSES = ['document_image', 'capture_step'];
/** Server ceiling for a single asset (20 MiB) — refuse locally with a clear
 *  message rather than burning a round trip on a guaranteed 400. */
const ASSET_MAX_BYTES = 20 * 1024 * 1024;

const KINDS = ['document', 'artifact'];
const STATUSES = ['draft', 'published', 'archived'];
const LEVELS = ['private', 'group', 'internal', 'public'];
const BODY_FORMATS = ['markdown', 'html', 'jsx'];
const ARTIFACT_FORMATS = ['html', 'jsx'];
const PUBLISH_DESTINATIONS = ['intranet', 'public_web', 'schoology', 'google', 'okf'];
const UNPUBLISH_DESTINATIONS = ['intranet', 'public_web', 'schoology', 'google'];

function usage() {
  process.stdout.write(
    [
      'Usage: node run.js <subcommand> [...]',
      '',
      'Read (version-based — returns the last SAVED version):',
      '  find [--kind document|artifact] [--collection <slug|id>] [--tag <t>]',
      '       [--status draft|published|archived] [--query <title text>]',
      '  read --id <idOrSlug>',
      "  read-source --id <idOrSlug>   (a DOCUMENT's committed body TEXT — `read` never returns it)",
      '  list-assets --id <idOrSlug>',
      '',
      'Images (authored assets — the canonical way to put a picture in a document):',
      '  upload-asset --id <id> --file <png|jpeg|webp> [--alt <text>] [--filename <name>]',
      '                [--purpose document_image|capture_step]',
      '  get-asset --id <id> --asset-id <assetId> --out <path>',
      '',
      'Write (creates a new version; content starts private + draft):',
      '  create-document --title <t> [--markdown <md> | --markdown-file <path>]',
      '                  [--collection <slug|id>] [--tags a,b,c] [--visibility <level>]',
      '                  [--grants k:v,...]',
      '  create-artifact --title <t> (--code <src> | --code-file <path>)',
      '                  --body-format html|jsx [--collection <slug|id>] [--tags a,b,c]',
      '                  [--visibility <level>] [--grants k:v,...]',
      '  edit --id <id> (--body <text> | --body-file <path>) [--mode replace|append]',
      '       [--body-format markdown|html|jsx] [--summary <s>]',
      '  archive --id <id>   (soft-remove: status -> archived, stays findable)',
      '  delete  --id <id>   (HARD delete: permanent; owner/admin only; refused',
      '                       while published — unpublish everywhere first)',
      '  set-visibility --id <id> --level private|group|internal|public',
      '                 [--grants role:staff,building:GHS]',
      '',
      'Artifact code (HTML/JS/CSS, incl. <script>/<style>) is fully supported and',
      'sent base64-encoded automatically — you pass raw code, nothing to escape.',
      '',
      'Use --markdown-file / --body-file / --code-file for a LARGE document: an',
      'oversized argv fails the spawn with E2BIG (128 KiB), well below the 4 MiB',
      'the broker itself accepts.',
      '',
      'Publish (§26.4 — a public destination you may not publish directly returns',
      'a queued-for-approval result; relay its message verbatim):',
      '  publish --id <id> [--destination intranet|public_web|schoology|google|okf]',
      '  unpublish --id <id> --destination intranet|public_web|schoology|google',
      '',
    ].join('\n')
  );
}

/** Require a string flag; fail (exit 1) with a clear message when absent/boolean. */
function requireStr(args, name, label) {
  const v = args[name];
  if (v === undefined || v === true || v === '') {
    fail(`--${label} is required`);
  }
  return v;
}

/** Validate an optional enum flag; returns the value or undefined. */
function optEnum(args, name, label, allowed) {
  const v = args[name];
  if (v === undefined) return undefined;
  if (v === true) fail(`--${label} requires a value`);
  if (!allowed.includes(v)) {
    fail(`--${label} must be one of: ${allowed.join(', ')}`);
  }
  return v;
}

/** Validate an optional STRING flag; returns the string or undefined. A value-less
 *  flag (parseArgs yields `true`) is a usage error, not a silently dropped value. */
function optStr(args, name, label) {
  const v = args[name];
  if (v === undefined) return undefined;
  if (v === true) fail(`--${label} requires a value`);
  return v;
}

/**
 * Read a body either inline (`--markdown`/`--body`) or from a file
 * (`--markdown-file`/`--body-file`), rejecting the ambiguous combination.
 *
 * The file form is not a convenience — it is the only way to pass a LARGE
 * document. A whole SOP (or any long converted PDF) can exceed Linux's
 * per-argument limit (MAX_ARG_STRLEN, 128 KiB), and an oversized argv fails the
 * spawn with E2BIG before this process even starts, well below the broker's
 * 4 MiB request ceiling. `create-artifact` already had `--code-file` for exactly
 * this reason; documents need the same escape hatch.
 */
function readInlineOrFile(args, inlineKey, inlineLabel, fileKey, fileLabel) {
  const filePath = optStr(args, fileKey, fileLabel);
  if (filePath !== undefined && args[inlineKey] !== undefined) {
    fail(`pass either --${inlineLabel} or --${fileLabel}, not both`);
  }
  if (filePath === undefined) return optStr(args, inlineKey, inlineLabel);
  try {
    return validatedFs.readFileSync(filePath, 'utf8');
  } catch (err) {
    fail(`--${fileLabel} not readable: ${err.message}`);
  }
}

/** Build the { level, grants? } visibility object from --visibility/--grants. */
function buildVisibility(args) {
  const level = optEnum(args, 'visibility', 'visibility', LEVELS);
  if (level === undefined) return undefined;
  const grants = parseGrants(args.grants, 'grants');
  return grants ? { level, grants } : { level };
}

/**
 * Emit a create result, flagging the §26.4 "create-as-private" downgrade. Unlike
 * publish/set-visibility/unpublish (which return a real 202 approval signal), an
 * unauthorized PUBLIC create is silently created PRIVATE and a widen request is
 * queued server-side with NO field on the response. Compare requested vs. returned
 * level and synthesize the signal so the agent relays "widen pending", not "public".
 */
function emitCreated(payload, requestedVisibility) {
  const requested = requestedVisibility && requestedVisibility.level;
  if (
    requested &&
    payload &&
    typeof payload.visibilityLevel === 'string' &&
    payload.visibilityLevel !== requested
  ) {
    emit({
      ...payload,
      requestedVisibilityLevel: requested,
      approvalRequired: true,
      visibilityNote:
        `Requested visibility "${requested}" was not applied — the object was created ` +
        `"${payload.visibilityLevel}". A public create you may not perform directly is ` +
        `created PRIVATE and a widen-to-public request is queued for admin approval ` +
        `(§26.4). Tell the user the widen is pending approval — do NOT report it as public.`,
    });
    return;
  }
  emit(payload);
}

async function findObjects(args) {
  const query = {
    kind: optEnum(args, 'kind', 'kind', KINDS),
    status: optEnum(args, 'status', 'status', STATUSES),
    collection: optStr(args, 'collection', 'collection'),
    tag: optStr(args, 'tag', 'tag'),
    query: optStr(args, 'query', 'query'),
  };
  const { payload } = await restFetch('GET', '', { query });
  emit(payload);
}

async function readObject(args) {
  const id = requireStr(args, 'id', 'id');
  const { payload } = await restFetch('GET', `/${encodeURIComponent(id)}`);
  const version = payload && payload.version;
  const body =
    version && typeof version.bodyInline === 'string'
      ? version.bodyInline
      : null;
  let note;
  if (!version) {
    note =
      'This object has no saved version yet (it was created without a body). There is nothing to read back.';
  } else if (body === null) {
    note =
      'Body not returned inline: documents keep their text in the collaborative store (version.bodyLocation "proof"), and large artifacts are offloaded to object storage. This read shows the last SAVED version metadata only; the live editor state is not reachable here.';
  } else {
    note =
      'Shows the last SAVED version body (not the live collaborative editor state).';
  }
  emit({ ...payload, body, bodyAvailableInline: body !== null, note });
}

async function readSource(args) {
  // The ONLY way to get a DOCUMENT's body text. `read` returns metadata
  // with bodyLocation "proof" because the live text lives in the
  // collaborative store; this alias returns the last COMMITTED source.
  const id = requireStr(args, 'id', 'id');
  const { payload } = await restFetch('GET', `/${encodeURIComponent(id)}/source`);
  emit({
    ...payload,
    note:
      'Committed source of the last saved version. A document open in the live editor may be AHEAD of this until someone snapshots a version.',
  });
}

async function listAssets(args) {
  const id = requireStr(args, 'id', 'id');
  const { payload } = await restFetch('GET', `/${encodeURIComponent(id)}/assets`);
  emit(payload);
}

async function uploadAsset(args) {
  // Three server round trips: reserve → PUT bytes straight to the presigned
  // S3 URL → complete (which verifies the checksum, re-decodes the image,
  // strips metadata, and flips the asset to `ready`). Only a `ready` asset
  // may be referenced by a version directive.
  const id = requireStr(args, 'id', 'id');
  const file = requireStr(args, 'file', 'file');
  const alt = optStr(args, 'alt', 'alt') || '';
  const purpose =
    optEnum(args, 'purpose', 'purpose', ASSET_PURPOSES) || 'document_image';

  let bytes;
  try {
    bytes = validatedFs.readFileSync(file);
  } catch (err) {
    fail(`--file not readable: ${err.message}`);
  }
  if (bytes.length === 0) fail('--file is empty');
  if (bytes.length > ASSET_MAX_BYTES) {
    fail(
      `--file is ${bytes.length} bytes; Atrium assets are capped at ${ASSET_MAX_BYTES} bytes`
    );
  }
  const contentType = detectImageContentType(bytes);
  if (!contentType) {
    fail(
      '--file is not a PNG, JPEG, or WebP image (checked by magic bytes, not by filename)'
    );
  }
  const sha256 = sha256Base64Url(bytes);
  const filename = optStr(args, 'filename', 'filename') || path.basename(file);

  const { payload: reserved } = await restFetch(
    'POST',
    `/${encodeURIComponent(id)}/assets`,
    {
      body: {
        filename,
        contentType,
        byteLength: bytes.length,
        sha256,
        purpose,
      },
    }
  );
  const upload = reserved && reserved.upload;
  if (!upload || typeof upload.url !== 'string') {
    fail('AI Studio did not return an asset upload URL', 12);
  }
  await common._internals.putPresignedBytes(
    upload.url,
    upload.headers || { 'content-type': contentType },
    bytes
  );
  const { payload: completed } = await restFetch(
    'POST',
    `/${encodeURIComponent(id)}/assets/${encodeURIComponent(reserved.id)}/complete`,
    { body: { sha256 } }
  );
  // `embedRef` from the server carries the FILENAME as alt text. Rebuild the
  // directive with the caller's alt when one was given, so a screenshot
  // lands in the document with real alternative text instead of "diagram.png".
  // Quotes would break out of the alt="…" attribute; braces would end the
  // {...} directive early and truncate round-trip parsing downstream.
  const directive = alt
    ? `::atrium-asset{id="${completed.id}" alt="${alt.replace(/"/g, "'").replace(/[{}]/g, ' ').trim()}"}`
    : completed.embedRef;
  emit({
    ...completed,
    directive,
    note:
      'Embed `directive` on its OWN LINE in a document version to place this image. The asset belongs to THIS object — another object cannot reference it.',
  });
}

async function getAsset(args) {
  // Copy an image OUT of an object (assets are per-object, so re-embedding
  // one somewhere else means downloading and re-uploading it).
  const id = requireStr(args, 'id', 'id');
  const assetId = requireStr(args, 'asset_id', 'asset-id');
  const out = requireStr(args, 'out', 'out');
  const { payload } = await restFetch(
    'GET',
    `/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}/bytes`
  );
  if (!payload || typeof payload.data !== 'string') {
    fail('AI Studio returned no asset bytes', 12);
  }
  const bytes = Buffer.from(payload.data, 'base64');
  if (bytes.length === 0) fail('AI Studio returned an empty asset', 12);
  // Verify the decoded bytes really are one of the three image types this
  // surface can hold before writing anything to disk. Atrium normalizes and
  // re-encodes every asset on completion, so a mismatch means the response
  // is not what it claims to be — and refusing here keeps this command from
  // ever writing arbitrary response bytes to a caller-named path.
  if (!detectImageContentType(bytes)) {
    fail(
      'AI Studio returned bytes that are not a PNG, JPEG, or WebP image; refusing to write them',
      12
    );
  }
  try {
    validatedFs.writeFileSync(out, bytes);
  } catch (err) {
    fail(`--out not writable: ${err.message}`);
  }
  emit({
    id: payload.id,
    objectId: payload.objectId,
    filename: payload.filename,
    contentType: payload.contentType,
    byteLength: bytes.length,
    path: out,
  });
}

async function createDocument(args) {
  const markdown = readInlineOrFile(
    args,
    'markdown',
    'markdown',
    'markdown_file',
    'markdown-file'
  );
  const visibility = buildVisibility(args);
  const body = {
    kind: 'document',
    title: requireStr(args, 'title', 'title'),
    collectionId: optStr(args, 'collection', 'collection'),
    body: markdown,
    bodyFormat: markdown !== undefined ? 'markdown' : undefined,
    visibility,
    tags: parseList(args.tags, 'tags'),
  };
  const { payload } = await restFetch('POST', '', {
    body: withEncodedBody(body),
  });
  emitCreated(payload, visibility);
}

function readArtifactCode(args) {
  const codeFile = optStr(args, 'code_file', 'code-file');
  if (codeFile === undefined) return requireStr(args, 'code', 'code');
  if (args.code !== undefined) {
    fail('pass either --code or --code-file, not both');
  }
  let code;
  try {
    code = validatedFs.readFileSync(codeFile, 'utf8');
  } catch (err) {
    fail(`--code-file not readable: ${err.message}`);
    return undefined;
  }
  if (!code) fail('--code-file is empty');
  return code;
}

async function createArtifact(args) {
  const title = requireStr(args, 'title', 'title');
  const code = readArtifactCode(args);
  const bodyFormat = optEnum(
    args,
    'body_format',
    'body-format',
    ARTIFACT_FORMATS
  );
  if (!bodyFormat) {
    fail('--body-format html|jsx is required for create-artifact');
  }
  const visibility = buildVisibility(args);
  const body = {
    kind: 'artifact',
    title,
    collectionId: optStr(args, 'collection', 'collection'),
    body: code,
    bodyFormat,
    visibility,
    tags: parseList(args.tags, 'tags'),
  };
  const { payload } = await restFetch('POST', '', {
    body: withEncodedBody(body),
  });
  emitCreated(payload, visibility);
}

async function appendToBody(id, text, bodyFormat) {
  const { payload: current } = await restFetch(
    'GET',
    `/${encodeURIComponent(id)}`
  );
  const version = current && current.version;
  if (!version) {
    fail(
      'append: object has no current version to append to — use edit ' +
        '--mode replace or create-document instead.'
    );
  }
  if (typeof version.bodyInline !== 'string') {
    fail(
      'append: the current body is stored externally (version.bodyLocation) ' +
        'and cannot be read inline — use edit --mode replace --body <full text>.'
    );
  }
  return {
    body: `${version.bodyInline}\n\n${text}`,
    bodyFormat: bodyFormat || version.bodyFormat,
  };
}

async function editObject(args) {
  const id = requireStr(args, 'id', 'id');
  const text = readInlineOrFile(args, 'body', 'body', 'body_file', 'body-file');
  if (text === undefined || text === '') fail('--body or --body-file is required');
  const mode = optEnum(args, 'mode', 'mode', ['replace', 'append']) || 'replace';
  const requestedFormat = optEnum(
    args,
    'body_format',
    'body-format',
    BODY_FORMATS
  );
  const edit =
    mode === 'append'
      ? await appendToBody(id, text, requestedFormat)
      : { body: text, bodyFormat: requestedFormat };
  const { payload } = await restFetch(
    'POST',
    `/${encodeURIComponent(id)}/versions`,
    {
      body: withEncodedBody({
        ...edit,
        summary: optStr(args, 'summary', 'summary'),
      }),
    }
  );
  emit({ ...payload, mode });
}

async function archiveObject(args) {
  const id = requireStr(args, 'id', 'id');
  const { payload } = await restFetch('PATCH', `/${encodeURIComponent(id)}`, {
    body: { status: 'archived' },
  });
  emit({ ...payload, archived: true });
}

async function deleteObject(args) {
  const id = requireStr(args, 'id', 'id');
  const { payload } = await restFetch('DELETE', `/${encodeURIComponent(id)}`);
  emit({ ...payload, deleted: true });
}

async function setVisibility(args) {
  const id = requireStr(args, 'id', 'id');
  const level = optEnum(args, 'level', 'level', LEVELS);
  if (!level) fail('--level private|group|internal|public is required');
  const grants = parseGrants(args.grants, 'grants');
  const { approvalRequired, payload } = await restFetch(
    'PATCH',
    `/${encodeURIComponent(id)}/visibility`,
    { body: grants ? { level, grants } : { level } }
  );
  emit(approvalRequired ? { ...payload, approvalRequired: true } : payload);
}

async function publishObject(args) {
  const id = requireStr(args, 'id', 'id');
  const destination =
    optEnum(args, 'destination', 'destination', PUBLISH_DESTINATIONS) ||
    'intranet';
  const { approvalRequired, payload } = await restFetch(
    'POST',
    `/${encodeURIComponent(id)}/publish`,
    { body: { destination } }
  );
  emit(
    approvalRequired
      ? { ...payload, approvalRequired: true, destination }
      : payload
  );
}

async function unpublishObject(args) {
  const id = requireStr(args, 'id', 'id');
  const destination = optEnum(
    args,
    'destination',
    'destination',
    UNPUBLISH_DESTINATIONS
  );
  if (!destination) {
    fail('--destination intranet|public_web|schoology|google is required');
  }
  const { approvalRequired, payload } = await restFetch(
    'DELETE',
    `/${encodeURIComponent(id)}/publish/${encodeURIComponent(destination)}`
  );
  emit(
    approvalRequired
      ? { ...payload, approvalRequired: true, destination }
      : payload
  );
}

const COMMANDS = {
  find: findObjects,
  list: findObjects,
  read: readObject,
  'read-source': readSource,
  'list-assets': listAssets,
  'upload-asset': uploadAsset,
  'get-asset': getAsset,
  'create-document': createDocument,
  'create-artifact': createArtifact,
  edit: editObject,
  archive: archiveObject,
  delete: deleteObject,
  'set-visibility': setVisibility,
  publish: publishObject,
  unpublish: unpublishObject,
};

async function main() {
  const subcommand = process.argv[2];
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    usage();
    process.exit(0);
  }
  const args = parseArgs(process.argv, 3);
  if (args.help) {
    usage();
    process.exit(0);
  }
  const command = COMMANDS[subcommand];
  if (!command) {
    fail(`Unknown subcommand: ${subcommand}. Run with --help to see options.`);
  }
  await command(args);
}

if (require.main === module) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err), 2);
  });
}

module.exports = { main };
