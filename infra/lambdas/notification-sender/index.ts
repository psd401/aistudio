import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SQSEvent, SQSRecord, Context } from 'aws-lambda';

// Type definitions
interface Logger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

interface TimerFunction {
  (context?: Record<string, unknown>): void;
}

interface LoggerContext {
  timestamp?: string;
  environment?: string;
  service?: string;
  requestId?: string;
  operation?: string;
  recordId?: string;
  notificationId?: number;
  [key: string]: unknown;
}

interface NotificationMessage {
  executionResultId: number;
  userId: number;
  notificationType: string;
  scheduleName?: string;
}

interface ValidationResult {
  executionResultIdInt: number;
  userIdInt: number;
  notificationType: string;
  scheduleName: string | null;
}

interface ExecutionResult {
  id: number;
  scheduled_execution_id: number;
  result_data: Record<string, unknown>;
  status: string;
  executed_at: string;
  execution_duration_ms: number;
  error_message: string | null;
  schedule_name: string;
  user_id: number;
  assistant_architect_name: string;
}

interface ProcessResult {
  notificationId: number;
  status: string;
  email: string;
}

interface BatchResult {
  messageId: string;
  status: 'success' | 'error';
  result?: ProcessResult;
  error?: string;
}

interface LambdaResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

interface EnvironmentVariables {
  DATABASE_RESOURCE_ARN: string;
  DATABASE_SECRET_ARN: string;
  DATABASE_NAME: string;
  ENVIRONMENT: string;
  SES_FROM_EMAIL: string;
  APP_BASE_URL: string;
  SES_CONFIGURATION_SET?: string;
  NODE_ENV?: string;
}


// Lambda logging utilities (simplified version of main app pattern)
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function startTimer(operation: string): TimerFunction {
  const startTime = Date.now();
  return (context: Record<string, unknown> = {}): void => {
    const duration = Date.now() - startTime;
    const log = createLogger({ operation: 'timer' });
    log.info('Operation completed', {
      operation,
      duration,
      ...context
    });
  };
}

function createLogger(context: LoggerContext = {}): Logger {
  const baseContext: LoggerContext = {
    timestamp: new Date().toISOString(),
    environment: 'lambda',
    service: 'notification-sender',
    ...context
  };

  return {
    info: (message: string, meta: Record<string, unknown> = {}): void => {
      process.stdout.write(JSON.stringify({
        level: 'INFO',
        message,
        ...baseContext,
        ...meta
      }) + '\n');
    },
    error: (message: string, meta: Record<string, unknown> = {}): void => {
      process.stderr.write(JSON.stringify({
        level: 'ERROR',
        message,
        ...baseContext,
        ...meta
      }) + '\n');
    },
    warn: (message: string, meta: Record<string, unknown> = {}): void => {
      process.stderr.write(JSON.stringify({
        level: 'WARN',
        message,
        ...baseContext,
        ...meta
      }) + '\n');
    },
    debug: (message: string, meta: Record<string, unknown> = {}): void => {
      process.stdout.write(JSON.stringify({
        level: 'DEBUG',
        message,
        ...baseContext,
        ...meta
      }) + '\n');
    }
  };
}

// Security utility functions
function safeParseInt(value: unknown, fieldName = 'value'): number {
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

function safeJsonParse<T>(jsonString: string | null | undefined, fallback: T, fieldName = 'JSON data'): T {
  if (!jsonString) {
    return fallback;
  }

  try {
    return JSON.parse(jsonString) as T;
  } catch (error) {
    const log = createLogger({ operation: 'safeJsonParse' });
    log.error('JSON parse error', {
      fieldName,
      error: error instanceof Error ? error.message : 'Unknown error',
      jsonLength: jsonString?.length
    });
    return fallback;
  }
}

function sanitizeForLogging(data: unknown): unknown {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth', 'credential', 'email'];
  const sanitized = { ...(data as Record<string, unknown>) };

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
      sanitized[key] = '[REDACTED]';
    }
  }

  return sanitized;
}

