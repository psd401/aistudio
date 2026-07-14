/**
 * Shared Secrets Manager mock for psd-aistudio's bun test files.
 *
 * Bun's `mock.module` registry is process-wide: `bun test` loads every *.test.js
 * file into ONE process, so centralizing the stub here — required once by
 * common.test.js — keeps a single fake in effect for the whole run. Keyed by
 * SecretId via `secretsStore`; each test populates/clears it in beforeEach. This
 * covers the SHARED-key fallback path.
 *
 * The PER-USER key path (which shells out to `psd-credentials/get.js` via
 * execFileSync) is NOT stubbed here — bun's mock.module does not intercept
 * `node:` builtin requires. It is stubbed via common's `_internals.execFileSync`
 * seam directly in common.test.js instead.
 */

'use strict';

const { mock } = require('bun:test');

// ── Secrets Manager (shared-key fallback) ──────────────────────────────────────
class FakeGetSecretValueCommand {
  constructor(input) {
    this.input = input;
  }
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
      return {
        SecretString: typeof value === 'string' ? value : JSON.stringify(value),
      };
    }
    throw new Error(
      `Unexpected Secrets Manager command: ${command.constructor.name}`
    );
  }
}

mock.module('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: FakeSecretsManagerClient,
  GetSecretValueCommand: FakeGetSecretValueCommand,
}));

module.exports = { secretsStore };
