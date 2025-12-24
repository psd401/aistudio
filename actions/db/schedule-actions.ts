"use server"

import { hasToolAccess } from "@/lib/db/data-api-adapter"
import { createLogger, generateRequestId, startTimer, sanitizeForLogging } from "@/lib/logger"
import { handleError, ErrorFactories, createSuccess } from "@/lib/error-utils"
import { getServerSession } from "@/lib/auth/server-session"
import { ActionState } from "@/types"
// Note: cron-parser had import issues, using robust regex validation instead
import escapeHtml from "escape-html"
import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
  ScheduleState
} from "@aws-sdk/client-scheduler"
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"
// Drizzle ORM operations
import {
  getScheduleByIdForUser,
  getSchedulesByUserId,
  checkAssistantArchitectOwnership,
  createSchedule as drizzleCreateSchedule,
  updateSchedule as drizzleUpdateSchedule,
  deleteSchedule as drizzleDeleteSchedule,
  getScheduleUserIdByCognitoSub,
  type ScheduleConfig as DrizzleScheduleConfig,
} from "@/lib/db/drizzle"

// Types for Schedule Management
export interface ScheduleConfig {
  frequency: 'daily' | 'weekly' | 'monthly' | 'custom'
  time: string // HH:MM format
  timezone?: string
  cron?: string // for custom schedules
  daysOfWeek?: number[] // for weekly (0=Sunday, 6=Saturday)
  dayOfMonth?: number // for monthly (1-31)
}

// Lambda payload types for schedule operations
export interface ScheduleLambdaPayload {
  action: 'create' | 'update' | 'delete'
  scheduledExecutionId: number
  cronExpression?: string
  timezone?: string
  active?: boolean
}

export interface ScheduleLambdaResponse {
  statusCode: number
  body: string
  scheduleArn?: string
  errorType?: string
  errorMessage?: string
}

export interface CreateScheduleRequest {
  name: string
  assistantArchitectId: number
  scheduleConfig: ScheduleConfig
  inputData: Record<string, unknown>
}

export interface Schedule {
  id: number
  name: string
  userId: number
  assistantArchitectId: number
  scheduleConfig: ScheduleConfig
  inputData: Record<string, unknown>
  active: boolean
  createdAt: string
  updatedAt: string
  nextExecution?: string
  lastExecution?: {
    executedAt: string
    status: 'success' | 'failed'
  }
}

export interface UpdateScheduleRequest extends Partial<CreateScheduleRequest> {
  active?: boolean
}

// Security: CodeQL-compliant sanitizer that breaks taint flow completely
function sanitizeNumericId(value: unknown): number {
  // Convert to number and validate
  const num = Number(value)

  // Strict validation with early exit
  if (!Number.isInteger(num) || !Number.isFinite(num) || num <= 0 || num > Number.MAX_SAFE_INTEGER) {
    throw ErrorFactories.validationFailed([{ field: 'id', message: 'Invalid numeric ID', value }])
  }

  // Create a completely new clean value to break taint flow
  // Math.floor(Math.abs()) creates a new primitive that CodeQL recognizes as safe
  return Math.floor(Math.abs(num))
}

// Maximum schedules per user
// Note: Schedule limit per user removed - users can create unlimited schedules

// Maximum input data size (10MB) - increased from 50KB to be more generous
const MAX_INPUT_DATA_SIZE = 10485760

// Initialize AWS clients
const schedulerClient = new SchedulerClient({ region: process.env.AWS_REGION || 'us-east-1' })
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' })

// NOTE: Configuration caching removed as it was not being used
// If needed in future for performance optimization, restore from git history

/**
 * Gets the deployment environment for AWS service configuration
 */
function getEnvironment(): string {
  // Determine environment from available env vars (prioritize explicit settings)
  const env = process.env.AMPLIFY_ENV ||
             process.env.NEXT_PUBLIC_ENVIRONMENT ||
             process.env.ENVIRONMENT ||
             'dev'

  // Validate environment value against allowlist
  const allowedEnvironments = ['dev', 'prod']
  if (!allowedEnvironments.includes(env)) {
    throw ErrorFactories.sysConfigurationError(`Invalid environment: ${env}. Must be one of: ${allowedEnvironments.join(', ')}`)
  }

  return env
}

/**
 * Fetches EventBridge configuration from SSM Parameter Store with caching
 */
/**
 * Invokes the schedule-executor Lambda function to manage EventBridge schedules
 */
interface InvokeScheduleManagerPayload {
  scheduleId: number
  name?: string
  scheduleConfig?: ScheduleConfig
  inputData?: Record<string, unknown>
  active?: boolean
}

