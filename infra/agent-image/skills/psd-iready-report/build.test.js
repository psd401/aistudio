/**
 * psd-iready-report build.js + SKILL.md registration tests.
 *
 * Run: bun test infra/agent-image/skills/psd-iready-report/build.test.js
 *
 * All data here is synthetic. Never commit a real student row (FERPA).
 */

'use strict';

const { test, expect, describe } = require('bun:test');
const { validatedFs } = require('../../../validated-fs.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { expandLevel, renderReport, subRows } = require('./build.js');

const BUILD = path.join(__dirname, 'build.js');
// validated-fs allows reads under the cwd, temp and /opt. In the image the logo is
// under /opt/psd-skills; in the repo it is only reachable from the repo root.
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

function fixture() {
  return {
    fallYear: '2099',
    schoolYearName: '2099-00',
    grade: 3,
    generated: 'Jan 1, 2099',
    student: { id: '900001', firstName: 'Test', lastName: 'Student', ssid: '9999999999', school: 'Sample Elementary' },
    math: {
      diagnostic: {
        overall_score: 410, overall_level: 'Early On Grade Level', percentile: 55, quantile_score: 450,
        time_on_task: 38, typical_growth_measure: 0, typical_growth_goal: 21, stretch_growth_measure: 0, stretch_growth_goal: 40,
      },
      subtests: [
        { assessment_group: 'Geom', score: 420, level: 'Mid or Abo', met_standard: 'True', assessment_date: '2099-09-15T00:00:00' },
        { assessment_group: 'AlgThink', score: 400, level: 'Two Grade ', met_standard: false, assessment_date: '2099-09-15T00:00:00' },
      ],
    },
    reading: {
      diagnostic: {
        overall_score: 500, overall_level: 'Mid or Above Grade Level', percentile: 70, lexile_score: 600,
        time_on_task: 41, typical_growth_measure: null, typical_growth_goal: 18, stretch_growth_measure: null, stretch_growth_goal: 33,
      },
      subtests: [
        { assessment_group: 'Phonics', score: 510, level: 'Three or M', met_standard: 'false', assessment_date: '2099-09-16' },
      ],
    },
  };
}

function frontmatter() {
  const raw = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
  const block = raw.match(/^---\n([\s\S]*?)\n---/);
  expect(block).not.toBeNull();
  const fields = {};
  for (const line of block[1].split('\n')) {
    const field = line.match(/^(name|summary|description|allowed-tools):\s*(.*)$/);
    if (field) fields[field[1]] = field[2].trim();
  }
  return fields;
}

describe('expandLevel', () => {
  test('expands the 10-character truncations, including the trailing-space ones', () => {
    expect(expandLevel('Two Grade ')).toBe('Two Grade Levels Below');
    expect(expandLevel('One Grade ')).toBe('One Grade Level Below');
    expect(expandLevel('Three or M')).toBe('Three or More Grade Levels Below');
    expect(expandLevel('Early On G')).toBe('Early On Grade Level');
    expect(expandLevel('Mid or Abo')).toBe('Mid or Above Grade Level');
  });

  test('passes untruncated and empty values through', () => {
    expect(expandLevel('Mid or Above Grade Level')).toBe('Mid or Above Grade Level');
    expect(expandLevel(null)).toBe('');
  });
});

describe('subRows', () => {
  test('orders by domain, labels the Level row, and reads met_standard variants', () => {
    const html = subRows('math', [
      { assessment_group: 'Unknown', score: 1, level: '', met_standard: 0 },
      { assessment_group: 'Level', score: 2, level: '', met_standard: 1 },
      { assessment_group: 'AlgThink', score: 3, level: '', met_standard: 'True' },
    ]);
    const alg = html.indexOf('Algebra &amp; Algebraic Thinking');
    const level = html.indexOf('Math Level');
    const unknown = html.indexOf('Unknown');
    expect(alg).toBeGreaterThan(-1);
    expect(alg).toBeLessThan(level);
    expect(level).toBeLessThan(unknown);
    expect(html.match(/class="yes">Yes/g)).toHaveLength(2);
  });
});

describe('renderReport', () => {
  test('renders both subjects with expanded levels and the FERPA footer', () => {
    const html = renderReport(fixture(), 'AAAA');
    expect(html).toContain('i-Ready Fall 2099 Diagnostic Report');
    expect(html).toContain('Math Diagnostic');
    expect(html).toContain('Reading Diagnostic');
    expect(html).toContain('Two Grade Levels Below');
    expect(html).toContain('Three or More Grade Levels Below');
    expect(html).toContain('Confidential student record (FERPA)');
    expect(html).toContain('Math tested:</b> 2099-09-15');
    expect(html).toContain('data:image/png;base64,AAAA');
  });

  test('says a subject is missing instead of throwing', () => {
    const data = fixture();
    data.reading = { diagnostic: null, subtests: [] };
    const html = renderReport(data, 'AAAA');
    expect(html).toContain('No Fall diagnostic on record for this window.');
    expect(html).toContain('Reading tested:</b> —');
  });

  test('escapes HTML in warehouse values', () => {
    const data = fixture();
    data.student.lastName = '<script>x</script>';
    expect(renderReport(data, 'AAAA')).not.toContain('<script>x');
  });
});

describe('CLI', () => {
  // The agent runs build.js under node, whose JSON.parse errors quote the input
  // (Bun's do not), so the CLI must be exercised with node for the FERPA test.
  const run = (...args) => spawnSync('node', [BUILD, ...args], { encoding: 'utf8', cwd: REPO_ROOT });

  test('writes the HTML with the bundled logo embedded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iready-'));
    const data = path.join(dir, 'data.json');
    const out = path.join(dir, 'out.html');
    validatedFs.writeFileSync(data, JSON.stringify(fixture()));
    const result = run('--data', data, '--out', out);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).out).toBe(out);
    expect(validatedFs.readFileSync(out, 'utf8')).toMatch(/data:image\/png;base64,iVBOR/);
  });

  test('refuses a data file with neither subject', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iready-'));
    const data = path.join(dir, 'data.json');
    validatedFs.writeFileSync(data, JSON.stringify({ ...fixture(), math: { diagnostic: null }, reading: { diagnostic: null } }));
    const result = run('--data', data, '--out', path.join(dir, 'out.html'));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('bad_args');
  });

  test('never echoes the data file contents on malformed JSON (FERPA)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iready-'));
    const data = path.join(dir, 'data.json');
    // An unquoted name: V8 quotes the ~10 characters around the bad token,
    // i.e. `..."lastName":Pupil}" is not valid JSON`.
    validatedFs.writeFileSync(data, '{"student":{"lastName":Pupil}}');
    const result = run('--data', data, '--out', path.join(dir, 'out.html'));
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('Pupil');
  });

  test('refuses a JSON null data file with the intended message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iready-'));
    const data = path.join(dir, 'data.json');
    validatedFs.writeFileSync(data, 'null');
    const result = run('--data', data, '--out', path.join(dir, 'out.html'));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('neither a math nor a reading');
  });

  test('rejects a flag without a value', () => {
    expect(run('--data').status).toBe(1);
  });
});

describe('SKILL.md registration', () => {
  test('name matches the folder and every deploy-parsed field is present', () => {
    const fields = frontmatter();
    expect(fields.name).toBe(path.basename(__dirname));
    expect(fields.summary.length).toBeGreaterThan(0);
    expect(fields.description.length).toBeGreaterThan(0);
    expect(fields['allowed-tools']).toBe('Bash(node:*)');
    expect(fields.summary).not.toContain(': ');
  });

  test('summary carries the i-Ready report search terms', () => {
    const summary = frontmatter().summary.toLowerCase();
    for (const phrase of ['i-ready', 'fall', 'pdf', 'student']) expect(summary).toContain(phrase);
  });

  test('delivers privately and never publicly', () => {
    const body = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
    expect(body).toMatch(/Never use\s+`--to public`/);
    expect(body).not.toMatch(/publish\.js[^\n]*--to public/);
  });
});
