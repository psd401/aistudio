import { NextResponse } from "next/server"
import { getServerSession } from "@/lib/auth/server-session"
import { getNavigationItems, getAllNavigationItemRoles, getCapabilitiesByIdsMap } from "@/lib/db/drizzle"
import { createLogger, generateRequestId, startTimer } from '@/lib/logger'
import { getCurrentUserAction } from "@/actions/db/get-current-user-action"
import { getUserCapabilities } from "@/utils/roles";

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

// Derived types keep helpers type-safe without re-declaring shapes (no `any`).
type NavItem = Awaited<ReturnType<typeof getNavigationItems>>[number]
type NavLogger = ReturnType<typeof createLogger>

interface ErrorDetails {
  timestamp: string;
  endpoint: string;
  error: unknown;
  credentialIssue?: boolean;
  hint?: string;
  permissionIssue?: boolean;
}

/**
 * Collect all valid numeric capability IDs referenced by the navigation items,
 * so they can be batch-fetched in a single query.
 */
function collectCapabilityIds(navItems: NavItem[]): Set<number> {
  const capabilityIdsToLookup = new Set<number>();
  for (const item of navItems) {
    if (!item.capabilityId) continue;
    const capabilityId = Number(item.capabilityId);
    if (!Number.isNaN(capabilityId)) {
      capabilityIdsToLookup.add(capabilityId);
    }
  }
  return capabilityIdsToLookup;
}

/**
 * Determine whether the current user satisfies the role requirements for an item.
 * Uses multi-role junction data when present, otherwise the legacy single role.
 * Items with no role requirement are allowed.
 */
function isAllowedByRoles(
  item: NavItem,
  navItemRolesMap: Map<number, string[]>,
  userRoles: string[],
  log: NavLogger
): boolean {
  const requiredRoles = navItemRolesMap.get(item.id);
  if (requiredRoles && requiredRoles.length > 0) {
    // User must have at least one of the required roles
    const granted = requiredRoles.some(role => userRoles.includes(role));
    log.debug("Multi-role check for navigation item", {
      itemId: item.id,
      label: item.label,
      requiredRoles,
      userRoles,
      granted
    });
    return granted;
  }

  if (item.requiresRole) {
    // Fallback to single role check for backward compatibility
    const granted = userRoles.includes(item.requiresRole);
    log.debug("Single role check for navigation item", {
      itemId: item.id,
      label: item.label,
      requiredRole: item.requiresRole,
      userRoles,
      granted
    });
    return granted;
  }

  return true;
}

/**
 * Synchronously check whether the user's pre-fetched capability set grants
 * access to the capability gating a nav item. Eliminates N+1 DB queries.
 * Returns false for invalid, unknown, or denied capabilities.
 */
function isAllowedByCapability(
  item: NavItem,
  capabilitiesMap: Map<number, string>,
  userCapabilitiesSet: Set<string>,
  log: NavLogger
): boolean {
  const capabilityId = Number(item.capabilityId);
  if (Number.isNaN(capabilityId)) {
    log.warn("Invalid capability ID for navigation item", {
      itemId: item.id,
      label: item.label,
      capabilityId: item.capabilityId
    });
    return false;
  }

  const capabilityIdentifier = capabilitiesMap.get(capabilityId);
  if (!capabilityIdentifier) {
    log.warn("Capability not found for navigation item", {
      itemId: item.id,
      label: item.label,
      capabilityId
    });
    return false;
  }

  const granted = userCapabilitiesSet.has(capabilityIdentifier);
  log.debug("Capability access check for navigation item", {
    itemId: item.id,
    label: item.label,
    capabilityId,
    capabilityIdentifier,
    granted
  });
  return granted;
}

/**
 * Filter navigation items by role and capability, then keep parent sections only
 * when they have visible children or a direct link. Preserves source ordering.
 */
