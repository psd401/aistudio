import { NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { getNavigationItems, getAllNavigationItemRoles, getCapabilitiesByIdsMap } from "@/lib/db/drizzle"
import { createLogger, generateRequestId, startTimer } from '@/lib/logger'
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"
import { hasCapabilityAccess } from "@/utils/roles";

/**
 * Navigation API
 * 
 * Returns navigation items filtered by user permissions:
 * - Returns top-level items (parent_id = null) and their children
 * - Filters items requiring a capability the user doesn't have access to
 * - Hides admin items for non-admin users
 * - Preserves the parent-child relationship for proper nesting in the UI
 * 
 * Response format:
 * {
 *   isSuccess: boolean,
 *   data: [
 *     {
 *       id: string,
 *       label: string,
 *       icon: string, // Icon name from iconMap
 *       link: string | null, // If null, this is a dropdown section
 *       parent_id: string | null, // If null, this is a top-level item
 *       parent_label: string | null,
 *       capability_id: string | null, // If provided, requires capability access
 *       position: number // For ordering items
 *     },
 *     ...
 *   ]
 * }
 */
export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.navigation");
  const log = createLogger({ requestId, route: "api.navigation" });
  
  log.info("GET /api/navigation - Fetching navigation items");
  
  try {
    // Check if user is authenticated using NextAuth
    const session = await getServerSession()
    
    if (!session) {
      log.warn("Unauthorized access attempt to navigation");
      timer({ status: "error", reason: "unauthorized" });
      return NextResponse.json(
        { isSuccess: false, message: "Unauthorized" },
        { status: 401, headers: { "X-Request-Id": requestId } }
      )
    }
    
    log.debug("User authenticated", { userId: session.sub });
    
    // Check if database is configured (postgres.js driver - Issue #603)
    // Either DATABASE_URL (local dev) or DB_HOST (AWS ECS) must be set
    const hasDatabaseUrl = !!process.env.DATABASE_URL;
    const hasAwsDbConfig = !!process.env.DB_HOST;

    if (!hasDatabaseUrl && !hasAwsDbConfig) {
      log.error("Database configuration incomplete:", {
        DATABASE_URL: hasDatabaseUrl ? 'set' : 'missing',
        DB_HOST: hasAwsDbConfig ? 'set' : 'missing',
        hint: 'Set DATABASE_URL for local dev or DB_HOST for AWS ECS'
      });

      timer({ status: "error", reason: "missing_config" });
      return NextResponse.json(
        {
          isSuccess: false,
          message: `Database configuration incomplete. Set DATABASE_URL (local) or DB_HOST (AWS)`,
          debug: process.env.NODE_ENV !== 'production' ? {
            hasDatabaseUrl,
            hasAwsDbConfig,
            hint: 'For local dev: set DATABASE_URL. For AWS: DB_HOST is injected from Secrets Manager'
          } : undefined
        },
        { status: 500, headers: { "X-Request-Id": requestId } }
      )
    }
    
    try {
      const navItems = await getNavigationItems(true); // Get active items only

      // Get current user's roles
      const userResult = await getCurrentUserAction();
      const userRoles = userResult.isSuccess && userResult.data
        ? userResult.data.roles.map(r => r.name)
        : [];

      log.debug("User roles for navigation filtering", {
        userId: session.sub,
        roles: userRoles
      });

      // Get navigation item roles from the junction table
      const navItemRolesMap = await getAllNavigationItemRoles();

      // Collect all capability IDs that need to be looked up
      const capabilityIdsToLookup = new Set<number>();
      for (const item of navItems) {
        if (item.capabilityId) {
          const capabilityId = Number(item.capabilityId);
          if (!Number.isNaN(capabilityId)) {
            capabilityIdsToLookup.add(capabilityId);
          }
        }
      }

      // Batch fetch all capability identifiers using Drizzle
      const capabilitiesMap = capabilityIdsToLookup.size > 0
        ? await getCapabilitiesByIdsMap(Array.from(capabilityIdsToLookup))
        : new Map<number, string>();

      // Filter navigation items based on user permissions
      const filteredNavItems = [];
      const parentIds = new Set();
      
      for (const item of navItems) {
        let shouldInclude = true;
        
        // Check if item requires specific roles (multi-role support)
        const requiredRoles = navItemRolesMap.get(item.id);
        if (requiredRoles && requiredRoles.length > 0) {
          // User must have at least one of the required roles
          shouldInclude = requiredRoles.some(role => userRoles.includes(role));
          log.debug("Multi-role check for navigation item", {
            itemId: item.id,
            label: item.label,
            requiredRoles,
            userRoles,
            granted: shouldInclude
          });
        } else if (item.requiresRole) {
          // Fallback to single role check for backward compatibility
          shouldInclude = userRoles.includes(item.requiresRole);
          log.debug("Single role check for navigation item", {
            itemId: item.id,
            label: item.label,
            requiredRole: item.requiresRole,
            userRoles,
            granted: shouldInclude
          });
        }
        
        // Check if item requires capability access
        if (shouldInclude && item.capabilityId) {
          const capabilityId = Number(item.capabilityId);
          if (Number.isNaN(capabilityId)) {
            log.warn("Invalid capability ID for navigation item", {
              itemId: item.id,
              label: item.label,
              capabilityId: item.capabilityId
            });
            shouldInclude = false;
          } else {
            const capabilityIdentifier = capabilitiesMap.get(capabilityId);
            if (capabilityIdentifier) {
              try {
                const capabilityAccess = await hasCapabilityAccess(capabilityIdentifier);
                shouldInclude = capabilityAccess;

                log.debug("Capability access check for navigation item", {
                  itemId: item.id,
                  label: item.label,
                  capabilityId,
                  capabilityIdentifier,
                  granted: shouldInclude
                });
              } catch (capabilityError) {
                log.error("Error checking capability access", {
                  itemId: item.id,
                  label: item.label,
                  capabilityId,
                  capabilityIdentifier,
                  error: capabilityError instanceof Error ? capabilityError.message : 'Unknown error'
                });
                shouldInclude = false;
              }
            } else {
              log.warn("Capability not found for navigation item", {
                itemId: item.id,
                label: item.label,
                capabilityId
              });
              shouldInclude = false;
            }
          }
        }
        
        if (shouldInclude) {
          filteredNavItems.push(item);
          // Track parent IDs that have visible children
          if (item.parentId) {
            parentIds.add(item.parentId);
          }
        }
      }
      
      // Include parent items if they have visible children
      const finalNavItems = filteredNavItems.filter(item => {
        // Keep items that are either:
        // 1. Not parent items (have a parent_id)
        // 2. Parent items that have visible children
        // 3. Parent items with direct links (standalone pages)
        if (item.parentId !== null) return true; // Child item
        if (parentIds.has(item.id)) return true; // Parent with visible children
        if (item.link) return true; // Parent with direct link
        
        // Don't include empty parent sections
        return false;
      });

      // Format the navigation items
      const formattedNavItems = finalNavItems.map(item => ({
        id: item.id,
        label: item.label,
        icon: item.icon,
        link: item.link,
        parent_id: item.parentId,
        parent_label: null, // This column doesn't exist in the table
        capability_id: item.capabilityId,
        position: item.position,
        type: item.type || 'link',
        description: item.description || null,
        color: null // This column doesn't exist in the current table
      }))

      log.info("Navigation items filtered and retrieved", { 
        totalCount: navItems.length,
        filteredCount: formattedNavItems.length,
        userRoleCount: userRoles.length
      });
      timer({ status: "success", filteredCount: formattedNavItems.length });
      
      return NextResponse.json(
        {
          isSuccess: true,
          data: formattedNavItems
        },
        { headers: { "X-Request-Id": requestId } }
      )
      
    } catch (error) {
      log.error("Data API error:", error);
      
      // Enhanced error logging for debugging
      interface ErrorDetails {
        timestamp: string;
        endpoint: string;
        error: unknown;
        credentialIssue?: boolean;
        hint?: string;
        permissionIssue?: boolean;
      }

      const errorDetails: ErrorDetails = {
        timestamp: new Date().toISOString(),
        endpoint: '/api/navigation',
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack?.split('\n').slice(0, 5).join('\n')
        } : error
      };
      
      // Check if it's an AWS SDK error
      if (error instanceof Error && 'name' in error) {
        if (error.name === 'CredentialsProviderError' || 
            error.message?.includes('Could not load credentials')) {
          errorDetails.credentialIssue = true;
          errorDetails.hint = 'AWS credentials not properly configured';
        } else if (error.name === 'AccessDeniedException') {
          errorDetails.permissionIssue = true;
          errorDetails.hint = 'IAM permissions insufficient for RDS Data API';
        }
      }
      
      log.error("Enhanced error details:", errorDetails);
      
      timer({ status: "error", reason: "data_api_error" });
      return NextResponse.json(
        {
          isSuccess: false,
          message: "Failed to fetch navigation items",
          error: error instanceof Error ? error.message : "Unknown error",
          debug: process.env.NODE_ENV !== 'production' ? errorDetails : undefined
        },
        { status: 500, headers: { "X-Request-Id": requestId } }
      )
    }
    
  } catch (error) {
    timer({ status: "error" });
    log.error("Error in navigation API:", error)
    // Log more details about the error
    if (error instanceof Error) {
      log.error("Outer error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack?.split('\n').slice(0, 5).join('\n')
      });
    }
    return NextResponse.json(
      {
        isSuccess: false,
        message: error instanceof Error ? error.message : "Failed to fetch navigation"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
} 