async function invokeScheduleManager(action: ScheduleLambdaPayload['action'], payload: InvokeScheduleManagerPayload, requestId?: string): Promise<ScheduleLambdaResponse> {
  const log = createLogger({ operation: 'invokeScheduleManager', action, requestId })
  const environment = getEnvironment()
  const functionName = `aistudio-${environment}-schedule-executor`

  // Convert our payload to match the Lambda's expected format
  let lambdaPayload: ScheduleLambdaPayload = { action, scheduledExecutionId: payload.scheduleId }

  if (action === 'create') {
    if (!payload.scheduleConfig) {
      throw ErrorFactories.validationFailed([{ field: 'scheduleConfig', message: 'scheduleConfig is required for create action' }])
    }
    const cronExpression = convertToCronExpression(payload.scheduleConfig)
    lambdaPayload = {
      action,
      scheduledExecutionId: payload.scheduleId,
      cronExpression,
      timezone: payload.scheduleConfig.timezone || 'UTC'
    }
  } else if (action === 'update') {
    if (!payload.scheduleConfig) {
      throw ErrorFactories.validationFailed([{ field: 'scheduleConfig', message: 'scheduleConfig is required for update action' }])
    }
    const cronExpression = convertToCronExpression(payload.scheduleConfig)
    lambdaPayload = {
      action,
      scheduledExecutionId: payload.scheduleId,
      cronExpression,
      timezone: payload.scheduleConfig.timezone || 'UTC',
      active: payload.active
    }
  } else if (action === 'delete') {
    lambdaPayload = {
      action,
      scheduledExecutionId: payload.scheduleId
    }
  }

  const command = new InvokeCommand({
    FunctionName: functionName,
    Payload: JSON.stringify(lambdaPayload)
  })

  log.info('Invoking schedule executor Lambda', { functionName, action })

  const response = await lambdaClient.send(command)

  if (response.Payload) {
    const result: ScheduleLambdaResponse = JSON.parse(new TextDecoder().decode(response.Payload))
    if (result.errorType) {
      // Log full error for debugging (server-side only)
      log.error('Lambda invocation failed', {
        errorType: result.errorType,
        errorMessage: sanitizeForLogging(result.errorMessage),
        action,
        requestId
      })

      // Throw sanitized error for user
      throw ErrorFactories.externalServiceError(
        'ScheduleExecutorLambda',
        new Error('Failed to manage schedule')
      )
    }

    // Extract schedule ARN from the response for create operations
    if (action === 'create' && result.statusCode === 200) {
      const body = JSON.parse(result.body)
      return { ...result, scheduleArn: body.scheduleArn }
    }

    return result
  }

  throw ErrorFactories.externalServiceError('No response from Lambda function')
}

/**
 * Validates and sanitizes name field
 */
function validateAndSanitizeName(name: string): { isValid: boolean; sanitizedName: string; errors: string[] } {
  const errors: string[] = []

  if (!name || name.trim().length === 0) {
    errors.push('Name is required')
    return { isValid: false, sanitizedName: '', errors }
  }

  const sanitizedName = escapeHtml(name.trim())

  if (sanitizedName.length === 0) {
    errors.push('Name cannot be empty after sanitization')
  } else if (sanitizedName.length > 1000) {
    errors.push('Name exceeds maximum length of 1000 characters')
  }

  return { isValid: errors.length === 0, sanitizedName, errors }
}

/**
 * Validates input data size and structure
 */
function validateInputData(inputData: Record<string, unknown>): { isValid: boolean; errors: string[] } {
  const errors: string[] = []

  try {
    const serializedData = JSON.stringify(inputData)
    if (serializedData.length > MAX_INPUT_DATA_SIZE) {
      errors.push(`Input data exceeds maximum size limit of ${MAX_INPUT_DATA_SIZE / 1000}KB`)
    }
  } catch {
    errors.push('Input data is not serializable to JSON')
  }

  return { isValid: errors.length === 0, errors }
}

/**
 * Validates schedule configuration
 */
