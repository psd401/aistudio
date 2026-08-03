'use strict';

const { test, expect, describe } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const skill = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
const soul = fs.readFileSync(path.join(__dirname, '..', '..', 'SOUL.md'), 'utf8');

describe('psd-data discovery routing', () => {
  test('advertises PowerSchool, SIS, enrollment, and morning-brief data', () => {
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatter).not.toBeNull();
    const searchable = frontmatter[1].toLowerCase();
    for (const phrase of ['powerschool', 'sis', 'enrollment', 'morning-brief']) {
      expect(searchable).toContain(phrase);
    }
  });

  test('requires detailed discovery before an unavailable conclusion', () => {
    expect(skill).toContain('PowerSchool and SIS data lives here');
    expect(skill).toContain('tables --detailed');
    expect(skill).toContain('Discover before declaring data unavailable');
    expect(skill).toContain('Never assume generic column names');
  });

  test('does not treat a missing daily note as proof of schedule failure', () => {
    expect(skill).toContain('does not prove that a morning brief');
    expect(skill).toContain('delivery with missing daily-log persistence');
    expect(soul).toContain('absent daily memory entry alone does not prove a scheduled run failed');
  });

  test('fused routing points PowerSchool requests to psd-data', () => {
    expect(soul).toContain('PowerSchool and other SIS-backed student data');
    expect(soul).toContain('load that skill and discover its current tables');
  });
});
