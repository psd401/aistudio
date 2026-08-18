/**
 * quartile-growth-report SKILL.md contract tests.
 *
 * Run: bun test skill-frontmatter.test.js
 *
 * Beyond the usual registration checks, these guard the thing that nearly
 * shipped broken: the skill shells out to a python script under
 * /opt/agentcore-venv, but `allowed-tools` once granted only `Bash(node:*)`
 * and the documented command used a bare `python3` with a relative path.
 * Nothing in CI covered this skill's frontmatter, so nothing would have caught
 * it — the script is correct and well tested, and the report would simply
 * never have been runnable in production.
 */

'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Every path here is a test-local literal joined against __dirname. Nothing in
 * this file reads a caller- or model-supplied path.
 */

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
    const body = read('SKILL.md');
    // No bare `python3 …` — it neither matches the grant nor resolves, since
    // the agent's cwd is its workspace, not the skill directory.
    expect(body).not.toMatch(/(^|[^/\w])python3\s+scripts\//m);
    // Shell continuations first: the documented command wraps across lines,
    // and checking them separately would demand the interpreter on the line
    // that only carries the script path.
    const commands = body.replace(/\\\n\s*/g, ' ').split('\n');
    for (const line of commands) {
      // Only INVOCATIONS. Prose references scripts in backticks
      // (`gen_sql.py`) and should not be forced to carry a full path.
      if (!line.includes('.py') || line.includes('`')) continue;
      expect(line).toContain(VENV_PYTHON);
      expect(line).toContain('/opt/psd-skills/quartile-growth-report/');
    }
  });

  test('the norms asset the PR columns depend on is bundled', () => {
    const csv = path.join(__dirname, 'references', 'dibels8_norms_2021-22.csv');
    expect(fs.existsSync(csv)).toBe(true);
    // Header + 10,674 data rows, as validated.
    expect(fs.readFileSync(csv, 'utf8').trim().split('\n')).toHaveLength(10675);
    // The per-grade SQL fragments gen_sql.py actually embeds are compressed
    // from that CSV. Without them there is no PR column at all, and the agent
    // cannot derive a percentile — so their absence must fail here, loudly,
    // rather than at 3am in a principal's spreadsheet.
    for (let grade = 0; grade <= 5; grade += 1) {
      const fragment = path.join(__dirname, 'references', 'norms',
        `norms_sql_g${grade}.txt`);
      expect(fs.existsSync(fragment)).toBe(true);
      expect(fs.readFileSync(fragment, 'utf8')).toContain(
        'norms(meas0, per, cut, pr) AS (VALUES');
    }
  });

  test('the skill does not tell the agent to author SQL', () => {
    // The 40 queries are R&A's, byte-compared in test_gen_sql.py. A skill that
    // invites the agent to write its own is how the previous version spent a
    // week guessing column names against a live warehouse.
    const body = read('SKILL.md');
    expect(body).toContain('Do not write SQL');
    expect(body).toContain('Do not rewrite these queries');
  });
});