function validateScheduleConfig(config: ScheduleConfig): { isValid: boolean; errors: string[] } {
  const errors: string[] = []

  // Validate frequency
  if (!['daily', 'weekly', 'monthly', 'custom'].includes(config.frequency)) {
    errors.push('Invalid frequency. Must be daily, weekly, monthly, or custom')
  }

  // Validate time format (HH:MM)
  const timeRegex = /^([01]?\d|2[0-3]):[0-5]\d$/
  if (!timeRegex.test(config.time)) {
    errors.push('Invalid time format. Must be HH:MM (24-hour format)')
  }

  // Validate frequency-specific fields
  if (config.frequency === 'weekly') {
    if (!config.daysOfWeek || !Array.isArray(config.daysOfWeek) || config.daysOfWeek.length === 0) {
      errors.push('daysOfWeek is required and must be a non-empty array for weekly schedules')
    } else if (config.daysOfWeek.some(day => day < 0 || day > 6)) {
      errors.push('daysOfWeek must contain values between 0 (Sunday) and 6 (Saturday)')
    }
  }

  if (config.frequency === 'monthly') {
    if (!config.dayOfMonth || config.dayOfMonth < 1 || config.dayOfMonth > 31) {
      errors.push('dayOfMonth is required and must be between 1 and 31 for monthly schedules')
    }
  }

  if (config.frequency === 'custom') {
    if (!config.cron) {
      errors.push('cron expression is required for custom schedules')
    } else {
      // Comprehensive cron validation with strict input sanitization
      const trimmedCron = config.cron.trim()

      // First, ensure the cron string only contains allowed characters
      // eslint-disable-next-line no-useless-escape
      if (!/^[\d\s*,/\-]+$/.test(trimmedCron)) {
        errors.push('Cron expression contains invalid characters')
      } else {
        const cronFields = trimmedCron.split(/\s+/)

        // Validate exact field count first
        if (cronFields.length !== 5) {
          errors.push('cron expression must have exactly 5 fields (minute hour day month day-of-week)')
        } else {
          // Validate each field individually to prevent bypass attempts
          const [minute, hour, day, month, dayOfWeek] = cronFields

          // Validate minute field (0-59) - ReDoS-safe pattern
          if (!/^\*$|^[0-5]?\d$|^[0-5]?\d-[0-5]?\d$|^[0-5]?\d\/\d+$|^\*\/\d+$/.test(minute)) {
            errors.push('Invalid minute field in cron expression')
          }

          // Validate hour field (0-23) - ReDoS-safe pattern
          if (!/^\*$|^(?:[01]?\d|2[0-3])$|^(?:[01]?\d|2[0-3])-(?:[01]?\d|2[0-3])$|^(?:[01]?\d|2[0-3])\/\d+$|^\*\/\d+$/.test(hour)) {
            errors.push('Invalid hour field in cron expression')
          }

          // Validate day field (1-31) - ReDoS-safe pattern
          if (!/^\*$|^(?:[12]?\d|3[01])$|^(?:[12]?\d|3[01])-(?:[12]?\d|3[01])$|^(?:[12]?\d|3[01])\/\d+$|^\*\/\d+$/.test(day)) {
            errors.push('Invalid day field in cron expression')
          }

          // Validate month field (1-12) - ReDoS-safe pattern
          if (!/^\*$|^(?:[1-9]|1[0-2])$|^(?:[1-9]|1[0-2])-(?:[1-9]|1[0-2])$|^(?:[1-9]|1[0-2])\/\d+$|^\*\/\d+$/.test(month)) {
            errors.push('Invalid month field in cron expression')
          }

          // Validate day-of-week field (0-6) - ReDoS-safe pattern
          if (!/^\*$|^[0-6]$|^[0-6]-[0-6]$|^[0-6]\/\d+$|^\*\/\d+$/.test(dayOfWeek)) {
            errors.push('Invalid day-of-week field in cron expression')
          }
        }
      }
    }
  }

  // Note: Timezone validation removed to prevent false positives
  // The timezone will be stored as-is and used by the scheduler

  return { isValid: errors.length === 0, errors }
}

/**
 * Converts schedule configuration to cron expression for EventBridge
 */
function convertToCronExpression(scheduleConfig: ScheduleConfig): string {
  const { frequency, time, daysOfWeek, dayOfMonth, cron } = scheduleConfig

  if (frequency === 'custom' && cron) {
    return cron
  }

  const [hours, minutes] = time.split(':').map(Number)

  switch (frequency) {
    case 'daily':
      return `${minutes} ${hours} * * ? *`

    case 'weekly': {
      if (!daysOfWeek || daysOfWeek.length === 0) {
        throw ErrorFactories.validationFailed([{ field: 'daysOfWeek', message: 'Days of week required for weekly schedules' }])
      }
      // Convert from 0=Sunday to 1=Sunday for cron
      const cronDays = daysOfWeek.map(day => day === 0 ? 7 : day).join(',')
      return `${minutes} ${hours} ? * ${cronDays} *`
    }

    case 'monthly': {
      const day = dayOfMonth || 1
      return `${minutes} ${hours} ${day} * ? *`
    }

    default:
      throw ErrorFactories.validationFailed([{ field: 'frequency', message: `Unsupported frequency: ${frequency}`, value: frequency }])
  }
}

/**
 * Creates an EventBridge schedule
 */