function sanitizeEmailContent(content: string | null | undefined, maxLength = 200): string {
  if (!content) return '';
  return String(content)
    .replace(/[\r\n\t]/g, ' ')  // Remove newlines/tabs
    .replace(/[<>"'&]/g, '')     // Remove HTML/injection chars
    .substring(0, maxLength)
    .trim();
}

function validateNotificationMessage(messageBody: unknown): ValidationResult {
  if (!messageBody || typeof messageBody !== 'object') {
    throw new Error('Invalid message body: must be an object');
  }

  const body = messageBody as Record<string, unknown>;
  const { executionResultId, userId, notificationType, scheduleName } = body;

  if (!executionResultId || !userId || !notificationType) {
    throw new Error('Missing required fields: executionResultId, userId, notificationType');
  }

  if (scheduleName && (typeof scheduleName !== 'string' || scheduleName.length > 100)) {
    throw new Error('Invalid scheduleName: must be string under 100 characters');
  }

  if (!['email'].includes(String(notificationType))) {
    throw new Error(`Unsupported notification type: ${notificationType}`);
  }

  return {
    executionResultIdInt: safeParseInt(executionResultId, 'execution result ID'),
    userIdInt: safeParseInt(userId, 'user ID'),
    notificationType: String(notificationType),
    scheduleName: scheduleName ? String(scheduleName).trim() : null
  };
}

// Initialize clients
const rdsClient = new RDSDataClient({});
const sesClient = new SESv2Client({ region: process.env.SES_REGION || 'us-east-1' });
const cognitoClient = new CognitoIdentityProviderClient({});

// Environment variables with startup validation
const requiredEnvVars: Record<string, string | undefined> = {
  DATABASE_RESOURCE_ARN: process.env.DATABASE_RESOURCE_ARN,
  DATABASE_SECRET_ARN: process.env.DATABASE_SECRET_ARN,
  DATABASE_NAME: process.env.DATABASE_NAME,
  ENVIRONMENT: process.env.ENVIRONMENT,
  SES_FROM_EMAIL: process.env.SES_FROM_EMAIL,
  APP_BASE_URL: process.env.APP_BASE_URL
};

const optionalEnvVars: Record<string, string | undefined> = {
  SES_CONFIGURATION_SET: process.env.SES_CONFIGURATION_SET
};

// Validate required environment variables at startup
function validateEnvironmentVariables(): void {
  const missingVars: string[] = [];

  for (const [key, value] of Object.entries(requiredEnvVars)) {
    if (!value || value.trim() === '') {
      missingVars.push(key);
    }
  }

  if (missingVars.length > 0) {
    const errorMessage = `Missing required environment variables: ${missingVars.join(', ')}`;
    const startupLog = createLogger({ operation: 'startup' });
    startupLog.error('Lambda startup failed - missing environment variables', {
      missingVariables: missingVars
    });
    throw new Error(errorMessage);
  }

  const startupLog = createLogger({ operation: 'startup' });
  startupLog.info('Environment variables validated successfully', {
    requiredVarsPresent: Object.keys(requiredEnvVars).length,
    optionalVarsPresent: Object.values(optionalEnvVars).filter(Boolean).length
  });
}

// Run validation at module load time
validateEnvironmentVariables();

// Export validated environment variables
const env: EnvironmentVariables = {
  DATABASE_RESOURCE_ARN: requiredEnvVars.DATABASE_RESOURCE_ARN!,
  DATABASE_SECRET_ARN: requiredEnvVars.DATABASE_SECRET_ARN!,
  DATABASE_NAME: requiredEnvVars.DATABASE_NAME!,
  ENVIRONMENT: requiredEnvVars.ENVIRONMENT!,
  SES_FROM_EMAIL: requiredEnvVars.SES_FROM_EMAIL!,
  APP_BASE_URL: requiredEnvVars.APP_BASE_URL!,
  SES_CONFIGURATION_SET: optionalEnvVars.SES_CONFIGURATION_SET,
  NODE_ENV: process.env.NODE_ENV
};

/**
 * Notification Sender Lambda - SQS Handler
 *
 * Processes notification requests from SQS queue:
 * 1. Retrieves user email from Cognito user pool
 * 2. Fetches execution result data from database
 * 3. Generates markdown attachment with full execution output
 * 4. Sends branded email notification via SES
 * 5. Updates notification status in database
 *
 * Message format:
 * {
 *   "executionResultId": 123,
 *   "userId": 456,
 *   "notificationType": "email",
 *   "scheduleName": "Weather Report - Daily"
 * }
 */
const handler = async (event: SQSEvent, context: Context): Promise<LambdaResponse> => {
  const requestId = generateRequestId();
  const timer = startTimer('lambda.handler');
  const log = createLogger({ requestId, operation: 'notificationSender' });

  log.info('Notification sender Lambda started', {
    recordCount: event.Records?.length || 0,
    environment: env.ENVIRONMENT
  });

  const results: BatchResult[] = [];

  try {
    // Process each SQS record
    for (const record of event.Records || []) {
      const recordTimer = startTimer('process_record');
      const recordLog = createLogger({ requestId, recordId: record.messageId });

      try {
        const messageBody = safeJsonParse<Record<string, unknown>>(record.body, {}, 'SQS message body');
        const validatedMessage = validateNotificationMessage(messageBody);

        recordLog.info('Processing notification request', {
          executionResultId: validatedMessage.executionResultIdInt,
          userId: validatedMessage.userIdInt,
          notificationType: validatedMessage.notificationType
        });

        const result = await processNotificationRequest(validatedMessage, requestId);

        results.push({
          messageId: record.messageId,
          status: 'success',
          result
        });

        recordTimer({ status: 'success' });
        recordLog.info('Notification processed successfully');

      } catch (error) {
        recordLog.error('Failed to process notification', {
          error: error instanceof Error ? error.message : 'Unknown error',
          messageId: record.messageId
        });

        results.push({
          messageId: record.messageId,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        });

        recordTimer({ status: 'error' });
      }
    }

    timer({ status: 'success' });
    log.info('Notification batch completed', {
      totalRecords: results.length,
      successCount: results.filter(r => r.status === 'success').length,
      errorCount: results.filter(r => r.status === 'error').length
    });

    // Return partial batch failure information for SQS
    const failedRecords = results
      .filter(r => r.status === 'error')
      .map(r => ({ itemIdentifier: r.messageId }));

    return {
      batchItemFailures: failedRecords
    };

  } catch (error) {
    log.error('Notification sender failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: env.NODE_ENV === 'development' && error instanceof Error ? error.stack : undefined,
      requestId
    });
    timer({ status: 'error' });

    // Return all records as failed for retry
    return {
      batchItemFailures: (event.Records || []).map(record => ({
        itemIdentifier: record.messageId
      }))
    };
  }
};

/**
 * Process a single notification request
 */
async function processNotificationRequest(messageData: ValidationResult, requestId: string): Promise<ProcessResult> {
  const log = createLogger({ requestId, operation: 'processNotificationRequest' });
  const { executionResultIdInt, userIdInt, notificationType, scheduleName } = messageData;

  log.info('Processing notification request', {
    executionResultId: executionResultIdInt,
    userId: userIdInt,
    scheduleName
  });

  // Create notification record in database
  const notificationId = await createNotificationRecord(
    userIdInt,
    executionResultIdInt,
    notificationType
  );

  try {
    // Fetch execution result data
    const executionResult = await getExecutionResult(executionResultIdInt);
    if (!executionResult) {
      log.warn('Execution result lookup failed', { executionResultId: sanitizeForLogging(executionResultIdInt) });
      throw new Error('Execution result not accessible');
    }

    // Get user email from database
    const userEmail = await getUserEmail(userIdInt);
    if (!userEmail) {
      log.warn('User email lookup failed', { userId: sanitizeForLogging(userIdInt) });
      throw new Error('User notification preferences not available');
    }

    // Generate email content and send
    await sendEmailNotification(
      userEmail,
      executionResult,
      scheduleName || 'Assistant Architect Execution',
      notificationId
    );

    // Update notification status
    await updateNotificationStatus(notificationId, 'sent');

    log.info('Email notification sent successfully', {
      notificationId,
      executionResultId: executionResultIdInt
    });

    return {
      notificationId,
      status: 'sent',
      email: userEmail.replace(/(.{2}).*@/, '$1***@') // Mask email for logging
    };

  } catch (error) {
    log.error('Failed to process notification', {
      error: error instanceof Error ? error.message : 'Unknown error',
      notificationId
    });

    // Update notification status with failure
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await updateNotificationStatus(notificationId, 'failed', errorMessage);
    throw error;
  }
}

/**
 * Create notification record in database
 */
async function createNotificationRecord(userId: number, executionResultId: number, type: string): Promise<number> {
  const log = createLogger({ operation: 'createNotificationRecord' });

  try {
    const command = new ExecuteStatementCommand({
      resourceArn: env.DATABASE_RESOURCE_ARN,
      secretArn: env.DATABASE_SECRET_ARN,
      database: env.DATABASE_NAME,
      sql: `
        INSERT INTO user_notifications (
          user_id,
          execution_result_id,
          type,
          status,
          delivery_attempts,
          created_at
        ) VALUES (
          :user_id,
          :execution_result_id,
          :type,
          'sent',
          0,
          NOW()
        )
        RETURNING id
      `,
      parameters: [
        { name: 'user_id', value: { longValue: userId } },
        { name: 'execution_result_id', value: { longValue: executionResultId } },
        { name: 'type', value: { stringValue: type } }
      ]
    });

    const response = await rdsClient.send(command);
    const notificationId = response.records?.[0]?.[0]?.longValue;

    if (!notificationId) {
      throw new Error('Failed to create notification record - no ID returned');
    }

    return notificationId;
  } catch (error) {
    log.error('Failed to create notification record', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: sanitizeForLogging(userId),
      executionResultId: sanitizeForLogging(executionResultId)
    });
    throw error;
  }
}

