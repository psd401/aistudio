"use server"

import {
  checkUserRole,
  hasCapabilityAccess as dbHasCapabilityAccess,
  getUserCapabilities as dbGetUserCapabilities,
  getUserIdByCognitoSub,
  getUserRolesByCognitoSub as dbGetUserRolesByCognitoSub
} from "@/lib/db/drizzle";
import { getServerSession } from "@/lib/auth/server-session";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import type { Role } from '@/types';

const roleHierarchy: Record<Role, number> = {
  student: 0,
  staff: 1,
  administrator: 2
};

/**
 * Check if a user has a specific role
 */
export async function hasRole(roleName: string): Promise<boolean> {
  const requestId = generateRequestId();
  const timer = startTimer("hasRole");
  const log = createLogger({ requestId, function: "hasRole" });
  
  log.debug("Checking user role", { roleName });
  
  const session = await getServerSession();
  if (!session) {
    log.warn("Role check failed - no session", { roleName });
    timer({ status: "failed", reason: "no_session" });
    return false;
  }
  
  const userId = await getUserIdByCognitoSub(session.sub);
  if (!userId) {
    log.warn("Role check failed - user not found", { 
      cognitoSub: session.sub,
      roleName 
    });
    timer({ status: "failed", reason: "user_not_found" });
    return false;
  }
  
  const hasAccess = await checkUserRole(Number(userId), roleName);
  
  if (hasAccess) {
    log.info("Role check successful", { 
      userId,
      roleName,
      cognitoSub: session.sub 
    });
    timer({ status: "success" });
  } else {
    log.warn("Role check denied", { 
      userId,
      roleName,
      cognitoSub: session.sub 
    });
    timer({ status: "denied" });
  }
  
  return hasAccess;
}

/**
 * Check if the current user has access to a role-gated capability.
 *
 * Capabilities are the role-gated UI-feature registry (Nexus access, Assistant
 * Architect access, admin pages, etc.). This resolves the session itself and
 * delegates to the `capabilities`/`role_capabilities`-backed DB accessor.
 *
 * NOTE: not to be confused with `hasCapability()` in `@/lib/ai/capability-utils`,
 * which checks AI-model feature flags (image generation, web search, etc.).
 * See `docs/architecture/capabilities-and-scopes.md`.
 */
export async function hasCapabilityAccess(capabilityIdentifier: string): Promise<boolean> {
  const requestId = generateRequestId();
  const timer = startTimer("hasCapabilityAccess");
  const log = createLogger({ requestId, function: "hasCapabilityAccess" });

  log.debug("Checking capability access", { capabilityIdentifier });

  const session = await getServerSession();
  if (!session) {
    log.warn("Capability access check failed - no session", { capabilityIdentifier });
    timer({ status: "failed", reason: "no_session" });
    return false;
  }

  log.debug("Session found, checking database", {
    cognitoSub: session.sub,
    capabilityIdentifier
  });

  const hasAccess = await dbHasCapabilityAccess(session.sub, capabilityIdentifier);

  if (hasAccess) {
    log.info("Capability access granted", {
      cognitoSub: session.sub,
      capabilityIdentifier
    });
    timer({ status: "success" });
  } else {
    log.warn("Capability access denied", {
      cognitoSub: session.sub,
      capabilityIdentifier
    });
    timer({ status: "denied" });
  }

  return hasAccess;
}

/**
 * Get all capability identifiers the current user has access to.
 */
export async function getUserCapabilities(): Promise<string[]> {
  const session = await getServerSession();
  if (!session) return [];

  return dbGetUserCapabilities(session.sub);
}

/**
 * Get all roles a user has
 */
export async function getUserRoles(userId: string): Promise<string[]> {
  const requestId = generateRequestId();
  const timer = startTimer("getUserRoles");
  const log = createLogger({ requestId, function: "getUserRoles" });
  
  try {
    log.debug("Getting user roles", { userId });
    
    // Get cognito sub for the userId
    const session = await getServerSession();
    if (!session) {
      log.warn("Cannot get user roles - no session");
      timer({ status: "failed", reason: "no_session" });
      return [];
    }
    
    // Note: This function expects a userId but getUserRolesByCognitoSub expects a cognito sub
    // For now, assuming userId is the cognito sub (this may need adjustment based on usage)
    const roles = await dbGetUserRolesByCognitoSub(userId);
    
    log.info("User roles retrieved", { 
      userId,
      roleCount: roles.length,
      roles 
    });
    timer({ status: "success", roleCount: roles.length });
    
    return roles;
  } catch (error) {
    log.error("Error getting user roles", { 
      error: error instanceof Error ? error.message : "Unknown error",
      userId 
    });
    timer({ status: "error" });
    return [];
  }
}

/**
 * Check if user has any of the specified roles
 */
export async function hasAnyRole(userId: string, roles: string[]): Promise<boolean> {
  const requestId = generateRequestId();
  const timer = startTimer("hasAnyRole");
  const log = createLogger({ requestId, function: "hasAnyRole" });
  
  try {
    log.debug("Checking if user has any of specified roles", { 
      userId,
      requiredRoles: roles 
    });
    
    const userRoles = await getUserRoles(userId);
    const hasMatch = roles.some(role => userRoles.includes(role));
    
    if (hasMatch) {
      log.info("User has matching role", { 
        userId,
        userRoles,
        requiredRoles: roles,
        matchingRoles: roles.filter(r => userRoles.includes(r))
      });
      timer({ status: "success" });
    } else {
      log.warn("User lacks required roles", { 
        userId,
        userRoles,
        requiredRoles: roles 
      });
      timer({ status: "denied" });
    }
    
    return hasMatch;
  } catch (error) {
    log.error("Error checking if user has any role", { 
      error: error instanceof Error ? error.message : "Unknown error",
      userId,
      requiredRoles: roles 
    });
    timer({ status: "error" });
    return false;
  }
}

/**
 * Get the highest role a user has based on hierarchy
 */
export async function getHighestUserRole(userId: string): Promise<string | null> {
  const requestId = generateRequestId();
  const timer = startTimer("getHighestUserRole");
  const log = createLogger({ requestId, function: "getHighestUserRole" });
  
  try {
    log.debug("Getting highest user role", { userId });
    
    const userRoles = await getUserRoles(userId);
    if (userRoles.length === 0) {
      log.info("User has no roles", { userId });
      timer({ status: "success", result: "no_roles" });
      return null;
    }
    
    // Find the highest role based on the hierarchy
    let highestRole = userRoles[0];
    let highestRank = roleHierarchy[highestRole as keyof typeof roleHierarchy] || -1;
    
    for (const role of userRoles) {
      const rank = roleHierarchy[role as keyof typeof roleHierarchy] || -1;
      if (rank > highestRank) {
        highestRole = role;
        highestRank = rank;
      }
    }
    
    log.info("Highest user role determined", { 
      userId,
      userRoles,
      highestRole,
      rank: highestRank 
    });
    timer({ status: "success", highestRole });
    
    return highestRole;
  } catch (error) {
    log.error("Error getting highest user role", { 
      error: error instanceof Error ? error.message : "Unknown error",
      userId 
    });
    timer({ status: "error" });
    return null;
  }
}

export async function syncUserRole(_userId: string, _role: string): Promise<void> {
  // This is now handled by the database directly
  // Role sync happens through user_roles table
  throw new Error("syncUserRole is deprecated - use user_roles table directly");
} 