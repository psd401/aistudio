#!/usr/bin/env node
/**
 * run.js — chat-card
 *
 * Emits a PSD_AGENT_RICH_V1 envelope wrapping a Google Chat cardsV2 entry.
 * The Router Lambda (and Cron Lambda) detect the envelope in the agent's
 * final reply and lift the structured payload into the Chat messages.create
 * request — so this skill never touches the Chat API itself.
 *
 * The interface is intentionally two-layered:
 *   - High-level flags (--title, --paragraph, --kv, --button, ...) build
 *     widgets in declaration order. Covers ~90% of card layouts agents
 *     will reach for.
 *   - --card-json is the escape hatch for widget types the high-level
 *     interface doesn't expose (selectionInput, columns, etc).
 *
 * stdout: the envelope, exactly one block. Designed to be included
 *         verbatim in the agent's reply.
 * stderr: human-readable diagnostics.
 */

'use strict';

const { randomUUID } = require('node:crypto');

const RICH_ENVELOPE_OPEN = '<<<PSD_AGENT_RICH_V1>>>';
const RICH_ENVELOPE_CLOSE = '<<<END_PSD_AGENT_RICH_V1>>>';

/**
 * Parse process.argv into a flag map. Supports repeated flags by collecting
 * values into arrays. Flags without an explicit value (e.g. --divider) get
 * the literal `true`. Unknown flags raise — agents typo flags fairly often
 * and silent acceptance hides the bug.
 */
function parseArgs(argv) {
  const known = new Set([
    '--title',
    '--subtitle',
    '--paragraph',
    '--kv',
    '--divider',
    '--image',
    '--button',
    '--card-json',
    '--text-fallback',
    '--card-id',
    '--help',
    '-h',
  ]);
  const args = { _order: [] };
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--') && !(tok === '-h')) {
      throw new Error(`unexpected positional argument: ${tok}`);
    }
    if (!known.has(tok)) {
      throw new Error(`unknown flag: ${tok}`);
    }
    // Flags with no value.
    if (tok === '--divider' || tok === '--help' || tok === '-h') {
      args[tok] = true;
      args._order.push({ flag: tok, value: true });
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      throw new Error(`flag ${tok} requires a value`);
    }
    if (Array.isArray(args[tok])) {
      args[tok].push(val);
    } else if (args[tok] !== undefined) {
      args[tok] = [args[tok], val];
    } else {
      // First occurrence — store scalar; subsequent occurrences upgrade to array.
      args[tok] = val;
    }
    args._order.push({ flag: tok, value: val });
    i++;
  }
  return args;
}

/** Parse a `--button` spec: "label::intent[::k=v;k=v...]" */
function parseButtonSpec(spec) {
  const parts = spec.split('::');
  if (parts.length < 2) {
    throw new Error(
      `invalid --button "${spec}" — expected "label::intent[::k=v;k=v...]"`,
    );
  }
  const [label, intent, paramStr] = parts;
  if (!label.trim() || !intent.trim()) {
    throw new Error(`--button "${spec}" — label and intent must be non-empty`);
  }
  const parameters = [
    { key: 'intent', value: intent.trim() },
  ];
  if (paramStr) {
    for (const pair of paramStr.split(';')) {
      if (!pair.trim()) continue;
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) {
        throw new Error(
          `--button "${spec}" param "${pair}" missing '=' separator`,
        );
      }
      parameters.push({
        key: pair.slice(0, eqIdx).trim(),
        value: pair.slice(eqIdx + 1),
      });
    }
  }
  return {
    text: label,
    onClick: {
      action: {
        function: 'psd-agent',
        parameters,
      },
    },
  };
}

/** Parse a `--kv` spec: "topLabel::text" */
function parseKvSpec(spec) {
  const sepIdx = spec.indexOf('::');
  if (sepIdx === -1) {
    throw new Error(`invalid --kv "${spec}" — expected "topLabel::text"`);
  }
  const topLabel = spec.slice(0, sepIdx).trim();
  const text = spec.slice(sepIdx + 2);
  if (!topLabel) {
    throw new Error(`--kv "${spec}" — topLabel must be non-empty`);
  }
  return {
    decoratedText: {
      topLabel,
      text,
    },
  };
}

/**
 * Build the cardsV2 entry from the high-level flags, preserving the order
 * the agent declared them in (--paragraph, --kv, --divider, --image can
 * interleave). Buttons collect into a single buttonList widget appended at
 * the end of the section.
 */
function buildHighLevelCard(args) {
  const widgets = [];
  const buttons = [];

  for (const { flag, value } of args._order) {
    if (flag === '--paragraph') {
      widgets.push({ textParagraph: { text: value } });
    } else if (flag === '--kv') {
      widgets.push(parseKvSpec(value));
    } else if (flag === '--divider') {
      widgets.push({ divider: {} });
    } else if (flag === '--image') {
      widgets.push({ image: { imageUrl: value } });
    } else if (flag === '--button') {
      buttons.push(parseButtonSpec(value));
    }
    // Other flags (--title, --subtitle, --text-fallback, --card-id, --card-json)
    // are handled outside the widget loop.
  }

  if (buttons.length > 0) {
    widgets.push({ buttonList: { buttons } });
  }

  const card = {};
  const title = args['--title'];
  const subtitle = args['--subtitle'];
  if (title || subtitle) {
    card.header = {};
    if (title) card.header.title = title;
    if (subtitle) card.header.subtitle = subtitle;
  }
  if (widgets.length > 0) {
    card.sections = [{ widgets }];
  }
  return card;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`chat-card: ${err.message}\n`);
    process.exit(2);
  }

  if (args['--help'] || args['-h']) {
    process.stdout.write(
      'Usage: chat-card --title T [--paragraph P]... [--kv K::V]... ' +
        '[--divider] [--image URL]... [--button "label::intent[::k=v;k=v]"]... ' +
        '[--text-fallback F] [--card-json JSON]\n',
    );
    process.exit(0);
  }

  let card;
  if (args['--card-json']) {
    try {
      card = JSON.parse(args['--card-json']);
    } catch (err) {
      process.stderr.write(`chat-card: --card-json is not valid JSON: ${err.message}\n`);
      process.exit(2);
    }
    if (typeof card !== 'object' || card === null || Array.isArray(card)) {
      process.stderr.write(
        'chat-card: --card-json must be a JSON object (the "card" field of a cardsV2 entry)\n',
      );
      process.exit(2);
    }
  } else {
    try {
      card = buildHighLevelCard(args);
    } catch (err) {
      process.stderr.write(`chat-card: ${err.message}\n`);
      process.exit(2);
    }
    if (Object.keys(card).length === 0) {
      process.stderr.write(
        'chat-card: nothing to render — pass at least --title, --paragraph, --kv, --image, or --card-json\n',
      );
      process.exit(2);
    }
  }

  const cardId = args['--card-id'] || `c-${randomUUID()}`;
  const envelope = {
    cardsV2: [{ cardId, card }],
  };
  // textFallback is what Chat uses for notification previews and
  // text-only renderings. Always populate it so the Router never falls
  // back to its generic "Rich response" placeholder. Prefer the agent's
  // explicit fallback, then the card title, then a generic last resort.
  envelope.textFallback =
    args['--text-fallback'] || (card.header && card.header.title) || 'Card';

  process.stdout.write(
    `${RICH_ENVELOPE_OPEN}\n${JSON.stringify(envelope)}\n${RICH_ENVELOPE_CLOSE}\n`,
  );
}

main();