async function _createEventBridgeSchedule(
  scheduleId: number,
  name: string,
  scheduleConfig: ScheduleConfig,
  targetArn: string,
  roleArn: string,
  _inputData: Record<string, unknown>
): Promise<string> {
  const log = createLogger({ operation: 'createEventBridgeSchedule' })

  try {
    // SECURITY FIX: Validate schedule configuration before cron conversion
    const validationResult = validateScheduleConfig(scheduleConfig)
    if (!validationResult.isValid) {
      throw ErrorFactories.validationFailed([{ field: 'scheduleConfig', message: `Invalid schedule configuration: ${validationResult.errors.join(', ')}` }])
    }

    // SECURITY FIX: Validate and sanitize name input (AWS schedule name limit: 64 chars)
    const sanitizedName = name?.toString().trim().substring(0, 50) || ""
    if (!sanitizedName || sanitizedName.length === 0) {
      throw ErrorFactories.validationFailed([{ field: 'name', message: 'Schedule name is required and cannot be empty', value: name }])
    }

    // SECURITY FIX: Validate environment and scheduleId are safe for interpolation
    const environment = getEnvironment()
    const safeScheduleId = sanitizeNumericId(scheduleId)

    const cronExpression = convertToCronExpression(scheduleConfig)
    const scheduleName = `aistudio-${environment}-schedule-${safeScheduleId}`

    // Validate schedule name length (AWS limit is 64 characters)
    if (scheduleName.length > 64) {
      throw ErrorFactories.validationFailed([{ field: 'name', message: `Schedule name too long: ${scheduleName.length} chars (max: 64)`, value: scheduleName }])
    }

    log.info('Creating EventBridge schedule', {
      scheduleName,
      cronExpression,
      targetArn,
      scheduleId: safeScheduleId,
      sanitizedName
    })

    const command = new CreateScheduleCommand({
      Name: scheduleName,
      Description: `AI Studio schedule: ${escapeHtml(sanitizedName)}`,
      ScheduleExpression: `cron(${cronExpression})`,
      ScheduleExpressionTimezone: scheduleConfig.timezone || 'UTC',
      State: ScheduleState.ENABLED,
      FlexibleTimeWindow: {
        Mode: FlexibleTimeWindowMode.OFF
      },
      Target: {
        Arn: targetArn,
        RoleArn: roleArn,
        Input: JSON.stringify({
          source: 'aws.scheduler',
          scheduledExecutionId: scheduleId
        })
      }
    })

    const response = await schedulerClient.send(command)
    log.info('EventBridge schedule created successfully', { scheduleArn: response.ScheduleArn })

    return response.ScheduleArn || `arn:aws:scheduler:${process.env.AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:schedule/default/${scheduleName}`
  } catch (error) {
    log.error('Failed to create EventBridge schedule', {
      error: sanitizeForLogging(error),
      scheduleId,
      name
    })
    throw error
  }
}

/**
 * Updates an EventBridge schedule
 */
async function _updateEventBridgeSchedule(
  scheduleId: number,
  name: string,
  scheduleConfig: ScheduleConfig,
  targetArn: string,
  roleArn: string,
  _inputData: Record<string, unknown>,
  active: boolean
): Promise<void> {
  const log = createLogger({ operation: 'updateEventBridgeSchedule' })

  try {
    // SECURITY FIX: Validate schedule configuration before cron conversion
    const validationResult = validateScheduleConfig(scheduleConfig)
    if (!validationResult.isValid) {
      throw ErrorFactories.validationFailed([{ field: 'scheduleConfig', message: `Invalid schedule configuration: ${validationResult.errors.join(', ')}` }])
    }

    // SECURITY FIX: Validate and sanitize name input
    const sanitizedName = name?.toString().trim().substring(0, 50) || ""
    if (!sanitizedName || sanitizedName.length === 0) {
      throw ErrorFactories.validationFailed([{ field: 'name', message: 'Schedule name is required and cannot be empty', value: name }])
    }

    // SECURITY FIX: Validate environment and scheduleId are safe for interpolation
    const environment = getEnvironment()
    const safeScheduleId = sanitizeNumericId(scheduleId)

    const scheduleName = `aistudio-${environment}-schedule-${safeScheduleId}`
    const cronExpression = convertToCronExpression(scheduleConfig)

    // Validate schedule name length
    if (scheduleName.length > 64) {
      throw ErrorFactories.validationFailed([{ field: 'name', message: `Schedule name too long: ${scheduleName.length} chars (max: 64)`, value: scheduleName }])
    }

    log.info('Updating EventBridge schedule', {
      scheduleName,
      cronExpression,
      active,
      scheduleId: safeScheduleId,
      sanitizedName
    })

    const command = new UpdateScheduleCommand({
      Name: scheduleName,
      Description: `AI Studio schedule: ${escapeHtml(sanitizedName)}`,
      ScheduleExpression: `cron(${cronExpression})`,
      ScheduleExpressionTimezone: scheduleConfig.timezone || 'UTC',
      State: active ? ScheduleState.ENABLED : ScheduleState.DISABLED,
      FlexibleTimeWindow: {
        Mode: FlexibleTimeWindowMode.OFF
      },
      Target: {
        Arn: targetArn,
        RoleArn: roleArn,
        Input: JSON.stringify({
          source: 'aws.scheduler',
          scheduledExecutionId: scheduleId
        })
      }
    })

    await schedulerClient.send(command)
    log.info('EventBridge schedule updated successfully', { scheduleId })
  } catch (error) {
    log.error('Failed to update EventBridge schedule', {
      error: sanitizeForLogging(error),
      scheduleId
    })
    throw error
  }
}

/**
 * Deletes an EventBridge schedule
 */
