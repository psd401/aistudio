// Transform: @swc/jest, NOT ts-jest.
//
// ts-jest drives the TypeScript compiler through its JavaScript API
// (`ts.sys`, `ts.findConfigFile`, `ts.readConfigFile`). TypeScript 7 — which
// infra moved to in #1209 — ships the native port, whose npm package exports
// only `./lib/version.cjs` from its main entry; every one of those functions is
// `undefined`. ts-jest therefore died on `ts.sys.fileExists` before running a
// single test, taking all 37 suites in both projects with it. No ts-jest release
// fixes this: the latest (29.4.12) still declares `typescript: ">=4.3 <7"`.
//
// #1209 already migrated the CDK runner off the same API (ts-node -> tsx) and
// simply missed jest, which nothing caught because CI does not run this config.
// SWC strips types without touching the TypeScript API, and is the same
// transform the root project uses through next/jest.
//
// Consequence, matching the root gate: these tests are no longer type-checked
// as a side effect of running. `bun run typecheck` (tsc -p infra/tsconfig.json)
// remains the type gate.
//
// RUN SERIALLY — `bun run test` passes `--runInBand`, and that is load-bearing,
// not a preference. The CDK suites synthesize stacks, which stages Lambda assets
// into shared directories; with jest's default worker pool several workers stage
// the same assets at once and the run DEADLOCKS — every worker sleeping at 0%
// CPU, no test output, forever. It does not reproduce in a tree that already has
// staged assets and nested lambda node_modules, which is why it only shows up on
// a clean checkout (i.e. CI). Verified on a fresh clone with only the two
// installs CI performs: parallel hung past 40 minutes, `--runInBand` finished
// all 58 suites in ~97s.
const swcTransform = (target) => [
  '@swc/jest',
  {
    jsc: {
      parser: { syntax: 'typescript' },
      target,
    },
    // Jest's runtime is CommonJS; infra/package.json is not `type: module`, so
    // this matches what `module: NodeNext` resolved to under ts-jest.
    module: { type: 'commonjs' },
  },
];

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
      // target mirrors infra/tsconfig.json ("target": "ES2022").
      transform: {
        '^.+\\.tsx?$': swcTransform('es2022')
      }
    },
    {
      displayName: 'lambdas',
      testEnvironment: 'node',
      roots: ['<rootDir>/lambdas'],
      testMatch: ['**/__tests__/**/*.test.ts'],
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
      // These suites import `bun:test` (`mock.module`, bun's `mock()`) and run
      // under `bun test`, not jest. embedding-generator's landed 2026-08-01,
      // while ts-jest was dead, so jest had never actually tried to collect it
      // until the transform was fixed — it is bun-only, not broken.
      testPathIgnorePatterns: [
        '<rootDir>/lambdas/agent-skill-builder/',
        '<rootDir>/lambdas/embedding-generator/__tests__/collected-generation-ack.test.ts',
      ],
      // target mirrors lambdas/tsconfig.test.json ("target": "ES2020"), which
      // ts-jest used to read via its `tsconfig` option.
      transform: {
        '^.+\\.tsx?$': swcTransform('es2020')
      }
    }
  ]
};
