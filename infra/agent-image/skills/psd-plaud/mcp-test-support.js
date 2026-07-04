/**
 * Shared Secrets Manager stub for psd-plaud's bun test files.
 *
 * Bun's `mock.module` registry is process-wide: `bun test` loads every
 * *.test.js file into the same process, so two files independently calling
 * `mock.module('@aws-sdk/client-secrets-manager', ...)` would clobber each
 * other (the later registration silently wins for both files). Centralizing
 * the registration here — required once by both run.test.js and
 * common.test.js — keeps a single fake in effect for the whole test run.
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
    if (command instanceof FakePutSecretValueCommand) {
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

module.exports = { secretsStore };