async function _deleteEventBridgeSchedule(scheduleId: number): Promise<void> {
  const log = createLogger({ operation: 'deleteEventBridgeSchedule' })

  try {
    const environment = getEnvironment()
    const scheduleName = `aistudio-${environment}-schedule-${scheduleId}`

    log.info('Deleting EventBridge schedule', { scheduleName, scheduleId })

    const command = new DeleteScheduleCommand({
      Name: scheduleName
    })

    await schedulerClient.send(command)
    log.info('EventBridge schedule deleted successfully', { scheduleId })
  } catch (error) {
    log.error('Failed to delete EventBridge schedule', {
      error: sanitizeForLogging(error),
      scheduleId
    })
    // Don't throw error for delete operations - log and continue
  }
}

/**
 * Creates a new schedule
 */
export async function createScheduleAction(params: CreateScheduleRequest): Promise<ActionState<{ id: number; scheduleArn?: string; nextExecution?: string }>> {
  const requestId = generateRequestId()
  const timer = startTimer("createScheduleAction")
  const log = createLogger({ requestId, action: "createSchedule" })

  try {
    log.info("createScheduleAction called with params", {
      params: sanitizeForLogging(params),
      paramTypes: {
        name: typeof params.name,
        assistantArchitectId: typeof params.assistantArchitectId,
        scheduleConfig: typeof params.scheduleConfig,
        inputData: typeof params.inputData
      },
      assistantArchitectIdValue: params.assistantArchitectId,
      scheduleConfigDetails: sanitizeForLogging(params.scheduleConfig)
    })
    log.info("Creating schedule", { params: sanitizeForLogging(params) })

    // Auth check
    const session = await getServerSession()
    if (!session || !session.sub) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
    }

    // Check if user has access to assistant-architect tool
    const hasAccess = await hasToolAccess(session.sub, "assistant-architect")
    if (!hasAccess) {
      log.warn("User lacks assistant-architect access")
      throw ErrorFactories.authzInsufficientPermissions("assistant-architect")
    }


    // Validate input
    const { name, assistantArchitectId, scheduleConfig, inputData } = params

    // Validate and sanitize name
    log.info("Validating name", { name, nameType: typeof name })
    const nameValidation = validateAndSanitizeName(name)
    if (!nameValidation.isValid) {
      log.error("Name validation failed", { nameValidation })
      throw ErrorFactories.validationFailed(
        nameValidation.errors.map(error => ({ field: 'name', message: error }))
      )
    }
    const sanitizedName = nameValidation.sanitizedName
    log.info("Name validation passed", { sanitizedName })

    // Security: Sanitize ID with CodeQL-compliant pattern that breaks taint flow
    log.info("Validating assistantArchitectId", {
      assistantArchitectId,
      type: typeof assistantArchitectId,
      value: assistantArchitectId,
      isNaN: Number.isNaN(Number(assistantArchitectId))
    })
    let cleanArchitectId: number
    try {
      cleanArchitectId = sanitizeNumericId(assistantArchitectId)
      log.info("AssistantArchitectId validation passed", { cleanArchitectId })
    } catch (error) {
      log.error("AssistantArchitectId validation failed", {
        assistantArchitectId,
        type: typeof assistantArchitectId,
        converted: Number(assistantArchitectId),
        isNaN: Number.isNaN(Number(assistantArchitectId)),
        isInteger: Number.isInteger(Number(assistantArchitectId)),
        error: sanitizeForLogging(error)
      })
      throw ErrorFactories.validationFailed([{
        field: 'assistantArchitectId',
        message: `assistantArchitectId must be a valid positive integer. Received: ${assistantArchitectId} (${typeof assistantArchitectId})`
      }])
    }

    // Validate schedule configuration
    log.info("Validating schedule configuration", {
      scheduleConfig: sanitizeForLogging(scheduleConfig)
    })
    const validation = validateScheduleConfig(scheduleConfig)
    if (!validation.isValid) {
      log.error("Schedule config validation failed", {
        scheduleConfig: sanitizeForLogging(scheduleConfig),
        validationErrors: validation.errors
      })
      throw ErrorFactories.validationFailed(
        validation.errors.map(error => ({ field: 'scheduleConfig', message: error }))
      )
    }
    log.info("Schedule config validation passed")

    // Validate input data size
    log.info("Validating input data", {
      inputDataSize: JSON.stringify(inputData).length,
      inputDataType: typeof inputData
    })
    const inputDataValidation = validateInputData(inputData)
    if (!inputDataValidation.isValid) {
      log.error("Input data validation failed", {
        inputDataValidation,
        inputDataSize: JSON.stringify(inputData).length
      })
      throw ErrorFactories.validationFailed(
        inputDataValidation.errors.map(error => ({ field: 'inputData', message: error }))
      )
    }
    log.info("Input data validation passed")

    // Get user ID from sub using Drizzle
    const userId = await getScheduleUserIdByCognitoSub(session.sub)

    if (!userId) {
      log.warn("User not found")
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    // Check if assistant architect exists and user has access using Drizzle
    const hasArchitectAccess = await checkAssistantArchitectOwnership(cleanArchitectId, userId)

    if (!hasArchitectAccess) {
      log.warn("Assistant architect not found or no access")
      throw ErrorFactories.authzInsufficientPermissions("assistant architect")
    }

    // Note: Schedule count limit removed - users can create unlimited schedules

    // Note: Duplicate name check removed - users can have multiple schedules with the same name

    // Create the schedule using Drizzle
    const createdSchedule = await drizzleCreateSchedule({
      userId,
      assistantArchitectId: cleanArchitectId,
      name: sanitizedName,
      scheduleConfig: scheduleConfig as DrizzleScheduleConfig,
      inputData: inputData as Record<string, string>,
      updatedBy: session.sub,
    })

    if (!createdSchedule) {
      throw ErrorFactories.dbQueryFailed("INSERT INTO scheduled_executions", new Error("Failed to create schedule"))
    }

    const scheduleId = createdSchedule.id

    // Try to create EventBridge schedule
    let scheduleArn: string | undefined
    let eventBridgeEnabled = false
    const warnings: string[] = []

    try {
      const result = await invokeScheduleManager('create', {
        scheduleId,
        name: sanitizedName,
        scheduleConfig,
        inputData
      }, requestId)

      scheduleArn = result.scheduleArn

      eventBridgeEnabled = true
      log.info("EventBridge schedule created successfully", { scheduleArn, scheduleId })

    } catch (error) {
      log.warn("EventBridge schedule creation failed, continuing with database-only mode", {
        error: sanitizeForLogging(error),
        scheduleId
      })
      warnings.push("EventBridge integration unavailable - schedule saved to database only")
      // Don't throw error - continue with database-only mode
    }

    timer({ status: "success" })
    log.info("Schedule created successfully", {
      scheduleId,
      scheduleArn,
      eventBridgeEnabled
    })

    return createSuccess({
      id: scheduleId,
      scheduleArn,
      eventBridgeEnabled,
      warnings
    }, "Schedule created successfully")

  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to create schedule", {
      context: "createScheduleAction",
      requestId,
      operation: "createSchedule"
    })
  }
}

