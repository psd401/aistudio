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
import { revalidateSettingsCache, getSetting } from "@/lib/settings-manager"

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

    return createSuccess(result, "Settings retrieved successfully")
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

// Upload a branding logo to S3 and save the URL as a setting (admin only)
export async function uploadBrandingLogoAction(formData: FormData): Promise<ActionState<string>> {
  const requestId = generateRequestId()
  const timer = startTimer("uploadBrandingLogo")
  const log = createLogger({ requestId, action: "uploadBrandingLogo" })

  try {
    log.info("Action started: Uploading branding logo")

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized logo upload attempt")
      throw ErrorFactories.authNoSession()
    }

    const isAdmin = await hasRole("administrator")
    if (!isAdmin) {
      log.warn("Logo upload denied - not admin", { userId: session.sub })
      throw ErrorFactories.authzAdminRequired("upload branding logo")
    }

    // Validate file is actually a File object (not a string — FormDataEntryValue is string | File)
    const rawFile = formData.get("file")
    if (!(rawFile instanceof File)) {
      throw ErrorFactories.missingRequiredField("file")
    }
    const file = rawFile

    // Server-side MIME allowlist — SVG excluded due to stored XSS risk
    const MIME_TO_EXT: Record<string, { ext: string; magic: number[] }> = {
      "image/png":  { ext: "png",  magic: [0x89, 0x50, 0x4E, 0x47] },
      "image/jpeg": { ext: "jpg",  magic: [0xFF, 0xD8, 0xFF] },
      // WebP is a RIFF container: bytes 0-3 must be RIFF, bytes 8-11 must be WEBP
      // Using RIFF header only (0x52 0x49 0x46 0x46) would also match WAV and AVI files
      "image/webp": { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
    }
    const typeConfig = MIME_TO_EXT[file.type]
    if (!typeConfig) {
      throw ErrorFactories.invalidInput("file", file.type, "Must be PNG, JPEG, or WebP")
    }

    // Validate file size (max 2MB for logos)
    const maxSize = 2 * 1024 * 1024
    if (file.size > maxSize) {
      throw ErrorFactories.invalidInput("file", file.size, "Maximum logo size is 2MB")
    }

    const buffer = Buffer.from(await file.arrayBuffer())

    // Magic-byte validation — confirms actual content matches declared type.
    // WebP requires both RIFF header (bytes 0-3) AND WEBP marker (bytes 8-11)
    // because the RIFF container is shared by WAV and AVI files.
    const WEBP_MARKER = [0x57, 0x45, 0x42, 0x50]
    const magicValid = file.type === "image/webp"
      ? typeConfig.magic.every((byte, i) => buffer[i] === byte) &&
        WEBP_MARKER.every((byte, i) => buffer[8 + i] === byte)
      : typeConfig.magic.every((byte, i) => buffer[i] === byte)
    if (!magicValid) {
      throw ErrorFactories.invalidInput("file", file.type, "File content does not match declared type")
    }

    // Extension derived from server-validated MIME type, never from user-supplied filename
    const fileName = `branding-logo.${typeConfig.ext}`

    const { uploadDocument, getDocumentSignedUrl, deleteDocument } = await import("@/lib/aws/s3-client")

    // Read the previous key before uploading so we can clean it up afterward.
    // Must happen before uploadDocument() to avoid a data-loss window where
    // the old object is deleted but the upload then fails — leaving no logo at all.
    const previousKey = await getSetting("BRANDING_LOGO_URL")

    const { key } = await uploadDocument({
      userId: "_branding",
      fileName,
      fileContent: buffer,
      contentType: file.type,
      metadata: { purpose: "branding-logo" }
    })

    // Save the S3 key as the setting value (not the signed URL, which expires)
    await upsertSetting({
      key: "BRANDING_LOGO_URL",
      value: key,
      description: "Logo image S3 key (uploaded via admin settings)",
      category: "branding",
      isSecret: false
    })

    // Invalidate only the logo URL cache entry, not the entire settings cache
    await revalidateSettingsCache("BRANDING_LOGO_URL")

    // Delete the previous logo only after the new one is fully saved.
    // This order prevents data loss: if upload fails above, the old logo survives.
    // Deletion failure is non-fatal — the orphaned file wastes storage but causes no user impact.
    if (previousKey && !previousKey.startsWith("/")) {
      try {
        await deleteDocument(previousKey)
        log.debug("Deleted previous branding logo", { previousKey })
      } catch {
        log.warn("Could not delete previous branding logo", { previousKey })
      }
    }

    // Return a signed URL for immediate client-side preview
    const signedUrl = await getDocumentSignedUrl({ key, expiresIn: 3600 })

    log.info("Branding logo uploaded successfully", { key })
    timer({ status: "success" })

    return createSuccess(signedUrl, "Logo uploaded successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to upload logo. Please try again.", {
      context: "uploadBrandingLogo",
      requestId,
      operation: "uploadBrandingLogo"
    })
  }
}

// Get a signed URL for the branding logo if it's stored in S3 (admin/internal use)
export async function getBrandingLogoUrlAction(): Promise<ActionState<string>> {
  const requestId = generateRequestId()
  const timer = startTimer("getBrandingLogoUrl")
  const log = createLogger({ requestId, action: "getBrandingLogoUrl" })

  try {
    log.info("Action started: Getting branding logo URL")

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized branding logo URL access attempt")
      throw ErrorFactories.authNoSession()
    }

    // Use getSetting() directly to avoid importing the Settings object (which would
    // deepen the existing circular dependency: settings-manager → settings-actions → settings-manager)
    const logoValue = (await getSetting("BRANDING_LOGO_URL")) ?? "/logo.png"

    // If the value is a local path (starts with /), return as-is — no S3 involved
    if (logoValue.startsWith("/")) {
      timer({ status: "success" })
      return createSuccess(logoValue, "Logo URL retrieved")
    }

    // Otherwise it's an S3 key — generate a signed URL
    const { getDocumentSignedUrl } = await import("@/lib/aws/s3-client")
    const signedUrl = await getDocumentSignedUrl({ key: logoValue, expiresIn: 3600 })

    timer({ status: "success" })
    return createSuccess(signedUrl, "Logo URL retrieved")
  } catch (error) {
    log.error("Failed to get branding logo URL", { error })
    timer({ status: "error" })
    return handleError(error, "Failed to retrieve branding logo URL", {
      context: "getBrandingLogoUrl",
      requestId,
      operation: "getBrandingLogoUrl"
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

