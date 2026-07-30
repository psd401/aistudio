#!/usr/bin/env node

"use strict";

const {
  requestAgentBroker,
} = require("../_shared/agent-broker");

const DEFAULT_MAX_WAIT_MIN = 20;
const POLL_INTERVAL_MS = 20_000;
const BROKER_TIMEOUT_MS = 30_000;
const EMAIL_RE = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/;

class ResearchCliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ResearchCliError";
    this.code = code;
    Object.assign(this, details);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      args.help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new ResearchCliError(
        "bad_args",
        `Unexpected positional argument: ${argument}`,
      );
    }
    const key = argument.slice(2).replace(/-/g, "_");
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function validatedArgs(args) {
  if (typeof args.user !== "string" || !EMAIL_RE.test(args.user)) {
    throw new ResearchCliError(
      "bad_args",
      "--user is required and must be the caller email",
    );
  }
  const hasPrompt = typeof args.prompt === "string" && args.prompt.trim().length > 0;
  const hasCheck = typeof args.check === "string" && args.check.length > 0;
  if (hasPrompt === hasCheck) {
    throw new ResearchCliError(
      "bad_args",
      "Provide exactly one of --prompt or --check",
    );
  }
  const maxWaitMin =
    args.max_wait_min === undefined
      ? DEFAULT_MAX_WAIT_MIN
      : Number(args.max_wait_min);
  if (!Number.isFinite(maxWaitMin) || maxWaitMin <= 0) {
    throw new ResearchCliError(
      "bad_args",
      "--max-wait-min must be a positive number",
    );
  }
  return {
    user: args.user,
    prompt: hasPrompt ? args.prompt.trim() : null,
    interactionId: hasCheck ? args.check : null,
    maxWaitMs: maxWaitMin * 60_000,
  };
}

function resumeCommand(user, interactionId) {
  return (
    "node /opt/psd-skills/psd-deep-research/research.js " +
    `--user ${shellQuote(user)} --check ${shellQuote(interactionId)}`
  );
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function validateStartResult(result) {
  if (
    !result ||
    typeof result !== "object" ||
    typeof result.interactionId !== "string" ||
    result.interactionId.length === 0 ||
    typeof result.status !== "string"
  ) {
    throw new ResearchCliError(
      "upstream_error",
      "Deep Research broker returned an invalid start response",
    );
  }
  return result;
}

function validateStatusResult(result, interactionId) {
  if (
    !result ||
    typeof result !== "object" ||
    result.interactionId !== interactionId ||
    typeof result.status !== "string" ||
    !Number.isFinite(result.elapsedSec)
  ) {
    throw new ResearchCliError(
      "upstream_error",
      "Deep Research broker returned an invalid status response",
      { interactionId },
    );
  }
  if (
    result.status === "completed" &&
    (typeof result.report !== "string" || !Array.isArray(result.citations))
  ) {
    throw new ResearchCliError(
      "upstream_error",
      "Deep Research broker returned an invalid completed report",
      { interactionId },
    );
  }
  return result;
}

async function requestStart(prompt, broker) {
  return validateStartResult(
    await broker(
      "/api/agent/credentials",
      { operation: "deep-research-start", prompt },
      { timeoutMs: BROKER_TIMEOUT_MS },
    ),
  );
}

async function requestStatus(interactionId, broker) {
  return validateStatusResult(
    await broker(
      "/api/agent/credentials",
      { operation: "deep-research-status", interactionId },
      { timeoutMs: BROKER_TIMEOUT_MS },
    ),
    interactionId,
  );
}

async function requestRecoverableStatus(interactionId, user, broker) {
  try {
    return await requestStatus(interactionId, broker);
  } catch (error) {
    const output = errorOutput(error);
    throw new ResearchCliError(output.error, output.message, {
      interactionId,
      resumeCommand: resumeCommand(user, interactionId),
    });
  }
}

function completedOutput(status) {
  return {
    report: status.report,
    citations: status.citations,
    interactionId: status.interactionId,
    durationMs: Math.max(0, Math.round(status.elapsedSec * 1_000)),
  };
}

function pendingOutput(status, user) {
  return {
    interactionId: status.interactionId,
    status: status.status,
    elapsedSec: status.elapsedSec,
    resumeCommand: resumeCommand(user, status.interactionId),
  };
}

async function runResearch(
  args,
  dependencies = {},
) {
  const options = validatedArgs(args);
  const broker = dependencies.broker || requestAgentBroker;
  const sleep =
    dependencies.sleep ||
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const now = dependencies.now || Date.now;

  if (options.interactionId) {
    const status = await requestRecoverableStatus(
      options.interactionId,
      options.user,
      broker,
    );
    return status.status === "completed"
      ? completedOutput(status)
      : pendingOutput(status, options.user);
  }

  const startedAt = now();
  const started = await requestStart(options.prompt, broker);
  const interactionId = started.interactionId;

  while (true) {
    const status = await requestRecoverableStatus(
      interactionId,
      options.user,
      broker,
    );
    if (status.status === "completed") {
      return completedOutput(status);
    }
    const remainingMs = options.maxWaitMs - (now() - startedAt);
    if (remainingMs <= 0) {
      throw new ResearchCliError(
        "timeout",
        "Deep Research is still running. Resume it with --check instead of starting a new run.",
        {
          interactionId,
          resumeCommand: resumeCommand(options.user, interactionId),
        },
      );
    }
    await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
  }
}

function errorOutput(error) {
  if (error instanceof ResearchCliError) {
    return {
      error: error.code,
      message: error.message,
      ...(error.interactionId ? { interactionId: error.interactionId } : {}),
      ...(error.resumeCommand ? { resumeCommand: error.resumeCommand } : {}),
    };
  }
  const responseBody =
    error && typeof error === "object" && error.responseBody
      ? error.responseBody
      : null;
  const code =
    responseBody &&
    typeof responseBody === "object" &&
    typeof responseBody.code === "string"
      ? responseBody.code
      : "upstream_error";
  return {
    error: code,
    message: error instanceof Error ? error.message : String(error),
  };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      "Usage: research.js --user <caller-email> (--prompt <question> | --check <interactionId>) [--max-wait-min 20]\n",
    );
    return;
  }
  writeJson(await runResearch(args));
}

if (require.main === module) {
  main().catch((error) => {
    const output = errorOutput(error);
    process.stderr.write(`Error: ${output.message}\n`);
    writeJson(output);
    process.exitCode = 1;
  });
}

module.exports = {
  BROKER_TIMEOUT_MS,
  DEFAULT_MAX_WAIT_MIN,
  POLL_INTERVAL_MS,
  ResearchCliError,
  errorOutput,
  parseArgs,
  runResearch,
};