/**
 * Gets all schedules for the current user
 */
export async function getSchedulesAction(): Promise<ActionState<Schedule[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getSchedulesAction")
  const log = createLogger({ requestId, action: "getSchedules" })

  try {
    log.info("Getting user schedules")

    // Auth check
    const session = await getServerSession()
    if (!session || !session.sub) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
    }

    // Check if user has access to assistant-architect tool
    const hasAccess = await hasToolAccess(session.sub, "assistant-architect")
    if (!hasAccess) {
      log.warn("User lacks assistant-architect access")
      throw ErrorFactories.authzInsufficientPermissions("assistant-architect")
    }

    // Get user ID from sub using Drizzle
    const userId = await getScheduleUserIdByCognitoSub(session.sub)

    if (!userId) {
      log.warn("User not found")
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    // Get schedules with last execution info using Drizzle
    const drizzleSchedules = await getSchedulesByUserId(userId)

    // Transform results to action Schedule format
    const schedules: Schedule[] = drizzleSchedules.map(drizzleSchedule => {
      const schedule: Schedule = {
        id: drizzleSchedule.id,
        name: drizzleSchedule.name,
        userId: drizzleSchedule.userId,
        assistantArchitectId: drizzleSchedule.assistantArchitectId,
        scheduleConfig: drizzleSchedule.scheduleConfig as ScheduleConfig,
        inputData: drizzleSchedule.inputData,
        active: drizzleSchedule.active ?? true,
        createdAt: drizzleSchedule.createdAt?.toISOString() ?? new Date().toISOString(),
        updatedAt: drizzleSchedule.updatedAt.toISOString()
      }

      // Add last execution info if available
      if (drizzleSchedule.lastExecutedAt && drizzleSchedule.lastExecutionStatus) {
        schedule.lastExecution = {
          executedAt: drizzleSchedule.lastExecutedAt.toISOString(),
          status: drizzleSchedule.lastExecutionStatus as 'success' | 'failed'
        }
      }

      return schedule
    })

    timer({ status: "success", count: schedules.length })
    log.info("Schedules retrieved successfully", { count: schedules.length })

    return createSuccess(schedules, "Schedules retrieved successfully")

  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to get schedules", {
      context: "getSchedulesAction",
      requestId,
      operation: "getSchedules"
    })
  }
}

/**
 * Updates an existing schedule
 */
