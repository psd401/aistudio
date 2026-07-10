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
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            tsconfig: '<rootDir>/lambdas/tsconfig.test.json',
            isolatedModules: true
          }
        ]
      }
    }
  ]
};
