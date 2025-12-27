"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { getSettings, getSettingValue as getSettingValueDrizzle, upsertSetting, deleteSetting as deleteSettingDrizzle, getSettingActualValue as getSettingActualValueDrizzle } from "@/lib/db/drizzle"
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
  isSecret: boolean | null
  hasValue?: boolean
  createdAt: Date | null
  updatedAt: Date | null
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
    const result = await getSettings()

    log.info("Settings retrieved successfully", {
      settingCount: result.length,
      secretCount: result.filter(s => s.isSecret === true).length
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

    const value = await getSettingValueDrizzle(key)

    log.debug("Setting value retrieved", { key, hasValue: !!value })
    timer({ status: value ? "success" : "not_found", key })
    return value
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

    // Upsert the setting using Drizzle
    log.debug("Upserting setting", { key: input.key })
    const setting = await upsertSetting(input)

    // Invalidate the settings cache
    log.debug("Invalidating settings cache")
    await revalidateSettingsCache()

    log.info("Setting saved successfully", {
      key: setting.key,
      category: setting.category
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
    await deleteSettingDrizzle(key)

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
    const value = await getSettingActualValueDrizzle(key)

    log.info("Actual setting value retrieved", { key, hasValue: !!value })
    timer({ status: value ? "success" : "not_found", key })
    return createSuccess(value, value ? "Value retrieved successfully" : "Setting not found")
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

