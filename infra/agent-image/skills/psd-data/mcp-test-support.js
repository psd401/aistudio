/**
 * Shared owner-bound broker stub for psd-data tests.
 */

'use strict';

const { mock } = require('bun:test');
const path = require('node:path');

const credentialStore = {};
const brokerCalls = [];
const modulePath = path.resolve(__dirname, '..', '_shared', 'agent-broker.js');

mock.module(modulePath, () => ({
  getOwnerCredential: async (name) => {
    brokerCalls.push({ operation: 'get', name });
    const value = credentialStore[name];
    return value === undefined
      ? null
      : { name, value: JSON.stringify(value), scope: 'user' };
  },
  requestAgentBroker: async (route, body) => {
    brokerCalls.push({ operation: 'request', route, body });
    return { url: 'https://app.test/agent-connect-data?token=test' };
  },
}));

module.exports = { credentialStore, brokerCalls };
