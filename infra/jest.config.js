module.exports = {
  testEnvironment: 'node',
  // document-processor-v2 ships its own __tests__ dirs (chunkText, html-sanitizer,
  // lambda-logger, office-processor, handler) that were previously invisible to any
  // Jest run — `roots` scopes test *discovery* itself, not just filtering, so listing
  // only `test` here made every lambda test file dead weight with zero CI signal.
  // Scoped to this lambda (not all of infra/lambdas) to avoid pulling in sibling
  // lambda test suites (agent-triage-poll, agent-router) that this change hasn't
  // verified against this config.
  roots: ['<rootDir>/test', '<rootDir>/lambdas/document-processor-v2'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  }
};
