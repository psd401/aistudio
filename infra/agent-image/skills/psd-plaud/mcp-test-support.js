/**
 * Shared owner-bound broker stub for psd-plaud tests.
 */

'use strict';

const { mock } = require('bun:test');
const path = require('node:path');

const credentialStore = {};
const brokerCalls = [];
const operationResults = [];
const modulePath = path.resolve(__dirname, '..', '_shared', 'agent-broker.js');

mock.module(modulePath, () => ({
  requestAgentBroker: async (route, body) => {
    brokerCalls.push({ operation: 'request', route, body });
    if (route === '/api/agent/credentials') {
      return { status: 'ok', result: operationResults.shift() };
    }
    return { url: 'https://app.test/agent-connect-plaud?token=test' };
  },
}));

module.exports = { credentialStore, brokerCalls, operationResults };
