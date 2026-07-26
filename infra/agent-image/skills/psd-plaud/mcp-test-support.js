/**
 * Shared owner-bound broker stub for psd-plaud tests.
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
  putOwnerCredential: async (name, value) => {
    brokerCalls.push({ operation: 'put', name, value });
    credentialStore[name] = JSON.parse(value);
    return { name, action: 'rotated' };
  },
  requestAgentBroker: async (route, body) => {
    brokerCalls.push({ operation: 'request', route, body });
    return { url: 'https://app.test/agent-connect-plaud?token=test' };
  },
}));

module.exports = { credentialStore, brokerCalls };
