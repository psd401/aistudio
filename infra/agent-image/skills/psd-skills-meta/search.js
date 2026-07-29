#!/usr/bin/env node
/**
 * search.js — skills.search
 * Usage: node search.js --query <search term>
 *
 * Searches the skill catalog by name or summary keyword.
 * Returns name + summary only (no full SKILL.md content).
 */

'use strict';

const {
  fail,
  rejectAuthorityArgs,
  parseArgs,
  emit,
  skillBroker,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: search.js --query <search term>');
    process.exit(0);
  }
  rejectAuthorityArgs(args);

  if (!args.query) {
    fail('--query is required (search term)');
  }

  try {
    emit(await skillBroker('search', { query: args.query }));
  } catch (err) {
    fail(`Search failed: ${err.message}`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
