import { randomUUID } from "node:crypto";
import { and, count, eq, gt, gte, isNull, lt, sql, sum } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import { deepResearchReservations } from "@/lib/db/schema";

const LEASE_MS = 30 * 60 * 1000;
const BUDGET_WINDOW_MS = 60 * 60 * 1000;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export type DeepResearchReservation =
  | { allowed: true; leaseId: string }
  | {
      allowed: false;
      reason: "user_concurrency" | "deployment_concurrency" | "user_budget" | "deployment_budget";
    };

/** Atomically reserve both concurrency and a conservative maximum run cost. */
export async function reserveDeepResearch(
  userId: number
): Promise<DeepResearchReservation> {
  const userConcurrency = positiveInt(
    process.env.DEEP_RESEARCH_USER_CONCURRENCY,
    1
  );
  const deploymentConcurrency = positiveInt(
    process.env.DEEP_RESEARCH_DEPLOYMENT_CONCURRENCY,
    5
  );
  const reservedCostCents = positiveInt(
    process.env.DEEP_RESEARCH_MAX_RUN_COST_CENTS,
    500
  );
  const userBudgetCents = positiveInt(
    process.env.DEEP_RESEARCH_USER_HOURLY_BUDGET_CENTS,
    1_000
  );
  const deploymentBudgetCents = positiveInt(
    process.env.DEEP_RESEARCH_DEPLOYMENT_HOURLY_BUDGET_CENTS,
    5_000
  );
  const now = new Date();
  const budgetStart = new Date(now.getTime() - BUDGET_WINDOW_MS);

  return executeTransaction(
    async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(1146245715, 1)`
      );
      await tx
        .update(deepResearchReservations)
        .set({ status: "expired", releasedAt: now })
        .where(
          and(
            eq(deepResearchReservations.status, "active"),
            lt(deepResearchReservations.expiresAt, now)
          )
        );

      const [
        activeUserRows,
        activeDeploymentRows,
        userBudgetRows,
        deploymentBudgetRows,
      ] =
        await Promise.all([
          tx
            .select({ value: count() })
            .from(deepResearchReservations)
            .where(
              and(
                eq(deepResearchReservations.userId, userId),
                eq(deepResearchReservations.status, "active"),
                gt(deepResearchReservations.expiresAt, now),
                isNull(deepResearchReservations.releasedAt)
              )
            ),
          tx
            .select({ value: count() })
            .from(deepResearchReservations)
            .where(
              and(
                eq(deepResearchReservations.status, "active"),
                gt(deepResearchReservations.expiresAt, now),
                isNull(deepResearchReservations.releasedAt)
              )
            ),
          tx
            .select({ value: sum(deepResearchReservations.reservedCostCents) })
            .from(deepResearchReservations)
            .where(
              and(
                eq(deepResearchReservations.userId, userId),
                gte(deepResearchReservations.reservedAt, budgetStart)
              )
            ),
          tx
            .select({ value: sum(deepResearchReservations.reservedCostCents) })
            .from(deepResearchReservations)
            .where(gte(deepResearchReservations.reservedAt, budgetStart)),
        ]);
      const [activeUser] = activeUserRows;
      const [activeDeployment] = activeDeploymentRows;
      const [userBudget] = userBudgetRows;
      const [deploymentBudget] = deploymentBudgetRows;

      if ((activeUser?.value ?? 0) >= userConcurrency) {
        return { allowed: false, reason: "user_concurrency" } as const;
      }
      if ((activeDeployment?.value ?? 0) >= deploymentConcurrency) {
        return { allowed: false, reason: "deployment_concurrency" } as const;
      }
      if (Number(userBudget?.value ?? 0) + reservedCostCents > userBudgetCents) {
        return { allowed: false, reason: "user_budget" } as const;
      }
      if (
        Number(deploymentBudget?.value ?? 0) + reservedCostCents >
        deploymentBudgetCents
      ) {
        return { allowed: false, reason: "deployment_budget" } as const;
      }

      const leaseId = randomUUID();
      await tx.insert(deepResearchReservations).values({
        id: leaseId,
        userId,
        reservedCostCents,
        expiresAt: new Date(now.getTime() + LEASE_MS),
      });
      return { allowed: true, leaseId } as const;
    },
    "reserveDeepResearch"
  );
}

/** Release concurrency on every terminal path; the cost reservation is retained. */
export async function releaseDeepResearch(leaseId: string): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(deepResearchReservations)
        .set({ status: "released", releasedAt: new Date() })
        .where(
          and(
            eq(deepResearchReservations.id, leaseId),
            eq(deepResearchReservations.status, "active")
          )
        ),
    "releaseDeepResearch"
  );
}
