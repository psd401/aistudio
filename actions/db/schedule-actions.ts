"use server"

import { executeSQL, createParameter, hasToolAccess } from "@/lib/db/data-api-adapter"
import { transformSnakeToCamel } from "@/lib/db/field-mapper"
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
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm"
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"

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
  inputData: Record<string, any>
}

export interface Schedule {
  id: number
  name: string
  userId: number
  assistantArchitectId: number
  scheduleConfig: ScheduleConfig
  inputData: Record<string, any>
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
    throw new Error('Invalid numeric ID')
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
const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' })
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' })

// Configuration caching
const configCache = new Map<string, { config: { targetArn: string; roleArn: string }; timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

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
    throw new Error(`Invalid environment: ${env}. Must be one of: ${allowedEnvironments.join(', ')}`)
  }

  return env
}

/**
 * Fetches EventBridge configuration from SSM Parameter Store with caching
 */
/**
 * Invokes the schedule-executor Lambda function to manage EventBridge schedules
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function invokeScheduleManager(action: ScheduleLambdaPayload['action'], payload: any, requestId?: string): Promise<ScheduleLambdaResponse> {
  const log = createLogger({ operation: 'invokeScheduleManager', action, requestId })
  const environment = getEnvironment()
  const functionName = `aistudio-${environment}-schedule-executor`

  // Convert our payload to match the Lambda's expected format
  let lambdaPayload: ScheduleLambdaPayload = { action, scheduledExecutionId: payload.scheduleId }

  if (action === 'create') {
    const cronExpression = convertToCronExpression(payload.scheduleConfig)
    lambdaPayload = {
      action,
      scheduledExecutionId: payload.scheduleId,
      cronExpression,
      timezone: payload.scheduleConfig.timezone || 'UTC'
    }
  } else if (action === 'update') {
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

  throw new Error('No response from Lambda function')
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
function validateInputData(inputData: Record<string, any>): { isValid: boolean; errors: string[] } {
  const errors: string[] = []

  try {
    const serializedData = JSON.stringify(inputData)
    if (serializedData.length > MAX_INPUT_DATA_SIZE) {
      errors.push(`Input data exceeds maximum size limit of ${MAX_INPUT_DATA_SIZE / 1000}KB`)
    }
  } catch (_error) {
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
  const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/
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
      if (!/^[0-9*\-/,\s]+$/.test(trimmedCron)) {
        errors.push('Cron expression contains invalid characters')
      } else {
        const cronFields = trimmedCron.split(/\s+/)

        // Validate exact field count first
        if (cronFields.length !== 5) {
          errors.push('cron expression must have exactly 5 fields (minute hour day month day-of-week)')
        } else {
          // Validate each field individually to prevent bypass attempts
          const [minute, hour, day, month, dayOfWeek] = cronFields

          // Validate minute field (0-59)
          if (!/^(\*|([0-5]?\d)(-([0-5]?\d))?(\/\d+)?)$/.test(minute)) {
            errors.push('Invalid minute field in cron expression')
          }

          // Validate hour field (0-23)
          if (!/^(\*|([01]?\d|2[0-3])(-([01]?\d|2[0-3]))?(\/\d+)?)$/.test(hour)) {
            errors.push('Invalid hour field in cron expression')
          }

          // Validate day field (1-31)
          if (!/^(\*|([12]?\d|3[01])(-([12]?\d|3[01]))?(\/\d+)?)$/.test(day)) {
            errors.push('Invalid day field in cron expression')
          }

          // Validate month field (1-12)
          if (!/^(\*|([1-9]|1[0-2])(-([1-9]|1[0-2]))?(\/\d+)?)$/.test(month)) {
            errors.push('Invalid month field in cron expression')
          }

          // Validate day-of-week field (0-6)
          if (!/^(\*|([0-6])(-([0-6]))?(\/\d+)?)$/.test(dayOfWeek)) {
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
        throw new Error('Days of week required for weekly schedules')
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
      throw new Error(`Unsupported frequency: ${frequency}`)
  }
}

/**
 * Creates an EventBridge schedule
 */
