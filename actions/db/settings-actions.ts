"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { executeSQL } from "@/lib/db/data-api-adapter"
import { hasRole } from "@/lib/auth/role-helpers"
import { ActionState } from "@/types/actions-types"
import {
  createSuccess,
  handleError,
  ErrorFactories
} from "@/lib/error-utils"
import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging
} from "@/lib/logger"
import { revalidateSettingsCache } from "@/lib/settings-manager"

export interface Setting {
  id: number
  key: string
  value: string | null
  description: string | null
  category: string | null
  isSecret: boolean
  hasValue?: boolean
  createdAt: Date
  updatedAt: Date
}

export interface CreateSettingInput {
  key: string
  value: string | null
  description?: string | null
  category?: string | null
  isSecret?: boolean
}

export interface UpdateSettingInput {
  key: string
  value: string | null
  description?: string | null
}

// Get all settings (admin only)
export async function getSettingsAction(): Promise<ActionState<Setting[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getSettings")
  const log = createLogger({ requestId, action: "getSettings" })
  
  try {
    log.info("Action started: Getting settings")
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized settings access attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking administrator role")
    // Check if user is an administrator
    const isAdmin = await hasRole("administrator")
    if (!isAdmin) {
      log.warn("Settings access denied - not admin", { userId: session.sub })
      throw ErrorFactories.authzAdminRequired("view settings")
    }

    log.debug("Fetching settings from database")
    const result = await executeSQL(`
      SELECT 
        id,
        key,
        CASE 
          WHEN is_secret = true THEN '••••••••'
          ELSE value
        END as value,
        CASE 
          WHEN value IS NOT NULL AND value != '' THEN true
          ELSE false
        END as has_value,
        description,
        category,
        is_secret,
        created_at,
        updated_at
      FROM settings
      ORDER BY category, key
    `)

    log.info("Settings retrieved successfully", {
      settingCount: result.length,
      secretCount: result.filter(s => s.is_secret).length
    })
    
    timer({ status: "success", count: result.length })
    
    return createSuccess(result as unknown as Setting[], "Settings retrieved successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to get settings. Please try again or contact support.", {
      context: "getSettings",
      requestId,
      operation: "getSettings"
    })
  }
}

// Get a single setting value (for internal use)
export async function getSettingValueAction(key: string): Promise<string | null> {
  const requestId = generateRequestId()
  const timer = startTimer("getSettingValue")
  const log = createLogger({ requestId, action: "getSettingValue" })
  
  try {
    log.debug("Getting setting value", { key })
    
    const result = await executeSQL(
      `SELECT value FROM settings WHERE key = :key`,
      [{ name: 'key', value: { stringValue: key } }]
    )

    if (result && result.length > 0) {
      const value = result[0].value
      log.debug("Setting value retrieved", { key, hasValue: !!value })
      timer({ status: "success", key })
      return typeof value === 'string' ? value : null
    }

    log.debug("Setting not found", { key })
    timer({ status: "not_found", key })
    return null
  } catch (error) {
    log.error("Error getting setting value", { key, error })
    timer({ status: "error" })
    return null
  }
}

