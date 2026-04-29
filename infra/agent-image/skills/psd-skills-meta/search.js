#!/usr/bin/env node
/**
 * search.js — skills.search
 * Usage: node search.js --user <email> --query <search term>
 *
 * Searches the skill catalog by name or summary keyword.
 * Returns name + summary only (no full SKILL.md content).
 */

'use strict';

const {
  fail,
  validateEnv,
  validateUserEmail,
  parseArgs,
  emit,
  searchSkills,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: search.js --user <email> --query <search term>');
    process.exit(0);
  }
  validateEnv();
  validateUserEmail(args.user);

  if (!args.query) {
    fail('--query is required (search term)');
  }

  try {
    const results = await searchSkills(args.query, args.user);
    emit({ skills: results, count: results.length });
  } catch (err) {
    fail(`Search failed: ${err.message}`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
