'use strict';

const { test, expect, describe } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const skillPath = path.join(__dirname, 'SKILL.md');
const referencePath = path.join(__dirname, 'references', 'strategic-plan.md');

function readSkill() {
  return fs.readFileSync(skillPath, 'utf8');
}

function parseFrontmatter() {
  const frontmatter = readSkill().match(/^---\n([\s\S]*?)\n---/);
  expect(frontmatter).not.toBeNull();
  const fields = { name: '', summary: '', description: '' };
  for (const line of frontmatter[1].split('\n')) {
    const field = line.match(/^(name|summary|description):\s*(.*)$/);
    if (field) fields[field[1]] = field[2].trim();
  }
  return fields;
}

describe('PSD Strategic Plan skill registration', () => {
  test('uses discoverable, single-line frontmatter fields', () => {
    const fields = parseFrontmatter();
    expect(fields.name).toBe('psd-strategic-plan');
    expect(fields.name).toBe(path.basename(__dirname));
    expect(fields.summary.length).toBeGreaterThan(0);
    expect(fields.description.length).toBeGreaterThan(0);

    const frontmatter = readSkill().match(/^---\n([\s\S]*?)\n---/)[1];
    for (const name of ['name', 'summary', 'description']) {
      expect(
        frontmatter.split('\n').filter((line) => line.startsWith(`${name}:`))
      ).toHaveLength(1);
    }
  });

  for (const phrase of [
    'strategic plan',
    'mission',
    'vision',
    'academic excellence',
    'innovation',
    'fiscal responsibility',
    'learning environment',
    'community partnership',
    '2026-2030',
  ]) {
    test(`summary exposes "${phrase}" to skills.search`, () => {
      expect(parseFrontmatter().summary.toLowerCase()).toContain(phrase);
    });
  }
});

describe('PSD Strategic Plan reference', () => {
  test('bundles every published value and goal', () => {
    const reference = fs.readFileSync(referencePath, 'utf8').toLowerCase();
    for (const phrase of [
      'excellence',
      'character',
      'confidence',
      'culture',
      'curiosity',
      'academic excellence',
      'innovation',
      'fiscal responsibility',
      'learning environment',
      'community partnership & engagement',
    ]) {
      expect(reference).toContain(phrase);
    }
  });

  test('pins live knowledge to repository 166 with snapshot fallback', () => {
    const skill = readSkill();
    const reference = fs.readFileSync(referencePath, 'utf8');
    for (const text of [skill, reference]) {
      expect(text).toContain('https://aistudio.psd401.ai/repositories/166');
    }
    expect(skill).toContain('--repository-id 166');
    expect(skill).toContain('--repository-ids 166');
    expect(reference).toContain('repository takes precedence');
    expect(skill).not.toContain('Structuring This Skill');
    expect(reference).toContain('Search repository 166 first');
  });
});