export async function updateScheduleAction(id: number, params: UpdateScheduleRequest): Promise<ActionState<Schedule>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateScheduleAction")
  const log = createLogger({ requestId, action: "updateSchedule" })

  try {
    log.info("Updating schedule", { params: sanitizeForLogging(params) })

    // Auth check
    const session = await getServerSession()
    if (!session || !session.sub) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
    }

    // Check if user has access to assistant-architect tool
    const hasAccess = await hasToolAccess(session.sub, "assistant-architect")
    if (!hasAccess) {
      log.warn("User lacks assistant-architect access")
      throw ErrorFactories.authzInsufficientPermissions("assistant-architect")
    }

    // Get user ID from sub using Drizzle
    const userId = await getScheduleUserIdByCognitoSub(session.sub)

    if (!userId) {
      log.warn("User not found")
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    // Check if schedule exists and user owns it using Drizzle
    const existingSchedule = await getScheduleByIdForUser(id, userId)

    if (!existingSchedule) {
      log.warn("Schedule not found or no access")
      throw ErrorFactories.authzResourceNotFound("schedule", id.toString())
    }

    // Schedule exists and user has access, proceed with update

    // Build update data object
    const updateData: {
      name?: string;
      assistantArchitectId?: number;
      scheduleConfig?: DrizzleScheduleConfig;
      inputData?: Record<string, string>;
      active?: boolean;
      updatedBy?: string;
    } = {
      updatedBy: session.sub
    }

    if (params.name !== undefined) {
      // Validate and sanitize name
      const nameValidation = validateAndSanitizeName(params.name)
      if (!nameValidation.isValid) {
        throw ErrorFactories.validationFailed(
          nameValidation.errors.map(error => ({ field: 'name', message: error }))
        )
      }
      updateData.name = nameValidation.sanitizedName
    }

    if (params.assistantArchitectId !== undefined) {
      // Security: Pre-validate user access BEFORE sanitization to prevent bypass
      // First verify user has general assistant architect access
      const hasAccess = await hasToolAccess(session.sub, "assistant-architect")
      if (!hasAccess) {
        throw ErrorFactories.authzToolAccessDenied("assistant-architect")
      }

      // Security: Sanitize ID with CodeQL-compliant pattern that breaks taint flow
      let cleanArchitectId: number
      try {
        cleanArchitectId = sanitizeNumericId(params.assistantArchitectId)
      } catch {
        throw ErrorFactories.validationFailed([{
          field: 'assistantArchitectId',
          message: 'assistantArchitectId must be a valid positive integer'
        }])
      }

      // Check if assistant architect exists and user has ownership access using Drizzle
      const hasArchitectAccess = await checkAssistantArchitectOwnership(cleanArchitectId, userId)

      if (!hasArchitectAccess) {
        throw ErrorFactories.authzInsufficientPermissions("assistant architect")
      }

      updateData.assistantArchitectId = cleanArchitectId
    }

    if (params.scheduleConfig !== undefined) {
      // Validate schedule configuration
      const validation = validateScheduleConfig(params.scheduleConfig)
      if (!validation.isValid) {
        throw ErrorFactories.validationFailed(
          validation.errors.map(error => ({ field: 'scheduleConfig', message: error }))
        )
      }

      updateData.scheduleConfig = params.scheduleConfig as DrizzleScheduleConfig
    }

    if (params.inputData !== undefined) {
      // Validate input data size
      const inputDataValidation = validateInputData(params.inputData)
      if (!inputDataValidation.isValid) {
        throw ErrorFactories.validationFailed(
          inputDataValidation.errors.map(error => ({ field: 'inputData', message: error }))
        )
      }

      updateData.inputData = params.inputData as Record<string, string>
    }

    if (params.active !== undefined) {
      updateData.active = params.active
    }

    // Check if there's anything to update besides updatedBy
    const hasUpdates = Object.keys(updateData).filter(k => k !== 'updatedBy').length > 0
    if (!hasUpdates) {
      throw ErrorFactories.validationFailed([{ field: 'general', message: 'No fields to update' }])
    }

    // Execute update using Drizzle
    const updatedSchedule = await drizzleUpdateSchedule(id, userId, updateData)

    if (!updatedSchedule) {
      throw ErrorFactories.dbQueryFailed("UPDATE scheduled_executions", new Error("Failed to update schedule"))
    }

    const schedule: Schedule = {
      id: updatedSchedule.id,
      name: updatedSchedule.name,
      userId: updatedSchedule.userId,
      assistantArchitectId: updatedSchedule.assistantArchitectId,
      scheduleConfig: updatedSchedule.scheduleConfig as ScheduleConfig,
      inputData: updatedSchedule.inputData,
      active: updatedSchedule.active ?? true,
      createdAt: updatedSchedule.createdAt?.toISOString() ?? new Date().toISOString(),
      updatedAt: updatedSchedule.updatedAt.toISOString()
    }

    // Try to update EventBridge schedule if schedule-related fields changed
    let eventBridgeUpdated = false
    const warnings: string[] = []

    if (params.scheduleConfig !== undefined || params.active !== undefined || params.name !== undefined) {
      try {
        await invokeScheduleManager('update', {
          scheduleId: schedule.id,
          name: schedule.name,
          scheduleConfig: schedule.scheduleConfig,
          inputData: schedule.inputData,
          active: schedule.active
        }, requestId)
        eventBridgeUpdated = true
        log.info("EventBridge schedule updated successfully", { scheduleId: schedule.id })
      } catch (error) {
        log.warn("Failed to update EventBridge schedule, database changes preserved", {
          error: sanitizeForLogging(error),
          scheduleId: schedule.id
        })
        warnings.push("EventBridge update failed - database changes preserved")
        // Don't fail the entire update operation if EventBridge update fails
        // The database update succeeded, so we return success but log the EventBridge error
      }
    }

    timer({ status: "success" })
    log.info("Schedule updated successfully", {
      scheduleId: schedule.id,
      eventBridgeUpdated,
      warningsCount: warnings.length
    })

    return createSuccess({
      ...schedule,
      eventBridgeUpdated,
      warnings
    }, "Schedule updated successfully")

  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update schedule", {
      context: "updateScheduleAction",
      requestId,
      operation: "updateSchedule"
    })
  }
}

