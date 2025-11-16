import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.auth.federated-signout");
  const log = createLogger({ requestId, route: "api.auth.federated-signout" });
  
  log.info("GET /api/auth/federated-signout - Processing federated signout");
  
  try {
    // Build Cognito logout URL first
    const cognitoDomain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN;
    const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
    const baseUrl = process.env.AUTH_URL || 'http://localhost:3000';
    
    if (!cognitoDomain || !clientId) {
      log.error('Missing Cognito configuration for logout');
      timer({ status: "error", reason: "missing_config" });
      return NextResponse.redirect(new URL('/', baseUrl));
    }
    
    // Use the exact logout URI that's configured in CDK (with trailing slash)
    const logoutUri = `${baseUrl}/`;
    const cognitoLogoutUrl = `https://${cognitoDomain}/logout?client_id=${clientId}&logout_uri=${encodeURIComponent(logoutUri)}`;
    
    
    // Create redirect response and clear all auth cookies
    const response = NextResponse.redirect(cognitoLogoutUrl);
    
    // Clear NextAuth session cookies
    const cookieStore = await cookies();
    const allCookies = cookieStore.getAll();
    
    // Clear each auth-related cookie
    for (const cookie of allCookies) {
      if (cookie.name.includes('auth') ||
          cookie.name.includes('session') ||
          cookie.name.includes('csrf') ||
          cookie.name.includes('callback') ||
          cookie.name.includes('pkce') ||
          cookie.name.includes('state') ||
          cookie.name.includes('nonce')) {
        response.cookies.set(cookie.name, '', {
          expires: new Date(0),
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production'
        });
      }
    }
    
    // Also try to clear with specific cookie names
    const cookiesToClear = [
      'authjs.session-token',
      'authjs.session-token.0',
      'authjs.session-token.1',
      'authjs.csrf-token',
      'authjs.callback-url',
      'authjs.pkce.code_verifier',
      'authjs.state',
      'authjs.nonce',
      '__Secure-authjs.session-token',
      '__Secure-authjs.session-token.0',
      '__Secure-authjs.session-token.1',
    ];
    
    for (const cookieName of cookiesToClear) {
      response.cookies.set(cookieName, '', {
        expires: new Date(0),
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: false
      });
    }
    
    log.info("Federated signout successful");
    timer({ status: "success" });
    return response;
  } catch (error) {
    timer({ status: "error" });
    log.error('Federated signout error', error);
    return NextResponse.redirect(new URL('/', process.env.AUTH_URL || 'http://localhost:3000'));
  }
}