/**
 * Get execution result data from database
 */
async function getExecutionResult(executionResultId: number): Promise<ExecutionResult | null> {
  const log = createLogger({ operation: 'getExecutionResult' });

  try {
    const command = new ExecuteStatementCommand({
      resourceArn: env.DATABASE_RESOURCE_ARN,
      secretArn: env.DATABASE_SECRET_ARN,
      database: env.DATABASE_NAME,
      sql: `
        SELECT
          er.id,
          er.scheduled_execution_id,
          er.result_data,
          er.status,
          er.executed_at,
          er.execution_duration_ms,
          er.error_message,
          se.name as schedule_name,
          se.user_id,
          aa.name as assistant_architect_name
        FROM execution_results er
        JOIN scheduled_executions se ON er.scheduled_execution_id = se.id
        JOIN assistant_architects aa ON se.assistant_architect_id = aa.id
        WHERE er.id = :execution_result_id
      `,
      parameters: [
        { name: 'execution_result_id', value: { longValue: executionResultId } }
      ]
    });

    const response = await rdsClient.send(command);

    if (!response.records || response.records.length === 0) {
      return null;
    }

    const record = response.records[0];

    return {
      id: record[0]?.longValue || 0,
      scheduled_execution_id: record[1]?.longValue || 0,
      result_data: record[2]?.stringValue ? safeJsonParse<Record<string, unknown>>(record[2].stringValue, {}, 'result_data') : {},
      status: record[3]?.stringValue || '',
      executed_at: record[4]?.stringValue || '',
      execution_duration_ms: record[5]?.longValue || 0,
      error_message: record[6]?.stringValue || null,
      schedule_name: record[7]?.stringValue || '',
      user_id: record[8]?.longValue || 0,
      assistant_architect_name: record[9]?.stringValue || ''
    };
  } catch (error) {
    log.error('Failed to get execution result', {
      error: error instanceof Error ? error.message : 'Unknown error',
      executionResultId: sanitizeForLogging(executionResultId)
    });
    throw error;
  }
}

