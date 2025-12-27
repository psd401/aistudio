/**
 * Drizzle Settings Operations
 *
 * Application settings with secret masking and caching support.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #541 - Remove Legacy RDS Data API Code
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, sql } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { settings } from "@/lib/db/schema";

// ============================================
// Types
// ============================================

export interface SettingData {
  id: number;
  key: string;
  value: string | null;
  description: string | null;
  category: string | null;
  isSecret: boolean | null;
  hasValue?: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface CreateSettingData {
  key: string;
  value: string | null;
  description?: string | null;
  category?: string | null;
  isSecret?: boolean;
}

// ============================================
// Query Operations
// ============================================

/**
 * Get all settings with secret masking
 * Secrets show '••••••••' instead of actual value
 */
export async function getSettings(): Promise<SettingData[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: settings.id,
          key: settings.key,
          value: sql<string | null>`
            CASE
              WHEN ${settings.isSecret} = true THEN '••••••••'
              ELSE ${settings.value}
            END
          `,
          hasValue: sql<boolean>`
            CASE
              WHEN ${settings.value} IS NOT NULL AND ${settings.value} != '' THEN true
              ELSE false
            END
          `,
          description: settings.description,
          category: settings.category,
          isSecret: settings.isSecret,
          createdAt: settings.createdAt,
          updatedAt: settings.updatedAt,
        })
        .from(settings)
        .orderBy(settings.category, settings.key),
    "getSettings"
  );

  return result;
}

/**
 * Get a single setting value by key
 * Returns the actual value (not masked)
 */
export async function getSettingValue(key: string): Promise<string | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .limit(1),
    "getSettingValue"
  );

  return result[0]?.value || null;
}

/**
 * Get actual (unmasked) value for a setting
 * Used by admin to view secret values
 */
export async function getSettingActualValue(key: string): Promise<string | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .limit(1),
    "getSettingActualValue"
  );

  return result[0]?.value || null;
}

// ============================================
// CRUD Operations
// ============================================

/**
 * Create or update a setting
 * Handles special logic for keeping existing secret values when updating
 */
export async function upsertSetting(
  input: CreateSettingData
): Promise<SettingData> {
  // Check if setting exists
  const existing = await executeQuery(
    (db) =>
      db
        .select({
          id: settings.id,
          isSecret: settings.isSecret,
          value: settings.value,
        })
        .from(settings)
        .where(eq(settings.key, input.key))
        .limit(1),
    "upsertSetting:check"
  );

  let result;

  if (existing.length > 0) {
    // Update existing setting
    const existingValue = existing[0].value;
    const isSecret = existing[0].isSecret;
    const hasExistingValue = existingValue !== null && existingValue !== "";
    const keepExistingValue = isSecret && !input.value && hasExistingValue;

    if (keepExistingValue) {
      // Update without changing the value
      result = await executeQuery(
        (db) =>
          db
            .update(settings)
            .set({
              description: input.description || null,
              category: input.category || null,
              isSecret: input.isSecret || false,
              updatedAt: new Date(),
            })
            .where(eq(settings.key, input.key))
            .returning({
              id: settings.id,
              key: settings.key,
              value: sql<string | null>`
                CASE
                  WHEN ${settings.isSecret} = true THEN '••••••••'
                  ELSE ${settings.value}
                END
              `,
              hasValue: sql<boolean>`
                CASE
                  WHEN ${settings.value} IS NOT NULL AND ${settings.value} != '' THEN true
                  ELSE false
                END
              `,
              description: settings.description,
              category: settings.category,
              isSecret: settings.isSecret,
              createdAt: settings.createdAt,
              updatedAt: settings.updatedAt,
            }),
        "upsertSetting:update"
      );
    } else {
      // Update including the value
      result = await executeQuery(
        (db) =>
          db
            .update(settings)
            .set({
              value: input.value || null,
              description: input.description || null,
              category: input.category || null,
              isSecret: input.isSecret || false,
              updatedAt: new Date(),
            })
            .where(eq(settings.key, input.key))
            .returning({
              id: settings.id,
              key: settings.key,
              value: sql<string | null>`
                CASE
                  WHEN ${settings.isSecret} = true THEN '••••••••'
                  ELSE ${settings.value}
                END
              `,
              hasValue: sql<boolean>`
                CASE
                  WHEN ${settings.value} IS NOT NULL AND ${settings.value} != '' THEN true
                  ELSE false
                END
              `,
              description: settings.description,
              category: settings.category,
              isSecret: settings.isSecret,
              createdAt: settings.createdAt,
              updatedAt: settings.updatedAt,
            }),
        "upsertSetting:updateWithValue"
      );
    }
  } else {
    // Create new setting
    result = await executeQuery(
      (db) =>
        db
          .insert(settings)
          .values({
            key: input.key,
            value: input.value || null,
            description: input.description || null,
            category: input.category || null,
            isSecret: input.isSecret || false,
          })
          .returning({
            id: settings.id,
            key: settings.key,
            value: sql<string | null>`
              CASE
                WHEN ${settings.isSecret} = true THEN '••••••••'
                ELSE ${settings.value}
              END
            `,
            hasValue: sql<boolean>`
              CASE
                WHEN ${settings.value} IS NOT NULL AND ${settings.value} != '' THEN true
                ELSE false
              END
            `,
            description: settings.description,
            category: settings.category,
            isSecret: settings.isSecret,
            createdAt: settings.createdAt,
            updatedAt: settings.updatedAt,
          }),
      "upsertSetting:insert"
    );
  }

  return result[0];
}

/**
 * Delete a setting by key
 */
export async function deleteSetting(key: string): Promise<void> {
  await executeQuery(
    (db) => db.delete(settings).where(eq(settings.key, key)),
    "deleteSetting"
  );
}
