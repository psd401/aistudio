/**
 * Test Setup Validator
 *
 * Validates that performance tests have proper configuration before running.
 * Provides clear error messages when setup is incomplete.
 */

import { getTestEnvironment } from '../config';
import { getAuthToken } from './auth-helper';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate test environment setup
 */
export async function validateTestSetup(): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const env = getTestEnvironment();

  // Check if testing against a real API (not localhost without auth)
  const isRealAPI =
    !env.baseUrl.includes('localhost') ||
    env.baseUrl.includes('aistudio.psd401.ai');

  if (isRealAPI) {
    // Real API requires authentication
    const token = await getAuthToken();

    if (!token || token === 'mock-token-for-local-testing') {
      errors.push(
        'Performance tests require valid authentication when testing against real APIs.\n' +
        '\n' +
        'Please configure one of the following:\n' +
        '  1. Environment variable: export AUTH_TOKEN="your-jwt-token"\n' +
        '  2. Test user credentials:\n' +
        '     export TEST_USER_EMAIL="test@example.com"\n' +
        '     export TEST_USER_PASSWORD="your-password"\n' +
        '\n' +
        'For local testing without auth:\n' +
        '  - Ensure server is running on localhost:3000\n' +
        '  - Or use TEST_ENV=local (default)'
      );
    }
  } else {
    // Local testing - warn if server might not be running
    warnings.push(
      'Testing against localhost. Ensure development server is running:\n' +
      '  npm run dev  # or docker-compose up'
    );
  }

  // Validate environment configuration
  if (process.env.TEST_ENV && !['local', 'staging', 'production'].includes(process.env.TEST_ENV)) {
    warnings.push(
      `Unknown TEST_ENV value: "${process.env.TEST_ENV}". ` +
      'Valid values: local, staging, production'
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Check if we should skip performance tests
 *
 * Performance tests are skipped by default in CI environments unless explicitly enabled.
 * This prevents CI from hanging on tests that require a running server + authentication.
 */
export function shouldSkipPerformanceTests(): boolean {
  // If explicitly enabled, always run
  if (process.env.RUN_PERFORMANCE_TESTS === 'true') {
    return false;
  }

  // If in CI and not explicitly enabled, skip
  const isCI = process.env.CI === 'true' ||
               process.env.GITHUB_ACTIONS === 'true' ||
               process.env.CONTINUOUS_INTEGRATION === 'true';

  if (isCI) {
    console.log(
      '\n⏭️  Skipping performance tests in CI (not enabled)\n' +
      '   To run in CI: set RUN_PERFORMANCE_TESTS=true\n'
    );
    return true;
  }

  // In local environments, don't skip by default
  return false;
}

/**
 * Assert that test setup is valid, throwing descriptive error if not
 */
export async function assertValidTestSetup(): Promise<void> {
  const result = await validateTestSetup();

  if (result.warnings.length > 0) {
    console.warn('\n⚠️  Setup Warnings:');
    for (const warning of result.warnings) {
      console.warn(`   ${warning}`);
    }
    console.warn('');
  }

  if (!result.isValid) {
    const errorMessage = [
      '',
      '❌ Performance Test Setup Invalid',
      '',
      ...result.errors.map(err => `   ${err}`),
      '',
      'Fix the above issues and try again.',
      ''
    ].join('\n');

    throw new Error(errorMessage);
  }
}

/**
 * Create a beforeAll hook that validates setup
 *
 * Usage in tests:
 * ```typescript
 * import { createSetupValidator } from './lib/test-setup-validator';
 *
 * describe('My Performance Test', () => {
 *   beforeAll(createSetupValidator());
 *
 *   test('runs successfully', async () => {
 *     // test code
 *   });
 * });
 * ```
 */
export function createSetupValidator() {
  return async () => {
    await assertValidTestSetup();
  };
}
