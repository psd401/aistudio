import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { SchedulerClient, CreateScheduleCommand, UpdateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Context as LambdaContext } from 'aws-lambda';
import * as jwt from 'jsonwebtoken';


// Lambda logging utilities (simplified version of main app pattern)
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function startTimer(operation: string) {
  const startTime = Date.now();
  return (context: Record<string, any> = {}) => {
    const duration = Date.now() - startTime;
    // Use structured logging without console methods
    const logEntry = {
      level: 'INFO',
      message: 'Operation completed',
      operation,
      duration,
      timestamp: new Date().toISOString(),
      service: 'schedule-executor',
      ...sanitizeForLogging(context)
    };
    process.stdout.write(JSON.stringify(logEntry) + '\n');
  };
}

function createLogger(context: Record<string, any> = {}) {
  const baseContext = {
    timestamp: new Date().toISOString(),
    environment: 'lambda',
    service: 'schedule-executor',
    ...sanitizeForLogging(context)
  };

  return {
    info: (message: string, meta: Record<string, any> = {}) => {
      const logEntry = {
        level: 'INFO',
        message,
        ...baseContext,
        ...sanitizeForLogging(meta)
      };
      process.stdout.write(JSON.stringify(logEntry) + '\n');
    },
    error: (message: string, meta: Record<string, any> = {}) => {
      const logEntry = {
        level: 'ERROR',
        message,
        ...baseContext,
        ...sanitizeForLogging(meta)
      };
      process.stderr.write(JSON.stringify(logEntry) + '\n');
    },
    warn: (message: string, meta: Record<string, any> = {}) => {
      const logEntry = {
        level: 'WARN',
        message,
        ...baseContext,
        ...sanitizeForLogging(meta)
      };
      process.stderr.write(JSON.stringify(logEntry) + '\n');
    },
    debug: (message: string, meta: Record<string, any> = {}) => {
      const logEntry = {
        level: 'DEBUG',
        message,
        ...baseContext,
        ...sanitizeForLogging(meta)
      };
      process.stdout.write(JSON.stringify(logEntry) + '\n');
    }
  };
}