// Create or update a setting (admin only)
export async function upsertSettingAction(input: CreateSettingInput): Promise<ActionState<Setting>> {
  const requestId = generateRequestId()
  const timer = startTimer("upsertSetting")
  const log = createLogger({ requestId, action: "upsertSetting" })
  
  try {
    log.info("Action started: Upserting setting", {
      key: input.key,
      category: input.category,
      isSecret: input.isSecret,
      hasValue: !!input.value
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized setting upsert attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking administrator role")
    // Check if user is an administrator
    const isAdmin = await hasRole("administrator")
    if (!isAdmin) {
      log.warn("Setting upsert denied - not admin", { userId: session.sub, key: input.key })
      throw ErrorFactories.authzAdminRequired("manage settings")
    }

    // Check if setting exists
    log.debug("Checking if setting exists", { key: input.key })
    const existingResult = await executeSQL(
      `SELECT id FROM settings WHERE key = :key`,
      [{ name: 'key', value: { stringValue: input.key } }]
    )

    let result
    if (existingResult && existingResult.length > 0) {
      // Check if this is a secret being updated with empty value (keep existing)
      const existingIsSecret = await executeSQL(
        `SELECT is_secret, value FROM settings WHERE key = :key`,
        [{ name: 'key', value: { stringValue: input.key } }]
      )
      
      const isSecret = existingIsSecret?.[0]?.is_secret === true || existingIsSecret?.[0]?.is_secret === 1
      const hasExistingValue = existingIsSecret?.[0]?.value !== null && existingIsSecret?.[0]?.value !== ''
      const keepExistingValue = isSecret && !input.value && hasExistingValue
      
      // Update existing setting
      if (keepExistingValue) {
        // Update without changing the value
        result = await executeSQL(
          `UPDATE settings 
           SET description = :description, 
               category = :category, 
               is_secret = :isSecret,
               updated_at = NOW()
           WHERE key = :key
           RETURNING id, key, 
             CASE 
               WHEN is_secret = true THEN '••••••••'
               ELSE value
             END as value,
             CASE 
               WHEN value IS NOT NULL AND value != '' THEN true
               ELSE false
             END as has_value,
             description, category, is_secret, created_at, updated_at`,
          [
            { name: 'description', value: input.description ? { stringValue: input.description } : { isNull: true } },
            { name: 'category', value: input.category ? { stringValue: input.category } : { isNull: true } },
            { name: 'isSecret', value: { booleanValue: input.isSecret || false } },
            { name: 'key', value: { stringValue: input.key } }
          ]
        )
      } else {
        // Update including the value
        result = await executeSQL(
          `UPDATE settings 
           SET value = :value, 
               description = :description, 
               category = :category, 
               is_secret = :isSecret,
               updated_at = NOW()
           WHERE key = :key
           RETURNING id, key, 
             CASE 
               WHEN is_secret = true THEN '••••••••'
               ELSE value
             END as value,
             CASE 
               WHEN value IS NOT NULL AND value != '' THEN true
               ELSE false
             END as has_value,
             description, category, is_secret, created_at, updated_at`,
          [
            { name: 'value', value: input.value ? { stringValue: input.value } : { isNull: true } },
            { name: 'description', value: input.description ? { stringValue: input.description } : { isNull: true } },
            { name: 'category', value: input.category ? { stringValue: input.category } : { isNull: true } },
            { name: 'isSecret', value: { booleanValue: input.isSecret || false } },
            { name: 'key', value: { stringValue: input.key } }
          ]
        )
      }
    } else {
      // Create new setting
      result = await executeSQL(
        `INSERT INTO settings (key, value, description, category, is_secret)
         VALUES (:key, :value, :description, :category, :isSecret)
         RETURNING id, key, 
           CASE 
             WHEN is_secret = true THEN '••••••••'
             ELSE value
           END as value,
           CASE 
             WHEN value IS NOT NULL AND value != '' THEN true
             ELSE false
           END as has_value,
           description, category, is_secret, created_at, updated_at`,
        [
          { name: 'key', value: { stringValue: input.key } },
          { name: 'value', value: input.value ? { stringValue: input.value } : { isNull: true } },
          { name: 'description', value: input.description ? { stringValue: input.description } : { isNull: true } },
          { name: 'category', value: input.category ? { stringValue: input.category } : { isNull: true } },
          { name: 'isSecret', value: { booleanValue: input.isSecret || false } }
        ]
      )
    }

    if (!result || result.length === 0) {
      log.error("Failed to save setting", { key: input.key })
      throw ErrorFactories.dbQueryFailed("INSERT/UPDATE settings", new Error("No record returned"))
    }

    const setting = result[0] as unknown as Setting

    // Invalidate the settings cache
    log.debug("Invalidating settings cache")
    await revalidateSettingsCache()

    log.info("Setting saved successfully", {
      key: setting.key,
      category: setting.category,
      isUpdate: !!(existingResult && existingResult.length > 0)
    })
    
    timer({ status: "success", key: setting.key })
    
    return createSuccess(setting, "Setting saved successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to save setting. Please try again or contact support.", {
      context: "upsertSetting",
      requestId,
      operation: "upsertSetting",
      metadata: sanitizeForLogging({ key: input.key, category: input.category }) as Record<string, unknown>
    })
  }
}

// Delete a setting (admin only)
export async function deleteSettingAction(key: string): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteSetting")
  const log = createLogger({ requestId, action: "deleteSetting" })
  
  try {
    log.info("Action started: Deleting setting", { key })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized setting deletion attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking administrator role")
    // Check if user is an administrator
    const isAdmin = await hasRole("administrator")
    if (!isAdmin) {
      log.warn("Setting deletion denied - not admin", { userId: session.sub, key })
      throw ErrorFactories.authzAdminRequired("delete settings")
    }

    log.info("Deleting setting from database", { key })
    await executeSQL(
      `DELETE FROM settings WHERE key = :key`,
      [{ name: 'key', value: { stringValue: key } }]
    )

    // Invalidate the settings cache
    log.debug("Invalidating settings cache")
    await revalidateSettingsCache()

    log.info("Setting deleted successfully", { key })
    
    timer({ status: "success", key })
    
    return createSuccess(undefined, "Setting deleted successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to delete setting. Please try again or contact support.", {
      context: "deleteSetting",
      requestId,
      operation: "deleteSetting",
      metadata: { key }
    })
  }
}

// Get actual (unmasked) value for a secret setting (admin only)
export async function getSettingActualValueAction(key: string): Promise<ActionState<string | null>> {
  const requestId = generateRequestId()
  const timer = startTimer("getSettingActualValue")
  const log = createLogger({ requestId, action: "getSettingActualValue" })
  
  try {
    log.info("Action started: Getting actual setting value", { key })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized secret value access attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking administrator role")
    // Check if user is an administrator
    const isAdmin = await hasRole("administrator")
    if (!isAdmin) {
      log.warn("Secret value access denied - not admin", { userId: session.sub, key })
      throw ErrorFactories.authzAdminRequired("view secret values")
    }

    log.debug("Fetching actual setting value from database", { key })
    const result = await executeSQL(
      `SELECT value FROM settings WHERE key = :key`,
      [{ name: 'key', value: { stringValue: key } }]
    )

    if (result && result.length > 0) {
      const value = result[0].value
      log.info("Actual setting value retrieved", { key, hasValue: !!value })
      timer({ status: "success", key })
      return createSuccess(typeof value === 'string' ? value : null, "Value retrieved successfully")
    }

    log.warn("Setting not found", { key })
    timer({ status: "not_found", key })
    return createSuccess(null, "Setting not found")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to get setting value. Please try again or contact support.", {
      context: "getSettingActualValue",
      requestId,
      operation: "getSettingActualValue",
      metadata: { key }
    })
  }
}

