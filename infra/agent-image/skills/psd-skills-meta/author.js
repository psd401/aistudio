#!/usr/bin/env node
/**
 * author.js — skills.author
 * Usage: node author.js --user <email> --name <name> --summary <summary>
 *        --skill-md <base64-encoded SKILL.md> --files <JSON array of {path, content_base64}>
 *
 * Creates a skill draft in S3, registers it in the database, and triggers
 * the Skill Builder Lambda for automated scanning and promotion.
 */

'use strict';

const {
  fail,
  validateEnv,
  validateUserEmail,
  parseArgs,
  emit,
  authorSkill,
} = require('./common');

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: author.js --user <email> --name <name> --summary <summary> ' +
      '--skill-md <base64> --files <json>'
    );
    process.exit(0);
  }
  validateEnv();
  validateUserEmail(args.user);

  if (!args.name) fail('--name is required (skill name)');
  if (!args.summary) fail('--summary is required (one-line summary for catalog)');
  if (!args.skill_md) fail('--skill-md is required (base64-encoded SKILL.md content)');

  // Decode SKILL.md
  let skillMdContent;
  try {
    skillMdContent = Buffer.from(args.skill_md, 'base64').toString('utf-8');
  } catch {
    fail('--skill-md must be valid base64');
  }

  // Validate SKILL.md frontmatter
  if (!skillMdContent.startsWith('---')) {
    fail('SKILL.md must start with YAML frontmatter (---)');
  }
  const fmEnd = skillMdContent.indexOf('---', 3);
  if (fmEnd === -1) {
    fail('SKILL.md frontmatter not closed (missing second ---)');
  }
  const fm = skillMdContent.slice(3, fmEnd);
  if (!fm.includes('name:')) {
    fail('SKILL.md frontmatter missing required "name" field');
  }
  if (!fm.includes('summary:')) {
    fail('SKILL.md frontmatter missing required "summary" field');
  }

  // Parse additional files
  let files = [];
  if (args.files) {
    try {
      files = JSON.parse(args.files);
      if (!Array.isArray(files)) {
        fail('--files must be a JSON array of {path, content_base64} objects');
      }
    } catch {
      fail('--files must be valid JSON');
    }
  }

  // Validate file entries
  for (const file of files) {
    if (!file.path || !file.content_base64) {
      fail('Each file entry must have "path" and "content_base64" fields');
    }
    // Security: prevent path traversal
    if (file.path.includes('..') || file.path.startsWith('/')) {
      fail(`Invalid file path: "${file.path}" — no traversal or absolute paths allowed`);
    }
  }

  try {
    const skillId = await authorSkill(
      args.name,
      args.summary,
      skillMdContent,
      files,
      args.user,
    );

    emit({
      skillId,
      name: args.name,
      status: 'draft_submitted',
      message: `Skill "${args.name}" has been submitted as a draft. ` +
        'The automated scanner is running. If the scan is clean, the skill ' +
        'will be auto-promoted and available in your next session. If flagged, ' +
        'it will appear in the admin review queue.',
    });
  } catch (err) {
    fail(`Failed to author skill: ${err.message}`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
