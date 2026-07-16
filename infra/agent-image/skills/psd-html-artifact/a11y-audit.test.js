'use strict';
/**
 * Unit tests for the shared WCAG 2.2 AA accessibility gate (Issue #1245).
 *
 * Proves the gate BLOCKS a deliberately-inaccessible fixture on critical/serious
 * axe-core violations and PASSES an accessible one — the property that makes
 * "every delivered HTML artifact is accessible" enforceable rather than
 * best-effort. Also exercises `deliver.js --audit-only` end-to-end so the CLI
 * exit contract (0 pass / 3 blocked) is guaranteed for callers.
 *
 * Run: cd infra/agent-image/skills/psd-html-artifact && bun test
 */

const { test, expect } = require('bun:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { auditHtml } = require('./a11y-audit');

// Missing lang, no <main>, unlabeled image, empty button, unlabeled input —
// each is a WCAG A/AA failure axe scores critical or serious.
const INACCESSIBLE = [
  '<!doctype html><html><head><title>x</title></head><body>',
  '<img src="a.png">',
  '<button></button>',
  '<input type="text">',
  '</body></html>',
].join('');

const ACCESSIBLE = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Accessible page</title></head>',
  '<body><main><h1>Heading</h1><p>Readable content.</p>',
  '<img src="a.png" alt="a descriptive alt">',
  '<button type="button">Press me</button>',
  '<label>Your name <input type="text"></label>',
  '</main></body></html>',
].join('');

test('auditHtml BLOCKS an inaccessible page on critical/serious violations', async () => {
  const report = await auditHtml(INACCESSIBLE);
  expect(report.pass).toBe(false);
  expect(report.blocking.length).toBeGreaterThan(0);
  // Every blocking finding must be critical or serious (the legal floor).
  for (const v of report.blocking) {
    expect(['critical', 'serious']).toContain(v.impact);
  }
  const ids = report.blocking.map((v) => v.id);
  expect(ids).toContain('image-alt');
  expect(ids).toContain('button-name');
  expect(ids).toContain('html-has-lang');
});

test('auditHtml PASSES an accessible page (zero critical/serious)', async () => {
  const report = await auditHtml(ACCESSIBLE);
  expect(report.pass).toBe(true);
  expect(report.blocking).toEqual([]);
  expect(report.counts.critical).toBe(0);
  expect(report.counts.serious).toBe(0);
});

test('auditHtml disables color-contrast (jsdom cannot compute it) so it never blocks here', async () => {
  // Deliberately awful contrast; the gate must NOT flag it (a browser owns contrast).
  const lowContrast =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head>' +
    '<body><main><h1 style="color:#eee;background:#fff">Faint</h1><p style="color:#f0f0f0;background:#fff">hard to read</p></main></body></html>';
  const report = await auditHtml(lowContrast);
  const ids = report.violations.map((v) => v.id);
  expect(ids).not.toContain('color-contrast');
  expect(report.pass).toBe(true);
});

test('auditHtml rejects empty input', async () => {
  await expect(auditHtml('')).rejects.toThrow();
  await expect(auditHtml('   ')).rejects.toThrow();
});

function runDeliver(...argv) {
  return spawnSync('node', [path.join(__dirname, 'deliver.js'), ...argv], {
    encoding: 'utf8',
  });
}

test('deliver.js --audit-only exits 0 and reports ok for an accessible file', () => {
  const file = path.join(require('node:os').tmpdir(), `a11y-good-${Date.now()}.html`);
  require('node:fs').writeFileSync(file, ACCESSIBLE);
  try {
    const res = runDeliver('--audit-only', '--file', file);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe('ok');
    expect(out.audit.pass).toBe(true);
  } finally {
    require('node:fs').rmSync(file, { force: true });
  }
});

test('deliver.js --audit-only exits 3 with a11y_violations for an inaccessible file', () => {
  const file = path.join(require('node:os').tmpdir(), `a11y-bad-${Date.now()}.html`);
  require('node:fs').writeFileSync(file, INACCESSIBLE);
  try {
    const res = runDeliver('--audit-only', '--file', file);
    expect(res.status).toBe(3);
    const out = JSON.parse(res.stdout);
    expect(out.error).toBe('a11y_violations');
    expect(out.blocking.length).toBeGreaterThan(0);
  } finally {
    require('node:fs').rmSync(file, { force: true });
  }
});
