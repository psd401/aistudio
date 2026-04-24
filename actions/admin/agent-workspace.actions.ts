"use server"

import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
import { handleError, createSuccess } from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
import { desc, eq, sql } from "drizzle-orm"
import { psdAgentWorkspaceTokens } from "@/lib/db/schema/tables/agent-workspace-tokens"
import { users } from "@/lib/db/schema/tables/users"

export interface WorkspaceTokenRow {
  id: number
  ownerUserId: number
  ownerEmail: string
  agentEmail: string
  status: string
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

    const rows = await executeQuery(
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
    )

    // Count statuses
    const statusCounts = {
      active: 0,
      pending: 0,
      stale: 0,
      revoked: 0,
      notConnected: 0,
    }

    const tokens: WorkspaceTokenRow[] = rows.map((row) => {
      const status = row.status ?? "pending"
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

    // Count total users to calculate "not connected"
    const [userCountResult] = await executeQuery(
      (db) =>
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(users),
      "countTotalUsers"
    )
    const totalUsers = userCountResult?.count ?? 0
    statusCounts.notConnected = Math.max(0, totalUsers - tokens.length)

    timer({ status: "success" })
    log.info("Workspace tokens listed", { count: tokens.length })

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
