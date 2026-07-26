/** Owner-bound classified-evaluation gateway client. */

'use strict';

const { requestAgentBroker } = require('../_shared/agent-broker');

const RATING_VALUES = [
  'Requires Improvement',
  'Fair',
  'Satisfactory',
  'Good',
  'Outstanding',
];

class GatewayConfigError extends Error {}
class GatewayTransportError extends Error {}
class GatewayToolError extends Error {
  constructor(message, rpcError) {
    super(message);
    this.rpcError = rpcError;
  }
}

const _internals = { requestAgentBroker };

/**
 * The model-facing process submits only a named tool and arguments. The web
 * broker derives evaluator identity from the signed invocation, loads the
 * platform gateway credential, pins the SSE/message endpoints, and executes
 * the one-shot MCP exchange.
 */
async function callGatewayTool(toolName, toolArgs) {
  try {
    return await _internals.requestAgentBroker(
      '/api/agent/classified-evaluation',
      { toolName, arguments: toolArgs || {} },
      { timeoutMs: 155_000 }
    );
  } catch (err) {
    if (err && err.status === 503) {
      throw new GatewayConfigError(
        'The classified evaluation gateway is not configured.'
      );
    }
    if (err && err.status === 422) {
      throw new GatewayToolError(
        'The classified evaluation gateway rejected the operation.',
        err.responseBody && err.responseBody.detail
      );
    }
    throw new GatewayTransportError(
      err instanceof Error ? err.message : String(err)
    );
  }
}

module.exports = {
  RATING_VALUES,
  GatewayConfigError,
  GatewayTransportError,
  GatewayToolError,
  callGatewayTool,
  _internals,
};
