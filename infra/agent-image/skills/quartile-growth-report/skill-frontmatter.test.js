/**
 * quartile-growth-report SKILL.md contract tests.
 *
 * Run: bun test skill-frontmatter.test.js
 *
 * Beyond the usual registration checks, these guard the thing that nearly
 * shipped broken: the skill's national-percentile workflow shells out to
 * scripts/norms_values.py, but `allowed-tools` granted only `Bash(node:*)` and
 * the documented command used a bare `python3` with a relative path. Nothing in
 * CI covered this skill's frontmatter, so nothing would have caught it — the
 * script is correct and well tested, and the PR columns would simply never have
 * been generatable in production.
 */

'use strict';

const { test, expect, describe } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const VENV_PYTHON = '/opt/agentcore-venv/bin/python3';

function read(file) {
  return fs.readFileSync(path.join(__dirname, file), 'utf8');
}

function frontmatter() {
  const raw = read('SKILL.md');
  const block = raw.match(/^---\n([\s\S]*?)\n---/);
  expect(block).not.toBeNull();
  const fields = {};
  for (const line of block[1].split('\n')) {
    const match = line.match(/^([a-z-]+):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}

describe('quartile-growth-report frontmatter', () => {
  test('declares name, summary and description', () => {
    const fm = frontmatter();
    expect(fm.name).toBe('quartile-growth-report');
    expect(fm.summary.length).toBeGreaterThan(0);
    expect(fm.description.length).toBeGreaterThan(0);
  });

  test('summary is a single parseable line', () => {
    const summaryLines = read('SKILL.md')
      .split('\n')
      .filter((line) => line.startsWith('summary:'));
    expect(summaryLines).toHaveLength(1);
  });

  test('description carries the trigger phrases a principal would use', () => {
    const description = frontmatter().description.toLowerCase();
    expect(description).toContain('quartile');
    expect(description).toContain('growth');
  });

  test('allowed-tools grants the interpreter the skill actually shells out to', () => {
    // The grant is prefix-matched, so `Bash(node:*)` alone would refuse every
    // norms_values.py invocation and silently cost the report its PR columns.
    expect(frontmatter()['allowed-tools']).toContain(VENV_PYTHON);
  });

  test('every documented python invocation uses the absolute interpreter and script path', () => {
    for (const file of ['SKILL.md', 'references/sql.md']) {
      const body = read(file);
      // No bare `python3 …` — it neither matches the grant nor resolves, since
      // the agent's cwd is its workspace, not the skill directory.
      expect(body).not.toMatch(/(^|[^/\w])python3\s+scripts\//m);
      for (const line of body.split('\n')) {
        // Only INVOCATIONS. Prose references the script in backticks
        // (`norms_values.py`) and should not be forced to carry a full path.
        if (!line.includes('norms_values.py') || line.includes('`')) continue;
        expect(line).toContain(VENV_PYTHON);
        expect(line).toContain('/opt/psd-skills/quartile-growth-report/');
      }
    }
  });

  test('the norms asset the PR columns depend on is bundled', () => {
    const csv = path.join(__dirname, 'references', 'dibels8_norms_2021-22.csv');
    expect(fs.existsSync(csv)).toBe(true);
    // Header + 10,674 data rows, as validated.
    expect(fs.readFileSync(csv, 'utf8').trim().split('\n')).toHaveLength(10675);
  });
});
