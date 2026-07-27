#!/usr/bin/env node
/**
 * author.js — skills.author
 * Usage: node author.js --name <name> --summary <summary>
 *        --skill-md <base64-encoded SKILL.md> --files <JSON array of {path, content_base64}>
 *
 * Creates a skill draft in S3, registers it in the database, and triggers
 * the Skill Builder Lambda for automated scanning and promotion.
 */

'use strict';

const {
  fail,
  rejectAuthorityArgs,
  parseArgs,
  emit,
  skillBroker,
} = require('./common');

function validateAuthorArgs(args) {
  if (!args.name) fail('--name is required (skill name)');
  if (!args.summary) fail('--summary is required (one-line summary for catalog)');
  if (!args.skill_md) {
    fail('--skill-md is required (base64-encoded SKILL.md content)');
  }
  if (/^psd-/i.test(args.name)) {
    fail(
      `Skill name "${args.name}" uses the reserved "psd-" prefix. ` +
      'User-authored skills must start with the caller\'s username ' +
      '(e.g. "hagelk-weekly-digest"). The "psd-" prefix is reserved ' +
      'for system-provided skills bundled into /opt/psd-skills/.'
    );
  }
}

function decodeSkillMarkdown(encoded) {
  let content;
  try {
    content = Buffer.from(encoded, 'base64').toString('utf-8');
  } catch {
    fail('--skill-md must be valid base64');
  }
  if (!content.startsWith('---')) {
    fail('SKILL.md must start with YAML frontmatter (---)');
  }
  const fmEnd = content.indexOf('---', 3);
  if (fmEnd === -1) {
    fail('SKILL.md frontmatter not closed (missing second ---)');
  }
  const frontmatter = content.slice(3, fmEnd);
  if (!frontmatter.includes('name:')) {
    fail('SKILL.md frontmatter missing required "name" field');
  }
  if (!frontmatter.includes('summary:')) {
    fail('SKILL.md frontmatter missing required "summary" field');
  }
  return content;
}

function parseFiles(rawFiles) {
  if (!rawFiles) return [];
  try {
    const files = JSON.parse(rawFiles);
    if (!Array.isArray(files)) {
      fail('--files must be a JSON array of {path, content_base64} objects');
    }
    return files;
  } catch {
    fail('--files must be valid JSON');
  }
}

function validateFiles(files) {
  const path = require('node:path');
  const fakeRoot = '/safe-skill-root';
  for (const file of files) {
    if (!file.path || !file.content_base64) {
      fail('Each file entry must have "path" and "content_base64" fields');
    }
    if (file.path.includes('..') || file.path.startsWith('/')) {
      fail(`Invalid file path: "${file.path}" — no traversal or absolute paths allowed`);
    }
    const resolved = path.resolve(fakeRoot, file.path);
    if (!resolved.startsWith(fakeRoot + path.sep) && resolved !== fakeRoot) {
      fail(`Invalid file path: "${file.path}" — resolves outside skill directory`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: author.js --name <name> --summary <summary> ' +
      '--skill-md <base64> --files <json>'
    );
    process.exit(0);
  }
  rejectAuthorityArgs(args);
  validateAuthorArgs(args);
  const skillMdContent = decodeSkillMarkdown(args.skill_md);
  const files = parseFiles(args.files);
  validateFiles(files);

  try {
    const result = await skillBroker('author', {
      name: args.name,
      summary: args.summary,
      skillMdBase64: Buffer.from(skillMdContent, 'utf8').toString('base64'),
      files,
    });

    emit({
      skillId: result.skillId,
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