/**
 * Get user email from database (stored from Cognito during user creation)
 */
async function getUserEmail(userId: number): Promise<string | null> {
  const log = createLogger({ operation: 'getUserEmail' });

  try {
    const command = new ExecuteStatementCommand({
      resourceArn: env.DATABASE_RESOURCE_ARN,
      secretArn: env.DATABASE_SECRET_ARN,
      database: env.DATABASE_NAME,
      sql: `
        SELECT email, cognito_sub
        FROM users
        WHERE id = :user_id
      `,
      parameters: [
        { name: 'user_id', value: { longValue: userId } }
      ]
    });

    const response = await rdsClient.send(command);

    if (!response.records || response.records.length === 0) {
      return null;
    }

    const record = response.records[0];
    const email = record[0]?.stringValue;

    // If email is not in our database, we can try to get it from Cognito
    // (This is a fallback, normally email should be stored during user creation)
    if (!email && record[1]?.stringValue) {
      log.info('Email not in database, attempting Cognito lookup');
      // This would require additional Cognito permissions and user pool ID
      // For now, return null to indicate email not available
      return null;
    }

    return email || null;
  } catch (error) {
    log.error('Failed to get user email', {
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: sanitizeForLogging(userId)
    });
    throw error;
  }
}

/**
 * Build HTML email content with improved markdown formatting
 */