function buildVisibleNavItems(
  navItems: NavItem[],
  navItemRolesMap: Map<number, string[]>,
  userRoles: string[],
  capabilitiesMap: Map<number, string>,
  userCapabilitiesSet: Set<string>,
  log: NavLogger
): NavItem[] {
  const filteredNavItems: NavItem[] = [];
  const parentIds = new Set<NavItem["id"]>();

  for (const item of navItems) {
    let shouldInclude = isAllowedByRoles(item, navItemRolesMap, userRoles, log);

    if (shouldInclude && item.capabilityId) {
      shouldInclude = isAllowedByCapability(item, capabilitiesMap, userCapabilitiesSet, log);
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
  return filteredNavItems.filter(item => {
    if (item.parentId !== null) return true; // Child item
    if (parentIds.has(item.id)) return true; // Parent with visible children
    if (item.link) return true; // Parent with direct link
    return false; // Empty parent section — hide
  });
}

/**
 * Map filtered navigation items into the API response shape.
 */
function formatNavItems(finalNavItems: NavItem[]) {
  return finalNavItems.map(item => ({
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
  }));
}

/**
 * Validate that a database connection is configured (local DATABASE_URL or AWS
 * DB_HOST). Returns a 500 response describing the gap, or null when configured.
 */
function checkDatabaseConfigured(requestId: string, log: NavLogger): NextResponse | null {
  // Check if database is configured (postgres.js driver - Issue #603)
  // Either DATABASE_URL (local dev) or DB_HOST (AWS ECS) must be set
  const hasDatabaseUrl = !!process.env.DATABASE_URL;
  const hasAwsDbConfig = !!process.env.DB_HOST;

  if (hasDatabaseUrl || hasAwsDbConfig) {
    return null;
  }

  log.error("Database configuration incomplete:", {
    DATABASE_URL: hasDatabaseUrl ? 'set' : 'missing',
    DB_HOST: hasAwsDbConfig ? 'set' : 'missing',
    hint: 'Set DATABASE_URL for local dev or DB_HOST for AWS ECS'
  });

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
  );
}

/**
 * Build enriched diagnostic details for a data-layer error, flagging known
 * AWS credential / permission failure modes.
 */
function buildDataApiErrorDetails(error: unknown): ErrorDetails {
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

  return errorDetails;
}

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

    const dbConfigError = checkDatabaseConfigured(requestId, log);
    if (dbConfigError) {
      timer({ status: "error", reason: "missing_config" });
      return dbConfigError;
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
      const capabilityIdsToLookup = collectCapabilityIds(navItems);

      // Batch fetch all capability identifiers using Drizzle
      const capabilitiesMap = capabilityIdsToLookup.size > 0
        ? await getCapabilitiesByIdsMap(Array.from(capabilityIdsToLookup))
        : new Map<number, string>();

      // Fetch user's granted capabilities once — avoids N+1 DB queries in filter
      const userCapabilities = await getUserCapabilities();
      const userCapabilitiesSet = new Set(userCapabilities);

      // Filter navigation items based on user permissions
      const finalNavItems = buildVisibleNavItems(
        navItems,
        navItemRolesMap,
        userRoles,
        capabilitiesMap,
        userCapabilitiesSet,
        log
      );

      // Format the navigation items
      const formattedNavItems = formatNavItems(finalNavItems)

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
      const errorDetails = buildDataApiErrorDetails(error);

      log.error("Enhanced error details:", errorDetails);

      timer({ status: "error", reason: "data_api_error" });
      return NextResponse.json(
        {
          isSuccess: false,
          message: "Failed to fetch navigation items",
          // Raw error.message is intentionally NOT returned in the response body:
          // it can leak AWS SDK credential errors, DB table/column names, or
          // connection strings to any authenticated user. Full detail is logged
          // above and exposed via `debug` in non-production only.
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
      // Generic message only — raw error.message can leak infrastructure detail
      // to authenticated users. Full error is logged above.
      { isSuccess: false, message: "Failed to fetch navigation" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}