/**
 * Deletes a schedule
 */
export async function deleteScheduleAction(id: number): Promise<ActionState<{ success: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteScheduleAction")
  const log = createLogger({ requestId, action: "deleteSchedule" })

  try {
    log.info("Deleting schedule")

    // Auth check
    const session = await getServerSession()
    if (!session || !session.sub) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
    }

    // Check if user has access to assistant-architect tool
    const hasAccess = await hasToolAccess(session.sub, "assistant-architect")
    if (!hasAccess) {
      log.warn("User lacks assistant-architect access")
      throw ErrorFactories.authzInsufficientPermissions("assistant-architect")
    }

    // Get user ID from sub using Drizzle
    const userId = await getScheduleUserIdByCognitoSub(session.sub)

    if (!userId) {
      log.warn("User not found")
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    // Check if schedule exists and user owns it using Drizzle
    const existingSchedule = await getScheduleByIdForUser(id, userId)

    if (!existingSchedule) {
      log.warn("Schedule not found or no access")
      throw ErrorFactories.authzResourceNotFound("schedule", id.toString())
    }

    // Delete the schedule using Drizzle (cascade will handle related records)
    const deleted = await drizzleDeleteSchedule(id, userId)

    if (!deleted) {
      throw ErrorFactories.dbQueryFailed("DELETE FROM scheduled_executions", new Error("Failed to delete schedule"))
    }

    // Delete EventBridge schedule via Lambda proxy
    try {
      await invokeScheduleManager('delete', { scheduleId: id }, requestId)
      log.info("EventBridge schedule deleted successfully", { scheduleId: id })
    } catch (error) {
      log.error("Failed to delete EventBridge schedule", {
        error: sanitizeForLogging(error),
        scheduleId: id
      })
      // Don't fail the entire delete operation if EventBridge delete fails
      // The database record is already deleted, so we continue with success
    }

    timer({ status: "success" })
    log.info("Schedule deleted successfully")

    return createSuccess({ success: true }, "Schedule deleted successfully")

  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to delete schedule", {
      context: "deleteScheduleAction",
      requestId,
      operation: "deleteSchedule"
    })
  }
}

/**
 * Gets a single schedule by ID
 */
export async function getScheduleAction(id: number): Promise<ActionState<Schedule>> {
  const requestId = generateRequestId()
  const timer = startTimer("getScheduleAction")
  const log = createLogger({ requestId, action: "getSchedule" })

  try {
    log.info("Getting schedule")

    // Auth check
    const session = await getServerSession()
    if (!session || !session.sub) {
      log.warn("Unauthorized")
      throw ErrorFactories.authNoSession()
    }

    // Check if user has access to assistant-architect tool
    const hasAccess = await hasToolAccess(session.sub, "assistant-architect")
    if (!hasAccess) {
      log.warn("User lacks assistant-architect access")
      throw ErrorFactories.authzInsufficientPermissions("assistant-architect")
    }

    // Get user ID from sub using Drizzle
    const userId = await getScheduleUserIdByCognitoSub(session.sub)

    if (!userId) {
      log.warn("User not found")
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    // Get schedule with last execution info using Drizzle
    const drizzleSchedule = await getScheduleByIdForUser(id, userId)

    if (!drizzleSchedule) {
      log.warn("Schedule not found or no access")
      throw ErrorFactories.authzResourceNotFound("schedule", id.toString())
    }

    const schedule: Schedule = {
      id: drizzleSchedule.id,
      name: drizzleSchedule.name,
      userId: drizzleSchedule.userId,
      assistantArchitectId: drizzleSchedule.assistantArchitectId,
      scheduleConfig: drizzleSchedule.scheduleConfig as ScheduleConfig,
      inputData: drizzleSchedule.inputData,
      active: drizzleSchedule.active ?? true,
      createdAt: drizzleSchedule.createdAt?.toISOString() ?? new Date().toISOString(),
      updatedAt: drizzleSchedule.updatedAt.toISOString()
    }

    // Add last execution info if available
    if (drizzleSchedule.lastExecutedAt && drizzleSchedule.lastExecutionStatus) {
      schedule.lastExecution = {
        executedAt: drizzleSchedule.lastExecutedAt.toISOString(),
        status: drizzleSchedule.lastExecutionStatus as 'success' | 'failed'
      }
    }

    timer({ status: "success" })
    log.info("Schedule retrieved successfully")

    return createSuccess(schedule, "Schedule retrieved successfully")

  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to get schedule", {
      context: "getScheduleAction",
      requestId,
      operation: "getSchedule"
    })
  }
}