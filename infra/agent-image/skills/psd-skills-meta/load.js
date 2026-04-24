#!/usr/bin/env node
/**
 * load.js — skills.load
 * Usage: node load.js --user <email> --name <skill-name>
 *
 * Loads a skill's full SKILL.md content from S3 and outputs it,
 * making the skill available for the current session.
 */

'use strict';

const {
  fail,
  validateEnv,
  validateUserEmail,
  parseArgs,
  emit,
  loadSkillMd,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: load.js --user <email> --name <skill-name>');
    process.exit(0);
  }
  validateEnv();
  validateUserEmail(args.user);

  if (!args.name) {
    fail('--name is required (skill name to load)');
  }

  try {
    const content = await loadSkillMd(args.name, args.user);

    if (!content) {
      emit({
        error: 'not_found',
        message: `Skill "${args.name}" not found in the catalog or not accessible. ` +
          'Use skills.search to find available skills.',
      });
      process.exit(0);
    }

    emit({ name: args.name, skillMd: content });
  } catch (err) {
    fail(`Failed to load skill: ${err.message}`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
