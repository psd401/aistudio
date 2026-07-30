#!/usr/bin/env node
/**
 * load.js — skills.load
 * Usage: node load.js --name <skill-name>
 *
 * Loads a skill's full SKILL.md content and outputs it, making the skill
 * available for the current session. Image-bundled skills resolve from the
 * read-only /opt catalog; user-authored skills resolve through the broker.
 */

'use strict';

const path = require('node:path');
const { validatedFs } = require('../../../validated-fs.cjs');
const {
  fail,
  rejectAuthorityArgs,
  parseArgs,
  emit,
  skillBroker,
  validateSafeName,
} = require('./common');

const SKILLS_DIR = process.env.PSD_SKILLS_DIR || '/opt/psd-skills';

function readBundledSkill(name) {
  const skillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
  try {
    return validatedFs.readFileSync(skillPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: load.js --name <skill-name>');
    process.exit(0);
  }
  rejectAuthorityArgs(args);

  if (!args.name) {
    fail('--name is required (skill name to load)');
  }
  validateSafeName(args.name, 'skill name');

  try {
    const bundledSkillMd = readBundledSkill(args.name);
    if (bundledSkillMd !== null) {
      emit({ name: args.name, skillMd: bundledSkillMd });
      return;
    }

    const skill = await skillBroker('load', { name: args.name });

    if (!skill) {
      emit({
        error: 'not_found',
        message: `Skill "${args.name}" not found in the catalog or not accessible. ` +
          'Use skills.search to find available skills.',
      });
      process.exit(0);
    }

    emit(skill);
  } catch (err) {
    fail(`Failed to load skill: ${err.message}`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
