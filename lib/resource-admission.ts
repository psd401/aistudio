import { randomUUID } from "node:crypto"
import {
  and,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  sql,
  sum,
} from "drizzle-orm"
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client"
import { resourceAdmissionLeases } from "@/lib/db/schema"

const HOUR_MS = 60 * 60 * 1000
export const RESOURCE_ADMISSION_REPLAY_TTL_MS = 24 * HOUR_MS
const NON_CHARGEABLE_HOURLY_STATUSES = new Set(["released"])

export function resourceAdmissionCountsTowardHourlyBudget(
  status: string,
): boolean {
  return !NON_CHARGEABLE_HOURLY_STATUSES.has(status)
}

export function resourceAdmissionCleanupCutoff(now: Date): Date {
  return new Date(now.getTime() - RESOURCE_ADMISSION_REPLAY_TTL_MS)
}

export interface ResourceAdmissionLimits {
  contextActive: number
  ownerActive: number
  globalActive: number
  contextHourlyUnits: number
  ownerHourlyUnits: number
  globalHourlyUnits: number
  leaseMs: number
}

export interface ResourceAdmissionRequest {
  kind: string
  ownerKey: string
  contextKey: string
  idempotencyKey: string
  units: number
  limits: ResourceAdmissionLimits
}

export type ResourceAdmission =
  | {
      allowed: true
      leaseId: string
      reservedUnits: number
    }
  | {
      allowed: false
      reason:
        | "owner_concurrency"
        | "context_concurrency"
        | "global_concurrency"
        | "context_hourly"
        | "owner_hourly"
        | "global_hourly"
        | "duplicate"
    }

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function boundedKey(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} is invalid`)
  }
  return normalized
}

/**
 * Atomically reserve active capacity and sliding-hour units for a resource.
 * The kind-scoped transaction lock makes owner and global checks one admission
 * decision across all web tasks. The unique idempotency key rejects retries so
 * an already-used key can never authorize repeated work.
 */
export async function acquireResourceAdmission(
  request: ResourceAdmissionRequest,
): Promise<ResourceAdmission> {
  const kind = boundedKey(request.kind, "kind", 64)
  const ownerKey = boundedKey(request.ownerKey.toLowerCase(), "ownerKey", 256)
  const contextKey = boundedKey(request.contextKey, "contextKey", 256)
  const idempotencyKey = boundedKey(
    request.idempotencyKey,
    "idempotencyKey",
    256,
  )
  const units = positiveSafeInteger(request.units, "units")
  const limits = {
    contextActive: positiveSafeInteger(
      request.limits.contextActive,
      "contextActive",
    ),
    ownerActive: positiveSafeInteger(
      request.limits.ownerActive,
      "ownerActive",
    ),
    globalActive: positiveSafeInteger(
      request.limits.globalActive,
      "globalActive",
    ),
    contextHourlyUnits: positiveSafeInteger(
      request.limits.contextHourlyUnits,
      "contextHourlyUnits",
    ),
    ownerHourlyUnits: positiveSafeInteger(
      request.limits.ownerHourlyUnits,
      "ownerHourlyUnits",
    ),
    globalHourlyUnits: positiveSafeInteger(
      request.limits.globalHourlyUnits,
      "globalHourlyUnits",
    ),
    leaseMs: positiveSafeInteger(request.limits.leaseMs, "leaseMs"),
  }
  const now = new Date()
  const windowStart = new Date(now.getTime() - HOUR_MS)
  const replayCutoff = resourceAdmissionCleanupCutoff(now)

  return executeTransaction(
    async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${kind}, 0))`,
      )
      await tx
        .update(resourceAdmissionLeases)
        .set({ status: "expired", finishedAt: now })
        .where(
          and(
            eq(resourceAdmissionLeases.kind, kind),
            eq(resourceAdmissionLeases.status, "active"),
            lt(resourceAdmissionLeases.expiresAt, now),
          ),
        )
      await tx
        .delete(resourceAdmissionLeases)
        .where(
          and(
            eq(resourceAdmissionLeases.kind, kind),
            inArray(resourceAdmissionLeases.status, [
              "completed",
              "released",
              "expired",
            ]),
            lt(resourceAdmissionLeases.finishedAt, replayCutoff),
          ),
        )

      const [existing] = await tx
        .select({
          id: resourceAdmissionLeases.id,
          reservedUnits: resourceAdmissionLeases.reservedUnits,
        })
        .from(resourceAdmissionLeases)
        .where(
          and(
            eq(resourceAdmissionLeases.kind, kind),
            eq(resourceAdmissionLeases.ownerKey, ownerKey),
            eq(resourceAdmissionLeases.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
      if (existing) {
        return {
          allowed: false,
          reason: "duplicate",
        } as const
      }

      const [
        contextActiveRows,
        ownerActiveRows,
        globalActiveRows,
        contextHourlyRows,
        ownerHourlyRows,
        globalHourlyRows,
      ] =
        await Promise.all([
          tx
            .select({ value: count() })
            .from(resourceAdmissionLeases)
            .where(
              and(
                eq(resourceAdmissionLeases.kind, kind),
                eq(resourceAdmissionLeases.contextKey, contextKey),
                eq(resourceAdmissionLeases.status, "active"),
                gt(resourceAdmissionLeases.expiresAt, now),
                isNull(resourceAdmissionLeases.finishedAt),
              ),
            ),
          tx
            .select({ value: count() })
            .from(resourceAdmissionLeases)
            .where(
              and(
                eq(resourceAdmissionLeases.kind, kind),
                eq(resourceAdmissionLeases.ownerKey, ownerKey),
                eq(resourceAdmissionLeases.status, "active"),
                gt(resourceAdmissionLeases.expiresAt, now),
                isNull(resourceAdmissionLeases.finishedAt),
              ),
            ),
          tx
            .select({ value: count() })
            .from(resourceAdmissionLeases)
            .where(
              and(
                eq(resourceAdmissionLeases.kind, kind),
                eq(resourceAdmissionLeases.status, "active"),
                gt(resourceAdmissionLeases.expiresAt, now),
                isNull(resourceAdmissionLeases.finishedAt),
              ),
            ),
          tx
            .select({ value: sum(resourceAdmissionLeases.reservedUnits) })
            .from(resourceAdmissionLeases)
            .where(
              and(
                eq(resourceAdmissionLeases.kind, kind),
                eq(resourceAdmissionLeases.contextKey, contextKey),
                gte(resourceAdmissionLeases.admittedAt, windowStart),
                ne(resourceAdmissionLeases.status, "released"),
              ),
            ),
          tx
            .select({ value: sum(resourceAdmissionLeases.reservedUnits) })
            .from(resourceAdmissionLeases)
            .where(
              and(
                eq(resourceAdmissionLeases.kind, kind),
                eq(resourceAdmissionLeases.ownerKey, ownerKey),
                gte(resourceAdmissionLeases.admittedAt, windowStart),
                ne(resourceAdmissionLeases.status, "released"),
              ),
            ),
          tx
            .select({ value: sum(resourceAdmissionLeases.reservedUnits) })
            .from(resourceAdmissionLeases)
            .where(
              and(
                eq(resourceAdmissionLeases.kind, kind),
                gte(resourceAdmissionLeases.admittedAt, windowStart),
                ne(resourceAdmissionLeases.status, "released"),
              ),
            ),
        ])

      if ((contextActiveRows[0]?.value ?? 0) >= limits.contextActive) {
        return { allowed: false, reason: "context_concurrency" } as const
      }
      if ((ownerActiveRows[0]?.value ?? 0) >= limits.ownerActive) {
        return { allowed: false, reason: "owner_concurrency" } as const
      }
      if ((globalActiveRows[0]?.value ?? 0) >= limits.globalActive) {
        return { allowed: false, reason: "global_concurrency" } as const
      }
      if (
        Number(contextHourlyRows[0]?.value ?? 0) + units >
        limits.contextHourlyUnits
      ) {
        return { allowed: false, reason: "context_hourly" } as const
      }
      if (
        Number(ownerHourlyRows[0]?.value ?? 0) + units >
        limits.ownerHourlyUnits
      ) {
        return { allowed: false, reason: "owner_hourly" } as const
      }
      if (
        Number(globalHourlyRows[0]?.value ?? 0) + units >
        limits.globalHourlyUnits
      ) {
        return { allowed: false, reason: "global_hourly" } as const
      }

      const leaseId = randomUUID()
      await tx.insert(resourceAdmissionLeases).values({
        id: leaseId,
        kind,
        ownerKey,
        contextKey,
        idempotencyKey,
        reservedUnits: units,
        expiresAt: new Date(now.getTime() + limits.leaseMs),
      })
      return {
        allowed: true,
        leaseId,
        reservedUnits: units,
      } as const
    },
    `acquireResourceAdmission:${kind}`,
  )
}

export async function finishResourceAdmission(
  leaseId: string,
  actualUnits?: number,
): Promise<void> {
  if (
    actualUnits !== undefined &&
    (!Number.isSafeInteger(actualUnits) || actualUnits < 0)
  ) {
    throw new Error("actualUnits must be a non-negative safe integer")
  }
  const safeActual = actualUnits
  await executeQuery(
    (db) =>
      db
        .update(resourceAdmissionLeases)
        .set({
          status: "completed",
          finishedAt: new Date(),
          ...(safeActual === undefined ? {} : { actualUnits: safeActual }),
        })
        .where(
          and(
            eq(resourceAdmissionLeases.id, leaseId),
            eq(resourceAdmissionLeases.status, "active"),
          ),
        ),
    "finishResourceAdmission",
  )
}

export async function releaseResourceAdmission(
  leaseId: string,
): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(resourceAdmissionLeases)
        .set({ status: "released", finishedAt: new Date() })
        .where(
          and(
            eq(resourceAdmissionLeases.id, leaseId),
            eq(resourceAdmissionLeases.status, "active"),
          ),
        ),
    "releaseResourceAdmission",
  )
}
