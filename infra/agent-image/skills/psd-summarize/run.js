#!/usr/bin/env node
/**
 * psd-summarize — records-safe summarization.
 *
 * Reads text on STDIN and returns a summary with sensitive content excluded
 * per one or more redaction profiles, so downstream records (chat replies,
 * memory, telemetry) hold a curated summary instead of raw source text. This
 * is the STANDARD place the district's "keep out of records" policy lives —
 * other skills (e.g. psd-plaud) pipe content through it.
 *
 * It calls Bedrock (Claude Haiku) DIRECTLY at the Mantle upstream — NOT the
 * local logging proxy — so the raw input text is never written to AI Studio's
 * request logs. The input also never enters the agent's own model context when
 * a caller (like psd-plaud) pipes to this skill internally.
 *
 * Usage:
 *   echo "<text>" | node run.js [--profiles students,personnel,topics-only]
 *                               [--output summary|action-items|decisions|key-topics]
 *                               [--length brief|standard|detailed]
 *                               [--context "what this is"]
 *
 * IMPORTANT: summarization REDUCES but does not GUARANTEE removal of sensitive
 * content. It is risk-reduction, not a legal/compliance guarantee.
 *
 * Env: AWS_BEARER_TOKEN_BEDROCK, MANTLE_ANTHROPIC_URL
 *      (default https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages),
 *      SUMMARIZE_MODEL_ID (default anthropic.claude-haiku-4-5).
 */

'use strict';

const MANTLE_URL =
  process.env.MANTLE_ANTHROPIC_URL ||
  'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages';
const MODEL_ID = process.env.SUMMARIZE_MODEL_ID || 'anthropic.claude-haiku-4-5';
const BEARER = process.env.AWS_BEARER_TOKEN_BEDROCK || '';

function fail(message, code = 1) {
  process.stderr.write(`psd-summarize: ${message}\n`);
  process.exit(code);
}
function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (!a.startsWith('--')) fail(`Unexpected positional argument: ${a}`);
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; }
    else { args[key] = next; i++; }
  }
  return args;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    // If nothing is piped, don't hang forever.
    if (process.stdin.isTTY) resolve('');
  });
}

const PROFILE_RULES = {
  students:
    'Exclude student personally identifiable information: student names, IDs, ' +
    'schools tied to a named student, disabilities, discipline, grades, health, ' +
    'family/immigration status, and anything that could identify a specific student. ' +
    'Refer to students generically ("a student", "several students").',
  personnel:
    'Exclude sensitive personnel information: named staff tied to discipline, ' +
    'performance, complaints, salary, medical/leave, or investigations. Describe ' +
    'personnel matters generically without naming individuals or quoting them.',
  'topics-only':
    'Output only decisions, action items, and topics discussed. Do NOT include ' +
    'verbatim quotes, who-said-what attributions, or narrative detail.',
};

const OUTPUT_RULES = {
  summary: 'Produce a concise summary in short bullet points.',
  'action-items': 'Produce only a bulleted list of concrete action items (owner + task if stated, owners de-identified per the profiles).',
  decisions: 'Produce only a bulleted list of decisions that were made.',
  'key-topics': 'Produce only a bulleted list of the key topics discussed.',
};

const LENGTH_RULES = {
  brief: 'Keep it very short (3-5 bullets max).',
  standard: 'Keep it concise (roughly 5-10 bullets).',
  detailed: 'Be thorough but still summarized; no verbatim transcript.',
};

function buildSystemPrompt(profiles, output, length, context) {
  const rules = profiles.map((p) => PROFILE_RULES[p]).filter(Boolean);
  return [
    'You summarize source text for a U.S. public school district. Your summary ' +
    'may become a public record subject to disclosure, so you must exclude ' +
    'sensitive content as instructed below. Never reproduce the source verbatim.',
    context ? `The source is: ${context}.` : '',
    '',
    'Redaction rules (follow ALL):',
    ...rules.map((r) => `- ${r}`),
    '- Never invent facts. If a detail is excluded, simply omit it — do not note what was removed unless it changes the meaning.',
    '',
    OUTPUT_RULES[output] || OUTPUT_RULES.summary,
    LENGTH_RULES[length] || LENGTH_RULES.standard,
    '',
    'Output ONLY the summary content. No preamble, no "Here is", no closing remarks.',
  ].filter((l) => l !== undefined).join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write('Usage: <text on stdin> | run.js [--profiles a,b] [--output summary] [--length standard] [--context "..."]\n');
    process.exit(0);
  }
  if (!BEARER) fail('AWS_BEARER_TOKEN_BEDROCK is not set — cannot call the model');

  const text = (await readStdin()).trim();
  if (!text) fail('No input text on stdin');

  const validProfiles = Object.keys(PROFILE_RULES);
  let profiles = typeof args.profiles === 'string'
    ? args.profiles.split(',').map((s) => s.trim()).filter(Boolean)
    : ['students', 'personnel']; // conservative default
  const unknown = profiles.filter((p) => !validProfiles.includes(p));
  if (unknown.length) fail(`Unknown --profiles: ${unknown.join(', ')}. Valid: ${validProfiles.join(', ')}`);

  const output = typeof args.output === 'string' ? args.output : 'summary';
  const length = typeof args.length === 'string' ? args.length : 'standard';
  const context = typeof args.context === 'string' ? args.context : '';

  const system = buildSystemPrompt(profiles, output, length, context);

  // Guard against oversized inputs (Haiku context is large, but bound cost).
  const MAX_CHARS = 400000;
  const clipped = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;

  let resp;
  try {
    resp = await fetch(MANTLE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${BEARER}`,
      },
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: `Source text to summarize:\n\n${clipped}` }],
      }),
    });
  } catch (err) {
    fail(`Model request failed: ${err.message}`, 12);
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    fail(`Model HTTP ${resp.status}: ${t.slice(0, 300)}`, 12);
  }
  const data = await resp.json().catch(() => null);
  if (!data) fail('Model returned non-JSON', 12);
  // Anthropic Messages response: { content: [{type:'text', text}], ... }
  const parts = Array.isArray(data.content) ? data.content : [];
  const summary = parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n').trim();
  if (!summary) fail('Model returned an empty summary', 12);

  emit({ status: 'ok', profiles, output, length, summary });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
