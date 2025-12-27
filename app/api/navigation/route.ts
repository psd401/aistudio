import { NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { getNavigationItems, getAllNavigationItemRoles, getToolsByIds } from "@/lib/db/drizzle"
import { createLogger, generateRequestId, startTimer } from '@/lib/logger'
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"
import { hasToolAccess } from "@/utils/roles";

/**
 * Navigation API
 * 
 * Returns navigation items filtered by user permissions:
 * - Returns top-level items (parent_id = null) and their children
 * - Filters items requiring tools the user doesn't have access to
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
 *       tool_id: string | null, // If provided, requires tool access
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
    
    // Check if Data API is configured
    const missingEnvVars = [];
    if (!process.env.RDS_RESOURCE_ARN) missingEnvVars.push('RDS_RESOURCE_ARN');
    if (!process.env.RDS_SECRET_ARN) missingEnvVars.push('RDS_SECRET_ARN');
    
    // AWS Amplify provides AWS_REGION and AWS_DEFAULT_REGION at runtime
    // We should check NEXT_PUBLIC_AWS_REGION as a fallback
    const region = process.env.AWS_REGION || 
                   process.env.AWS_DEFAULT_REGION || 
                   process.env.NEXT_PUBLIC_AWS_REGION;
    
    if (!region) missingEnvVars.push('NEXT_PUBLIC_AWS_REGION');
    
    if (missingEnvVars.length > 0) {
      log.error("Missing required environment variables:", {
        missing: missingEnvVars,
        RDS_RESOURCE_ARN: process.env.RDS_RESOURCE_ARN ? 'set' : 'missing',
        RDS_SECRET_ARN: process.env.RDS_SECRET_ARN ? 'set' : 'missing',
        AWS_REGION: process.env.AWS_REGION || 'not set (provided by Amplify)',
        AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || 'not set (provided by Amplify)',
        NEXT_PUBLIC_AWS_REGION: process.env.NEXT_PUBLIC_AWS_REGION || 'not set',
        availableEnvVars: Object.keys(process.env).filter(k => 
          k.includes('AWS') || k.includes('RDS')).join(', ')
      });
      
      timer({ status: "error", reason: "missing_config" });
      return NextResponse.json(
        {
          isSuccess: false,
          message: `Database configuration incomplete. Missing: ${missingEnvVars.join(', ')}`,
          debug: process.env.NODE_ENV !== 'production' ? {
            missing: missingEnvVars,
            availableEnvVars: Object.keys(process.env).filter(k => 
              k.includes('AWS') || k.includes('RDS'))
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

      // Collect all tool IDs that need to be looked up
      const toolIdsToLookup = new Set<number>();
      for (const item of navItems) {
        if (item.toolId) {
          const toolId = Number(item.toolId);
          if (!Number.isNaN(toolId)) {
            toolIdsToLookup.add(toolId);
          }
        }
      }

      // Batch fetch all tool identifiers using Drizzle
      const toolsMap = toolIdsToLookup.size > 0
        ? await getToolsByIds(Array.from(toolIdsToLookup))
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
        
        // Check if item requires tool access
        if (shouldInclude && item.toolId) {
          const toolId = Number(item.toolId);
          if (Number.isNaN(toolId)) {
            log.warn("Invalid tool ID for navigation item", {
              itemId: item.id,
              label: item.label,
              toolId: item.toolId
            });
            shouldInclude = false;
          } else {
            const toolIdentifier = toolsMap.get(toolId);
            if (toolIdentifier) {
              try {
                const toolAccess = await hasToolAccess(toolIdentifier);
                shouldInclude = toolAccess;
                
                log.debug("Tool access check for navigation item", {
                  itemId: item.id,
                  label: item.label,
                  toolId,
                  toolIdentifier,
                  granted: shouldInclude
                });
              } catch (toolError) {
                log.error("Error checking tool access", {
                  itemId: item.id,
                  label: item.label,
                  toolId,
                  toolIdentifier,
                  error: toolError instanceof Error ? toolError.message : 'Unknown error'
                });
                shouldInclude = false;
              }
            } else {
              log.warn("Tool not found for navigation item", {
                itemId: item.id,
                label: item.label,
                toolId
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
        tool_id: item.toolId,
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