import { randomUUID } from "node:crypto"
import { and, eq, gte, lt, sql, sum } from "drizzle-orm"
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client"
import { agenticCostReservations } from "@/lib/db/schema"

const LEASE_MS = 20 * 60 * 1000
const BUDGET_WINDOW_MS = 60 * 60 * 1000

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export type AgenticCostReservation =
  | { allowed: true; leaseId: string; reservedCostCents: number }
  | {
      allowed: false
      reason: "user_budget" | "deployment_budget" | "duplicate_execution"
    }

export async function reserveAgenticCost(
  userId: number,
  executionId: number,
  maximumCostCents: number,
): Promise<AgenticCostReservation> {
  if (!Number.isFinite(maximumCostCents) || maximumCostCents <= 0) {
    throw new Error("Agentic cost reservation must be a positive finite value")
  }
  const reservedCostCents = Math.ceil(maximumCostCents)
  const userBudgetCents = positiveInt(
    process.env.AGENTIC_ASSISTANT_USER_HOURLY_BUDGET_CENTS,
    10_000,
  )
  const deploymentBudgetCents = positiveInt(
    process.env.AGENTIC_ASSISTANT_DEPLOYMENT_HOURLY_BUDGET_CENTS,
    50_000,
  )
  const now = new Date()
  const budgetStart = new Date(now.getTime() - BUDGET_WINDOW_MS)

  return executeTransaction(
    async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1094931513, 1)`)
      await tx
        .update(agenticCostReservations)
        .set({ status: "expired", releasedAt: now })
        .where(
          and(
            eq(agenticCostReservations.status, "active"),
            lt(agenticCostReservations.expiresAt, now),
          ),
        )

      const [existing] = await tx
        .select({
          id: agenticCostReservations.id,
          userId: agenticCostReservations.userId,
          status: agenticCostReservations.status,
          reservedCostCents: agenticCostReservations.reservedCostCents,
        })
        .from(agenticCostReservations)
        .where(eq(agenticCostReservations.executionId, executionId))
        .limit(1)
      if (existing) {
        return { allowed: false, reason: "duplicate_execution" } as const
      }

      const accountedCost = sql<number>`GREATEST(${agenticCostReservations.reservedCostCents}, COALESCE(${agenticCostReservations.actualCostCents}, 0))`
      const [userRows, deploymentRows] = await Promise.all([
        tx
          .select({ value: sum(accountedCost) })
          .from(agenticCostReservations)
          .where(
            and(
              eq(agenticCostReservations.userId, userId),
              gte(agenticCostReservations.reservedAt, budgetStart),
            ),
          ),
        tx
          .select({ value: sum(accountedCost) })
          .from(agenticCostReservations)
          .where(gte(agenticCostReservations.reservedAt, budgetStart)),
      ])
      const currentUserCost = Number(userRows[0]?.value ?? 0)
      const currentDeploymentCost = Number(deploymentRows[0]?.value ?? 0)
      if (currentUserCost + reservedCostCents > userBudgetCents) {
        return { allowed: false, reason: "user_budget" } as const
      }
      if (currentDeploymentCost + reservedCostCents > deploymentBudgetCents) {
        return { allowed: false, reason: "deployment_budget" } as const
      }

      const leaseId = randomUUID()
      await tx.insert(agenticCostReservations).values({
        id: leaseId,
        userId,
        executionId,
        reservedCostCents,
        expiresAt: new Date(now.getTime() + LEASE_MS),
      })
      return { allowed: true, leaseId, reservedCostCents } as const
    },
    "reserveAgenticCost",
  )
}

export type AgenticCostReconciliation = {
  actualCostCents: number
  deploymentHourlyCostCents: number
  deploymentBudgetCents: number
  withinDeploymentBudget: boolean
}

/**
 * Record measured token-based cost while holding the same global lock used by
 * admission. Rolling accounting retains the greater of conservative and actual
 * cost, including a final-step overshoot.
 */
export async function reconcileAgenticCost(
  leaseId: string,
  actualCostCents: number,
): Promise<AgenticCostReconciliation> {
  if (!Number.isFinite(actualCostCents) || actualCostCents <= 0) {
    throw new Error("Actual agentic cost must be a positive finite value")
  }
  const reconciledCostCents = Math.ceil(actualCostCents)
  const deploymentBudgetCents = positiveInt(
    process.env.AGENTIC_ASSISTANT_DEPLOYMENT_HOURLY_BUDGET_CENTS,
    50_000,
  )
  const now = new Date()
  const budgetStart = new Date(now.getTime() - BUDGET_WINDOW_MS)

  return executeTransaction(
    async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1094931513, 1)`)
      const [updated] = await tx
        .update(agenticCostReservations)
        .set({
          actualCostCents: sql`GREATEST(COALESCE(${agenticCostReservations.actualCostCents}, 0), ${reconciledCostCents})`,
          reconciledAt: now,
        })
        .where(eq(agenticCostReservations.id, leaseId))
        .returning({
          actualCostCents: agenticCostReservations.actualCostCents,
        })
      if (!updated?.actualCostCents) {
        throw new Error("Agentic cost reservation was not found")
      }
      const accountedCost = sql<number>`GREATEST(${agenticCostReservations.reservedCostCents}, COALESCE(${agenticCostReservations.actualCostCents}, 0))`
      const [rows] = await tx
        .select({ value: sum(accountedCost) })
        .from(agenticCostReservations)
        .where(gte(agenticCostReservations.reservedAt, budgetStart))
      const deploymentHourlyCostCents = Number(rows?.value ?? 0)
      return {
        actualCostCents: updated.actualCostCents,
        deploymentHourlyCostCents,
        deploymentBudgetCents,
        withinDeploymentBudget:
          deploymentHourlyCostCents <= deploymentBudgetCents,
      }
    },
    "reconcileAgenticCost",
  )
}

export async function releaseAgenticCost(leaseId: string): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(agenticCostReservations)
        .set({ status: "released", releasedAt: new Date() })
        .where(
          and(
            eq(agenticCostReservations.id, leaseId),
            eq(agenticCostReservations.status, "active"),
          ),
        ),
    "releaseAgenticCost",
  )
}
