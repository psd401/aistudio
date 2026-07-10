module.exports = {
  projects: [
    {
      displayName: 'infra',
      testEnvironment: 'node',
      roots: ['<rootDir>/test'],
      testMatch: ['**/*.test.ts'],
      transform: {
        '^.+\\.tsx?$': 'ts-jest'
      }
    },
    {
      displayName: 'lambdas',
      testEnvironment: 'node',
      roots: ['<rootDir>/lambdas'],
      testMatch: ['**/__tests__/**/*.test.ts'],
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
