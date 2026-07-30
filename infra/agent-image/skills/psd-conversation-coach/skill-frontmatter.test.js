/**
 * psd-conversation-coach SKILL.md registration tests.
 *
 * Run: bun test skill-frontmatter.test.js
 *
 * skills.search matches name and summary only. The deploy-parsed fields use
 * the same line-oriented regexes as agent-platform-stack.ts so a valid-looking
 * YAML edit cannot silently break registration or discoverability. The tool
 * grant is checked separately against the skill's declared frontmatter.
 */

'use strict';

const { test, expect, describe } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

function readSkill() {
  return fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
}

function parseFrontmatterAsStackDoes() {
  const raw = readSkill();
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
  expect(frontmatter).not.toBeNull();

  const fields = { name: '', summary: '', description: '' };
  for (const line of frontmatter[1].split('\n')) {
    const field = line.match(/^(name|summary|description):\s*(.*)$/);
    if (!field) continue;
    fields[field[1]] = field[2].trim();
  }
  return fields;
}

function registeredSummary(fields) {
  return fields.summary || `Bundled skill: ${fields.name}`;
}

describe('SKILL.md registration frontmatter', () => {
  test('declares fields parsed by the deploy-time registration path', () => {
    const fields = parseFrontmatterAsStackDoes();
    expect(fields.name).toBe('psd-conversation-coach');
    expect(fields.name).toBe(path.basename(__dirname));
    expect(fields.summary.length).toBeGreaterThan(0);
    expect(fields.description.length).toBeGreaterThan(0);
  });

  test('registers a real summary, not the fallback placeholder', () => {
    const fields = parseFrontmatterAsStackDoes();
    expect(registeredSummary(fields)).not.toBe(
      'Bundled skill: psd-conversation-coach'
    );
  });

  test('keeps each deploy-parsed field on exactly one physical line', () => {
    const frontmatter = readSkill().match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatter).not.toBeNull();

    for (const name of ['name', 'summary', 'description']) {
      const lines = frontmatter[1]
        .split('\n')
        .filter((line) => line.startsWith(`${name}:`));
      expect(lines).toHaveLength(1);
    }

    const summaryLine = frontmatter[1]
      .split('\n')
      .find((line) => line.startsWith('summary:'));
    expect(summaryLine.slice('summary:'.length)).not.toContain(': ');
  });

  test('declares the only tool the knowledge skill needs', () => {
    expect(readSkill()).toContain('allowed-tools: Read');
  });
});

describe('skills.search discoverability', () => {
  const requiredPhrases = [
    'crucial conversation',
    'difficult conversation',
    'practice',
    'role-play',
  ];

  for (const phrase of requiredPhrases) {
    test(`summary contains "${phrase}"`, () => {
      const searchableSummary = parseFrontmatterAsStackDoes().summary.toLowerCase();
      expect(searchableSummary).toContain(phrase);
    });
  }
});
