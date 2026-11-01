#!/usr/bin/env node
/**
 * psd-prr — the caller's PSD Public Records (PRR) work via PRR's hosted MCP
 * server (https://prr.psd401.net/mcp), authenticated with the caller's OWN
 * personal access token.
 *
 * Usage:
 *   node run.js tools                                   (live tool list)
 *   node run.js call <psd_prr_tool> [--args '<json>']   (one tool call)
 *
 * The token (`prr_pat_…`, slot `prr_pat`) never enters this process. The
 * AI Studio web tier reads it from the owner-scoped credential broker, speaks
 * Streamable HTTP to PRR, and returns only the MCP result
 * (`executePrrOperation` in lib/agent-credentials/owner-operation-broker.ts).
 * When the token is missing or PRR rejects it (expired after at most 90 days,
 * or revoked), this skill mints a one-time credential-entry link for
 * `prr_pat` so the user can save a new one without pasting it into chat.
 *
 * Exit codes: 0 ok · 1 usage · 10 needs-auth · 11 forbidden ·
 *             12 mcp/upstream error · 14 rate-limited.
 */

'use strict';

const EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  needsAuth: 10,
  forbidden: 11,
  upstream: 12,
  rateLimited: 14,
});

const CREDENTIAL_NAME = 'prr_pat';
const TOKEN_PAGE = 'https://prr.psd401.net/agent-access';
// Shape check only, for a fast usage error. The web tier's allowlist of the
// eleven PRR tools is the boundary; this just keeps an obvious typo or a tool
// from another server from costing a broker round trip.
const TOOL_NAME_RE = /^psd_prr_[a-z0-9_]{1,64}$/;
const AUTHORITY_FLAGS = ['user', 'owner_email', 'user_email', 'user_id'];
const USAGE =
  "Usage: run.js tools | run.js call <psd_prr_tool> [--args '<json object>']\n";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
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

class UsageError extends Error {}

function toolArguments(raw) {
  if (raw === undefined) return {};
  let parsed;
  try { parsed = JSON.parse(String(raw)); }
  catch { throw new UsageError('--args must be a JSON object'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError('--args must be a JSON object');
  }
  return parsed;
}

/** Turn argv into the broker request body, or throw UsageError. */
function brokerRequest(args) {
  for (const name of AUTHORITY_FLAGS) {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      throw new UsageError(
        `--${name.replace(/_/g, '-')} is not accepted; identity comes from the signed invocation`,
      );
    }
  }
  const [subcommand, toolName] = args._;
  if (subcommand === 'tools') {
    return { operation: 'prr-mcp', method: 'tools/list', toolArgs: {} };
  }
  if (subcommand === 'call') {
    if (typeof toolName !== 'string' || !TOOL_NAME_RE.test(toolName)) {
      throw new UsageError('call requires a psd_prr_* tool name (run `tools` to list them)');
    }
    return {
      operation: 'prr-mcp',
      method: 'tools/call',
      toolName,
      toolArgs: toolArguments(args.args),
    };
  }
  throw new UsageError(`Unknown subcommand "${subcommand || ''}".`);
}

function resultText(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/**
 * The needs-auth payload. `code` (prr_token_missing / prr_token_rejected) is
 * also the signature the scheduled-run failure notice classifies on, so keep
 * it in the output verbatim.
 */
async function needsAuth(response, requestAgentBroker) {
  let url = null;
  try {
    const link = await requestAgentBroker('/api/agent/consent-link', {
      kind: 'credential_entry',
      name: CREDENTIAL_NAME,
    });
    if (link && typeof link.url === 'string') url = link.url;
  } catch {
    // Fall through with url null: the user still needs the instructions.
  }
  const code = response.code === 'prr_token_rejected'
    ? 'prr_token_rejected'
    : 'prr_token_missing';
  return {
    status: 'needs-auth',
    kind: 'prr',
    code,
    reason: response.reason || 'PRR personal access token is unavailable',
    credentialName: CREDENTIAL_NAME,
    url,
    expiresInMinutes: url ? 15 : null,
    tokenPage: TOKEN_PAGE,
    instructions: [
      code === 'prr_token_rejected'
        ? 'Tell the user PRR rejected their saved personal access token (it expired — tokens last at most 90 days — or was revoked).'
        : 'Tell the user their PSD Agent is not connected to Public Records yet.',
      `Step 1: they create a personal access token at ${TOKEN_PAGE} (it is shown once).`,
      url
        ? 'Step 2: send the url on a line by itself (no markdown, no parens, no trailing period); they paste the token into that page. The link works once and expires in 15 minutes.'
        : 'Step 2: the entry link could not be issued right now; ask them to reply when ready and run this command again to get a fresh link.',
      'Step 3: after they confirm it is saved, retry the original request.',
      'Do not ask the user to paste the token into chat, and do not store a pasted token with psd-credentials put.js. If they paste one anyway, tell them to revoke it at the PRR agent-access page and create a new one.',
    ],
  };
}

/** Map the broker's operation result to output + exit code. */
async function reportResponse(response, body, requestAgentBroker, emit) {
  const tool = body.toolName ?? null;
  const status = response && response.status;
  if (status === 'needs-auth') {
    emit(await needsAuth(response, requestAgentBroker));
    return EXIT.needsAuth;
  }
  if (status === 'forbidden') {
    emit({ status: 'forbidden', tool, detail: response.detail ?? null });
    return EXIT.forbidden;
  }
  if (status === 'rate-limited') {
    emit({ status: 'rate-limited', message: 'PRR is rate-limiting requests. Wait a moment and retry.' });
    return EXIT.rateLimited;
  }
  if (status !== 'ok') {
    emit({ status: 'error', message: 'PRR broker returned an invalid result' });
    return EXIT.upstream;
  }
  const result = response.result ?? null;
  if (result && result.error) {
    emit({ status: 'mcp-error', tool, jsonrpc_error: result.error });
    return EXIT.upstream;
  }
  // An MCP tool-level failure is a JSON-RPC success carrying isError:true.
  if (result && result.isError) {
    const detail = resultText(result);
    emit({ status: 'mcp-error', tool, tool_error: detail ? detail.slice(0, 400) : null });
    return EXIT.upstream;
  }
  emit(result);
  return EXIT.ok;
}

/**
 * Run one psd-prr command. Dependencies are injected so tests never touch the
 * network; returns the process exit code.
 */
async function runPrr(argv, deps) {
  const { requestAgentBroker, stdout, stderr } = deps;
  const emit = (value) => stdout(JSON.stringify(value) + '\n');
  const args = parseArgs(argv);
  if (args.help) { stdout(USAGE); return EXIT.ok; }

  let body;
  try { body = brokerRequest(args); }
  catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr(`psd-prr: ${error.message}\n${USAGE}`);
    return EXIT.usage;
  }

  let response;
  try { response = await requestAgentBroker('/api/agent/credentials', body); }
  catch (error) {
    stderr(`psd-prr: PRR broker request failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.upstream;
  }

  return reportResponse(response, body, requestAgentBroker, emit);
}

if (require.main === module) {
  const { requestAgentBroker } = require('../_shared/agent-broker');
  runPrr(process.argv.slice(2), {
    requestAgentBroker,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  })
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`psd-prr: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(EXIT.upstream);
    });
}

module.exports = { runPrr, EXIT };
