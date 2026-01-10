const nextJest = require('next/jest');

const createJestConfig = nextJest({
  dir: './',
});

const customJestConfig = {
  setupFilesAfterEnv: [
    '<rootDir>/jest.setup.js',
    '<rootDir>/tests/setup.ts'
  ],
  testEnvironment: 'jest-environment-jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^uuid$': '<rootDir>/tests/mocks/uuid.js',
    'lucide-react': '<rootDir>/tests/mocks/lucide-react.js',
    'next-auth/react': '<rootDir>/tests/mocks/next-auth.js',
    'next/navigation': '<rootDir>/tests/mocks/next-navigation.js',
    '^@radix-ui/(.*)$': '<rootDir>/tests/mocks/radix-ui-primitives.js',
    '^@/components/ui/select$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/dialog$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/label$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/button$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/input$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/card$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/tabs$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/badge$': '<rootDir>/tests/mocks/radix-ui.js',
    '^@/components/ui/dropdown-menu$': '<rootDir>/tests/mocks/dropdown-menu.js',
    '^@/components/ui/scroll-area$': '<rootDir>/tests/mocks/scroll-area.js',
    '^@/components/ui/table$': '<rootDir>/tests/mocks/radix-ui.js'
  },
  setupFiles: ['<rootDir>/.jest/setEnvVars.js'],
  transformIgnorePatterns: [
    'node_modules/(?!(lucide-react|next-auth|@next-auth|nanoid)/)'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/e2e/',
    '/.next/',
    '/infra/', // Infra has its own Jest config
    '/infra/cdk.out/',
    'mock-sse-factory.ts' // Utility file, not a test file
  ]
};

module.exports = createJestConfig(customJestConfig); 