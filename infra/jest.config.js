module.exports = {
  projects: [
    {
      displayName: 'infra',
      testEnvironment: 'node',
      roots: ['<rootDir>/test'],
      testMatch: ['**/*.test.ts'],
      // `tsc` emits ignored JavaScript beside the TypeScript source. Resolve
      // TypeScript first so a prior build cannot make Jest exercise stale code.
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
      // CDK local bundling installs Lambda dependencies in-place. Pin this
      // package to the infra workspace copy so Jest mocks it consistently
      // before and after a synth has populated nested node_modules folders.
      moduleNameMapper: {
        '^@aws-sdk/client-sqs$': '<rootDir>/../node_modules/@aws-sdk/client-sqs'
      },
      transform: {
        '^.+\\.tsx?$': 'ts-jest'
      }
    },
    {
      displayName: 'lambdas',
      testEnvironment: 'node',
      roots: ['<rootDir>/lambdas'],
      testMatch: ['**/__tests__/**/*.test.ts'],
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
      // agent-skill-builder's suite imports `bun:test` and runs under
      // `bun test`, not jest.
      testPathIgnorePatterns: ['<rootDir>/lambdas/agent-skill-builder/'],
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            tsconfig: '<rootDir>/lambdas/tsconfig.test.json'
          }
        ]
      }
    }
  ]
};
