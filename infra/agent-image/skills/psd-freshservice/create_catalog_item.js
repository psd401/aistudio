#!/usr/bin/env node
/**
 * create_catalog_item.js — create a Freshservice Service Catalog item.
 *
 * Usage:
 *   node create_catalog_item.js --user <email> --data '<json>'
 *
 * Required JSON fields: name, category_id (from list_catalog_categories.js).
 * Common optional fields: description, short_description, delivery_time,
 * cost_visibility, visibility, group_visibility, item_type, custom_fields.
 *
 * WHY THIS EXISTS. A caller asked the agent to build a "Student Travel — Hotel
 * Reservations" catalog item with custom required fields on 2026-08-31. The
 * skill covered tickets, notes and approvals only, so the agent searched the
 * catalog, found nothing, and offered to open a plain ticket instead — which
 * was not what was asked for and did not create the thing.
 *
 * AUTHORIZATION. This skill uses each caller's OWN Freshservice API key, so
 * this call runs with that person's Freshservice role. Creating catalog items
 * is a catalog-admin action; most agents do not have it. A 403 here therefore
 * means "your Freshservice account lacks catalog-admin", NOT "your key is
 * bad" — the message below says so explicitly, because telling users to
 * re-issue a working key is exactly what the generic 403 wording caused before
 * (four callers, 2026-08-17).
 *
 * KNOWN LIMIT. The request is sent as JSON. Freshservice documents this
 * endpoint as multipart/form-data because it also accepts an icon and file
 * attachments; those are NOT supported here — the owner-bound broker sends
 * JSON only, deliberately, so no file bytes from the model runtime are ever
 * signed with a user's credential. Create the item's fields here and attach an
 * icon in the Freshservice UI. If the upstream rejects the JSON body, the raw
 * upstream error is surfaced verbatim rather than reinterpreted.
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch, parseJsonArg } =
  require('./lib/api');

// Fields the agent may set. An allowlist for the same reason create_ticket.js
// has one: Freshservice accepts fields the agent has no business controlling,
// and a pass-through body would hand the model whatever the API version adds
// next.
const ALLOWED_FIELDS = new Set([
  'name',
  'category_id',
  'description',
  'short_description',
  'delivery_time',
  'cost_visibility',
  'cost',
  'visibility',
  'group_visibility',
  'agent_group_visibility',
  'item_type',
  'ci_type_id',
  'product_id',
  'quantity',
  'botified',
  // The custom required fields a real catalog item is mostly made of. Passed
  // through as a nested object; Freshservice validates their shape.
  'custom_fields',
]);

function validated(data) {
  if (!data.name || typeof data.name !== 'string') {
    fail('Required field: name (the catalog item title)', 'bad_args');
  }
  if (!Number.isInteger(data.category_id) || data.category_id <= 0) {
    fail(
      'Required field: category_id (a positive integer). Run ' +
        'list_catalog_categories.js --user <email> to find it.',
      'bad_args'
    );
  }
  if (
    data.custom_fields !== undefined &&
    (typeof data.custom_fields !== 'object' ||
      data.custom_fields === null ||
      Array.isArray(data.custom_fields))
  ) {
    fail('custom_fields must be a JSON object', 'bad_args');
  }
  const filtered = Object.create(null);
  const rejected = [];
  for (const key of Object.keys(data)) {
    if (ALLOWED_FIELDS.has(key)) {
      filtered[key] = data[key];
    } else {
      rejected.push(key);
    }
  }
  // Named, not silently dropped: a caller who passed a field that vanished
  // would otherwise get an item that quietly lacks it.
  if (rejected.length > 0) {
    fail(
      `These fields are not settable from the agent: ${rejected.join(', ')}. ` +
        `Settable fields are: ${[...ALLOWED_FIELDS].join(', ')}.`,
      'bad_args'
    );
  }
  return filtered;
}

// A 403 on this endpoint is a ROLE problem, not a credential problem. Say which.
function failForbidden(result) {
  fail(
    'Freshservice refused this catalog write (403). Creating Service Catalog ' +
      'items requires catalog-admin rights, and this skill acts as YOU — so ' +
      'this means your own Freshservice role does not include catalog ' +
      'administration. Your stored API key is fine and does NOT need to be ' +
      're-issued. Ask a Freshservice admin to grant catalog-admin, or to ' +
      `create the item for you. Upstream detail: ${result.error}`,
    'catalog_admin_required'
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: create_catalog_item.js --user <email> --data \'{"name":"...","category_id":N}\'\n' +
        '\n' +
        'Find category_id with: list_catalog_categories.js --user <email>\n' +
        `Settable fields: ${[...ALLOWED_FIELDS].join(', ')}`
    );
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const data = parseJsonArg(args.data, '--data');
  const filtered = validated(data);

  const apiKey = getApiKey(userEmail);
  const result = await fsFetch(apiKey, '/service_catalog_items', {
    method: 'POST',
    body: JSON.stringify(filtered),
  });
  if (!result.__ok) {
    if (result.status === 403) failForbidden(result);
    fail(result.error, result.code || 'upstream_error');
  }
  emit(result.data);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
