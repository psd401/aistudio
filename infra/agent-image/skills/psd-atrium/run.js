#!/usr/bin/env node
/**
 * run.js — psd-atrium skill entrypoint (Issue #1055, Atrium agent access Path 2).
 *
 * Gives the agent VERSION-BASED read/write access to Atrium — PSD's collaborative
 * document + live-artifact workspace with an intranet publishing flow — over the
 * existing `/api/v1/content/*` REST surface, authenticated with a scoped `sk-`
 * content key. Reads return the last saved version; writes create a new version
 * (the honest external equivalent of an edit). The live collaborative rail
 * (comment/suggest, real-time Yjs) is session-only and NOT reachable here — see
 * SKILL.md.
 *
 * Usage:
 *   node run.js find [--kind document|artifact] [--collection <slug|id>]
 *                    [--tag <t>] [--status draft|published|archived] [--query <text>]
 *   node run.js read --id <idOrSlug>
 *   node run.js create-document --title <t> [--markdown <md>] [--collection <slug|id>]
 *                    [--tags a,b,c] [--visibility private|group|internal|public]
 *                    [--grants role:staff,building:GHS]
 *   node run.js create-artifact --title <t> --code <src> --body-format html|jsx
 *                    [--collection <slug|id>] [--tags a,b,c]
 *                    [--visibility <level>] [--grants ...]
 *   node run.js edit --id <id> --body <text> [--mode replace|append]
 *                    [--body-format markdown|html|jsx] [--summary <s>]
 *   node run.js set-visibility --id <id> --level private|group|internal|public
 *                    [--grants role:staff,building:GHS]
 *   node run.js publish --id <id> [--destination intranet|public_web|schoology|google|okf]
 *   node run.js unpublish --id <id> --destination intranet|public_web|schoology|google
 *
 * Exit codes:
 *   0   success (JSON result printed to stdout; incl. approval_required outcomes)
 *   1   usage / config error
 *   2   internal / unexpected
 *   11  unauthorized (content API key missing/invalid or lacks the scope)
 *   12  upstream content-API error (403/404/422/5xx) or network
 *   14  rate-limited
 */

'use strict';

const {
  fail,
  emit,
  parseArgs,
  parseList,
  parseGrants,
  restFetch,
} = require('./common');

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
      '',
      'Write (creates a new version; content starts private + draft):',
      '  create-document --title <t> [--markdown <md>] [--collection <slug|id>]',
      '                  [--tags a,b,c] [--visibility <level>] [--grants k:v,...]',
      '  create-artifact --title <t> --code <src> --body-format html|jsx',
      '                  [--collection <slug|id>] [--tags a,b,c]',
      '                  [--visibility <level>] [--grants k:v,...]',
      '  edit --id <id> --body <text> [--mode replace|append]',
      '       [--body-format markdown|html|jsx] [--summary <s>]',
      '  set-visibility --id <id> --level private|group|internal|public',
      '                 [--grants role:staff,building:GHS]',
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

