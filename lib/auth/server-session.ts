"use server"

import { createAuth } from "@/auth";
import logger from "@/lib/logger";
import { createRequestContext } from "./request-context";

export interface CognitoSession {
  sub: string;
  email?: string;
  givenName?: string | null;
  familyName?: string | null;
  /** Cognito ID token — available when session includes tokens (used for cognito_passthrough MCP auth) */
  idToken?: string;
  [key: string]: unknown;
}

/**
 * Gets the current authenticated session using NextAuth v5.
 * This wraps NextAuth's auth() to maintain the same interface.
 */
export async function getServerSession(): Promise<CognitoSession | null> {
  const context = await createRequestContext();
  
  try {
    // logger.debug("Creating auth instance", { requestId: context.requestId });
    
    // Create new auth instance per request
    const { auth } = createAuth();
    const session = await auth();
    
    if (!session?.user?.id) {
      // logger.debug("No session found", { requestId: context.requestId });
      return null;
    }
    
    // Validate session integrity
    if (session.user.id && session.user.email) {
      // logger.debug("Session validated", { 
      //   requestId: context.requestId,
      //   userId: session.user.id,
      //   // Never log full session data
      // });
    }
    
    // Convert NextAuth session to match our CognitoSession interface
    return {
      ...session.user,
      sub: session.user.id,
      email: session.user.email || undefined,
      givenName: session.user.givenName || undefined,
      familyName: session.user.familyName || undefined,
      idToken: session.idToken || undefined,
    };
  } catch (error) {
    // Sanitize error to prevent exposing sensitive information
    const sanitizedError = {
      message: error instanceof Error ? error.message : 'Unknown error',
      name: error instanceof Error ? error.name : 'Error',
      // Don't log stack traces or full error objects that might contain sensitive data
    };
    
    logger.error("Session retrieval failed:", { 
      error: sanitizedError, 
      requestId: context.requestId 
    });
    return null;
  }
}