#!/usr/bin/env node
/**
 * list_catalog_categories.js — list Freshservice Service Catalog categories,
 * and optionally the items inside one.
 *
 * Usage:
 *   node list_catalog_categories.js --user <email>
 *   node list_catalog_categories.js --user <email> --category-id <id>
 *   node list_catalog_categories.js --user <email> --search "hotel"
 *
 * Every catalog item belongs to a category, and `create_catalog_item.js`
 * requires that category's numeric id. This is how you find it — and how you
 * check whether the item already exists before creating a duplicate.
 */

'use strict';

const { fail, emit, parseArgs, requireUser, getApiKey, fsFetch } =
  require('./lib/api');

function requireNumericId(value, flag) {
  if (!/^\d+$/.test(String(value))) {
    fail(`${flag} must be a numeric id`, 'bad_args');
  }
  return String(value);
}

// The broker's query grammar excludes "/" so a value cannot smuggle a path
// segment, and rejects anything outside a conservative charset. Fail here with
// a readable message rather than letting the broker return a bare rejection.
const SEARCH_TERM_RE = /^[A-Za-z0-9_.,:+@ -]{1,100}$/;

async function listItems(apiKey, args) {
  const query = new URLSearchParams();
  if (args.category_id && args.category_id !== true) {
    query.set('category_id', requireNumericId(args.category_id, '--category-id'));
  }
  if (args.search && args.search !== true) {
    const term = String(args.search);
    if (!SEARCH_TERM_RE.test(term)) {
      fail(
        '--search may contain only letters, digits, spaces and . , : + @ _ - ' +
          '(100 characters max)',
        'bad_args'
      );
    }
    query.set('search_term', term);
  }
  const suffix = query.toString();
  const result = await fsFetch(
    apiKey,
    `/service_catalog/items${suffix ? `?${suffix}` : ''}`
  );
  if (!result.__ok) fail(result.error, result.code || 'upstream_error');
  return result.data;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: list_catalog_categories.js --user <email>\n' +
        '       list_catalog_categories.js --user <email> --category-id <id>\n' +
        '       list_catalog_categories.js --user <email> --search "hotel"\n' +
        '\n' +
        'With no filter, lists the catalog CATEGORIES. With --category-id or\n' +
        '--search, lists the ITEMS matching that filter.'
    );
    process.exit(0);
  }
  const userEmail = requireUser(args);
  const apiKey = getApiKey(userEmail);

  const filtering =
    (args.category_id && args.category_id !== true) ||
    (args.search && args.search !== true);
  if (filtering) {
    emit(await listItems(apiKey, args));
    return;
  }

  const result = await fsFetch(apiKey, '/service_catalog/categories');
  if (!result.__ok) fail(result.error, result.code || 'upstream_error');
  emit(result.data);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
