/**
 * Authentication Helper for Performance Testing
 *
 * Provides utilities for authenticating requests during performance tests.
 * Reuses patterns from e2e tests for consistency.
 */

import { getTestEnvironment } from '../config';

export interface AuthCredentials {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
}

/**
 * Get authentication token for performance tests
 *
 * For local development, this can use a test user or mock token.
 * For staging/production, this should use proper authentication flow.
 */
export async function getAuthToken(): Promise<string | undefined> {
  const env = getTestEnvironment();

  // If token is provided via environment, use it
  if (env.authToken) {
    return env.authToken;
  }

  // If test user credentials are provided, authenticate
  if (env.testUser) {
    return authenticateTestUser(env.testUser);
  }

  // For local testing, token may not be required if auth is disabled
  // or if using a local mock server
  return undefined;
}

/**
 * Authenticate test user and get access token
 *
 * IMPORTANT: This function does NOT implement Cognito authentication.
 * For staging/production testing, you MUST provide AUTH_TOKEN via environment.
 *
 * Only supports local testing without authentication.
 */
async function authenticateTestUser(
  _credentials: AuthCredentials
): Promise<string> {
  const env = getTestEnvironment();

  // Fail fast if trying to authenticate against non-local environment
  if (!env.baseUrl.includes('localhost')) {
    throw new Error(
      '\n' +
      '❌ Authentication Error: Real Cognito authentication not implemented\n' +
      '\n' +
      'This test helper does NOT implement AWS Cognito authentication.\n' +
      'To test against staging/production, you must provide a valid token:\n' +
      '\n' +
      '  export AUTH_TOKEN="your-valid-jwt-token"\n' +
      '\n' +
      'Alternatively, test against local environment:\n' +
      '  export TEST_ENV=local  # or omit for default\n' +
      '\n' +
      `Current target: ${env.baseUrl}\n`
    );
  }

  // Local testing only - return mock token
  console.warn('⚠️  Local testing mode - using mock authentication');
  return 'mock-local-dev-token';
}

/**
 * Create authenticated fetch headers
 */
export function createAuthHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}