function buildHtmlEmail(data: {
  subject: string;
  greeting: string;
  scheduleName: string;
  status: string;
  executionTime: string;
  summary: string;
  errorMessage: string | null;
  isSuccess: boolean;
  resultsUrl: string;
  manageSchedulesUrl: string;
  unsubscribeUrl: string;
  preferencesUrl: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${data.subject}</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1e3a8a; color: white; padding: 20px; text-align: center; }
        .logo { font-size: 24px; font-weight: bold; }
        .content { padding: 20px; background: #f9fafb; }
        .summary { background: white; padding: 15px; border-radius: 8px; margin: 15px 0; }
        .success { border-left: 4px solid #10b981; }
        .error { border-left: 4px solid #ef4444; }
        .button { display: inline-block; background: #1e3a8a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 10px 0; }
        .footer { text-align: center; color: #6b7280; font-size: 12px; padding: 20px; }
        .code-block { background: #f3f4f6; padding: 12px; border-radius: 6px; font-family: 'Courier New', monospace; font-size: 13px; white-space: pre-wrap; word-wrap: break-word; overflow-x: auto; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">Peninsula School District</div>
            <div>AI Studio</div>
        </div>
        <div class="content">
            <h2>${data.greeting}</h2>

            <p>Your scheduled "<strong>${data.scheduleName}</strong>" execution completed ${data.status} at ${data.executionTime}.</p>

            ${data.summary ? `
            <div class="summary ${data.isSuccess ? 'success' : 'error'}">
                <h3>Summary</h3>
                <div class="code-block">${data.summary}</div>
            </div>
            ` : ''}

            ${data.errorMessage ? `
            <div class="summary error">
                <h3>Error Details</h3>
                <div class="code-block">${data.errorMessage}</div>
            </div>
            ` : ''}

            <div style="text-align: center; margin: 20px 0;">
                <a href="${data.resultsUrl}" class="button">View Full Results</a>
                <a href="${data.manageSchedulesUrl}" class="button" style="background: #6b7280;">Manage Schedules</a>
            </div>
        </div>
        <div class="footer">
            <p>Peninsula School District AI Studio</p>
            <p><a href="${data.unsubscribeUrl}">Unsubscribe</a> | <a href="${data.preferencesUrl}">Email Preferences</a></p>
        </div>
    </div>
</body>
</html>`;
}

/**
 * Build text email content for fallback
 */
function buildTextEmail(data: {
  greeting: string;
  scheduleName: string;
  status: string;
  executionTime: string;
  summary: string;
  errorMessage: string | null;
  resultsUrl: string;
  manageSchedulesUrl: string;
  unsubscribeUrl: string;
  preferencesUrl: string;
}): string {
  let text = `Peninsula School District AI Studio

${data.greeting},

Your scheduled "${data.scheduleName}" execution completed ${data.status} at ${data.executionTime}.

`;

  if (data.summary) {
    text += `Summary:
${data.summary}

`;
  }

  if (data.errorMessage) {
    text += `Error Details:
${data.errorMessage}

`;
  }

  text += `View full results: ${data.resultsUrl}
Manage schedules: ${data.manageSchedulesUrl}

---
Peninsula School District AI Studio
Unsubscribe: ${data.unsubscribeUrl}
Email Preferences: ${data.preferencesUrl}
`;

  return text;
}

/**
 * Send email notification using SES v2 with attachment support
 */
async function sendEmailNotification(userEmail: string, executionResult: ExecutionResult, scheduleName: string, notificationId: number): Promise<string> {
  const log = createLogger({ operation: 'sendEmailNotification', notificationId });

  try {
    // Prepare email data
    const isSuccess = executionResult.status === 'success';
    const executionTime = new Date(executionResult.executed_at).toLocaleString('en-US', {
      timeZone: process.env.EMAIL_TIMEZONE || 'America/Los_Angeles',
      dateStyle: 'medium',
      timeStyle: 'short'
    });

    // Generate summary from result data
    const summary = generateExecutionSummary(executionResult.result_data);

    // Create markdown attachment
    const markdownContent = generateMarkdownAttachment(executionResult, scheduleName);

    // Create email subject
    const subject = `${sanitizeEmailContent(scheduleName)} - ${isSuccess ? 'Execution Complete' : 'Execution Failed'}`;

    // Build HTML content with better markdown formatting
    const htmlContent = buildHtmlEmail({
      subject,
      greeting: 'Hi there',
      scheduleName: sanitizeEmailContent(scheduleName),
      status: isSuccess ? 'successfully' : 'with errors',
      executionTime,
      summary: summary || (isSuccess ? 'Execution completed successfully.' : 'Execution encountered errors.'),
      errorMessage: sanitizeEmailContent(executionResult.error_message, 500),
      isSuccess,
      resultsUrl: `${env.APP_BASE_URL}/execution-results/${executionResult.id}`,
      manageSchedulesUrl: `${env.APP_BASE_URL}/schedules`,
      unsubscribeUrl: `${env.APP_BASE_URL}/preferences/unsubscribe`,
      preferencesUrl: `${env.APP_BASE_URL}/preferences`
    });

    // Build text content for fallback
    const textContent = buildTextEmail({
      greeting: 'Hi there',
      scheduleName: sanitizeEmailContent(scheduleName),
      status: isSuccess ? 'successfully' : 'with errors',
      executionTime,
      summary: summary || (isSuccess ? 'Execution completed successfully.' : 'Execution encountered errors.'),
      errorMessage: sanitizeEmailContent(executionResult.error_message, 500),
      resultsUrl: `${env.APP_BASE_URL}/execution-results/${executionResult.id}`,
      manageSchedulesUrl: `${env.APP_BASE_URL}/schedules`,
      unsubscribeUrl: `${env.APP_BASE_URL}/preferences/unsubscribe`,
      preferencesUrl: `${env.APP_BASE_URL}/preferences`
    });

    log.info('Sending email with SES v2', {
      hasConfigurationSet: !!env.SES_CONFIGURATION_SET,
      executionStatus: executionResult.status,
      hasAttachment: !!markdownContent
    });

    // Prepare SES v2 email parameters with attachment
    const emailParams = {
      FromEmailAddress: env.SES_FROM_EMAIL,
      Destination: {
        ToAddresses: [userEmail]
      },
      Content: {
        Simple: {
          Subject: {
            Data: subject,
            Charset: 'UTF-8'
          },
          Body: {
            Text: {
              Data: textContent,
              Charset: 'UTF-8'
            },
            Html: {
              Data: htmlContent,
              Charset: 'UTF-8'
            }
          },
          // Add attachment using SES v2 Simple format
          ...(markdownContent && {
            Attachments: [{
              RawContent: Buffer.from(markdownContent),
              FileName: `${scheduleName.replace(/[^a-zA-Z0-9-_]/g, '_')}-${new Date(executionResult.executed_at).toISOString().slice(0, 10)}.md`,
              ContentType: 'text/markdown'
            }]
          })
        }
      },
      ...(env.SES_CONFIGURATION_SET && {
        ConfigurationSetName: env.SES_CONFIGURATION_SET
      })
    };

    const response = await sesClient.send(new SendEmailCommand(emailParams));

    log.info('Email sent successfully', {
      messageId: response.MessageId,
      notificationId
    });

    return response.MessageId || '';

  } catch (error) {
    log.error('Failed to send email', {
      error: error instanceof Error ? error.message : 'Unknown error',
      notificationId,
      userEmail: sanitizeForLogging(userEmail)
    });
    throw error;
  }
}

/**
 * Generate execution summary from result data
 */
function generateExecutionSummary(resultData: Record<string, unknown>): string | null {
  if (!resultData || typeof resultData !== 'object') {
    return null;
  }

  // Extract key information from the result data
  // Handle different output field names (assistant architect vs other executions)
  const summary: string[] = [];
  const maxSummaryLength = parseInt(process.env.MAX_SUMMARY_LENGTH || '10000', 10);

  // Check for assistant architect output fields first (text, finalOutput), then fallback to output
  const assistantOutput = resultData.text || resultData.finalOutput || resultData.output;
  if (assistantOutput && typeof assistantOutput === 'string') {
    // Truncate output for summary
    const output = String(assistantOutput);
    if (output.length > maxSummaryLength) {
      summary.push(output.substring(0, maxSummaryLength) + '...');
    } else {
      summary.push(output);
    }
  }

  if (resultData.metrics && typeof resultData.metrics === 'object') {
    const metrics = resultData.metrics as Record<string, unknown>;
    summary.push(`Processed in ${metrics.duration || 'unknown'} ms`);
  }

  if (resultData.warnings && Array.isArray(resultData.warnings)) {
    summary.push(`${resultData.warnings.length} warning(s) generated`);
  }

  return summary.length > 0 ? summary.join('\n') : null;
}

/**
 * Generate markdown attachment content
 */
function generateMarkdownAttachment(executionResult: ExecutionResult, scheduleName: string): string {
  const executionTime = new Date(executionResult.executed_at).toISOString();

  let markdown = `# ${scheduleName} - Execution Results\n\n`;
  markdown += `**Execution ID:** ${executionResult.id}\n`;
  markdown += `**Status:** ${executionResult.status}\n`;
  markdown += `**Executed At:** ${executionTime}\n`;
  markdown += `**Assistant Architect:** ${executionResult.assistant_architect_name}\n`;

  if (executionResult.execution_duration_ms) {
    markdown += `**Duration:** ${executionResult.execution_duration_ms}ms\n`;
  }

  markdown += `\n---\n\n`;

  if (executionResult.status === 'success' && executionResult.result_data) {
    markdown += `## Execution Output\n\n`;

    // Handle different output field names (assistant architect vs other executions)
    const assistantOutput = executionResult.result_data.text ||
                           executionResult.result_data.finalOutput ||
                           executionResult.result_data.output;

    if (assistantOutput) {
      markdown += `${assistantOutput}\n\n`;
    }

    if (executionResult.result_data.metrics) {
      markdown += `## Metrics\n\n`;
      markdown += `\`\`\`json\n${JSON.stringify(executionResult.result_data.metrics, null, 2)}\n\`\`\`\n\n`;
    }
  } else if (executionResult.error_message) {
    markdown += `## Error Details\n\n`;
    markdown += `\`\`\`\n${executionResult.error_message}\n\`\`\`\n\n`;
  }

  markdown += `## Raw Result Data\n\n`;
  markdown += `\`\`\`json\n${JSON.stringify(executionResult.result_data, null, 2)}\n\`\`\`\n\n`;

  markdown += `---\n\n`;
  markdown += `*Generated by Peninsula School District AI Studio*\n`;
  markdown += `*View full results: ${env.APP_BASE_URL}/execution-results/${executionResult.id}*`;

  return markdown;
}

/**
 * Update notification status in database
 */
async function updateNotificationStatus(notificationId: number, status: string, failureReason: string | null = null): Promise<boolean> {
  const log = createLogger({ operation: 'updateNotificationStatus' });

  try {
    const command = new ExecuteStatementCommand({
      resourceArn: env.DATABASE_RESOURCE_ARN,
      secretArn: env.DATABASE_SECRET_ARN,
      database: env.DATABASE_NAME,
      sql: `
        UPDATE user_notifications
        SET
          status = :status,
          delivery_attempts = delivery_attempts + 1,
          last_attempt_at = NOW(),
          failure_reason = :failure_reason
        WHERE id = :notification_id
        RETURNING id
      `,
      parameters: [
        { name: 'notification_id', value: { longValue: notificationId } },
        { name: 'status', value: { stringValue: status } },
        {
          name: 'failure_reason',
          value: failureReason ? { stringValue: failureReason } : { isNull: true }
        }
      ]
    });

    const response = await rdsClient.send(command);
    const success = response.records && response.records.length > 0;

    if (!success) {
      throw new Error('Notification status update failed - no rows updated');
    }

    log.info('Notification status updated successfully', {
      notificationId,
      status
    });
    return true;
  } catch (error) {
    log.error('Failed to update notification status', {
      error: error instanceof Error ? error.message : 'Unknown error',
      notificationId: sanitizeForLogging(notificationId),
      status
    });
    throw error;
  }
}

// Export handler for Lambda runtime
exports.handler = handler;