async function main() {
  const subcommand = process.argv[2];
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    usage();
    process.exit(0);
  }

  // parseArgs reads flags starting at argv index 3 (after the subcommand); pass a
  // synthetic argv so its i=2 loop start aligns with the first flag.
  const args = parseArgs([process.argv[0], process.argv[1], ...process.argv.slice(3)]);
  if (args.help) {
    usage();
    process.exit(0);
  }

  switch (subcommand) {
    case 'find':
    case 'list': {
      const kind = optEnum(args, 'kind', 'kind', KINDS);
      const status = optEnum(args, 'status', 'status', STATUSES);
      const query = {
        kind,
        status,
        collection: optStr(args, 'collection', 'collection'),
        tag: optStr(args, 'tag', 'tag'),
        query: optStr(args, 'query', 'query'),
      };
      const { payload } = await restFetch('GET', '', { query });
      emit(payload);
      return;
    }

    case 'read': {
      const id = requireStr(args, 'id', 'id');
      const { payload } = await restFetch('GET', `/${encodeURIComponent(id)}`);
      // Surface the saved body inline when available. Only small ARTIFACTS carry
      // an inline body; DOCUMENT text lives in the collaborative store
      // (bodyLocation "proof") and large artifacts are offloaded to object storage
      // — neither is returned here. Say so plainly rather than implying the object
      // is empty.
      const version = payload && payload.version;
      const body = version && typeof version.bodyInline === 'string' ? version.bodyInline : null;
      let note;
      if (!version) {
        // A bodyless object (e.g. create-document with no --markdown) has no saved
        // version — don't claim "here is the saved body" for something empty.
        note =
          'This object has no saved version yet (it was created without a body). There is nothing to read back.';
      } else if (body === null) {
        note =
          'Body not returned inline: documents keep their text in the collaborative store (version.bodyLocation "proof"), and large artifacts are offloaded to object storage. This read shows the last SAVED version metadata only; the live editor state is not reachable here.';
      } else {
        note = 'Shows the last SAVED version body (not the live collaborative editor state).';
      }
      emit({ ...payload, body, bodyAvailableInline: body !== null, note });
      return;
    }

    case 'create-document': {
      const title = requireStr(args, 'title', 'title');
      const markdown = optStr(args, 'markdown', 'markdown');
      const visibility = buildVisibility(args);
      const body = {
        kind: 'document',
        title,
        collectionId: optStr(args, 'collection', 'collection'),
        body: markdown,
        bodyFormat: markdown !== undefined ? 'markdown' : undefined,
        visibility,
        tags: parseList(args.tags, 'tags'),
      };
      const { payload } = await restFetch('POST', '', { body });
      emitCreated(payload, visibility);
      return;
    }

    case 'create-artifact': {
      const title = requireStr(args, 'title', 'title');
      const code = requireStr(args, 'code', 'code');
      const bodyFormat = optEnum(args, 'body_format', 'body-format', ARTIFACT_FORMATS);
      if (!bodyFormat) fail('--body-format html|jsx is required for create-artifact');
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
      const { payload } = await restFetch('POST', '', { body });
      emitCreated(payload, visibility);
      return;
    }

    case 'edit': {
      const id = requireStr(args, 'id', 'id');
      const text = requireStr(args, 'body', 'body');
      const mode = optEnum(args, 'mode', 'mode', ['replace', 'append']) || 'replace';
      let bodyFormat = optEnum(args, 'body_format', 'body-format', BODY_FORMATS);
      const summary = optStr(args, 'summary', 'summary');

      let finalBody = text;
      if (mode === 'append') {
        // Version-based append = read the last saved body, concatenate, snapshot a
        // new version. Only possible when the current body is returned INLINE.
        const { payload: current } = await restFetch('GET', `/${encodeURIComponent(id)}`);
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
        finalBody = `${version.bodyInline}\n\n${text}`;
        if (!bodyFormat) bodyFormat = version.bodyFormat;
      }

      const { payload } = await restFetch('POST', `/${encodeURIComponent(id)}/versions`, {
        body: { body: finalBody, bodyFormat, summary },
      });
      emit({ ...payload, mode });
      return;
    }

    case 'set-visibility': {
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
      return;
    }

    case 'publish': {
      const id = requireStr(args, 'id', 'id');
      const destination =
        optEnum(args, 'destination', 'destination', PUBLISH_DESTINATIONS) || 'intranet';
      const { approvalRequired, payload } = await restFetch(
        'POST',
        `/${encodeURIComponent(id)}/publish`,
        { body: { destination } }
      );
      // approval_required is a SUCCESS outcome (exit 0). Surface message verbatim.
      emit(approvalRequired ? { ...payload, approvalRequired: true, destination } : payload);
      return;
    }

    case 'unpublish': {
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
      emit(approvalRequired ? { ...payload, approvalRequired: true, destination } : payload);
      return;
    }

    default:
      fail(`Unknown subcommand: ${subcommand}. Run with --help to see options.`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err), 2);
  });
}

module.exports = { main };
