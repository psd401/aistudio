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
import {
  executeQuery,
  executeTransaction,
  type DbTransaction,
} from "@/lib/db/drizzle-client"
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

interface NormalizedAdmissionRequest {
  kind: string
  ownerKey: string
  contextKey: string
  idempotencyKey: string
  units: number
  limits: ResourceAdmissionLimits
  now: Date
  windowStart: Date
  replayCutoff: Date
}

interface AdmissionUsage {
  contextActive: number
  ownerActive: number
  globalActive: number
  contextHourlyUnits: number
  ownerHourlyUnits: number
  globalHourlyUnits: number
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

/**
 * Is this denial a CAPACITY threshold rather than a correctness guard?
 *
 * The capacity reasons (concurrency and hourly budgets) are advisory: their
 * limits were set in #1353 without data on real usage, and per Hagel
 * (2026-07-27) they must never block a user — callers measure and log them
 * instead.
 *
 * `duplicate` is NOT one of them. It means the same idempotency key was
 * already admitted, i.e. a REPLAY. Letting that through would double-apply
 * whatever the caller does next — a second upload reservation, a second
 * charge — so it stays a hard failure everywhere.
 */
export function isCapacityDenial(
  admission: ResourceAdmission,
): boolean {
  return !admission.allowed && admission.reason !== "duplicate"
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
  const normalized = normalizeAdmissionRequest(request)
  return executeTransaction(
    (tx) => acquireAdmissionWithinTransaction(tx, normalized),
    `acquireResourceAdmission:${normalized.kind}`,
  )
}

function normalizeAdmissionRequest(
  request: ResourceAdmissionRequest,
): NormalizedAdmissionRequest {
  const now = new Date()
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
  return {
    kind: boundedKey(request.kind, "kind", 64),
    ownerKey: boundedKey(request.ownerKey.toLowerCase(), "ownerKey", 256),
    contextKey: boundedKey(request.contextKey, "contextKey", 256),
    idempotencyKey: boundedKey(request.idempotencyKey, "idempotencyKey", 256),
    units: positiveSafeInteger(request.units, "units"),
    limits,
    now,
    windowStart: new Date(now.getTime() - HOUR_MS),
    replayCutoff: resourceAdmissionCleanupCutoff(now),
  }
}

async function acquireAdmissionWithinTransaction(
  tx: DbTransaction,
  request: NormalizedAdmissionRequest,
): Promise<ResourceAdmission> {
  await lockAndCleanAdmissionRows(tx, request)
  if (await hasDuplicateAdmission(tx, request)) {
    return { allowed: false, reason: "duplicate" }
  }
  const usage = await loadAdmissionUsage(tx, request)
  const denialReason = admissionDenialReason(usage, request)
  if (denialReason) return { allowed: false, reason: denialReason }

  const leaseId = randomUUID()
  await tx.insert(resourceAdmissionLeases).values({
    id: leaseId,
    kind: request.kind,
    ownerKey: request.ownerKey,
    contextKey: request.contextKey,
    idempotencyKey: request.idempotencyKey,
    reservedUnits: request.units,
    expiresAt: new Date(request.now.getTime() + request.limits.leaseMs),
  })
  return { allowed: true, leaseId, reservedUnits: request.units }
}

async function lockAndCleanAdmissionRows(
  tx: DbTransaction,
  request: NormalizedAdmissionRequest,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${request.kind}, 0))`,
  )
  await tx
    .update(resourceAdmissionLeases)
    .set({ status: "expired", finishedAt: request.now })
    .where(
      and(
        eq(resourceAdmissionLeases.kind, request.kind),
        eq(resourceAdmissionLeases.status, "active"),
        lt(resourceAdmissionLeases.expiresAt, request.now),
      ),
    )
  await tx
    .delete(resourceAdmissionLeases)
    .where(
      and(
        eq(resourceAdmissionLeases.kind, request.kind),
        inArray(resourceAdmissionLeases.status, [
          "completed",
          "released",
          "expired",
        ]),
        lt(resourceAdmissionLeases.finishedAt, request.replayCutoff),
      ),
    )
}

async function hasDuplicateAdmission(
  tx: DbTransaction,
  request: NormalizedAdmissionRequest,
): Promise<boolean> {
  const [existing] = await tx
    .select({ id: resourceAdmissionLeases.id })
    .from(resourceAdmissionLeases)
    .where(
      and(
        eq(resourceAdmissionLeases.kind, request.kind),
        eq(resourceAdmissionLeases.ownerKey, request.ownerKey),
        eq(resourceAdmissionLeases.idempotencyKey, request.idempotencyKey),
      ),
    )
    .limit(1)
  return existing !== undefined
}

async function loadAdmissionUsage(
  tx: DbTransaction,
  request: NormalizedAdmissionRequest,
): Promise<AdmissionUsage> {
  const [contextActive, ownerActive, globalActive, contextHourly, ownerHourly, globalHourly] =
    await Promise.all([
      activeAdmissionCount(tx, request, "context"),
      activeAdmissionCount(tx, request, "owner"),
      activeAdmissionCount(tx, request, "global"),
      hourlyAdmissionUnits(tx, request, "context"),
      hourlyAdmissionUnits(tx, request, "owner"),
      hourlyAdmissionUnits(tx, request, "global"),
    ])
  return {
    contextActive,
    ownerActive,
    globalActive,
    contextHourlyUnits: contextHourly,
    ownerHourlyUnits: ownerHourly,
    globalHourlyUnits: globalHourly,
  }
}

type AdmissionScope = "context" | "owner" | "global"

async function activeAdmissionCount(
  tx: DbTransaction,
  request: NormalizedAdmissionRequest,
  scope: AdmissionScope,
): Promise<number> {
  const scopeCondition =
    scope === "context"
      ? eq(resourceAdmissionLeases.contextKey, request.contextKey)
      : scope === "owner"
        ? eq(resourceAdmissionLeases.ownerKey, request.ownerKey)
        : undefined
  const rows = await tx
    .select({ value: count() })
    .from(resourceAdmissionLeases)
    .where(
      and(
        eq(resourceAdmissionLeases.kind, request.kind),
        scopeCondition,
        eq(resourceAdmissionLeases.status, "active"),
        gt(resourceAdmissionLeases.expiresAt, request.now),
        isNull(resourceAdmissionLeases.finishedAt),
      ),
    )
  return rows[0]?.value ?? 0
}

async function hourlyAdmissionUnits(
  tx: DbTransaction,
  request: NormalizedAdmissionRequest,
  scope: AdmissionScope,
): Promise<number> {
  const scopeCondition =
    scope === "context"
      ? eq(resourceAdmissionLeases.contextKey, request.contextKey)
      : scope === "owner"
        ? eq(resourceAdmissionLeases.ownerKey, request.ownerKey)
        : undefined
  const rows = await tx
    .select({ value: sum(resourceAdmissionLeases.reservedUnits) })
    .from(resourceAdmissionLeases)
    .where(
      and(
        eq(resourceAdmissionLeases.kind, request.kind),
        scopeCondition,
        gte(resourceAdmissionLeases.admittedAt, request.windowStart),
        ne(resourceAdmissionLeases.status, "released"),
      ),
    )
  return Number(rows[0]?.value ?? 0)
}

function admissionDenialReason(
  usage: AdmissionUsage,
  request: NormalizedAdmissionRequest,
): Exclude<ResourceAdmission, { allowed: true }>["reason"] | null {
  if (usage.contextActive >= request.limits.contextActive) return "context_concurrency"
  if (usage.ownerActive >= request.limits.ownerActive) return "owner_concurrency"
  if (usage.globalActive >= request.limits.globalActive) return "global_concurrency"
  if (usage.contextHourlyUnits + request.units > request.limits.contextHourlyUnits) {
    return "context_hourly"
  }
  if (usage.ownerHourlyUnits + request.units > request.limits.ownerHourlyUnits) {
    return "owner_hourly"
  }
  if (usage.globalHourlyUnits + request.units > request.limits.globalHourlyUnits) {
    return "global_hourly"
  }
  return null
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
