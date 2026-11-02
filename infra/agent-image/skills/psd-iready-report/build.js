#!/usr/bin/env node

/**
 * psd-iready-report — render one student's Fall i-Ready diagnostic report as
 * PSD-branded letter-size HTML, ready for psd-print-pdf.
 *
 * Usage: node build.js --data <report.json> --out <report.html>
 *
 * Contributed by cantonwinej as a user skill and promoted to the bundled
 * catalog (#2023). The JSON shape is documented in SKILL.md; diagnostic and
 * subtest rows are passed through with the warehouse's own column names.
 */

'use strict';

const { validatedFs } = require("../../../validated-fs.cjs");

const path = require('node:path');

const LOGO = path.join(__dirname, '..', 'psd-brand-guidelines', 'assets', 'psd_logo-white-horizontal.png');

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: 'bad_args', message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail(`Unexpected positional argument: ${arg}`);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) fail(`${arg} needs a value`);
    args[arg.slice(2)] = next;
    i++;
  }
  return args;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The warehouse truncates subtest `level` to 10 characters, which leaves a
// trailing space on "Two Grade " and "One Grade " — so match on the trimmed
// value. Values that arrive untruncated pass through unchanged.
const LEVELS = {
  'Three or M': 'Three or More Grade Levels Below',
  'Two Grade': 'Two Grade Levels Below',
  'One Grade': 'One Grade Level Below',
  'Early On G': 'Early On Grade Level',
  'Mid or Abo': 'Mid or Above Grade Level',
};
const expandLevel = (l) => {
  const trimmed = String(l ?? '').trim();
  return LEVELS[trimmed] || trimmed;
};

const GROUPS = {
  AlgThink: 'Algebra & Algebraic Thinking',
  NumOps: 'Number & Operations',
  MeasData: 'Measurement & Data',
  Geom: 'Geometry',
  'Comprehension Overall': 'Comprehension Overall',
  CompInfo: 'Comprehension: Informational Text',
  CompLit: 'Comprehension: Literature',
  Vocab: 'Vocabulary',
  Phonics: 'Phonics',
  HFWords: 'High-Frequency Words',
  PhonoAware: 'Phonological Awareness',
  'Comprehension Level': 'Comprehension Level',
};
const ORDER = {
  math: ['AlgThink', 'NumOps', 'MeasData', 'Geom', 'Level'],
  reading: ['Comprehension Overall', 'CompInfo', 'CompLit', 'Vocab', 'Phonics', 'HFWords', 'PhonoAware', 'Level', 'Comprehension Level'],
};

function num(v) {
  if (v === null || v === undefined || v === '' || v === 'null') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toString() : esc(v);
}

const isMet = (v) => v === true || v === 'True' || v === 'true' || v === 1 || v === '1';

function subRows(kind, rows) {
  const order = ORDER[kind];
  // Unknown groups sort after the known ones instead of to the top.
  const rank = (g) => (order.includes(g) ? order.indexOf(g) : order.length);
  const sorted = [...rows].sort((a, b) => rank(a.assessment_group) - rank(b.assessment_group));
  return sorted.map((r) => {
    const name = r.assessment_group === 'Level'
      ? (kind === 'math' ? 'Math Level' : 'Reading Level')
      : (GROUPS[r.assessment_group] || r.assessment_group);
    const met = isMet(r.met_standard);
    return `<tr><td>${esc(name)}</td><td>${num(r.score)}</td><td>${esc(expandLevel(r.level))}</td><td class="${met ? 'yes' : 'no'}">${met ? 'Yes' : 'No'}</td></tr>`;
  }).join('');
}

function section(title, kind, g, extraLabel, extraKey) {
  const x = g && g.diagnostic;
  // A student may have tested in only one subject this window; say so rather
  // than failing the whole report.
  if (!x) return `<h2>${title}</h2>\n<p class="none">No Fall diagnostic on record for this window.</p>`;
  const subtests = (g.subtests || []);
  return `<h2>${title}</h2>
<div class="cards">
<div class="card"><div class="k">Overall score</div><div class="v">${num(x.overall_score)}</div></div>
<div class="card"><div class="k">Placement</div><div class="v" style="font-size:12px">${esc(x.overall_level)}</div></div>
<div class="card"><div class="k">Percentile</div><div class="v">${num(x.percentile)}</div></div>
<div class="card"><div class="k">${extraLabel}</div><div class="v">${num(x[extraKey])}</div></div>
<div class="card"><div class="k">Time on task</div><div class="v">${num(x.time_on_task)} min</div></div>
</div>
<table><tr><th>Growth</th><th>Measure</th><th>Goal</th></tr>
<tr><td>Typical growth</td><td>${num(x.typical_growth_measure)}</td><td>${num(x.typical_growth_goal)}</td></tr>
<tr><td>Stretch growth</td><td>${num(x.stretch_growth_measure)}</td><td>${num(x.stretch_growth_goal)}</td></tr></table>
${subtests.length > 0 ? `<table style="margin-top:8px"><tr><th>${kind === 'math' ? 'Math' : 'Reading'} domain</th><th>Score</th><th>Level</th><th>Met standard</th></tr>
${subRows(kind, subtests)}</table>` : ''}`;
}