async function createEventBridgeSchedule(
  scheduleId: number,
  name: string,
  scheduleConfig: ScheduleConfig,
  targetArn: string,
  roleArn: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  _inputData: any
): Promise<string> {
  const log = createLogger({ operation: 'createEventBridgeSchedule' })

  try {
    // SECURITY FIX: Validate schedule configuration before cron conversion
    const validationResult = validateScheduleConfig(scheduleConfig)
    if (!validationResult.isValid) {
      throw new Error(`Invalid schedule configuration: ${validationResult.errors.join(', ')}`)
    }

    // SECURITY FIX: Validate and sanitize name input (AWS schedule name limit: 64 chars)
    const sanitizedName = name?.toString().trim().substring(0, 50) || ""
    if (!sanitizedName || sanitizedName.length === 0) {
      throw new Error('Schedule name is required and cannot be empty')
    }

    // SECURITY FIX: Validate environment and scheduleId are safe for interpolation
    const environment = getEnvironment()
    const safeScheduleId = sanitizeNumericId(scheduleId)

    const cronExpression = convertToCronExpression(scheduleConfig)
    const scheduleName = `aistudio-${environment}-schedule-${safeScheduleId}`

    // Validate schedule name length (AWS limit is 64 characters)
    if (scheduleName.length > 64) {
      throw new Error(`Schedule name too long: ${scheduleName.length} chars (max: 64)`)
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
async function updateEventBridgeSchedule(
  scheduleId: number,
  name: string,
  scheduleConfig: ScheduleConfig,
  targetArn: string,
  roleArn: string,
  inputData: any,
  active: boolean
): Promise<void> {
  const log = createLogger({ operation: 'updateEventBridgeSchedule' })

  try {
    // SECURITY FIX: Validate schedule configuration before cron conversion
    const validationResult = validateScheduleConfig(scheduleConfig)
    if (!validationResult.isValid) {
      throw new Error(`Invalid schedule configuration: ${validationResult.errors.join(', ')}`)
    }

    // SECURITY FIX: Validate and sanitize name input
    const sanitizedName = name?.toString().trim().substring(0, 50) || ""
    if (!sanitizedName || sanitizedName.length === 0) {
      throw new Error('Schedule name is required and cannot be empty')
    }

    // SECURITY FIX: Validate environment and scheduleId are safe for interpolation
    const environment = getEnvironment()
    const safeScheduleId = sanitizeNumericId(scheduleId)

    const scheduleName = `aistudio-${environment}-schedule-${safeScheduleId}`
    const cronExpression = convertToCronExpression(scheduleConfig)

    // Validate schedule name length
    if (scheduleName.length > 64) {
      throw new Error(`Schedule name too long: ${scheduleName.length} chars (max: 64)`)
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
async function deleteEventBridgeSchedule(scheduleId: number): Promise<void> {
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
      isNaN: isNaN(Number(assistantArchitectId))
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
        isNaN: isNaN(Number(assistantArchitectId)),
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

    // Get user ID from sub
    const userResult = await executeSQL<{ id: number }>(`
      SELECT id FROM users WHERE cognito_sub = :cognitoSub
    `, [createParameter('cognitoSub', session.sub)])

    if (!userResult || userResult.length === 0) {
      log.warn("User not found")
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    const userId = userResult[0].id

    // Check if assistant architect exists and user has access
    const architectResult = await executeSQL<{ id: number; name: string }>(`
      SELECT id, name FROM assistant_architects
      WHERE id = :architectId AND user_id = :userId
    `, [
      createParameter('architectId', cleanArchitectId),
      createParameter('userId', userId)
    ])

    if (!architectResult || architectResult.length === 0) {
      log.warn("Assistant architect not found or no access")
      throw ErrorFactories.authzInsufficientPermissions("assistant architect")
    }

    // Note: Schedule count limit removed - users can create unlimited schedules

    // Note: Duplicate name check removed - users can have multiple schedules with the same name

    // Create the schedule
    const result = await executeSQL<{ id: number }>(`
      INSERT INTO scheduled_executions (
        user_id, assistant_architect_id, name, schedule_config, input_data, updated_by
      ) VALUES (
        :userId, :assistantArchitectId, :name, :scheduleConfig::jsonb, :inputData::jsonb, :updatedBy
      ) RETURNING id
    `, [
      createParameter('userId', userId),
      createParameter('assistantArchitectId', cleanArchitectId),
      createParameter('name', sanitizedName),
      createParameter('scheduleConfig', JSON.stringify(scheduleConfig)),
      createParameter('inputData', JSON.stringify(inputData)),
      createParameter('updatedBy', session.sub)
    ])

    if (!result || result.length === 0) {
      throw ErrorFactories.dbQueryFailed("INSERT INTO scheduled_executions", new Error("Failed to create schedule"))
    }

    const scheduleId = result[0].id

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

    // Get user ID from sub
    const userResult = await executeSQL<{ id: number }>(`
      SELECT id FROM users WHERE cognito_sub = :cognitoSub
    `, [createParameter('cognitoSub', session.sub)])

    if (!userResult || userResult.length === 0) {
      log.warn("User not found")
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    const userId = userResult[0].id

    // Get schedules with last execution info
    const result = await executeSQL<any>(`
      SELECT
        se.id,
        se.name,
        se.user_id,
        se.assistant_architect_id,
        se.schedule_config,
        se.input_data,
        se.active,
        se.created_at,
        se.updated_at,
        er.executed_at as last_executed_at,
        er.status as last_execution_status
      FROM scheduled_executions se
      LEFT JOIN LATERAL (
        SELECT executed_at, status
        FROM execution_results
        WHERE scheduled_execution_id = se.id
        ORDER BY executed_at DESC
        LIMIT 1
      ) er ON true
      WHERE se.user_id = :userId
      ORDER BY se.created_at DESC
    `, [createParameter('userId', userId)])

    // Transform results
    const schedules: Schedule[] = result.map(row => {
      const transformed = transformSnakeToCamel<any>(row)

      // Parse JSONB fields
      let scheduleConfig: ScheduleConfig
      let inputData: Record<string, any>

      try {
        scheduleConfig = typeof transformed.scheduleConfig === 'string'
          ? JSON.parse(transformed.scheduleConfig)
          : transformed.scheduleConfig
      } catch {
        scheduleConfig = { frequency: 'daily', time: '09:00' }
      }

      try {
        inputData = typeof transformed.inputData === 'string'
          ? JSON.parse(transformed.inputData)
          : transformed.inputData
      } catch {
        inputData = {}
      }

      const schedule: Schedule = {
        id: transformed.id,
        name: transformed.name,
        userId: transformed.userId,
        assistantArchitectId: transformed.assistantArchitectId,
        scheduleConfig,
        inputData,
        active: transformed.active,
        createdAt: transformed.createdAt,
        updatedAt: transformed.updatedAt
      }

      // Add last execution info if available
      if (transformed.lastExecutedAt && transformed.lastExecutionStatus) {
        schedule.lastExecution = {
          executedAt: transformed.lastExecutedAt ? new Date(transformed.lastExecutedAt + ' UTC').toISOString() : '',
          status: transformed.lastExecutionStatus
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

    // Get user ID from sub
    const userResult = await executeSQL<{ id: number }>(`
      SELECT id FROM users WHERE cognito_sub = :cognitoSub
    `, [createParameter('cognitoSub', session.sub)])

    if (!userResult || userResult.length === 0) {
      log.warn("User not found")
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    const userId = userResult[0].id

    // Check if schedule exists and user owns it
    const existingResult = await executeSQL<any>(`
      SELECT id, name, user_id, assistant_architect_id, schedule_config, input_data, active, created_at, updated_at
      FROM scheduled_executions
      WHERE id = :id AND user_id = :userId
    `, [
      createParameter('id', id),
      createParameter('userId', userId)
    ])

    if (!existingResult || existingResult.length === 0) {
      log.warn("Schedule not found or no access")
      throw ErrorFactories.authzResourceNotFound("schedule", id.toString())
    }

    // Schedule exists and user has access, proceed with update

    // Build update query dynamically
    const updates: string[] = []
    const parameters: any[] = [
      createParameter('id', id),
      createParameter('userId', userId),
      createParameter('updatedBy', session.sub)
    ]

    if (params.name !== undefined) {
      // Validate and sanitize name
      const nameValidation = validateAndSanitizeName(params.name)
      if (!nameValidation.isValid) {
        throw ErrorFactories.validationFailed(
          nameValidation.errors.map(error => ({ field: 'name', message: error }))
        )
      }
      const sanitizedName = nameValidation.sanitizedName

      // Note: Duplicate name check removed - users can have multiple schedules with the same name

      updates.push('name = :name')
      parameters.push(createParameter('name', sanitizedName))
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

      // Check if assistant architect exists and user has ownership access
      const architectResult = await executeSQL<{ id: number }>(`
        SELECT id FROM assistant_architects
        WHERE id = :architectId AND user_id = :userId
      `, [
        createParameter('architectId', cleanArchitectId),
        createParameter('userId', userId)
      ])

      if (!architectResult || architectResult.length === 0) {
        throw ErrorFactories.authzInsufficientPermissions("assistant architect")
      }

      updates.push('assistant_architect_id = :assistantArchitectId')
      parameters.push(createParameter('assistantArchitectId', cleanArchitectId))
    }

    if (params.scheduleConfig !== undefined) {
      // Validate schedule configuration
      const validation = validateScheduleConfig(params.scheduleConfig)
      if (!validation.isValid) {
        throw ErrorFactories.validationFailed(
          validation.errors.map(error => ({ field: 'scheduleConfig', message: error }))
        )
      }

      updates.push('schedule_config = :scheduleConfig::jsonb')
      parameters.push(createParameter('scheduleConfig', JSON.stringify(params.scheduleConfig)))
    }

    if (params.inputData !== undefined) {
      // Validate input data size
      const inputDataValidation = validateInputData(params.inputData)
      if (!inputDataValidation.isValid) {
        throw ErrorFactories.validationFailed(
          inputDataValidation.errors.map(error => ({ field: 'inputData', message: error }))
        )
      }

      updates.push('input_data = :inputData::jsonb')
      parameters.push(createParameter('inputData', JSON.stringify(params.inputData)))
    }

    if (params.active !== undefined) {
      updates.push('active = :active')
      parameters.push(createParameter('active', params.active))
    }

    if (updates.length === 0) {
      throw ErrorFactories.validationFailed([{ field: 'general', message: 'No fields to update' }])
    }

    // Add updated_at and updated_by
    updates.push('updated_at = NOW()', 'updated_by = :updatedBy')

    // Execute update
    const updateResult = await executeSQL<any>(`
      UPDATE scheduled_executions
      SET ${updates.join(', ')}
      WHERE id = :id AND user_id = :userId
      RETURNING id, name, user_id, assistant_architect_id, schedule_config, input_data, active, created_at, updated_at
    `, parameters)

    if (!updateResult || updateResult.length === 0) {
      throw ErrorFactories.dbQueryFailed("UPDATE scheduled_executions", new Error("Failed to update schedule"))
    }

    // Transform and return updated schedule
    const updated = transformSnakeToCamel<any>(updateResult[0])

    let scheduleConfig: ScheduleConfig
    let inputData: Record<string, any>

    try {
      scheduleConfig = typeof updated.scheduleConfig === 'string'
        ? JSON.parse(updated.scheduleConfig)
        : updated.scheduleConfig
    } catch {
      scheduleConfig = { frequency: 'daily', time: '09:00' }
    }

    try {
      inputData = typeof updated.inputData === 'string'
        ? JSON.parse(updated.inputData)
        : updated.inputData
    } catch {
      inputData = {}
    }

    const schedule: Schedule = {
      id: updated.id,
      name: updated.name,
      userId: updated.userId,
      assistantArchitectId: updated.assistantArchitectId,
      scheduleConfig,
      inputData,
      active: updated.active,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
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

    // Get user ID from sub
    const userResult = await executeSQL<{ id: number }>(`
      SELECT id FROM users WHERE cognito_sub = :cognitoSub
    `, [createParameter('cognitoSub', session.sub)])

    if (!userResult || userResult.length === 0) {
      log.warn("User not found")
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    const userId = userResult[0].id

    // Check if schedule exists and user owns it
    const existingResult = await executeSQL<{ id: number }>(`
      SELECT id FROM scheduled_executions
      WHERE id = :id AND user_id = :userId
    `, [
      createParameter('id', id),
      createParameter('userId', userId)
    ])

    if (!existingResult || existingResult.length === 0) {
      log.warn("Schedule not found or no access")
      throw ErrorFactories.authzResourceNotFound("schedule", id.toString())
    }

    // Delete the schedule (cascade will handle related records)
    const deleteResult = await executeSQL<{ id: number }>(`
      DELETE FROM scheduled_executions
      WHERE id = :id AND user_id = :userId
      RETURNING id
    `, [
      createParameter('id', id),
      createParameter('userId', userId)
    ])

    if (!deleteResult || deleteResult.length === 0) {
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

    // Get user ID from sub
    const userResult = await executeSQL<{ id: number }>(`
      SELECT id FROM users WHERE cognito_sub = :cognitoSub
    `, [createParameter('cognitoSub', session.sub)])

    if (!userResult || userResult.length === 0) {
      log.warn("User not found")
      throw ErrorFactories.authzResourceNotFound("user", session.sub)
    }

    const userId = userResult[0].id

    // Get schedule with last execution info
    const result = await executeSQL<any>(`
      SELECT
        se.id,
        se.name,
        se.user_id,
        se.assistant_architect_id,
        se.schedule_config,
        se.input_data,
        se.active,
        se.created_at,
        se.updated_at,
        er.executed_at as last_executed_at,
        er.status as last_execution_status
      FROM scheduled_executions se
      LEFT JOIN LATERAL (
        SELECT executed_at, status
        FROM execution_results
        WHERE scheduled_execution_id = se.id
        ORDER BY executed_at DESC
        LIMIT 1
      ) er ON true
      WHERE se.id = :id AND se.user_id = :userId
    `, [
      createParameter('id', id),
      createParameter('userId', userId)
    ])

    if (!result || result.length === 0) {
      log.warn("Schedule not found or no access")
      throw ErrorFactories.authzResourceNotFound("schedule", id.toString())
    }

    // Transform result
    const row = result[0]
    const transformed = transformSnakeToCamel<any>(row)

    // Parse JSONB fields
    let scheduleConfig: ScheduleConfig
    let inputData: Record<string, any>

    try {
      scheduleConfig = typeof transformed.scheduleConfig === 'string'
        ? JSON.parse(transformed.scheduleConfig)
        : transformed.scheduleConfig
    } catch {
      scheduleConfig = { frequency: 'daily', time: '09:00' }
    }

    try {
      inputData = typeof transformed.inputData === 'string'
        ? JSON.parse(transformed.inputData)
        : transformed.inputData
    } catch {
      inputData = {}
    }

    const schedule: Schedule = {
      id: transformed.id,
      name: transformed.name,
      userId: transformed.userId,
      assistantArchitectId: transformed.assistantArchitectId,
      scheduleConfig,
      inputData,
      active: transformed.active,
      createdAt: transformed.createdAt,
      updatedAt: transformed.updatedAt
    }

    // Add last execution info if available
    if (transformed.lastExecutedAt && transformed.lastExecutionStatus) {
      schedule.lastExecution = {
        executedAt: transformed.lastExecutedAt ? new Date(transformed.lastExecutedAt + ' UTC').toISOString() : '',
        status: transformed.lastExecutionStatus
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