// Security utility functions
function safeParseInt(value: any, fieldName: string = 'value'): number {
  if (value === null || value === undefined) {
    throw new Error(`Invalid ${fieldName}: value is null or undefined`);
  }

  const stringValue = String(value).trim();
  if (stringValue === '') {
    throw new Error(`Invalid ${fieldName}: empty string`);
  }

  const parsed = parseInt(stringValue, 10);
  if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${fieldName}: must be a positive integer`);
  }

  return parsed;
}

function safeJsonParse(jsonString: any, fallback: any = null, fieldName: string = 'JSON data'): any {
  if (!jsonString) {
    return fallback;
  }

  try {
    return JSON.parse(jsonString);
  } catch (error) {
    const log = createLogger({ operation: 'safeJsonParse' });
    log.error('JSON parse error', {
      fieldName,
      error: error instanceof Error ? error.message : String(error),
      jsonLength: jsonString?.length
    });
    return fallback;
  }
}

function sanitizeForLogging(data: any): any {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth', 'credential'];
  const sanitized = { ...data };

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
      sanitized[key] = '[REDACTED]';
    }
  }

  return sanitized;
}

// Initialize clients
const rdsClient = new RDSDataClient({});
const schedulerClient = new SchedulerClient({});
const ssmClient = new SSMClient({});
const secretsClient = new SecretsManagerClient({});

// Environment variables with startup validation
const requiredEnvVars = {
  DATABASE_RESOURCE_ARN: process.env.DATABASE_RESOURCE_ARN,
  DATABASE_SECRET_ARN: process.env.DATABASE_SECRET_ARN,
  DATABASE_NAME: process.env.DATABASE_NAME,
  ENVIRONMENT: process.env.ENVIRONMENT,
  ECS_INTERNAL_ENDPOINT_PARAM: process.env.ECS_INTERNAL_ENDPOINT_PARAM, // SSM parameter name
  INTERNAL_API_SECRET_ARN_PARAM: process.env.INTERNAL_API_SECRET_ARN_PARAM // SSM parameter name
};

const optionalEnvVars = {
  DLQ_URL: process.env.DLQ_URL,
  SCHEDULER_EXECUTION_ROLE_ARN: process.env.SCHEDULER_EXECUTION_ROLE_ARN
};

// Validate required environment variables at startup
function validateEnvironmentVariables() {
  const missingVars = [];

  for (const [key, value] of Object.entries(requiredEnvVars)) {
    if (!value || value.trim() === '') {
      missingVars.push(key);
    }
  }

  if (missingVars.length > 0) {
    const errorMessage = `Missing required environment variables: ${missingVars.join(', ')}`;
    const logEntry = {
      level: 'ERROR',
      message: 'Lambda startup failed - missing environment variables',
      missingVariables: missingVars,
      timestamp: new Date().toISOString(),
      service: 'schedule-executor'
    };
    process.stderr.write(JSON.stringify(logEntry) + '\n');
    throw new Error(errorMessage);
  }

  const logEntry = {
    level: 'INFO',
    message: 'Environment variables validated successfully',
    requiredVarsPresent: Object.keys(requiredEnvVars).length,
    optionalVarsPresent: Object.values(optionalEnvVars).filter(Boolean).length,
    timestamp: new Date().toISOString(),
    service: 'schedule-executor'
  };
  process.stdout.write(JSON.stringify(logEntry) + '\n');
}

// Run validation at module load time
validateEnvironmentVariables();

// Export validated environment variables
const DATABASE_RESOURCE_ARN = requiredEnvVars.DATABASE_RESOURCE_ARN;
const DATABASE_SECRET_ARN = requiredEnvVars.DATABASE_SECRET_ARN;
const DATABASE_NAME = requiredEnvVars.DATABASE_NAME;
const ENVIRONMENT = requiredEnvVars.ENVIRONMENT;
const DLQ_URL = optionalEnvVars.DLQ_URL;

/**
 * Get ECS internal endpoint from SSM Parameter Store
 * Cached for Lambda container lifetime to reduce SSM API calls
 */
let cachedEcsEndpoint: string | null = null;

async function getEcsEndpoint(parameterName: string, requestId: string): Promise<string> {
  const log = createLogger({ requestId, operation: 'getEcsEndpoint' });

  // Return cached value if available
  if (cachedEcsEndpoint) {
    log.debug('Using cached ECS endpoint', { parameterName });
    return cachedEcsEndpoint;
  }

  try {
    log.info('Fetching ECS endpoint from SSM', { parameterName });

    const command = new GetParameterCommand({
      Name: parameterName,
      WithDecryption: false
    });

    const response = await ssmClient.send(command);

    if (!response.Parameter?.Value) {
      throw new Error(`SSM parameter ${parameterName} has no value`);
    }

    cachedEcsEndpoint = response.Parameter.Value;
    log.info('ECS endpoint retrieved successfully', {
      parameterName,
      endpoint: cachedEcsEndpoint
    });

    return cachedEcsEndpoint;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Failed to get ECS endpoint from SSM', {
      error: errorMessage,
      parameterName
    });
    throw new Error(`Failed to retrieve ECS endpoint from SSM: ${errorMessage}`);
  }
}

/**
 * Get internal API secret from Secrets Manager
 * Secret ARN is read from SSM parameter, then secret value is fetched
 * Cached for Lambda container lifetime to reduce API calls
 */
let cachedInternalApiSecret: string | null = null;

async function getInternalApiSecret(ssmParamName: string, requestId: string): Promise<string> {
  const log = createLogger({ requestId, operation: 'getInternalApiSecret' });

  // Return cached value if available
  if (cachedInternalApiSecret) {
    log.debug('Using cached internal API secret');
    return cachedInternalApiSecret;
  }

  try {
    log.info('Fetching secret ARN from SSM', { parameterName: ssmParamName });

    // Step 1: Get secret ARN from SSM
    const ssmCommand = new GetParameterCommand({
      Name: ssmParamName,
      WithDecryption: false
    });

    const ssmResponse = await ssmClient.send(ssmCommand);

    if (!ssmResponse.Parameter?.Value) {
      throw new Error(`SSM parameter ${ssmParamName} has no value`);
    }

    const secretArn = ssmResponse.Parameter.Value;
    log.info('Retrieved secret ARN from SSM', { secretArn });

    // Step 2: Get secret value from Secrets Manager
    const secretCommand = new GetSecretValueCommand({
      SecretId: secretArn
    });

    const secretResponse = await secretsClient.send(secretCommand);

    if (!secretResponse.SecretString) {
      throw new Error(`Secret ${secretArn} has no SecretString value`);
    }

    // Parse the secret JSON and extract INTERNAL_API_SECRET field
    const secretData = JSON.parse(secretResponse.SecretString);
    if (!secretData.INTERNAL_API_SECRET) {
      throw new Error(`Secret ${secretArn} missing INTERNAL_API_SECRET field`);
    }

    cachedInternalApiSecret = secretData.INTERNAL_API_SECRET;
    log.info('Internal API secret retrieved successfully');

    return cachedInternalApiSecret as string;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Failed to get internal API secret', {
      error: errorMessage,
      parameterName: ssmParamName
    });
    throw new Error(`Failed to retrieve internal API secret: ${errorMessage}`);
  }
}

/**
 * Schedule Executor Lambda - EventBridge Scheduler Handler
 *
 * Handles two types of events:
 * 1. EventBridge Scheduled Events: Execute scheduled Assistant Architect workflows
 * 2. Direct Lambda Invocations: Schedule management operations (create/update/delete)
 *
 * For scheduled executions:
 * - Calls the /api/assistant-architect/execute/scheduled streaming endpoint
 * - Uses Server-Sent Events (SSE) for real-time updates
 * - Stores results in execution_results table
 *
 * For schedule management:
 * - Direct Lambda invocations from API routes
 * - Create/update/delete EventBridge schedules
 * - Rate limiting (max 10 schedules per user)
 */
export const handler = async (event: any, context: LambdaContext): Promise<any> => {
  const requestId = generateRequestId();
  const timer = startTimer('lambda.handler');
  const log = createLogger({ requestId, operation: 'scheduleExecutor' });

  log.info('ScheduleExecutor Lambda started', {
    hasEventBridgeSource: event.source === 'aws.scheduler',
    hasScheduledExecutionId: !!event.scheduledExecutionId,
    hasDirectInvocation: !!event.action,
    environment: ENVIRONMENT
  });

  try {
    // Check if this is an EventBridge scheduled event
    if (event.source === 'aws.scheduler' && event.scheduledExecutionId) {
      // Handle scheduled execution
      return await handleScheduledExecution(event.scheduledExecutionId, requestId);
    }

    // Check if this is a direct invocation for schedule management
    if (event.action) {
      return await handleScheduleManagement(event, requestId, context);
    }

    // Unknown event type
    log.error('Unknown event type', { event });
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Unknown event type',
        supported: ['scheduled_execution', 'schedule_management']
      })
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    log.error('Schedule executor failed', {
      error: errorMessage,
      stack: process.env.NODE_ENV === 'development' ? errorStack : undefined,
      requestId
    });
    timer({ status: 'error' });

    // Log error for CloudWatch monitoring (DLQ removed with SQS-based architecture)
    log.error('Schedule executor final error logged for monitoring', {
      originalEvent: event,
      error: errorMessage,
      timestamp: new Date().toISOString(),
      requestId
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        requestId
      })
    };
  }
};

/**
 * Handle scheduled execution triggered by EventBridge
 * Uses the existing assistant architect execution pattern
 */
async function handleScheduledExecution(scheduledExecutionId: any, requestId: string): Promise<any> {
  const log = createLogger({ requestId, scheduledExecutionId, operation: 'scheduledExecution' });
  const timer = startTimer('scheduled_execution');

  log.info('Processing scheduled execution', { scheduledExecutionId });

  let executionResultId = null;

  try {
    // Load scheduled execution config from database
    const scheduledExecution = await loadScheduledExecution(scheduledExecutionId);
    if (!scheduledExecution) {
      log.error('Scheduled execution not found', { scheduledExecutionId });
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: 'Scheduled execution not found',
          scheduledExecutionId
        })
      };
    }

    // Check if execution is active
    if (!scheduledExecution.active) {
      log.warn('Scheduled execution is inactive', { scheduledExecutionId });
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'Scheduled execution is inactive',
          scheduledExecutionId,
          skipped: true
        })
      };
    }

    log.info('Scheduled execution loaded', {
      name: scheduledExecution.name,
      userId: scheduledExecution.user_id,
      assistantArchitectId: scheduledExecution.assistant_architect_id,
      hasInputData: !!scheduledExecution.input_data
    });

    // Create execution result record
    executionResultId = await createExecutionResult(scheduledExecutionId);

    // Execute via ECS endpoint (direct HTTP call - no SQS)
    const result = await executeAssistantArchitectForSchedule(
      scheduledExecution,
      executionResultId,
      requestId
    );

    timer({ status: 'success' });
    log.info('Scheduled execution completed successfully', {
      executionResultId: result.executionId,
      status: result.status
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Scheduled execution completed successfully',
        scheduledExecutionId,
        executionResultId: result.executionId,
        status: result.status
      })
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Scheduled execution failed', { error: errorMessage });

    // Update execution result with failure (only if we created one)
    if (executionResultId) {
      try {
        await updateExecutionResult(
          executionResultId,
          'failed',
          null,
          null,
          errorMessage
        );
      } catch (updateError) {
        const updateErrorMessage = updateError instanceof Error ? updateError.message : String(updateError);
        log.error('Failed to update execution result with failure', { error: updateErrorMessage });
      }
    }

    timer({ status: 'error' });
    throw error;
  }
}

/**
 * Execute assistant architect by calling ECS endpoint directly via HTTP
 * NEW: Replaces SQS-based job submission with direct HTTP call to streaming endpoint
 */
async function executeAssistantArchitectForSchedule(scheduledExecution: any, executionResultId: any, requestId: string): Promise<any> {
  const log = createLogger({ requestId, executionResultId, operation: 'executeForSchedule' });

  log.info('Executing scheduled assistant architect via ECS endpoint', {
    assistantArchitectId: scheduledExecution.assistant_architect_id,
    inputData: Object.keys(scheduledExecution.input_data || {})
  });

  // Get ECS endpoint URL from SSM Parameter Store
  const ecsEndpointParamName = process.env.ECS_INTERNAL_ENDPOINT_PARAM;
  if (!ecsEndpointParamName) {
    throw new Error('ECS_INTERNAL_ENDPOINT_PARAM environment variable not configured');
  }

  const ecsEndpoint = await getEcsEndpoint(ecsEndpointParamName, requestId);
  if (!ecsEndpoint) {
    throw new Error('Failed to retrieve ECS endpoint from SSM Parameter Store');
  }

  // Get internal API secret for JWT generation (from Secrets Manager via SSM)
  const secretArnParamName = requiredEnvVars.INTERNAL_API_SECRET_ARN_PARAM;
  if (!secretArnParamName) {
    throw new Error('INTERNAL_API_SECRET_ARN_PARAM environment variable not configured');
  }

  const internalApiSecret = await getInternalApiSecret(secretArnParamName, requestId);

  // Generate short-lived JWT token for authentication

  const token = jwt.sign(
    {
      iss: 'schedule-executor',
      aud: 'assistant-architect-api',
      scheduleId: scheduledExecution.id.toString(),
      executionId: executionResultId.toString(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300 // 5 minutes
    },
    internalApiSecret,
    { algorithm: 'HS256' }
  );

  // Prepare request payload
  const payload = {
    scheduleId: scheduledExecution.id,
    toolId: scheduledExecution.assistant_architect_id,
    inputs: scheduledExecution.input_data || {},
    userId: scheduledExecution.user_id,
    triggeredBy: 'eventbridge',
    scheduledAt: new Date().toISOString()
  };

  log.info('Calling ECS scheduled execution endpoint', {
    endpoint: `${ecsEndpoint}/api/assistant-architect/execute/scheduled`,
    scheduleId: scheduledExecution.id,
    toolId: scheduledExecution.assistant_architect_id
  });

  // Make HTTP request to ECS endpoint with retry logic
  const maxRetries = 3;
  const MAX_RETRY_DURATION_MS = 10000; // 10s max total retry time
  const retryStartTime = Date.now();
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Check if total retry duration exceeded
    if (Date.now() - retryStartTime > MAX_RETRY_DURATION_MS) {
      throw new Error(`Retry timeout exceeded (${MAX_RETRY_DURATION_MS}ms)`);
    }

    try {
      // Create manual AbortController for Node.js < 17.3 compatibility
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 900000); // 15 minutes

      try {
        const response = await fetch(`${ecsEndpoint}/api/assistant-architect/execute/scheduled`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-Request-Id': requestId,
            'X-Internal-Request': 'schedule-executor'
          },
          body: JSON.stringify(payload),
          signal: abortController.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`ECS endpoint returned ${response.status}: ${errorBody}`);
        }

        const result: any = await response.json();

        log.info('Scheduled execution completed successfully via ECS', {
          executionId: result?.executionId,
          toolId: result?.toolId,
          scheduleId: result?.scheduleId,
          promptCount: result?.promptCount,
          attempt
        });

        return {
          executionId: result?.executionId || executionResultId,
          status: 'completed'
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      lastError = error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.warn(`ECS endpoint call failed (attempt ${attempt}/${maxRetries})`, {
        error: errorMessage,
        attempt,
        willRetry: attempt < maxRetries
      });

      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        const backoffMs = Math.pow(2, attempt - 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  // All retries failed
  const lastErrorMessage = lastError instanceof Error ? lastError.message : String(lastError);
  log.error('All ECS endpoint call attempts failed', {
    error: lastErrorMessage,
    maxRetries,
    scheduleId: scheduledExecution.id
  });
  throw lastError;
}

/**
 * Load scheduled execution configuration from database
 */
async function loadScheduledExecution(scheduledExecutionId: any, expectedUserId: any = null): Promise<any> {
  const log = createLogger({ operation: 'loadScheduledExecution' });

  try {
    const executionId = safeParseInt(scheduledExecutionId, 'scheduled execution ID');

    const whereClause = expectedUserId != null
      ? 'WHERE se.id = :scheduled_execution_id AND se.user_id = :user_id'
      : 'WHERE se.id = :scheduled_execution_id';

    const parameters = [
      { name: 'scheduled_execution_id', value: { longValue: executionId } },
      ...(expectedUserId != null
        ? [{ name: 'user_id', value: { longValue: safeParseInt(expectedUserId, 'user ID') } }]
        : [])
    ];

    const command = new ExecuteStatementCommand({
      resourceArn: DATABASE_RESOURCE_ARN,
      secretArn: DATABASE_SECRET_ARN,
      database: DATABASE_NAME,
      sql: `
        SELECT
          se.id,
          se.user_id,
          se.assistant_architect_id,
          se.name,
          se.schedule_config,
          se.input_data,
          se.active,
          se.created_at,
          aa.name as assistant_architect_name
        FROM scheduled_executions se
        JOIN assistant_architects aa ON se.assistant_architect_id = aa.id
        ${whereClause}
      `,
      parameters
    });

    const response = await rdsClient.send(command);

    if (!response.records || response.records.length === 0) {
      return null;
    }

    const record = response.records[0];

    return {
      id: record[0].longValue,
      user_id: record[1].longValue,
      assistant_architect_id: record[2].longValue,
      name: record[3].stringValue,
      schedule_config: safeJsonParse(record[4].stringValue || null, {}, 'schedule_config'),
      input_data: record[5].stringValue ? safeJsonParse(record[5].stringValue || null, {}, 'input_data') : {},
      active: record[6].booleanValue,
      created_at: record[7].stringValue,
      assistant_architect_name: record[8].stringValue
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Failed to load scheduled execution', {
      error: errorMessage,
      scheduledExecutionId: sanitizeForLogging(scheduledExecutionId)
    });
    throw error;
  }
}

/**
 * Create execution result record
 */
async function createExecutionResult(scheduledExecutionId: any): Promise<any> {
  const log = createLogger({ operation: 'createExecutionResult' });

  try {
    const executionId = safeParseInt(scheduledExecutionId, 'scheduled execution ID');

    const command = new ExecuteStatementCommand({
      resourceArn: DATABASE_RESOURCE_ARN,
      secretArn: DATABASE_SECRET_ARN,
      database: DATABASE_NAME,
      sql: `
        INSERT INTO execution_results (
          scheduled_execution_id,
          status,
          executed_at,
          result_data
        ) VALUES (
          :scheduled_execution_id,
          'running',
          NOW(),
          '{}'::jsonb
        )
        RETURNING id
      `,
      parameters: [
        { name: 'scheduled_execution_id', value: { longValue: executionId } }
      ]
    });

    const response = await rdsClient.send(command);
    if (!response.records || response.records.length === 0) {
      throw new Error('Failed to create execution result - no ID returned');
    }
    return response.records[0][0].longValue;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Failed to create execution result', {
      error: errorMessage,
      scheduledExecutionId: sanitizeForLogging(scheduledExecutionId)
    });
    throw error;
  }
}

/**
 * Update execution result with completion status
 */
async function updateExecutionResult(executionResultId: any, status: string, resultData: any = null, executionDuration: number | null = null, errorMessage: string | null = null): Promise<boolean> {
  const log = createLogger({ operation: 'updateExecutionResult' });

  try {
    const resultId = safeParseInt(executionResultId, 'execution result ID');

    const command = new ExecuteStatementCommand({
      resourceArn: DATABASE_RESOURCE_ARN,
      secretArn: DATABASE_SECRET_ARN,
      database: DATABASE_NAME,
      sql: `
        UPDATE execution_results
        SET
          status = :status,
          result_data = :result_data::jsonb,
          execution_duration_ms = :execution_duration_ms,
          error_message = :error_message,
          executed_at = NOW()
        WHERE id = :execution_result_id
        RETURNING id
      `,
      parameters: [
        { name: 'execution_result_id', value: { longValue: resultId } },
        { name: 'status', value: { stringValue: status } },
        {
          name: 'result_data',
          value: { stringValue: safeJsonStringify(resultData || {}) }
        },
        {
          name: 'execution_duration_ms',
          value: executionDuration ? { longValue: executionDuration } : { isNull: true }
        },
        {
          name: 'error_message',
          value: errorMessage ? { stringValue: errorMessage } : { isNull: true }
        }
      ]
    });

    const response = await rdsClient.send(command);
    const success = response.records && response.records.length > 0;

    if (!success) {
      throw new Error('Execution result update failed - no rows updated');
    }

    log.info('Execution result updated successfully', {
      executionResultId: resultId,
      status
    });
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Failed to update execution result', {
      error: errorMessage,
      executionResultId: sanitizeForLogging(executionResultId),
      status
    });
    throw error;
  }
}

/**
 * Handle schedule management operations (create/update/delete)
 */
async function handleScheduleManagement(event: any, requestId: string, lambdaContext: LambdaContext): Promise<any> {
  const log = createLogger({ requestId, operation: 'scheduleManagement' });
  const { action, ...params } = event;

  log.info('Processing schedule management action', { action });

  switch (action) {
    case 'create':
      return await createSchedule(params, requestId, lambdaContext);
    case 'update':
      return await updateSchedule(params, requestId, lambdaContext);
    case 'delete':
      return await deleteSchedule(params, requestId);
    default:
      log.error('Unknown schedule management action', { action });
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Unknown action',
          supported: ['create', 'update', 'delete']
        })
      };
  }
}

/**
 * Create a new EventBridge schedule
 */
async function createSchedule(params: any, requestId: string, lambdaContext: LambdaContext): Promise<any> {
  const log = createLogger({ requestId, operation: 'createSchedule' });
  const { scheduledExecutionId, cronExpression, timezone = 'UTC' } = params;

  log.info('Creating EventBridge schedule', { scheduledExecutionId, cronExpression, timezone });

  try {
    const scheduleName = `aistudio-${ENVIRONMENT}-schedule-${scheduledExecutionId}`;
    const functionArn = lambdaContext.invokedFunctionArn;

    const command = new CreateScheduleCommand({
      Name: scheduleName,
      ScheduleExpression: `cron(${cronExpression})`,
      ScheduleExpressionTimezone: timezone,
      FlexibleTimeWindow: {
        Mode: 'FLEXIBLE',
        MaximumWindowInMinutes: 5
      },
      Target: {
        Arn: functionArn,
        RoleArn: process.env.SCHEDULER_EXECUTION_ROLE_ARN,
        Input: JSON.stringify({
          source: 'aws.scheduler',
          scheduledExecutionId: scheduledExecutionId
        })
      },
      State: 'ENABLED'
    });

    const response = await schedulerClient.send(command);

    log.info('EventBridge schedule created successfully', { scheduleName });

    // Construct the schedule ARN with validation
    const region = process.env.AWS_REGION;
    if (!region) {
      throw new Error('AWS_REGION environment variable is required');
    }

    // Validate ARN format and extract account ID safely
    const arnParts = lambdaContext.invokedFunctionArn.split(':');
    if (arnParts.length < 5 || !arnParts[4].match(/^\d{12}$/)) {
      throw new Error('Invalid Lambda function ARN format');
    }
    const accountId = arnParts[4];

    const scheduleArn = `arn:aws:scheduler:${region}:${accountId}:schedule/default/${scheduleName}`;

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Schedule created successfully',
        scheduleName,
        scheduleArn,
        scheduledExecutionId
      })
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Failed to create EventBridge schedule', { error: errorMessage });
    throw error;
  }
}

/**
 * Update an existing EventBridge schedule
 */
async function updateSchedule(params: any, requestId: string, lambdaContext: LambdaContext): Promise<any> {
  const log = createLogger({ requestId, operation: 'updateSchedule' });
  const { scheduledExecutionId, cronExpression, timezone = 'UTC' } = params;

  log.info('Updating EventBridge schedule', { scheduledExecutionId, cronExpression, timezone });

  try {
    const scheduleName = `aistudio-${ENVIRONMENT}-schedule-${scheduledExecutionId}`;
    const functionArn = lambdaContext.invokedFunctionArn;

    const command = new UpdateScheduleCommand({
      Name: scheduleName,
      ScheduleExpression: `cron(${cronExpression})`,
      ScheduleExpressionTimezone: timezone,
      FlexibleTimeWindow: {
        Mode: 'FLEXIBLE',
        MaximumWindowInMinutes: 5
      },
      Target: {
        Arn: functionArn,
        RoleArn: process.env.SCHEDULER_EXECUTION_ROLE_ARN,
        Input: JSON.stringify({
          source: 'aws.scheduler',
          scheduledExecutionId: scheduledExecutionId
        })
      },
      State: 'ENABLED'
    });

    await schedulerClient.send(command);

    log.info('EventBridge schedule updated successfully', { scheduleName });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Schedule updated successfully',
        scheduleName,
        scheduledExecutionId
      })
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Failed to update EventBridge schedule', { error: errorMessage });
    throw error;
  }
}

/**
 * Delete an EventBridge schedule
 */
async function deleteSchedule(params: any, requestId: string): Promise<any> {
  const log = createLogger({ requestId, operation: 'deleteSchedule' });
  const { scheduledExecutionId } = params;

  log.info('Deleting EventBridge schedule', { scheduledExecutionId });

  try {
    const scheduleName = `aistudio-${ENVIRONMENT}-schedule-${scheduledExecutionId}`;

    const command = new DeleteScheduleCommand({
      Name: scheduleName
    });

    await schedulerClient.send(command);

    log.info('EventBridge schedule deleted successfully', { scheduleName });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Schedule deleted successfully',
        scheduleName,
        scheduledExecutionId
      })
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Failed to delete EventBridge schedule', { error: errorMessage });
    throw error;
  }
}

/**
 * Get user schedule count for rate limiting
 */
async function getUserScheduleCount(userId: any): Promise<number> {
  const log = createLogger({ operation: 'getUserScheduleCount' });

  try {
    const userIdInt = safeParseInt(userId, 'user ID');

    const command = new ExecuteStatementCommand({
      resourceArn: DATABASE_RESOURCE_ARN,
      secretArn: DATABASE_SECRET_ARN,
      database: DATABASE_NAME,
      sql: 'SELECT COUNT(*) as count FROM scheduled_executions WHERE user_id = :user_id AND active = true',
      parameters: [
        { name: 'user_id', value: { longValue: userIdInt } }
      ]
    });

    const response = await rdsClient.send(command);
    if (!response.records || response.records.length === 0) {
      return 0;
    }
    return Number(response.records[0][0].longValue) || 0;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Failed to get user schedule count', {
      error: errorMessage,
      userId: sanitizeForLogging(userId)
    });
    throw error;
  }
}

/**
 * Safe JSON serialization with size limits and circular reference protection
 */
function safeJsonStringify(obj: any, maxSize: number = 1024 * 1024): string { // 1MB limit
  try {
    // Check for circular references and handle special types
    const cache = new Set();
    const result = JSON.stringify(obj, (key, value) => {
      // Handle circular references
      if (typeof value === 'object' && value !== null) {
        if (cache.has(value)) {
          return '[Circular Reference]';
        }
        cache.add(value);
      }

      // Handle special types
      if (typeof value === 'function') return '[Function]';
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) return { error: value.message, stack: value.stack };
      if (value === undefined) return null;

      return value;
    });

    // Check size limit
    if (result.length > maxSize) {
      return JSON.stringify({
        error: 'Response too large',
        size: result.length,
        maxSize,
        truncated: true
      });
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      error: 'JSON serialization failed',
      originalError: errorMessage
    });
  }
}