function testedOn(g) {
  const first = g && g.subtests && g.subtests[0];
  return first && first.assessment_date ? esc(String(first.assessment_date).slice(0, 10)) : '—';
}

function renderReport(d, logoBase64) {
  const s = d.student || {};
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Josefin+Sans:wght@600;700&family=Josefin+Slab:wght@400;600&display=swap');
@page { size: letter; margin: 0; }
* { box-sizing: border-box; }
body { margin:0; font-family:'Josefin Slab', Georgia, serif; color:#25424C; background:#FFFAEC; font-size:12.5px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.header { background:#25424C; color:#FFFAEC; padding:20px 40px; display:flex; align-items:center; justify-content:space-between; border-bottom:6px solid #6CA18A; }
.header img { height:52px; }
.header .t { text-align:right; font-family:'Josefin Sans', Arial, sans-serif; }
.header .t .a { font-size:20px; font-weight:700; }
.header .t .b { font-size:12px; color:#6CA18A; margin-top:3px; }
.content { padding:18px 40px 10px; }
h2 { font-family:'Josefin Sans', Arial, sans-serif; font-weight:700; font-size:15px; color:#25424C; border-bottom:2px solid #6CA18A; padding-bottom:3px; margin:16px 0 8px; }
.meta { display:flex; flex-wrap:wrap; gap:6px 22px; background:#EEEBE4; padding:8px 14px; border-radius:4px; font-size:13px; }
.meta b { font-family:'Josefin Sans', Arial, sans-serif; }
.cards { display:flex; gap:8px; margin-bottom:8px; }
.card { flex:1; background:#EEEBE4; border-left:4px solid #346780; padding:6px 9px; }
.card .k { font-family:'Josefin Sans', Arial, sans-serif; font-size:9.5px; text-transform:uppercase; letter-spacing:.5px; color:#346780; }
.card .v { font-size:15px; font-weight:600; }
table { width:100%; border-collapse:collapse; }
th { background:#346780; color:#FFFAEC; font-family:'Josefin Sans', Arial, sans-serif; font-size:11px; text-align:left; padding:5px 8px; }
td { padding:4px 8px; border-bottom:1px solid #D7CDBE; }
tr:nth-child(even) td { background:#EEEBE4; }
.yes { color:#466857; font-weight:600; } .no { color:#8a4b3a; }
.none { font-style:italic; color:#346780; }
.note { font-size:11px; color:#346780; margin-top:6px; }
.footer { position:fixed; bottom:0; left:0; right:0; background:#EEEBE4; border-top:3px solid #6CA18A; padding:8px 40px; font-size:10px; display:flex; justify-content:space-between; }
</style></head><body>
<div class="header"><img src="data:image/png;base64,${logoBase64}" alt="Peninsula School District">
<div class="t"><div class="a">i-Ready Fall ${esc(d.fallYear)} Diagnostic Report</div><div class="b">School Year ${esc(d.schoolYearName)} · Grade ${esc(d.grade)}</div></div></div>
<div class="content">
<div class="meta"><span><b>Student:</b> ${esc(s.firstName)} ${esc(s.lastName)}</span><span><b>School:</b> ${esc(s.school)}</span><span><b>SSID:</b> ${esc(s.ssid)}</span><span><b>Student ID:</b> ${esc(s.id)}</span><span><b>Window:</b> Fall ${esc(d.fallYear)}</span><span><b>Math tested:</b> ${testedOn(d.math)}</span><span><b>Reading tested:</b> ${testedOn(d.reading)}</span></div>
${section('Math Diagnostic', 'math', d.math, 'Quantile', 'quantile_score')}
${section('Reading Diagnostic', 'reading', d.reading, 'Lexile', 'lexile_score')}
<div class="note">Growth progress percentages populate after the Fall window.</div>
</div>
<div class="footer"><span>Peninsula School District · Confidential student record (FERPA)</span><span>Source: PSD data warehouse · Generated ${esc(d.generated)}</span></div>
</body></html>`;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.data || !args.out) fail('usage: build.js --data <report.json> --out <report.html>');
  let data;
  try {
    data = JSON.parse(validatedFs.readFileSync(args.data, 'utf8'));
  } catch {
    // Never echo error.message: V8's JSON.parse errors quote the input, which
    // here is a student record that would land in the agent transcript.
    fail(`${args.data} could not be read as valid JSON`);
  }
  if (!data || (!data.math?.diagnostic && !data.reading?.diagnostic)) {
    fail('neither a math nor a reading Fall diagnostic is in --data; tell the user there is no Fall row instead of building an empty report');
  }
  const logo = validatedFs.readFileSync(LOGO).toString('base64');
  const html = renderReport(data, logo);
  validatedFs.writeFileSync(args.out, html);
  process.stdout.write(`${JSON.stringify({ out: args.out, bytes: Buffer.byteLength(html) })}\n`);
}

if (require.main === module) main();

module.exports = { expandLevel, renderReport, subRows };
