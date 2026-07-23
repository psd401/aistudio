/**
 * Shared Secrets Manager stub for psd-canva's bun test files.
 *
 * Bun's `mock.module` registry is process-wide: `bun test` loads every
 * *.test.js file into the same process, so two files independently calling
 * `mock.module('@aws-sdk/client-secrets-manager', ...)` would clobber each
 * other. Centralizing the registration here — required once by both
 * run.test.js and common.test.js — keeps a single fake in effect for the whole
 * test run.
 *
 * `secretsStore` is a plain, mutable object keyed by SecretId; each test file
 * populates/clears it in its own beforeEach.
 */

'use strict';

const { mock } = require('bun:test');

class FakeGetSecretValueCommand {
  constructor(input) { this.input = input; }
}
class FakePutSecretValueCommand {
  constructor(input) { this.input = input; }
}

const secretsStore = {};

// Set `smFailures.put` to an Error to make the next PutSecretValueCommand
// throw it (auto-clears after one throw).
const smFailures = { put: null };

class FakeSecretsManagerClient {
  async send(command) {
    if (command instanceof FakeGetSecretValueCommand) {
      const value = secretsStore[command.input.SecretId];
      if (value === undefined) {
        const err = new Error(`Secret ${command.input.SecretId} not found`);
        err.name = 'ResourceNotFoundException';
        throw err;
      }
      return { SecretString: typeof value === 'string' ? value : JSON.stringify(value) };
    }
    if (command instanceof FakePutSecretValueCommand) {
      if (smFailures.put) {
        const err = smFailures.put;
        smFailures.put = null;
        throw err;
      }
      secretsStore[command.input.SecretId] = JSON.parse(command.input.SecretString);
      return {};
    }
    throw new Error(`Unexpected Secrets Manager command: ${command.constructor.name}`);
  }
}

mock.module('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: FakeSecretsManagerClient,
  GetSecretValueCommand: FakeGetSecretValueCommand,
  PutSecretValueCommand: FakePutSecretValueCommand,
}));

module.exports = { secretsStore, smFailures };
