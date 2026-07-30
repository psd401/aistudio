/**
 * Owner-bound AI Studio repository client for psd-observances.
 *
 * The model runtime receives repository results only. OAuth grants and API keys
 * stay behind the existing trusted agent broker.
 */

'use strict';

const CONTAINER_BROKER_PATH = '/opt/psd-skills/_shared/agent-broker';

function loadAgentBroker() {
  try {
    return require('/opt/psd-skills/_shared/agent-broker');
  } catch (error) {
    const missingContainerModule =
      error &&
      error.code === 'MODULE_NOT_FOUND' &&
      String(error.message).includes(CONTAINER_BROKER_PATH);
    if (!missingContainerModule) throw error;
  }

  // Repo-tree fallback for local development and unit tests.
  return require('../_shared/agent-broker');
}

const { requestAgentBroker: defaultRequestAgentBroker } = loadAgentBroker();

const TOOL_SCOPES = Object.freeze({
  repositories_list: 'repositories:list',
  repositories_search: 'repositories:search',
});

class SkillFailure extends Error {
  constructor(message, code, exitCode, detail = undefined) {
    super(message);
    this.name = 'SkillFailure';
    this.code = code;
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

function fail(message, code = 'bad_args', exitCode = 1, detail = undefined) {
  throw new SkillFailure(message, code, exitCode, detail);
}

function reauthHint(toolName) {
  const scope = TOOL_SCOPES[toolName] || 'repository access';
  return (
    `Connect AI Studio access and retry. If it is already connected, reconnect ` +
    `it to authorize ${scope}.`
  );
}

function authFailure(toolName, detail) {
  fail(
    `AI Studio did not authorize this repository request. ${reauthHint(toolName)}`,
    'unauthorized',
    11,
    detail ? String(detail).slice(0, 512) : undefined,
  );
}

function textFromToolResult(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  const firstText = content.find(
    (part) => part && part.type === 'text' && typeof part.text === 'string',
  );
  if (!firstText) return result ?? null;

  try {
    return JSON.parse(firstText.text);
  } catch {
    return firstText.text;
  }
}

function looksUnauthorized(value) {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /unauthori[sz]ed|forbidden|insufficient scope|permission denied|credential is not configured/i.test(
    text,
  );
}

function assertSuccessfulHttpStatus(brokerResult, toolName) {
  const httpStatus = Number(brokerResult && brokerResult.httpStatus);
  if (httpStatus === 401 || httpStatus === 403) {
    authFailure(toolName, brokerResult && brokerResult.rawText);
  }
  if (httpStatus === 429) {
    fail(
      'AI Studio is rate-limiting repository requests. Wait briefly and retry.',
      'rate_limited',
      14,
    );
  }
  if (!Number.isInteger(httpStatus)) {
    fail(
      'The AI Studio broker returned a malformed response.',
      'upstream_error',
      12,
    );
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    fail(
      `AI Studio repository request failed with HTTP ${httpStatus}.`,
      'upstream_error',
      12,
    );
  }
  return httpStatus;
}

function parseMcpPayload(payload, toolName) {
  if (!payload || typeof payload !== 'object') {
    fail(
      'AI Studio returned a non-JSON repository response.',
      'upstream_error',
      12,
    );
  }

  if (payload.error) {
    if (looksUnauthorized(payload.error)) authFailure(toolName, payload.error);
    fail(
      `AI Studio MCP error: ${
        payload.error.message || JSON.stringify(payload.error)
      }`,
      'upstream_error',
      12,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
    fail(
      'AI Studio MCP returned no result.',
      'upstream_error',
      12,
    );
  }

  const result = payload.result;
  const data = textFromToolResult(result);
  if (result && result.isError) {
    if (looksUnauthorized(data)) authFailure(toolName, data);
    fail(
      `AI Studio repository tool failed: ${
        typeof data === 'string' ? data : JSON.stringify(data)
      }`,
      'upstream_error',
      12,
    );
  }
  return data;
}

function parseToolEnvelope(brokerResult, toolName) {
  assertSuccessfulHttpStatus(brokerResult, toolName);
  return parseMcpPayload(brokerResult && brokerResult.payload, toolName);
}

async function callRepositoryTool(
  toolName,
  toolArgs,
  requestAgentBroker = defaultRequestAgentBroker,
) {
  let brokerResult;
  try {
    brokerResult = await requestAgentBroker(
      '/api/agent/aistudio',
      {
        method: 'tools/call',
        params: { name: toolName, arguments: toolArgs },
      },
      { timeoutMs: 180_000 },
    );
  } catch (error) {
    const status = Number(error && error.status);
    if (
      status === 401 ||
      status === 403 ||
      looksUnauthorized(error instanceof Error ? error.message : error)
    ) {
      authFailure(
        toolName,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (status === 429) {
      fail(
        'AI Studio is rate-limiting repository requests. Wait briefly and retry.',
        'rate_limited',
        14,
      );
    }
    fail(
      `Could not reach the AI Studio repository service: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'upstream_error',
      12,
    );
  }

  return parseToolEnvelope(brokerResult, toolName);
}

module.exports = {
  SkillFailure,
  callRepositoryTool,
  defaultRequestAgentBroker,
  fail,
  loadAgentBroker,
  parseMcpPayload,
  parseToolEnvelope,
  reauthHint,
};
