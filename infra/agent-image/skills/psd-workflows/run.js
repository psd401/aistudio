#!/usr/bin/env node

/**
 * psd-workflows — dynamic CLI for the PSD Agent Gateway roster.
 *
 * Subcommands:
 *   list
 *   describe --tool <name>
 *   call --tool <name> --user <caller-email>
 *        [--json <inline> | --json-file <path>]
 *
 * Exit codes: 0 success, 2 bad args, 11 not configured, 12 transport,
 * 13 gateway/tool error.
 */

'use strict';

const { validatedFs } = require('../../../validated-fs.cjs');
const gateway = require('./gateway');

const CALLER_BOUND_MARKER = '[caller-bound]';
const MUTATING_TOOL_PREFIXES = [
  'approve_',
  'cancel_',
  'create_',
  'delete_',
  'reject_',
  'submit_',
  'update_',
];
const USAGE = `Usage:
  node run.js list
  node run.js describe --tool <name>
  node run.js call --tool <name> --user <caller-email> [--json <inline> | --json-file <path>]`;

class CliError extends Error {
  constructor(message, code = 2, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

function statusForCode(code) {
  switch (code) {
    case 11: return 'not-configured';
    case 12: return 'transport-error';
    case 13: return 'gateway-error';
    default: return 'bad-args';
  }
}

function isEmailish(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 254) return false;
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

function parseArgs(argv) {
  const args = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new CliError(`Unexpected positional argument: ${arg}\n${USAGE}`);
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

function assertOnlyArgs(args, allowed) {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new CliError(`Unexpected option(s): ${unexpected.join(', ')}\n${USAGE}`);
  }
}

function requireTool(args) {
  const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
  if (!tool || tool.length > 256) {
    throw new CliError(`--tool <name> is required.\n${USAGE}`);
  }
  return tool;
}

function requireUser(args) {
  const user = typeof args.user === 'string' ? args.user : '';
  if (!isEmailish(user)) {
    throw new CliError(
      '--user <caller-email> is required verbatim from the caller header.'
    );
  }
  return user;
}

function loadCallArgs(args, readFileSync = validatedFs.readFileSync) {
  if (typeof args.json === 'string' && typeof args.json_file === 'string') {
    throw new CliError('Use only one of --json or --json-file.');
  }
  let raw;
  if (typeof args.json_file === 'string') {
    try {
      raw = readFileSync(args.json_file, 'utf8');
    } catch (error) {
      throw new CliError(
        `Could not read --json-file ${args.json_file}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  } else if (typeof args.json === 'string') {
    raw = args.json;
  } else {
    return Object.create(null);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(
      `--json/--json-file is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('The workflow payload must be a JSON object.');
  }
  return parsed;
}

function callerBoundArgumentNames(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return [];
  const properties = inputSchema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.entries(properties).flatMap(([name, schema]) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
    return typeof schema.description === 'string' &&
      schema.description.includes(CALLER_BOUND_MARKER)
      ? [name]
      : [];
  });
}

function bindCallerArguments(payload, callerArgumentNames, user) {
  const result = Object.assign(Object.create(null), payload);
  for (const name of callerArgumentNames) result[name] = user;
  return result;
}

function familyForTool(name) {
  const withoutAction = name.replace(
    /^(?:approve|cancel|create|delete|get|list|reject|submit|update)_/,
    ''
  );
  const family = withoutAction.replace(/_schema$/, '');
  return family || 'other';
}

function isMutatingToolName(name) {
  return MUTATING_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function groupTools(tools) {
  const groups = new Map();
  for (const tool of tools) {
    const family = familyForTool(tool.name);
    const members = groups.get(family) || [];
    members.push(tool);
    groups.set(family, members);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([family, members]) => ({
      family,
      tools: members.sort((left, right) => left.name.localeCompare(right.name)),
    }));
}

function findTool(tools, toolName) {
  return tools.find((tool) => tool && tool.name === toolName);
}

function gatewayErrorToCliError(error) {
  if (error instanceof gateway.GatewayConfigError) {
    return new CliError(error.message, 11);
  }
  if (error instanceof gateway.GatewayToolError) {
    return new CliError(error.message, 13, { gateway: error.responseBody });
  }
  if (error instanceof gateway.GatewayTransportError) {
    return new CliError(error.message, 12);
  }
  return error instanceof CliError
    ? error
    : new CliError(error instanceof Error ? error.message : String(error), 12);
}

async function runList(args, listGatewayTools) {
  assertOnlyArgs(args, []);
  return { families: groupTools(await listGatewayTools()) };
}

async function runDescribe(args, listGatewayTools) {
  assertOnlyArgs(args, ['tool']);
  const toolName = requireTool(args);
  const tool = findTool(await listGatewayTools(), toolName);
  if (!tool) throw new CliError(`Tool "${toolName}" is not in the live roster.`, 13);
  return tool;
}

async function runCall(args, dependencies) {
  assertOnlyArgs(args, ['tool', 'user', 'json', 'json_file']);
  const toolName = requireTool(args);
  const user = requireUser(args);
  const payload = loadCallArgs(args, dependencies.readFileSync);
  const tool = findTool(await dependencies.listGatewayTools(), toolName);
  if (!tool) throw new CliError(`Tool "${toolName}" is not in the live roster.`, 13);
  const callerArguments = callerBoundArgumentNames(tool.inputSchema);
  if (isMutatingToolName(toolName) && callerArguments.length === 0) {
    throw new CliError(
      `Gateway mutating tool "${toolName}" is missing a ${CALLER_BOUND_MARKER} argument marker.`,
      13
    );
  }
  const response = await dependencies.callGatewayTool(
    toolName,
    bindCallerArguments(payload, callerArguments, user)
  );
  if (response.isError) {
    throw new CliError(
      'The gateway reported an error for this request.',
      13,
      { tool: toolName, data: response.data }
    );
  }
  return response.data;
}

async function run(argv, dependencies = {}) {
  const listGatewayTools =
    dependencies.listGatewayTools || gateway.listGatewayTools;
  const callGatewayTool =
    dependencies.callGatewayTool || gateway.callGatewayTool;
  const readFileSync = dependencies.readFileSync || validatedFs.readFileSync;
  const subcommand = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const args = parseArgs(subcommand ? argv.slice(1) : argv);

  if (args.help || subcommand === null) return USAGE;
  try {
    if (subcommand === 'list') return runList(args, listGatewayTools);
    if (subcommand === 'describe') return runDescribe(args, listGatewayTools);
    if (subcommand === 'call') {
      return runCall(args, { listGatewayTools, callGatewayTool, readFileSync });
    }
    throw new CliError(`Unknown subcommand: ${subcommand}\n${USAGE}`);
  } catch (error) {
    throw gatewayErrorToCliError(error);
  }
}

async function main(argv = process.argv.slice(2), dependencies = {}, write = process.stdout.write.bind(process.stdout)) {
  try {
    const result = await run(argv, dependencies);
    write(typeof result === 'string' ? `${result}\n` : `${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const failure = gatewayErrorToCliError(error);
    write(`${JSON.stringify({
      status: statusForCode(failure.code),
      message: failure.message,
      ...failure.extra,
    })}\n`);
    return failure.code;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  CliError,
  USAGE,
  bindCallerArguments,
  callerBoundArgumentNames,
  familyForTool,
  groupTools,
  isMutatingToolName,
  loadCallArgs,
  main,
  parseArgs,
  requireTool,
  requireUser,
  run,
  statusForCode,
};
