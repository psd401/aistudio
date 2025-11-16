/**
 * Cookie utilities for managing authentication cookies
 */

const COOKIE_PREFIX = 'CognitoIdentityServiceProvider';
const AMPLIFY_COOKIE_PREFIX = 'amplify';

/**
 * Get all authentication-related cookie patterns
 */
export function getAuthCookiePatterns(): RegExp[] {
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;

  return [
    // Cognito specific cookies
    // eslint-disable-next-line security/detect-non-literal-regexp -- clientId from environment variable, not user input
    new RegExp(`^${COOKIE_PREFIX}\\.${clientId}\\..+`),
    // Generic Cognito cookies
    new RegExp(`^${COOKIE_PREFIX}\\..+`),
    // Amplify cookies
    new RegExp(`^${AMPLIFY_COOKIE_PREFIX}-.+`),
    // Legacy patterns
    /^accessToken$/,
    /^idToken$/,
    /^refreshToken$/,
    // AWS specific
    /^aws-cognito-.+/,
  ];
}

/**
 * Clear all authentication cookies on the client side
 */
export function clearAuthCookiesClient(): void {
  const patterns = getAuthCookiePatterns();
  
  // Get all cookies
  const cookies = document.cookie.split(';');
  
  for (const cookie of cookies) {
    const eqPos = cookie.indexOf('=');
    const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
    
    // Check if cookie matches any auth pattern
    if (patterns.some(pattern => pattern.test(name))) {
      // Clear cookie for all possible paths and domains
      const domains = [
        '', // current domain
        window.location.hostname,
        `.${window.location.hostname}`,
        'localhost',
        '.localhost'
      ];
      
      const paths = ['/', '/api', '/api/auth'];
      
      for (const domain of domains) {
        for (const path of paths) {
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=${path};${domain ? ` domain=${domain};` : ''}`;
          // Also try with secure and sameSite flags
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=${path};${domain ? ` domain=${domain};` : ''} secure; sameSite=lax;`;
        }
      }
    }
  }
}

/**
 * Get cookie clearing headers for server-side responses
 */
export function getCookieClearingHeaders(): string[] {
  const headers: string[] = [];
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || '';
  
  // Common cookie names to clear
  const cookieNames = [
    `${COOKIE_PREFIX}.${clientId}.accessToken`,
    `${COOKIE_PREFIX}.${clientId}.idToken`,
    `${COOKIE_PREFIX}.${clientId}.refreshToken`,
    `${COOKIE_PREFIX}.${clientId}.clockDrift`,
    `${COOKIE_PREFIX}.${clientId}.LastAuthUser`,
    'accessToken',
    'idToken',
    'refreshToken',
  ];
  
  // Add patterns for Amplify cookies
  for (let i = 0; i < 10; i++) {
    cookieNames.push(`${AMPLIFY_COOKIE_PREFIX}-${i}`);
  }
  
  const paths = ['/', '/api', '/api/auth'];
  
  for (const name of cookieNames) {
    for (const path of paths) {
      headers.push(`${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=${path}; httpOnly; secure; sameSite=lax`);
      headers.push(`${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=${path}`);
    }
  }
  
  return headers;
}