/**
 * Shared Secrets Manager stub for psd-data's bun test files.
 *
 * Bun's `mock.module` registry is process-wide: `bun test` loads every
 * *.test.js file into the same process, so two files independently calling
 * `mock.module(...)` for the same specifier would clobber each other.
 * Centralizing the registration here — required once by both run.test.js
 * and common.test.js — keeps a single fake in effect for the whole test run.
 * Mirrors psd-plaud/mcp-test-support.js.
 */

'use strict';

const { mock } = require('bun:test');

class FakeGetSecretValueCommand {
  constructor(input) { this.input = input; }
}

const secretsStore = {};

class FakeSecretsManagerClient {
  async send(command) {
    if (command instanceof FakeGetSecretValueCommand) {
      const value = secretsStore[command.input.SecretId];
      if (value === undefined) {
        const err = new Error(`Secret ${command.input.SecretId} not found`);
        err.name = 'ResourceNotFoundException';
        throw err;
      }
      return { SecretString: JSON.stringify(value) };
    }
    throw new Error(`Unexpected Secrets Manager command: ${command.constructor.name}`);
  }
}

mock.module('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: FakeSecretsManagerClient,
  GetSecretValueCommand: FakeGetSecretValueCommand,
}));

module.exports = { secretsStore };
