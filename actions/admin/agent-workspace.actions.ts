"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
import { desc, eq, sql } from "drizzle-orm"
import { psdAgentWorkspaceTokens, type WorkspaceTokenStatus } from "@/lib/db/schema/tables/agent-workspace-tokens"
import { users } from "@/lib/db/schema/tables/users"
import { userRoles } from "@/lib/db/schema/tables/user-roles"
import { roles } from "@/lib/db/schema/tables/roles"

export interface WorkspaceTokenRow {
  id: number
  ownerUserId: number
  ownerEmail: string
  agentEmail: string
  status: WorkspaceTokenStatus
  grantedScopes: string[]
  createdAt: string
  lastVerifiedAt: string | null
  revokedAt: string | null
  updatedAt: string
  /** Joined from users table */
  ownerName: string | null
}

export interface WorkspaceTokenListResult {
  tokens: WorkspaceTokenRow[]
  total: number
  statusCounts: {
    active: number
    pending: number
    stale: number
    revoked: number
    notConnected: number
  }
}

/**
 * List all workspace tokens with status counts. Admin-only.
 */
export async function getAgentWorkspaceTokens(): Promise<ActionState<WorkspaceTokenListResult>> {
  const requestId = generateRequestId()
  const timer = startTimer("getAgentWorkspaceTokens")
  const log = createLogger({ requestId, action: "getAgentWorkspaceTokens" })

  try {
    await requireRole("administrator")

    // Fetch tokens and staff user count in a single round trip.
    // "Not connected" is scoped to staff-role users only — students never
    // have agent accounts, so including them inflates the denominator.
    const [rows, [staffCountResult]] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              id: psdAgentWorkspaceTokens.id,
              ownerUserId: psdAgentWorkspaceTokens.ownerUserId,
              ownerEmail: psdAgentWorkspaceTokens.ownerEmail,
              agentEmail: psdAgentWorkspaceTokens.agentEmail,
              status: psdAgentWorkspaceTokens.status,
              grantedScopes: psdAgentWorkspaceTokens.grantedScopes,
              createdAt: psdAgentWorkspaceTokens.createdAt,
              lastVerifiedAt: psdAgentWorkspaceTokens.lastVerifiedAt,
              revokedAt: psdAgentWorkspaceTokens.revokedAt,
              updatedAt: psdAgentWorkspaceTokens.updatedAt,
              ownerFirstName: users.firstName,
              ownerLastName: users.lastName,
            })
            .from(psdAgentWorkspaceTokens)
            .leftJoin(users, eq(psdAgentWorkspaceTokens.ownerUserId, users.id))
            .orderBy(desc(psdAgentWorkspaceTokens.updatedAt)),
        "getAgentWorkspaceTokens"
      ),
      executeQuery(
        (db) =>
          db
            .select({ count: sql<number>`count(DISTINCT ${userRoles.userId})::int` })
            .from(userRoles)
            .innerJoin(roles, eq(userRoles.roleId, roles.id))
            .where(sql`${roles.name} IN ('administrator', 'staff')`),
        "countStaffUsers"
      ),
    ])

    // Count statuses
    const statusCounts = {
      active: 0,
      pending: 0,
      stale: 0,
      revoked: 0,
      notConnected: 0,
    }

    const tokens: WorkspaceTokenRow[] = rows.map((row) => {
      const status: WorkspaceTokenStatus = row.status ?? "pending"
      if (status in statusCounts) {
        statusCounts[status as keyof typeof statusCounts]++
      }
      return {
        id: row.id,
        ownerUserId: row.ownerUserId,
        ownerEmail: row.ownerEmail,
        agentEmail: row.agentEmail,
        status,
        grantedScopes: (row.grantedScopes ?? []) as string[],
        createdAt: row.createdAt?.toISOString() ?? "",
        lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt?.toISOString() ?? "",
        ownerName: [row.ownerFirstName, row.ownerLastName]
          .filter(Boolean)
          .join(" ") || null,
      }
    })

    const totalStaff = staffCountResult?.count ?? 0
    // "Not connected" = staff who have no active or pending token.
    // Using tokens.length would include revoked entries, undercounting
    // the actual number of staff without a working connection.
    const connectedOrPending = statusCounts.active + statusCounts.pending
    statusCounts.notConnected = Math.max(0, totalStaff - connectedOrPending)

    timer({ status: "success" })
    log.info("Workspace tokens listed", { count: tokens.length, staffTotal: totalStaff })

    return createSuccess({
      tokens,
      total: tokens.length,
      statusCounts,
    })
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load workspace tokens", {
      context: "getAgentWorkspaceTokens",
      requestId,
      operation: "getAgentWorkspaceTokens",
    })
  }
}
