/** Owner-bound PSD workflow gateway broker client. */

'use strict';

const { requestAgentBroker } = require('../_shared/agent-broker');

class GatewayConfigError extends Error {}
class GatewayTransportError extends Error {}
class GatewayToolError extends Error {
  constructor(message, responseBody) {
    super(message);
    this.responseBody = responseBody;
  }
}

const _internals = { requestAgentBroker };

async function requestGateway(payload) {
  try {
    return await _internals.requestAgentBroker(
      '/api/agent/workflow-gateway',
      payload,
      { timeoutMs: 155_000 }
    );
  } catch (err) {
    if (err && err.status === 503) {
      throw new GatewayConfigError('The PSD workflow gateway is not configured.');
    }
    if (err && (err.status === 400 || err.status === 422)) {
      throw new GatewayToolError(
        err.responseBody && typeof err.responseBody.error === 'string'
          ? err.responseBody.error
          : 'The PSD workflow gateway rejected the operation.',
        err.responseBody
      );
    }
    throw new GatewayTransportError(
      err instanceof Error ? err.message : String(err)
    );
  }
}

async function listGatewayTools() {
  const response = await requestGateway({ action: 'list-tools' });
  if (!response || !Array.isArray(response.tools)) {
    throw new GatewayTransportError('The PSD workflow gateway returned an invalid roster.');
  }
  return response.tools;
}

async function callGatewayTool(toolName, toolArgs) {
  return requestGateway({
    toolName,
    arguments: toolArgs || {},
  });
}

module.exports = {
  GatewayConfigError,
  GatewayTransportError,
  GatewayToolError,
  listGatewayTools,
  callGatewayTool,
  _internals,
};
