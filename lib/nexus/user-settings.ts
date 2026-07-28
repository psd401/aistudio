import { eq, sql } from "drizzle-orm"
import { safeJsonbStringify } from "@/lib/db/json-utils"
import { nexusUserPreferences } from "@/lib/db/schema"
import { executeTransaction } from "@/lib/db/drizzle-client"
import type { NexusUserSettings } from "@/lib/db/types/jsonb"

// "NXUS" as a stable signed-int namespace for per-user Nexus settings locks.
const NEXUS_USER_SETTINGS_LOCK_NAMESPACE = 1_314_411_859

/**
 * Merge top-level Nexus settings without losing concurrent preference writes.
 *
 * Every writer to nexus_user_preferences.settings must use this helper. The
 * per-user advisory lock also serializes the missing-row case, which a row
 * lock cannot cover before the first preference record exists.
 */
export function mergeNexusUserSettings(
  userId: number,
  patch: Partial<NexusUserSettings>,
): Promise<NexusUserSettings> {
  return executeTransaction(
    async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(
          ${NEXUS_USER_SETTINGS_LOCK_NAMESPACE},
          ${userId}
        )`,
      )
      const [existing] = await tx
        .select({ settings: nexusUserPreferences.settings })
        .from(nexusUserPreferences)
        .where(eq(nexusUserPreferences.userId, userId))
        .limit(1)
      const settings: NexusUserSettings = {
        ...(existing?.settings ?? {}),
        ...patch,
      }
      const settingsSql = sql`${safeJsonbStringify(settings)}::jsonb`
      const now = new Date()
      await tx
        .insert(nexusUserPreferences)
        .values({ userId, settings: settingsSql, updatedAt: now })
        .onConflictDoUpdate({
          target: nexusUserPreferences.userId,
          set: { settings: settingsSql, updatedAt: now },
        })
      return settings
    },
    "mergeNexusUserSettings",
  )
}
