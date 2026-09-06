#!/usr/bin/env node

/**
 * psd-print-pdf — turn an HTML file into a real PDF via headless Chromium.
 *
 * The failure this exists to end (nashs, 2026-09-01): asked to save an 8.5x11
 * back-to-school sign as a printable PDF, the agent had no browser, fell back
 * to PyMuPDF's HTML renderer, and produced a 400x600pt page with the flexbox
 * layout collapsed, the base64 logo dropped and the web fonts substituted. The
 * advice given was "open the link and use Print > Save as PDF yourself".
 */

'use strict';

const { validatedFs } = require("../../../validated-fs.cjs");

const path = require('node:path');
const { runMedia } = require('../_shared/media-relay');

const PAGE_SIZES = ['letter', 'legal', 'tabloid', 'a4', 'a3'];
const MAX_HTML_BYTES = 4 * 1024 * 1024;

function emit(object) {
  process.stdout.write(`${JSON.stringify(object, null, 2)}\n`);
}

function fail(message, code = 'error') {
  process.stderr.write(`Error: ${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) fail(`Unexpected positional argument: ${arg}`, 'bad_args');
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/** A flag that needs a value must not be silently ignored when given none. */
function valued(args, key, flag) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === true) {
    fail(`${flag} needs a value`, 'bad_args');
  }
  return String(value);
}

/** One bounded numeric flag, or undefined when it was not supplied. */
function boundedFlag(args, key, flag, minimum, maximum) {
  const raw = valued(args, key, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`${flag} must be between ${minimum} and ${maximum}`, 'bad_args');
  }
  return value;
}

/** Turn parsed argv into the relay payload. Split out to keep main() flat. */
function buildPayload(args, html) {
  const pageSize = valued(args, 'page_size', '--page-size') || 'letter';
  if (!PAGE_SIZES.includes(pageSize)) {
    fail(`--page-size must be one of ${PAGE_SIZES.join(', ')}`, 'bad_args');
  }
  const payload = { operation: 'html-to-pdf', html, pageSize };
  if (args.landscape === true) payload.landscape = true;
  if (args.no_background === true) payload.printBackground = false;

  const marginInches = boundedFlag(args, 'margin_inches', '--margin-inches', 0, 3);
  if (marginInches !== undefined) payload.marginInches = marginInches;
  const scale = boundedFlag(args, 'scale', '--scale', 0.1, 2);
  if (scale !== undefined) payload.scale = scale;
  return payload;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: print.js --file <page.html> --out <output.pdf> [options]\n' +
        '\n' +
        `  --page-size   ${PAGE_SIZES.join(' | ')}   (default letter)\n` +
        '  --landscape                                (default portrait)\n' +
        '  --margin-inches <0..3>                     (default 0)\n' +
        '  --scale <0.1..2>                           (default 1)\n' +
        '  --no-background                            omit printed backgrounds\n' +
        '\n' +
        "The page's own @page CSS wins over --page-size, which is what a page\n" +
        'already laid out for 8.5x11 relies on.',
    );
    return;
  }

  const file = valued(args, 'file', '--file');
  const out = valued(args, 'out', '--out');
  if (!file) fail('--file <page.html> is required', 'bad_args');
  if (!out) fail('--out <output.pdf> is required', 'bad_args');
  if (!/\.html?$/i.test(file)) {
    fail(`--file must be an .html file (got ${path.extname(file) || 'no extension'})`, 'bad_args');
  }
  if (!/\.pdf$/i.test(out)) fail('--out must end in .pdf', 'bad_args');

  let html;
  try {
    html = validatedFs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`, 'bad_args');
  }
  if (html.trim() === '') fail(`${file} is empty`, 'bad_args');
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_HTML_BYTES) {
    fail(
      `${file} is ${bytes} bytes, over the ${MAX_HTML_BYTES}-byte limit. ` +
        'Large embedded images are the usual cause — reference them by https URL instead.',
      'too_large',
    );
  }

  const payload = buildPayload(args, html);

  let result;
  try {
    result = await runMedia(payload);
  } catch (error) {
    fail(error.message, error.code || 'render_failed');
  }

  const pdf = Buffer.from(result.pdfBase64, 'base64');
  if (pdf.subarray(0, 5).toString() !== '%PDF-') {
    fail('the renderer returned something that is not a PDF', 'render_failed');
  }
  validatedFs.writeFileSync(out, pdf);

  emit({
    file: out,
    bytes: pdf.length,
    pages: result.pages,
    pageSize: result.pageSize,
    landscape: result.landscape,
    // Said explicitly because the next step is a judgement call the agent has
    // to make deliberately: this file is LOCAL and private until someone
    // publishes it.
    sharing: 'local-file-not-published',
  });
}

main().catch((error) => fail(error.message));
