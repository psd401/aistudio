import { getSettingValue as getSettingValueDrizzle } from "@/lib/db/drizzle"
import logger from "@/lib/logger"

// Cache for settings to avoid repeated database queries
// Uses stale-while-revalidate: serves stale value immediately while refreshing in background
const settingsCache = new Map<string, { value: string | null; timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes
// On DB error, retry after this shorter window rather than waiting the full TTL
const RETRY_AFTER_ERROR_MS = 30 * 1000 // 30 seconds

// Track in-flight background refreshes to avoid duplicate fetches
const pendingRefreshes = new Set<string>()

// Mask credential/secret key names in log output to avoid leaking config surface
const SENSITIVE_KEY_PATTERN = /KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL/i
export function maskKey(key: string): string {
  return SENSITIVE_KEY_PATTERN.test(key) ? `${key.substring(0, 4)}***` : key
}

// Background refresh: fetch fresh value without blocking the caller.
// IMPORTANT: Only called from within the `!(isAwsLambda && isBedrockCredential)` block,
// so Lambda+Bedrock keys (which must use IAM role, not env vars) never reach this function.
// Do not call backgroundRefresh() for Lambda+Bedrock keys from other code paths.
function backgroundRefresh(key: string): void {
  if (pendingRefreshes.has(key)) return
  pendingRefreshes.add(key)

  getSettingValueDrizzle(key)
    .then((dbValue) => {
      if (dbValue !== null) {
        // Fresh value from DB — update cache
        settingsCache.set(key, { value: dbValue, timestamp: Date.now() })
      } else {
        // getSettingValueDrizzle() returns null both when the setting is missing
        // and when a DB error occurs (via executeQuery retry/circuit breaker).
        // To avoid clobbering a previously-good
        // cached value on transient errors, only fall back to env when there is
        // no existing cache entry.
        const existing = settingsCache.get(key)
        if (existing) {
          // Preserve existing value, just refresh timestamp
          settingsCache.set(key, { value: existing.value, timestamp: Date.now() })
        } else {
          const envValue = process.env[key] || null
          settingsCache.set(key, { value: envValue, timestamp: Date.now() })
        }
      }
    })
    .catch((error) => {
      logger.error(`[SettingsManager] Background refresh failed for ${maskKey(key)}:`, error)
      // On error, retry after a short window (not full TTL) so we recover quickly when DB is back
      const stale = settingsCache.get(key)
      if (stale) {
        settingsCache.set(key, {
          value: stale.value,
          timestamp: Date.now() - CACHE_TTL + RETRY_AFTER_ERROR_MS,
        })
      }
    })
    .finally(() => {
      pendingRefreshes.delete(key)
    })
}

// Get a setting value with caching and fallback to environment variable
export async function getSetting(key: string): Promise<string | null> {
  // Special handling for Bedrock credentials in Lambda
  const isAwsLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME
  const isBedrockCredential = key === 'BEDROCK_ACCESS_KEY_ID' || key === 'BEDROCK_SECRET_ACCESS_KEY'

  // Don't use cache for Bedrock credentials in Lambda
  if (!(isAwsLambda && isBedrockCredential)) {
    const cached = settingsCache.get(key)
    if (cached) {
      const isStale = Date.now() - cached.timestamp >= CACHE_TTL
      if (!isStale) {
        // Cache hit — fresh
        return cached.value
      }
      // Stale-while-revalidate: return stale value immediately, refresh in background
      backgroundRefresh(key)
      return cached.value
    }
  }

  // Cold start — no cached value, must fetch synchronously
  try {
    // Try to get from database
    const dbValue = await getSettingValueDrizzle(key)

    if (dbValue !== null) {
      // Database value found - cache it and return
      settingsCache.set(key, { value: dbValue, timestamp: Date.now() })
      return dbValue
    }
  } catch (error) {
    logger.error(`[SettingsManager] Error fetching setting ${maskKey(key)} from database:`, error)
  }

  // Fall back to environment variable
  // IMPORTANT: In AWS Lambda, ignore Bedrock credentials from env vars
  // to force use of IAM role credentials

  if (isAwsLambda && isBedrockCredential) {
    // In Lambda, ignore Bedrock credential env vars to use IAM role
    logger.info(`[SettingsManager] Ignoring env var ${maskKey(key)} in Lambda environment`)
    // Cache the null for Lambda to avoid repeated DB queries
    settingsCache.set(key, { value: null, timestamp: Date.now() })
    return null
  }

  const envValue = process.env[key] || null

  // Only cache the final result to avoid blocking env var fallback
  settingsCache.set(key, { value: envValue, timestamp: Date.now() })

  return envValue
}

// Get multiple settings at once
export async function getSettings(keys: string[]): Promise<Record<string, string | null>> {
  const results: Record<string, string | null> = {}
  
  await Promise.all(
    keys.map(async (key) => {
      results[key] = await getSetting(key)
    })
  )
  
  return results
}

// Clear the cache (useful after updates)
// Also cancels any pending background refresh for the key to prevent a stale
// in-flight promise from writing old data back into the cache after invalidation.
export async function revalidateSettingsCache(key?: string): Promise<void> {
  if (key) {
    settingsCache.delete(key)
    pendingRefreshes.delete(key)
  } else {
    settingsCache.clear()
    pendingRefreshes.clear()
  }
  
  // Also clear S3 cache when settings are updated
  const { clearS3Cache } = await import("@/lib/aws/s3-client")
  clearS3Cache()
}

// Helper to get required setting (throws if not found)
export async function getRequiredSetting(key: string): Promise<string> {
  const value = await getSetting(key)
  if (!value) {
    throw new Error(`Required setting ${key} is not configured`)
  }
  return value
}

// Typed setting getters for common configurations
export const Settings = {
  // AI Providers
  async getAzureOpenAI() {
    const [key, endpoint, resourceName] = await Promise.all([
      getSetting('AZURE_OPENAI_KEY'),
      getSetting('AZURE_OPENAI_ENDPOINT'),
      getSetting('AZURE_OPENAI_RESOURCENAME')
    ])
    return { key, endpoint, resourceName }
  },

  async getBedrock() {
    const [accessKeyId, secretAccessKey, region] = await Promise.all([
      getSetting('BEDROCK_ACCESS_KEY_ID'),
      getSetting('BEDROCK_SECRET_ACCESS_KEY'),
      getSetting('BEDROCK_REGION')
    ])
    return { accessKeyId, secretAccessKey, region }
  },

  async getGoogleAI() {
    return getSetting('GOOGLE_API_KEY')
  },

  async getOpenAI() {
    return getSetting('OPENAI_API_KEY')
  },

  async getLatimer() {
    return getSetting('LATIMER_API_KEY')
  },

  async getGoogleVertex() {
    const [projectId, location, credentials] = await Promise.all([
      getSetting('GOOGLE_VERTEX_PROJECT_ID'),
      getSetting('GOOGLE_VERTEX_LOCATION'),
      getSetting('GOOGLE_APPLICATION_CREDENTIALS')
    ])
    return { projectId, location, credentials }
  },

  // Storage
  async getS3() {
    const [bucket, region] = await Promise.all([
      getSetting('S3_BUCKET') || getSetting('DOCUMENTS_BUCKET_NAME'),
      getSetting('AWS_REGION') || getSetting('NEXT_PUBLIC_AWS_REGION')
    ])
    return { bucket, region }
  },

  // External Services
  async getGitHub() {
    return getSetting('GITHUB_ISSUE_TOKEN')
  },

  async getFreshservice() {
    const [domain, apiKey, priority, status, ticketType, workspaceId, departmentId] = await Promise.all([
      getSetting('FRESHSERVICE_DOMAIN'),
      getSetting('FRESHSERVICE_API_KEY'),
      getSetting('FRESHSERVICE_DEFAULT_PRIORITY'),
      getSetting('FRESHSERVICE_DEFAULT_STATUS'),
      getSetting('FRESHSERVICE_TICKET_TYPE'),
      getSetting('FRESHSERVICE_WORKSPACE_ID'),
      getSetting('FRESHSERVICE_DEPARTMENT_ID')
    ])
    return {
      domain,
      apiKey,
      priority: priority || '2',      // Default to Medium
      status: status || '2',          // Default to Open
      ticketType: ticketType || 'Request',  // Changed from 'Incident' to 'Request'
      workspaceId,
      departmentId
    }
  },

  // Branding
  async getBranding() {
    const [orgName, appName, primaryColor, logoUrl, supportUrl, appUrl] = await Promise.all([
      getSetting('BRANDING_ORG_NAME'),
      getSetting('BRANDING_APP_NAME'),
      getSetting('BRANDING_PRIMARY_COLOR'),
      getSetting('BRANDING_LOGO_URL'),
      getSetting('BRANDING_SUPPORT_URL'),
      getSetting('BRANDING_APP_URL')
    ])
    // Validate primaryColor as a CSS hex color to prevent CSS injection
    // when embedded in style attributes (e.g. `color: ${primaryColor}`)
    const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/
    const validatedColor = primaryColor && HEX_COLOR_RE.test(primaryColor)
      ? primaryColor
      : '#1B365D'

    // Validate URLs to prevent javascript: URI injection in <a href>
    const validatedSupportUrl = supportUrl &&
      (supportUrl.startsWith('https://') || supportUrl.startsWith('http://'))
      ? supportUrl
      : ''

    // appUrl: canonical application URL, falls back to NEXT_PUBLIC_APP_URL env var
    const rawAppUrl = appUrl || process.env.NEXT_PUBLIC_APP_URL || ''
    const validatedAppUrl = rawAppUrl &&
      (rawAppUrl.startsWith('https://') || rawAppUrl.startsWith('http://'))
      ? rawAppUrl.replace(/\/+$/, '') // strip trailing slashes
      : ''

    const rawLogoValue = logoUrl || '/logo.png'
    return {
      orgName: orgName || 'Your Organization',
      appName: appName || 'AI Studio',
      primaryColor: validatedColor,
      // logoPath: the raw stored value. Either a local "/" path or an S3 key.
      // isLogoS3Key: true when the value must be resolved to a signed URL.
      // @example Server component usage — use getBrandingConfig() from lib/branding.ts
      //   which handles S3 resolution without requiring an auth session.
      logoPath: rawLogoValue,
      isLogoS3Key: !rawLogoValue.startsWith('/'),
      supportUrl: validatedSupportUrl,
      appUrl: validatedAppUrl
    }
  },

  // K-12 Content Safety
  async getContentSafety() {
    const [
      guardrailId,
      guardrailVersion,
      piiTokenTableName,
      violationTopicArn,
      enabled,
      piiTokenizationEnabled
    ] = await Promise.all([
      getSetting('BEDROCK_GUARDRAIL_ID'),
      getSetting('BEDROCK_GUARDRAIL_VERSION'),
      getSetting('PII_TOKEN_TABLE_NAME'),
      getSetting('GUARDRAIL_VIOLATION_TOPIC_ARN'),
      getSetting('CONTENT_SAFETY_ENABLED'),
      getSetting('PII_TOKENIZATION_ENABLED')
    ])
    return {
      guardrailId,
      guardrailVersion: guardrailVersion || 'DRAFT',
      piiTokenTableName,
      violationTopicArn,
      enabled: enabled !== 'false', // Default to true if not explicitly disabled
      piiTokenizationEnabled: piiTokenizationEnabled !== 'false' // Default to true
    }
  },

  // Voice (Issue #872)
  async getVoice() {
    const [provider, model, language, voiceName] = await Promise.all([
      getSetting('VOICE_PROVIDER'),
      getSetting('VOICE_MODEL'),
      getSetting('VOICE_LANGUAGE'),
      getSetting('VOICE_NAME'),
    ])
    return {
      provider: provider || null,
      model: model || null,
      language: language || 'en-US',
      voiceName: voiceName || null,
    }
  }
}
