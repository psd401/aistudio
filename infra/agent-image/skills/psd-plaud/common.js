/**
 * Shared helpers for the psd-plaud OpenClaw skill.
 *
 * Calls Plaud through the owner-bound web operation broker. The web tier
 * refreshes the per-user grant and speaks Streamable HTTP so each caller only
 * ever touches their own Plaud recordings.
 *
 * We deliberately do NOT use OpenClaw's built-in MCP client config: that is a
 * single global registry per gateway with no per-user token isolation, which
 * would share one Plaud account across all users. A per-user skill client keeps
 * each of the N users' tokens isolated (stored in Secrets Manager by email).
 *
 * Auth is a standard OAuth 2.1 flow (verified live against Plaud's server):
 *   - AS metadata: https://mcp.plaud.ai/.well-known/oauth-authorization-server
 *   - authorization_code + refresh_token grants, PKCE S256, public client (no
 *     secret). The one-time browser consent is driven by AI Studio's
 *     /agent-connect-plaud flow; this skill only does headless refresh.
 *
 * Refresh and MCP transport execute inside the trusted owner-bound web broker.
 * This model-facing helper receives only operation results.
 */

'use strict';

const { requestAgentBroker } = require('../_shared/agent-broker');

function fail(message, code = 1) {
  process.stderr.write(`psd-plaud: ${message}\n`);
  process.exit(code);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// argv parser. Unlike psd-workspace (which has no bare subcommand), psd-plaud
// takes a positional subcommand (`whoami`, `list`, …), so positionals are
// COLLECTED into args._ rather than rejected. Flag VALUES are consumed via the
// i++ below, so args._[0] is always the real subcommand — not a flag's value.
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) { args._.push(arg); continue; }
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; }
    else { args[key] = next; i++; }
  }
  return args;
}

function rejectAuthorityArgs(args) {
  for (const name of ['user', 'owner_email', 'user_email', 'user_id']) {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      fail(`--${name.replace(/_/g, '-')} is not accepted; identity comes from the signed invocation`);
    }
  }
}

/** Mint a one-time consent URL (chat → browser) via AI Studio. */
async function mintConsentUrl() {
  const data = await requestAgentBroker(
    '/api/agent/consent-link',
    { kind: 'plaud' },
  );
  if (!data.url) throw new Error('Consent-link API returned no URL');
  return data.url;
}

/** Emit a needs-auth payload and exit 10 (psd-rules Rule 9 chat conventions). */
async function emitNeedsAuthAndExit(reason) {
  let consentUrl;
  try { consentUrl = await mintConsentUrl(); }
  catch (err) { fail(`Unable to mint consent URL: ${err.message}`); }
  emit({
    status: 'needs-auth',
    kind: 'plaud',
    reason,
    consent_url: consentUrl,
    consent_chat_hyperlink: `<${consentUrl}|Connect your Plaud account>`,
    message:
      'Paste consent_chat_hyperlink on its own line, no surrounding markdown. ' +
      'Then on a separate line: "Click the link to connect your Plaud account so I can read your recordings."',
  });
  process.exit(10);
}

/**
 * Core: auth (refresh-or-mint) → initialize handshake → tools/call. Returns the
 * parsed MCP result object. Emits needs-auth (exit 10) when unauthorized, a
 * structured error + non-zero exit on failure. Does NOT write to stdout — so
 * callers that must keep content OUT of the agent's context (digest) can use it.
 */
async function invokeTool(toolName, toolArgs) {
  const response = await requestAgentBroker('/api/agent/credentials', {
    operation: 'plaud-mcp',
    method: 'tools/call',
    toolName,
    toolArgs: toolArgs || {},
  });
  if (response.status === 'needs-auth') {
    await emitNeedsAuthAndExit(response.reason || 'owner authorization is required');
  }
  if (response.status === 'rate-limited') {
    emit({ status: 'rate-limited', message: 'Plaud is rate-limiting requests. Wait a moment and retry.' });
    process.exit(14);
  }
  if (response.status !== 'ok') fail('Plaud broker returned an invalid result', 12);
  const result = response.result;
  if (result && result.error) {
    emit({ status: 'mcp-error', tool: toolName, jsonrpc_error: result.error });
    process.exit(12);
  }
  // Per the MCP spec, a tool-level failure is a JSON-RPC SUCCESS whose result
  // carries isError:true with the error text in result.content — it is NOT
  // surfaced via the top-level msg.error field checked above. Without this
  // guard the error text flows back to callers (e.g. digestRecording pipes it
  // into psd-summarize) as if it were real tool content.
  if (result && result.isError) {
    // Truncate like the HTTP-failure branches above — this text originates
    // from the upstream MCP server, and digestRecording calls invokeTool
    // specifically so raw tool content never reaches stdout uncontrolled;
    // an error payload shouldn't be a wider bypass of that than a real HTTP
    // failure already is.
    const detail = extractTextFromResult(result);
    emit({ status: 'mcp-error', tool: toolName, tool_error: detail ? detail.slice(0, 400) : null });
    process.exit(12);
  }
  return result ?? null;
}

/** Invoke a tool and write the raw result to stdout (surfaced to the model). */
async function callTool(toolName, toolArgs) {
  const result = await invokeTool(toolName, toolArgs);
  process.stdout.write(JSON.stringify(result) + '\n');
  return result;
}

/** Concatenate the text blocks of an MCP tools/call result. */
function extractTextFromResult(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/**
 * digest — fetch a recording's transcript and return ONLY a records-safe
 * summary. The raw transcript is fetched here and piped to psd-summarize on
 * stdin; it NEVER touches this skill's stdout, so it never enters the agent's
 * context, chat, memory, logs, or telemetry. This is the DEFAULT way to get
 * recording content (raw `transcript` is the explicit exception).
 */
async function digestRecording(id, opts) {
  const result = await invokeTool('get_transcript', { file_id: id });
  const transcript = extractTextFromResult(result);
  if (!transcript) {
    emit({ status: 'empty', message: 'No transcript text is available for this recording.' });
    process.exit(0);
  }
  const { spawnSync } = require('node:child_process');
  const args = ['/opt/psd-skills/psd-summarize/run.js', '--context', 'Plaud voice recording transcript'];
  if (opts.profiles) args.push('--profiles', opts.profiles);
  if (opts.output) args.push('--output', opts.output);
  if (opts.length) args.push('--length', opts.length);
  const res = spawnSync('node', args, {
    input: transcript, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    fail(`summarization failed (exit ${res.status}): ${(res.stderr || '').slice(0, 300)}`, 12);
  }
  // psd-summarize emits {status:'ok', summary}. Only the summary leaves here.
  process.stdout.write((res.stdout || '').trim() + '\n');
}

/** List the server's tools (for `tools` subcommand / schema introspection). */
async function listTools() {
  const response = await requestAgentBroker('/api/agent/credentials', {
    operation: 'plaud-mcp',
    method: 'tools/list',
    toolArgs: {},
  });
  if (response.status === 'needs-auth') {
    await emitNeedsAuthAndExit(response.reason || 'owner authorization is required');
  }
  if (response.status !== 'ok') fail('Plaud tools/list failed', 12);
  process.stdout.write(JSON.stringify(response.result ?? null) + '\n');
  return response.result ?? null;
}

module.exports = {
  fail, emit, parseArgs, rejectAuthorityArgs,
  mintConsentUrl,
  emitNeedsAuthAndExit, callTool, digestRecording, listTools,
};
