#!/usr/bin/env node
/**
 * psd-brand-guidelines — Node CLI for the PSD brand reference data.
 *
 * Ported from the upstream Python `brand.py` in
 *   psd401/psd-claude-plugins/plugins/psd-productivity/skills/psd-brand-guidelines
 *
 * Subcommands:
 *   colors                       — list all brand colors (hex + RGB + usage)
 *   color <name>                 — print one color's details as JSON
 *   typography                   — print heading/body font config as JSON
 *   logo [bg] [space]            — resolve and print the best logo asset path
 *   logos                        — list all logo asset paths (PNG only)
 *   validate "<prompt>"          — validate a prompt against the forbidden-
 *                                  generation patterns; prints JSON
 *                                  { valid, errors }, exits non-zero if invalid
 *   application <context>        — print application config (presentations,
 *                                  documents, digital) as JSON
 *
 * Asset files ship in ./assets/ alongside this script and resolve via
 *   path.join(__dirname, 'assets', <filename>)
 * so the CLI works wherever the skill directory is installed.
 *
 * Zero npm dependencies — uses only Node built-ins.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'brand-config.json');
const ASSETS_DIR = path.join(__dirname, 'assets');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function flatColors(config) {
  const out = {};
  for (const category of ['primary', 'supporting']) {
    for (const [name, data] of Object.entries(config.colors[category])) {
      out[name] = data.hex;
    }
  }
  return out;
}

function getColor(config, name) {
  for (const category of ['primary', 'supporting']) {
    if (config.colors[category] && name in config.colors[category]) {
      return config.colors[category][name];
    }
  }
  return null;
}

function resolveLogo(config, background, space) {
  const logos = config.logos;
  const colorOptions = (logos.selectionRules.byBackground[background]) || ['2color'];
  const colorVariant = colorOptions[0];
  const layoutOptions = (logos.selectionRules.bySpace[space]) || ['horizontal'];
  const availableLayouts = (logos.variants[colorVariant] || {}).files || [];

  let layout = null;
  for (const option of layoutOptions) {
    if (availableLayouts.includes(option)) {
      layout = option;
      break;
    }
  }
  if (layout === null && availableLayouts.length > 0) {
    layout = availableLayouts[0];
  }
  if (layout === null) {
    throw new Error(`No logo layout found for variant '${colorVariant}'`);
  }

  const filename = `psd_logo-${colorVariant}-${layout}.png`;
  return path.join(ASSETS_DIR, filename);
}

function allLogoPaths(config) {
  const out = [];
  for (const [variant, data] of Object.entries(config.logos.variants)) {
    for (const layout of data.files) {
      const p = path.join(ASSETS_DIR, `psd_logo-${variant}-${layout}.png`);
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

function validatePrompt(config, prompt) {
  const forbidden = config.forbiddenGeneration;
  const lower = String(prompt).toLowerCase();
  const violations = [];

  for (const pattern of forbidden.patterns) {
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      continue;
    }
    const m = lower.match(re);
    if (m) {
      violations.push(`Blocked: '${m[0]}'. ${forbidden.message}`);
    }
  }
  if (violations.length > 0) {
    violations.push(`Tip: ${forbidden.suggestion}`);
  }
  return { valid: violations.length === 0, errors: violations };
}

function usage() {
  const lines = [
    'Usage: node brand.js <command> [args]',
    '',
    'Commands:',
    '  colors                   List all brand colors',
    '  color <name>             Print one color (hex/rgb/usage) as JSON',
    '  typography               Print font config as JSON',
    '  logo [bg] [space]        Resolve logo path. bg=light|medium|dark, space=wide|square|vertical|small',
    '  logos                    List every available logo PNG path',
    '  validate "<prompt>"      Validate prompt against forbidden patterns',
    '  application <context>    Print application config for presentations|documents|digital',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function main(argv) {
  if (argv.length < 1) {
    usage();
    process.exit(0);
  }
  const config = loadConfig();
  const command = argv[0];

  if (command === 'colors') {
    const colors = flatColors(config);
    for (const [name, hex] of Object.entries(colors)) {
      process.stdout.write(`  ${name}: ${hex}\n`);
    }
    return;
  }

  if (command === 'color') {
    if (argv.length < 2) {
      process.stderr.write('Usage: brand.js color <name>\n');
      process.exit(1);
    }
    const color = getColor(config, argv[1]);
    if (!color) {
      process.stderr.write(`Color '${argv[1]}' not found. Available: ${Object.keys(flatColors(config)).join(', ')}\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(color, null, 2) + '\n');
    return;
  }

  if (command === 'typography') {
    process.stdout.write(JSON.stringify(config.typography, null, 2) + '\n');
    return;
  }

  if (command === 'logo') {
    const bg = argv[1] || 'light';
    const space = argv[2] || 'wide';
    try {
      const p = resolveLogo(config, bg, space);
      process.stdout.write(`Logo path: ${p}\n`);
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
    return;
  }

  if (command === 'logos') {
    const paths = allLogoPaths(config);
    for (const p of paths) process.stdout.write(p + '\n');
    return;
  }

  if (command === 'validate') {
    if (argv.length < 2) {
      process.stderr.write('Usage: brand.js validate "<prompt>"\n');
      process.exit(1);
    }
    const prompt = argv.slice(1).join(' ');
    const result = validatePrompt(config, prompt);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.valid) process.exit(1);
    return;
  }

  if (command === 'application') {
    if (argv.length < 2) {
      process.stderr.write('Usage: brand.js application <presentations|documents|digital>\n');
      process.exit(1);
    }
    const ctx = config.applications[argv[1]];
    if (!ctx) {
      process.stderr.write(`Unknown context '${argv[1]}'. Available: ${Object.keys(config.applications).join(', ')}\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(ctx, null, 2) + '\n');
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  usage();
  process.exit(1);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  loadConfig,
  flatColors,
  getColor,
  resolveLogo,
  allLogoPaths,
  validatePrompt,
};
