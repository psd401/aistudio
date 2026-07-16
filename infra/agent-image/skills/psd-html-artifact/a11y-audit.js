#!/usr/bin/env node
/**
 * a11y-audit.js — shared WCAG 2.2 AA accessibility gate for HTML artifacts.
 *
 * This is the SINGLE place PSD enforces "every delivered HTML artifact is
 * accessible" (Issue #1245). Both delivery paths run the SAME check:
 *   - psd-html-artifact/deliver.js runs it before uploading (and exposes it as
 *     `deliver.js --audit-only --file <html>`).
 *   - psd-learning-page runs it before publishing to Atrium (via require()).
 *
 * The gate BLOCKS on axe-core violations whose impact is `critical` or
 * `serious`. Moderate/minor findings are reported but do not block — they are
 * craft nudges, not a legal floor.
 *
 * Coverage split (see references/preflight-audit.md):
 *   - This module runs axe-core over jsdom. That covers STRUCTURE / ARIA /
 *     labels / lang / roles / names — the machine-checkable WCAG 2.2 AA subset
 *     that needs no layout or paint. It is the CI + runtime gate.
 *   - `color-contrast` and reflow/zoom CANNOT be evaluated here: jsdom does not
 *     lay out or paint, so axe cannot compute color or geometry. Those criteria
 *     are verified separately in a real headless browser during the functional
 *     check (axe/Lighthouse) and are documented in preflight-audit.md. Enabling
 *     color-contrast under jsdom yields false "can't-tell" incompletes, not a
 *     real result, so it is disabled here on purpose.
 *
 * Library (module) usage:
 *   const { auditHtml } = require('/opt/psd-skills/psd-html-artifact/a11y-audit.js');
 *   const report = await auditHtml(htmlString);
 *   if (!report.pass) { ...refuse to deliver/publish... }
 *
 * CLI usage:
 *   node a11y-audit.js --file <path-to.html>
 *   node a11y-audit.js --html "<!doctype html>..."
 *   Exit 0 = pass (no critical/serious). Exit 3 = blocked (critical/serious
 *   violations found — see stdout JSON). Exit 1 = bad args. Exit 2 = internal.
 */

'use strict';

const fs = require('node:fs');

// Impact levels that BLOCK delivery/publish. axe-core impacts are one of:
// 'minor' | 'moderate' | 'serious' | 'critical'.
const BLOCKING_IMPACTS = new Set(['critical', 'serious']);

/**
 * Run axe-core over an HTML string inside jsdom and return a structured report.
 *
 * @param {string} html               Full HTML document (self-contained).
 * @param {object} [opts]
 * @param {boolean} [opts.includeContrast=false]  Force-enable color-contrast.
 *        Off by default because jsdom cannot compute it (see file header);
 *        a real browser check owns contrast.
 * @returns {Promise<{
 *   pass: boolean,
 *   blocking: Array<object>,
 *   violations: Array<object>,
 *   counts: { critical:number, serious:number, moderate:number, minor:number },
 *   standard: string,
 *   note: string
 * }>}
 */
async function auditHtml(html, opts = {}) {
  if (typeof html !== 'string' || html.trim() === '') {
    throw new Error('auditHtml requires a non-empty HTML string');
  }

  // Lazy require so a missing dependency produces a clear, actionable error
  // instead of blowing up at import time in environments that never audit.
  let JSDOM;
  let axeSourcePath;
  try {
    ({ JSDOM } = require('jsdom'));
    axeSourcePath = require.resolve('axe-core');
  } catch (err) {
    throw new Error(
      'a11y gate unavailable: jsdom and axe-core must be installed for ' +
        `psd-html-artifact (${err.message})`
    );
  }

  const axeSource = fs.readFileSync(axeSourcePath, 'utf8');

  // `pretendToBeVisual` gives axe a requestAnimationFrame; `outside-only` lets
  // us eval axe's source into the window WITHOUT executing scripts embedded in
  // the artifact under test (we audit structure, we do not run the page's JS).
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  try {
    window.eval(axeSource);

    const runOptions = {
      resultTypes: ['violations'],
      // WCAG 2.2 AA and its predecessors, plus best-practice structural rules.
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
      rules: opts.includeContrast
        ? {}
        // jsdom can't compute layout/paint, so color-contrast returns noise.
        : { 'color-contrast': { enabled: false } },
    };

    const results = await window.axe.run(window.document.documentElement, runOptions);
    const violations = Array.isArray(results.violations) ? results.violations : [];

    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const v of violations) {
      const impact = v.impact || 'minor';
      if (counts[impact] === undefined) counts[impact] = 0;
      counts[impact] += 1;
    }

    const summarize = (v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: (v.nodes || []).slice(0, 5).map((n) => ({
        target: n.target,
        // Trim the offending markup so the report stays small and readable.
        html: typeof n.html === 'string' ? n.html.slice(0, 200) : '',
      })),
    });

    const blocking = violations
      .filter((v) => BLOCKING_IMPACTS.has(v.impact))
      .map(summarize);

    return {
      pass: blocking.length === 0,
      blocking,
      violations: violations.map(summarize),
      counts,
      standard: 'WCAG 2.2 AA (axe-core, structural subset; color-contrast + reflow are browser-verified)',
      note:
        'axe-core over jsdom covers structure/ARIA/labels/lang. Contrast and ' +
        'reflow/200%-zoom are NOT evaluated here (no layout engine) — verify ' +
        'those in a real browser.',
    };
  } finally {
    window.close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      process.stderr.write(`Unexpected positional argument: ${arg}\n`);
      process.exit(1);
    }
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

async function cli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: node a11y-audit.js --file <path.html> | --html "<html>"\n' +
        '  Exit 0 = pass, 3 = critical/serious violations, 1 = bad args.\n'
    );
    return 0;
  }

  let html;
  if (typeof args.file === 'string') {
    try {
      html = fs.readFileSync(args.file, 'utf8');
    } catch (err) {
      process.stdout.write(
        JSON.stringify({ error: 'bad_args', message: `--file not readable: ${err.message}` }) + '\n'
      );
      return 1;
    }
  } else if (typeof args.html === 'string') {
    html = args.html;
  } else {
    process.stdout.write(
      JSON.stringify({ error: 'bad_args', message: '--file <path> or --html <string> is required' }) + '\n'
    );
    return 1;
  }

  let report;
  try {
    report = await auditHtml(html, { includeContrast: args.include_contrast === true });
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: 'audit_error', message: err.message }) + '\n');
    return 2;
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.pass ? 0 : 3;
}

if (require.main === module) {
  cli(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stdout.write(JSON.stringify({ error: 'audit_error', message: err.message }) + '\n');
      process.exit(2);
    });
}

module.exports = { auditHtml, BLOCKING_IMPACTS, parseArgs };
