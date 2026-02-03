import { getSettingValueAction } from "@/actions/db/settings-actions"
import logger from "@/lib/logger"

// Cache for settings to avoid repeated database queries
const settingsCache = new Map<string, { value: string | null; timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Get a setting value with caching and fallback to environment variable
export async function getSetting(key: string): Promise<string | null> {
  // Special handling for Bedrock credentials in Lambda
  const isAwsLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME
  const isBedrockCredential = key === 'BEDROCK_ACCESS_KEY_ID' || key === 'BEDROCK_SECRET_ACCESS_KEY'
  
  // Don't use cache for Bedrock credentials in Lambda
  if (!(isAwsLambda && isBedrockCredential)) {
    // Check cache first
    const cached = settingsCache.get(key)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      // Cache hit
      return cached.value
    }
  }

  try {
    // Try to get from database
    const dbValue = await getSettingValueAction(key)
    
    if (dbValue !== null) {
      // Database value found - cache it and return
      settingsCache.set(key, { value: dbValue, timestamp: Date.now() })
      return dbValue
    }
  } catch (error) {
    logger.error(`[SettingsManager] Error fetching setting ${key} from database:`, error)
  }

  // Fall back to environment variable
  // IMPORTANT: In AWS Lambda, ignore Bedrock credentials from env vars
  // to force use of IAM role credentials
  
  if (isAwsLambda && isBedrockCredential) {
    // In Lambda, ignore Bedrock credential env vars to use IAM role
    logger.info(`[SettingsManager] Ignoring env var ${key} in Lambda environment`)
    // Cache the null for Lambda to avoid repeated DB queries
    settingsCache.set(key, { value: null, timestamp: Date.now() })
    return null
  }
  
  const envValue = process.env[key] || null
  
  // Only cache the final result to avoid blocking env var fallback
  settingsCache.set(key, { value: envValue, timestamp: Date.now() })
  
  if (envValue) {
    // Falling back to env var
  } else {
    // No value found
  }
  
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
export async function revalidateSettingsCache(key?: string) {
  if (key) {
    settingsCache.delete(key)
    // Cache cleared for key
  } else {
    settingsCache.clear()
    // Cache cleared
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
  }
}