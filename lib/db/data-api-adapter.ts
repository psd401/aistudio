import {
  RDSDataClient,
  ExecuteStatementCommand,
  ExecuteStatementCommandOutput,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  SqlParameter,
  ArrayValue
} from "@aws-sdk/client-rds-data";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';
import { snakeToCamel } from "./field-mapper";
import type { SelectNavigationItem } from '@/types/db-types';
import { executeWithRetry } from "./rds-error-handler";
import { ErrorFactories } from '@/lib/error-utils';

// Type aliases for cleaner code
type DataApiResponse = ExecuteStatementCommandOutput;
type DataApiParameter = SqlParameter;

// Custom types for our formatted results
export interface FormattedRow {
  [columnName: string]: string | number | boolean | null | Uint8Array | ArrayValue | string[] | number[] | boolean[];
}

// Helper function to create SQL parameters with proper types
export function createParameter(name: string, value: string | number | boolean | null | undefined | Uint8Array): SqlParameter {
  if (value === null || value === undefined) {
    return { name, value: { isNull: true } };
  } else if (typeof value === 'boolean') {
    return { name, value: { booleanValue: value } };
  } else if (typeof value === 'number') {
    return { name, value: { longValue: value } };
  } else if (value instanceof Uint8Array) {
    return { name, value: { blobValue: value } };
  } else {
    return { name, value: { stringValue: String(value) } };
  }
}

// Lazy-initialize the RDS Data API client
let client: RDSDataClient | null = null;

function getRDSClient(): RDSDataClient {
  if (!client) {
    // Use the Node.js credential provider chain which will:
    // 1. Check environment variables (AWS_ACCESS_KEY_ID, etc.)
    // 2. Check ECS container credentials (for Amplify WEB_COMPUTE)
    // 3. Check EC2 instance metadata
    // 4. Check shared credentials file
    // 5. Check ECS task role
    // AWS Amplify automatically sets AWS_REGION and AWS_DEFAULT_REGION at runtime
    // We can't set AWS-prefixed vars in console, but Amplify provides them
    const region = process.env.AWS_REGION || 
                   process.env.AWS_DEFAULT_REGION || 
                   process.env.NEXT_PUBLIC_AWS_REGION || 
                   'us-east-1';
    
    client = new RDSDataClient({ 
      region,
      credentials: fromNodeProviderChain(),
      maxAttempts: 1 // We'll handle retries ourselves with circuit breaker
    });
  }
  return client;
}

// Get Data API configuration at runtime with comprehensive validation
function getDataApiConfig() {
  // Check all required environment variables
  const missingVars = [];
  
  if (!process.env.RDS_RESOURCE_ARN) {
    missingVars.push('RDS_RESOURCE_ARN');
  }
  
  if (!process.env.RDS_SECRET_ARN) {
    missingVars.push('RDS_SECRET_ARN');
  }
  
  // Check for AWS region configuration
  // AWS Amplify provides AWS_REGION and AWS_DEFAULT_REGION at runtime
  // We should have NEXT_PUBLIC_AWS_REGION set in console as fallback
  const region = process.env.AWS_REGION || 
                 process.env.AWS_DEFAULT_REGION || 
                 process.env.NEXT_PUBLIC_AWS_REGION;
  
  if (!region) {
    missingVars.push('NEXT_PUBLIC_AWS_REGION (AWS region not configured)');
  }
  
  if (missingVars.length > 0) {
    const errorMsg = `Missing required environment variables: ${missingVars.join(', ')}. ` +
                     `Available env vars: ${Object.keys(process.env).filter(k => 
                       k.includes('AWS') || k.includes('RDS')).join(', ')}`;
    const log = createLogger({ context: "getDataApiConfig" })
    log.error('Environment validation failed', { 
      missingVars,
      region,
      hasResourceArn: !!process.env.RDS_RESOURCE_ARN,
      hasSecretArn: !!process.env.RDS_SECRET_ARN,
      availableEnvVars: Object.keys(process.env).filter(k => 
        k.includes('AWS') || k.includes('RDS'))
    });
    throw new Error(errorMsg);
  }
  
  // Configuration validated successfully
  
  return {
    resourceArn: process.env.RDS_RESOURCE_ARN,
    secretArn: process.env.RDS_SECRET_ARN,
    // Database name is included in the secret, but we can specify it explicitly
    // The Data API will use the database from the secret if not specified
    database: 'aistudio'
  };
}

/**
 * Convert Data API response to a more usable format
 * Automatically transforms snake_case column names to camelCase
 */
function formatDataApiResponse(response: DataApiResponse): FormattedRow[] {
  if (!response.records) return [];
  
  const columns = response.columnMetadata?.map((col) => col.name || '') || [];
  
  return response.records.map((record) => {
    const row: FormattedRow = {};
    for (const [index, field] of record.entries()) {
      const columnName = columns[index];
      // Transform snake_case to camelCase for the property name
      const camelCaseColumnName = snakeToCamel(columnName);
      
      // Extract the actual value from the field object
      let value: string | number | boolean | null | Uint8Array | ArrayValue | string[] | number[] | boolean[];
      if ('isNull' in field && field.isNull) {
        value = null;
      } else if ('stringValue' in field) {
        value = field.stringValue!;
      } else if ('longValue' in field) {
        value = field.longValue!;
      } else if ('doubleValue' in field) {
        value = field.doubleValue!;
      } else if ('booleanValue' in field) {
        value = field.booleanValue!;
      } else if ('blobValue' in field) {
        value = field.blobValue!;
      } else if ('arrayValue' in field) {
        // Extract array values properly - RDS Data API returns ArrayValue objects
        const arrayValue = field.arrayValue!;
        if (arrayValue.stringValues) {
          value = arrayValue.stringValues;
        } else if (arrayValue.longValues) {
          value = arrayValue.longValues;
        } else if (arrayValue.doubleValues) {
          value = arrayValue.doubleValues;
        } else if (arrayValue.booleanValues) {
          value = arrayValue.booleanValues;
        } else {
          value = [];
        }
      } else {
        value = null;
      }
      row[camelCaseColumnName] = value;
    }
    return row;
  });
}

/**
 * Execute a single SQL statement
 */
export async function executeSQL<T = FormattedRow>(sql: string, parameters: DataApiParameter[] = [], requestIdOrTransactionId?: string, transactionId?: string): Promise<T[]> {
  // Handle overloaded parameters - if requestIdOrTransactionId looks like a transaction ID, treat it as such
  let reqId: string;
  let txId: string | undefined;
  
  if (transactionId) {
    // New signature: executeSQL(sql, params, requestId, transactionId)
    reqId = requestIdOrTransactionId || generateRequestId();
    txId = transactionId;
  } else if (requestIdOrTransactionId && requestIdOrTransactionId.length > 20) {
    // Likely a transaction ID (they're long UUIDs)
    reqId = generateRequestId();
    txId = requestIdOrTransactionId;
  } else {
    // Original signature: executeSQL(sql, params, requestId)
    reqId = requestIdOrTransactionId || generateRequestId();
    txId = undefined;
  }
  
  const timer = startTimer("executeSQL")
  const log = createLogger({ requestId: reqId, context: "executeSQL" })
  
  // Use the new retry handler with circuit breaker
  return executeWithRetry(async () => {
    const config = getDataApiConfig();
    
    if (process.env.SQL_LOGGING !== 'false') {
      log.debug('Executing SQL', { 
        sql: sql.substring(0, 100) + (sql.length > 100 ? '...' : ''),
        parameters: parameters?.map(p => ({ name: p.name, hasValue: !!p.value })),
        requestId: reqId,
        inTransaction: !!txId
      });
    }
    
    const command = new ExecuteStatementCommand({
      ...config,
      sql,
      parameters: parameters.length > 0 ? parameters : undefined,
      includeResultMetadata: true,
      ...(txId && { transactionId: txId })
    });

    const response = await getRDSClient().send(command);
    const result = formatDataApiResponse(response as DataApiResponse) as T[];
    
    if (process.env.SQL_LOGGING !== 'false' && result.length > 0) {
      log.debug('SQL query completed', { 
        rowCount: result.length,
        duration: timer({ status: "success" }),
        requestId: reqId,
        inTransaction: !!txId
      });
    }
    
    return result;
  }, 'executeSQL', {
    maxRetries: 3,
    initialDelay: 100,
    maxDelay: 5000
  }, reqId);
}

/**
 * Execute multiple SQL statements in a transaction
 */
export async function executeTransaction<T = FormattedRow>(statements: Array<{ sql: string, parameters?: DataApiParameter[] }>): Promise<T[][]> {
  const transactionId = await beginTransaction();
  
  try {
    const results = [];
    for (const stmt of statements) {
      // Pass the transactionId to executeSQL to ensure atomicity
      const result = await executeSQL<T>(stmt.sql, stmt.parameters, undefined, transactionId);
      results.push(result);
    }
    
    await commitTransaction(transactionId);
    return results;
  } catch (error) {
    await rollbackTransaction(transactionId);
    throw error;
  }
}

async function beginTransaction() {
  const command = new BeginTransactionCommand({
    resourceArn: process.env.RDS_RESOURCE_ARN!,
    secretArn: process.env.RDS_SECRET_ARN!,
    database: process.env.RDS_DATABASE_NAME || 'aistudio'
  });
  const response = await getRDSClient().send(command);
  return response.transactionId!;
}

async function commitTransaction(transactionId: string) {
  const command = new CommitTransactionCommand({
    resourceArn: process.env.RDS_RESOURCE_ARN!,
    secretArn: process.env.RDS_SECRET_ARN!,
    transactionId
  });
  await getRDSClient().send(command);
}

async function rollbackTransaction(transactionId: string) {
  const command = new RollbackTransactionCommand({
    resourceArn: process.env.RDS_RESOURCE_ARN!,
    secretArn: process.env.RDS_SECRET_ARN!,
    transactionId
  });
  await getRDSClient().send(command);
}

/**
 * Navigation management functions
 */
export async function getNavigationItems(activeOnly: boolean = false) {
  const sql = activeOnly ? `
    SELECT id, label, icon, link, parent_id, description, type,
           tool_id, requires_role, position, is_active, created_at
    FROM navigation_items 
    WHERE is_active = true 
    ORDER BY position ASC
  ` : `
    SELECT id, label, icon, link, parent_id, description, type,
           tool_id, requires_role, position, is_active, created_at
    FROM navigation_items 
    ORDER BY position ASC
  `;
  
  return executeSQL<SelectNavigationItem>(sql);
}

export async function createNavigationItem(data: {
  label: string;
  icon: string;
  link?: string;
  description?: string;
  type: string;
  parentId?: number;
  toolId?: number;
  requiresRole?: string;
  position?: number;
  isActive?: boolean;
}) {
  const sql = `
    INSERT INTO navigation_items (
      label, icon, link, description, type, parent_id, 
      tool_id, requires_role, position, is_active, created_at
    )
    VALUES (
      :label, :icon, :link, :description, :type::navigation_type, :parentId,
      :toolId, :requiresRole, :position, :isActive, NOW()
    )
    RETURNING *
  `;
  
  const parameters = [
    createParameter('label', data.label),
    createParameter('icon', data.icon),
    createParameter('link', data.link),
    createParameter('description', data.description),
    createParameter('type', data.type),
    createParameter('parentId', data.parentId),
    createParameter('toolId', data.toolId),
    createParameter('requiresRole', data.requiresRole),
    createParameter('position', data.position || 0),
    createParameter('isActive', data.isActive ?? true)
  ];
  
  const result = await executeSQL(sql, parameters);
  
  if (!result || result.length === 0) {
    throw new Error('Failed to create navigation item');
  }
  
  return result[0];
}

export async function updateNavigationItem(id: number, data: Partial<{
  label: string;
  icon: string;
  link: string;
  description: string;
  type: string;
  parentId: number;
  toolId: number;
  requiresRole: string;
  position: number;
  isActive: boolean;
}>) {
  const fields = [];
  const parameters = [createParameter('id', id)];
  let paramIndex = 0;
  
  for (const [key, value] of Object.entries(data)) {
    const snakeKey = toSnakeCase(key);
    // Special handling for enum type field
    if (key === 'type') {
      fields.push(`${snakeKey} = :param${paramIndex}::navigation_type`);
    } else {
      fields.push(`${snakeKey} = :param${paramIndex}`);
    }
    
    parameters.push(createParameter(`param${paramIndex}`, value));
    paramIndex++;
  }
  
  if (fields.length === 0) {
    throw new Error('No fields to update');
  }
  
  const sql = `
    UPDATE navigation_items
    SET ${fields.join(', ')}
    WHERE id = :id
    RETURNING *
  `;
  
  const result = await executeSQL(sql, parameters);
  
  if (!result || result.length === 0) {
    throw new Error(`Navigation item with id ${id} not found or update failed`);
  }
  
  return result[0];
}

export async function deleteNavigationItem(id: number) {
  const sql = `
    DELETE FROM navigation_items
    WHERE id = :id
    RETURNING *
  `;
  
  const parameters = [createParameter('id', id)];
  
  const result = await executeSQL(sql, parameters);
  return result[0];
}


/**
 * User management functions
 */
export async function getUsers() {
  const query = `
    SELECT id, cognito_sub, email, first_name, last_name,
           last_sign_in_at, created_at, updated_at
    FROM users
    ORDER BY created_at DESC
  `;
  
  const results = await executeSQL(query);
  return results;
}

export async function getUserRoles() {
  const sql = `
    SELECT ur.user_id, r.name as role_name
    FROM user_roles ur
    INNER JOIN roles r ON r.id = ur.role_id
    ORDER BY r.name ASC
  `;
  
  const results = await executeSQL(sql);
  return results;
}

export interface UserData {
  id?: number;
  cognitoSub: string;
  email: string;
  firstName?: string;
  lastName?: string;
}

export async function createUser(userData: UserData) {
  const query = `
    INSERT INTO users (cognito_sub, email, first_name, last_name, created_at, updated_at)
    VALUES (:cognitoSub, :email, :firstName, :lastName, NOW(), NOW())
    RETURNING id, cognito_sub, email, first_name, last_name, created_at, updated_at
  `;

  const parameters = [
    createParameter('cognitoSub', userData.cognitoSub),
    createParameter('email', userData.email),
    createParameter('firstName', userData.firstName),
    createParameter('lastName', userData.lastName)
  ];
  
  const result = await executeSQL(query, parameters);
  return result[0];
}

export async function updateUser(id: number, updates: Record<string, string | number | boolean | null>) {
  // Build dynamic UPDATE statement
  const updateFields = Object.keys(updates)
    .filter(key => key !== 'id')
    .map((key, index) => `${toSnakeCase(key)} = :param${index}`);
  
  if (updateFields.length === 0) {
    throw new Error('No fields to update');
  }
  
  const sql = `
    UPDATE users 
    SET ${updateFields.join(', ')}, updated_at = NOW()
    WHERE id = :id
    RETURNING *
  `;
  
  const parameters = [
    createParameter('id', id),
    ...Object.entries(updates)
      .filter(([key]) => key !== 'id')
      .map(([, value], index) => createParameter(`param${index}`, value))
  ];
  
  const result = await executeSQL(sql, parameters);
  return result[0];
}

export async function deleteUser(id: number) {
  const sql = `
    DELETE FROM users 
    WHERE id = :id
    RETURNING *
  `;
  
  const parameters = [
    { name: 'id', value: { longValue: id } }
  ];
  
  const result = await executeSQL(sql, parameters);
  return result[0];
}

/**
 * Fetch user by Cognito sub
 */
export async function getUserByCognitoSub(cognitoSub: string) {
  const query = `
    SELECT id, cognito_sub, email, first_name, last_name,
           last_sign_in_at, created_at, updated_at
    FROM users
    WHERE cognito_sub = :cognitoSub
  `;

  const parameters = [
    createParameter('cognitoSub', cognitoSub)
  ];
  
  const result = await executeSQL(query, parameters);
  return result[0];
}

export async function checkUserRole(userId: number, roleName: string): Promise<boolean> {
  const query = `
    SELECT COUNT(*) as count
    FROM user_roles ur
    JOIN users u ON ur.user_id = u.id
    JOIN roles r ON ur.role_id = r.id
    WHERE u.id = :userId AND r.name = :roleName
  `;

  const parameters = [
    createParameter('userId', userId),
    createParameter('roleName', roleName)
  ];
  
  const result = await executeSQL(query, parameters);
  return Number(result[0].count) > 0;
}

export async function checkUserRoleByCognitoSub(cognitoSub: string, roleName: string): Promise<boolean> {
  const query = `
    SELECT COUNT(*) as count
    FROM user_roles ur
    JOIN users u ON ur.user_id = u.id
    JOIN roles r ON ur.role_id = r.id
    WHERE u.cognito_sub = :cognitoSub AND r.name = :roleName
  `;

  const parameters = [
    createParameter('cognitoSub', cognitoSub),
    createParameter('roleName', roleName)
  ];
  
  const result = await executeSQL(query, parameters);
  return Number(result[0].count) > 0;
}

export async function getUserIdByCognitoSub(cognitoSub: string): Promise<string | null> {
  const query = `
    SELECT id
    FROM users
    WHERE cognito_sub = :cognitoSub
  `;

  const parameters = [
    createParameter('cognitoSub', cognitoSub)
  ];
  
  const result = await executeSQL(query, parameters);
  return result[0]?.id ? String(result[0].id) : null;
}

/**
 * Get user roles by cognito sub
 */
export async function getUserRolesByCognitoSub(cognitoSub: string): Promise<string[]> {
  const query = `
    SELECT r.name
    FROM roles r
    JOIN user_roles ur ON r.id = ur.role_id
    JOIN users u ON ur.user_id = u.id
    WHERE u.cognito_sub = :cognitoSub
    ORDER BY r.name ASC
  `;

  const parameters = [
    createParameter('cognitoSub', cognitoSub)
  ];
  
  const result = await executeSQL(query, parameters);
  return result.map((row) => row.name as string);
}

export async function hasToolAccess(cognitoSub: string, toolIdentifier: string): Promise<boolean> {
  const requestId = generateRequestId();
  const timer = startTimer("db.hasToolAccess");
  const log = createLogger({ requestId, function: "db.hasToolAccess" });
  
  log.debug("Checking tool access in database", { 
    cognitoSub,
    toolIdentifier 
  });
  
  const query = `
    SELECT COUNT(*) as count
    FROM users u
    JOIN user_roles ur ON u.id = ur.user_id
    JOIN role_tools rt ON ur.role_id = rt.role_id
    JOIN tools t ON rt.tool_id = t.id
    WHERE u.cognito_sub = :cognitoSub
      AND t.identifier = :toolIdentifier
  `;

  const parameters = [
    createParameter('cognitoSub', cognitoSub),
    createParameter('toolIdentifier', toolIdentifier)
  ];
  
  try {
    const result = await executeSQL(query, parameters);
    const hasAccess = Number(result[0].count) > 0;
    
    if (hasAccess) {
      log.info("Database: Tool access granted", { 
        cognitoSub,
        toolIdentifier 
      });
    } else {
      log.warn("Database: Tool access denied", { 
        cognitoSub,
        toolIdentifier 
      });
    }
    
    timer({ status: "success", hasAccess });
    return hasAccess;
  } catch (error) {
    log.error("Database error checking tool access", {
      error: error instanceof Error ? error.message : "Unknown error",
      cognitoSub,
      toolIdentifier
    });
    timer({ status: "error" });
    throw error;
  }
}

export async function getUserTools(cognitoSub: string): Promise<string[]> {
  const query = `
    SELECT DISTINCT t.identifier
    FROM users u
    JOIN user_roles ur ON u.id = ur.user_id
    JOIN role_tools rt ON ur.role_id = rt.role_id
    JOIN tools t ON rt.tool_id = t.id
    WHERE u.cognito_sub = :cognitoSub
  `;

  const parameters = [
    createParameter('cognitoSub', cognitoSub)
  ];
  
  const result = await executeSQL(query, parameters);
  return result.map((r) => r.identifier as string);
}

// Helper function to convert camelCase to snake_case
function toSnakeCase(str: string): string {
  // Special handling for field names with "1k" in them
  if (str.includes('Per1k')) {
    str = str.replace('Per1k', 'Per_1k');
  }
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * Role management functions
 */
export async function getRoleByName(roleName: string) {
  const sql = `
    SELECT id, name
    FROM roles
    WHERE name = :roleName
  `;
  
  const parameters = [
    createParameter('roleName', roleName)
  ];
  
  return executeSQL(sql, parameters);
}

export async function updateUserRole(userId: number, newRoleName: string) {
  const [role] = await getRoleByName(newRoleName);
  if (!role) {
    throw new Error(`Role '${newRoleName}' not found`);
  }
  
  // Start a transaction to update user roles and increment role_version
  const statements = [
    {
      sql: 'DELETE FROM user_roles WHERE user_id = :userId',
      parameters: [createParameter('userId', userId)]
    },
    {
      sql: 'INSERT INTO user_roles (user_id, role_id) VALUES (:userId, :roleId)',
      parameters: [
        createParameter('userId', userId),
        createParameter('roleId', Number(role.id))
      ]
    },
    {
      // Increment role_version to invalidate cached sessions
      sql: 'UPDATE users SET role_version = COALESCE(role_version, 0) + 1, updated_at = NOW() WHERE id = :userId',
      parameters: [createParameter('userId', userId)]
    }
  ];
  
  await executeTransaction(statements);
  return { success: true };
}

export async function getRoles() {
  const sql = `
    SELECT id, name, description, is_system, created_at, updated_at
    FROM roles
    ORDER BY name ASC
  `;
  
  const result = await executeSQL(sql);
  return result;
}

/**
 * AI Models functions
 */
export async function getAIModels() {
  const sql = `
    SELECT id, name, provider, model_id, description, capabilities, allowed_roles,
           max_tokens, active, chat_enabled, created_at, updated_at,
           input_cost_per_1k_tokens, output_cost_per_1k_tokens, cached_input_cost_per_1k_tokens, pricing_updated_at,
           average_latency_ms, max_concurrency, supports_batching,
           nexus_capabilities, provider_metadata
    FROM ai_models
    ORDER BY name ASC
  `;
  
  return executeSQL(sql);
}

export async function createAIModel(modelData: {
  name: string;
  modelId: string;
  provider?: string;
  description?: string;
  capabilities?: string;
  allowedRoles?: string;
  maxTokens?: number;
  isActive?: boolean;
  chatEnabled?: boolean;
  inputCostPer1kTokens?: number;
  outputCostPer1kTokens?: number;
  cachedInputCostPer1kTokens?: number;
  pricingUpdatedAt?: Date;
  averageLatencyMs?: number;
  maxConcurrency?: number;
  supportsBatching?: boolean;
  nexusCapabilities?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}) {
  const sql = `
    INSERT INTO ai_models (
      name, model_id, provider, description, capabilities, allowed_roles, max_tokens, active, chat_enabled,
      input_cost_per_1k_tokens, output_cost_per_1k_tokens, cached_input_cost_per_1k_tokens, pricing_updated_at,
      average_latency_ms, max_concurrency, supports_batching,
      nexus_capabilities, provider_metadata,
      created_at, updated_at
    )
    VALUES (
      :name, :modelId, :provider, :description, :capabilities::jsonb, :allowedRoles::jsonb, :maxTokens, :isActive, :chatEnabled,
      :inputCostPer1kTokens, :outputCostPer1kTokens, :cachedInputCostPer1kTokens, :pricingUpdatedAt,
      :averageLatencyMs, :maxConcurrency, :supportsBatching,
      :nexusCapabilities::jsonb, :providerMetadata::jsonb,
      NOW(), NOW()
    )
    RETURNING *
  `;
  
  const parameters = [
    createParameter('name', modelData.name),
    createParameter('modelId', modelData.modelId),
    createParameter('provider', modelData.provider),
    createParameter('description', modelData.description),
    createParameter('capabilities', modelData.capabilities),
    createParameter('allowedRoles', modelData.allowedRoles),
    createParameter('maxTokens', modelData.maxTokens),
    createParameter('isActive', modelData.isActive ?? true),
    createParameter('chatEnabled', modelData.chatEnabled ?? false),
    createParameter('inputCostPer1kTokens', modelData.inputCostPer1kTokens),
    createParameter('outputCostPer1kTokens', modelData.outputCostPer1kTokens),
    createParameter('cachedInputCostPer1kTokens', modelData.cachedInputCostPer1kTokens),
    createParameter('pricingUpdatedAt', modelData.pricingUpdatedAt ? modelData.pricingUpdatedAt.toISOString() : null),
    createParameter('averageLatencyMs', modelData.averageLatencyMs),
    createParameter('maxConcurrency', modelData.maxConcurrency),
    createParameter('supportsBatching', modelData.supportsBatching),
    createParameter('nexusCapabilities', modelData.nexusCapabilities ? JSON.stringify(modelData.nexusCapabilities) : null),
    createParameter('providerMetadata', modelData.providerMetadata ? JSON.stringify(modelData.providerMetadata) : null)
  ];
  
  const result = await executeSQL(sql, parameters);
  return result[0];
}

interface AIModelUpdateFields {
  name?: string;
  modelId?: string;
  provider?: string;
  description?: string;
  capabilities?: string;
  allowedRoles?: string;
  maxTokens?: number;
  isActive?: boolean;
  chatEnabled?: boolean;
  inputCostPer1kTokens?: number;
  outputCostPer1kTokens?: number;
  cachedInputCostPer1kTokens?: number;
  pricingUpdatedAt?: Date | string;
  averageLatencyMs?: number;
  maxConcurrency?: number;
  supportsBatching?: boolean;
  nexusCapabilities?: Record<string, boolean> | string;
  providerMetadata?: Record<string, unknown> | string;
}

export async function updateAIModel(id: number, updates: AIModelUpdateFields) {
  // Convert camelCase keys to snake_case for the database
  const snakeCaseUpdates: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(updates)) {
    const snakeKey = toSnakeCase(key);
    // Handle JSONB fields - ensure they're strings
    if ((key === 'nexusCapabilities' || key === 'providerMetadata') && value && typeof value === 'object') {
      snakeCaseUpdates[snakeKey] = JSON.stringify(value);
    } else {
      snakeCaseUpdates[snakeKey] = value;
    }
  }
  
  // Fields that need JSONB casting
  const jsonbFields = ['capabilities', 'allowed_roles', 'nexus_capabilities', 'provider_metadata'];
  // Fields that need timestamp casting
  const timestampFields = ['pricing_updated_at'];
  
  const updateFields = Object.keys(snakeCaseUpdates)
    .filter(key => key !== 'id')
    .map((key, index) => {
      // Cast to JSONB for JSON fields
      if (jsonbFields.includes(key) && snakeCaseUpdates[key] !== null) {
        return `${key} = :param${index}::jsonb`;
      }
      // Cast to timestamp for timestamp fields
      if (timestampFields.includes(key) && snakeCaseUpdates[key] !== null) {
        return `${key} = :param${index}::timestamp`;
      }
      return `${key} = :param${index}`;
    });
  
  if (updateFields.length === 0) {
    throw new Error('No fields to update');
  }
  
  const sql = `
    UPDATE ai_models 
    SET ${updateFields.join(', ')}, updated_at = NOW()
    WHERE id = :id
    RETURNING *
  `;
  
  const parameters = [
    createParameter('id', id),
    ...Object.entries(snakeCaseUpdates)
      .filter(([key]) => key !== 'id')
      .map(([, value], index) => createParameter(`param${index}`, value))
  ];
  
  const result = await executeSQL(sql, parameters);
  return result[0];
}

export async function deleteAIModel(id: number) {
  const sql = `
    DELETE FROM ai_models 
    WHERE id = :id
    RETURNING *
  `;
  
  const parameters = [
    { name: 'id', value: { longValue: id } }
  ];
  
  const result = await executeSQL(sql, parameters);
  return result[0];
}

/**
 * Get count of references to a model across all tables
 *
 * Checks references in:
 * - chain_prompts (model_id FK)
 * - nexus_messages (model_id FK)
 * - nexus_conversations (model_used varchar - requires join with ai_models)
 * - tool_executions (3-table join: tool_executions → assistant_architects → chain_prompts → model_id)
 * - model_comparisons (model1_id/model2_id FK)
 */
export async function getModelReferenceCounts(modelId: number) {
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM chain_prompts WHERE model_id = :modelId) as chain_prompts_count,
      (SELECT COUNT(*) FROM nexus_messages WHERE model_id = :modelId) as nexus_messages_count,
      (SELECT COUNT(*)
       FROM nexus_conversations nc
       INNER JOIN ai_models am ON nc.model_used = am.model_id
       WHERE am.id = :modelId) as nexus_conversations_count,
      (SELECT COUNT(*)
       FROM tool_executions te
       INNER JOIN assistant_architects aa ON te.assistant_architect_id = aa.id
       INNER JOIN chain_prompts cp ON cp.assistant_architect_id = aa.id
       WHERE cp.model_id = :modelId) as tool_executions_count,
      (SELECT COUNT(*) FROM model_comparisons WHERE model1_id = :modelId OR model2_id = :modelId) as model_comparisons_count
  `;

  const parameters = [
    { name: 'modelId', value: { longValue: modelId } }
  ];

  const result = await executeSQL(sql, parameters);
  return result[0] || {
    chain_prompts_count: 0,
    nexus_messages_count: 0,
    nexus_conversations_count: 0,
    tool_executions_count: 0,
    model_comparisons_count: 0
  };
}

/**
 * Replace all references to a model with another model
 * This is done in a transaction to ensure atomicity
 */
export async function replaceModelReferences(
  targetModelId: number, 
  replacementModelId: number,
  userId: number
) {
  const requestId = generateRequestId();
  const timer = startTimer("replaceModelReferences");
  const log = createLogger({ requestId, operation: "replaceModelReferences" });
  
  log.info("Starting model replacement", { 
    targetModelId, 
    replacementModelId, 
    userId 
  });
  
  try {
    // First, get model names and counts outside the transaction
    const modelNamesSql = `
      SELECT 
        (SELECT name FROM ai_models WHERE id = :targetId) as target_name,
        (SELECT name FROM ai_models WHERE id = :replacementId) as replacement_name
    `;
    
    const modelNamesParams = [
      { name: 'targetId', value: { longValue: targetModelId } },
      { name: 'replacementId', value: { longValue: replacementModelId } }
    ];
    
    const modelNames = await executeSQL(modelNamesSql, modelNamesParams, requestId);
    const { targetName, replacementName } = modelNames[0] || {};
    
    if (!targetName || !replacementName) {
      log.error("Invalid model IDs provided", { targetModelId, replacementModelId });
      throw new Error("Invalid model IDs provided");
    }
    
    // Get current counts for audit
    const counts = await getModelReferenceCounts(targetModelId);
    
    // Prepare all statements for the transaction
    const statements = [];
    
    // Update chain_prompts
    if (Number(counts.chainPromptsCount) > 0) {
      statements.push({
        sql: `UPDATE chain_prompts SET model_id = :replacementId, updated_at = NOW() WHERE model_id = :targetId`,
        parameters: [
          { name: 'replacementId', value: { longValue: replacementModelId } },
          { name: 'targetId', value: { longValue: targetModelId } }
        ]
      });
    }
    
    // Update nexus_messages (model_id FK)
    if (Number(counts.nexusMessagesCount) > 0) {
      statements.push({
        sql: `UPDATE nexus_messages SET model_id = :replacementId, updated_at = NOW() WHERE model_id = :targetId`,
        parameters: [
          { name: 'replacementId', value: { longValue: replacementModelId } },
          { name: 'targetId', value: { longValue: targetModelId } }
        ]
      });
    }

    // Update nexus_conversations (model_used varchar - requires join with ai_models to get model_id string)
    if (Number(counts.nexusConversationsCount) > 0) {
      // Get the model_id strings for both target and replacement
      const modelIdsSql = `
        SELECT
          (SELECT model_id FROM ai_models WHERE id = :targetId) as target_model_id,
          (SELECT model_id FROM ai_models WHERE id = :replacementId) as replacement_model_id
      `;
      const modelIdsParams = [
        { name: 'targetId', value: { longValue: targetModelId } },
        { name: 'replacementId', value: { longValue: replacementModelId } }
      ];
      const modelIds = await executeSQL(modelIdsSql, modelIdsParams, requestId);
      const { targetModelId: targetModelIdStr, replacementModelId: replacementModelIdStr } = modelIds[0] || {};

      if (!targetModelIdStr || !replacementModelIdStr) {
        log.error("Model ID lookup failed - models may not exist", { targetModelId, replacementModelId });
        throw ErrorFactories.dbRecordNotFound("ai_models", !targetModelIdStr ? targetModelId : replacementModelId);
      }

      statements.push({
        sql: `UPDATE nexus_conversations SET model_used = :replacementModelId, updated_at = NOW() WHERE model_used = :targetModelId`,
        parameters: [
          { name: 'replacementModelId', value: { stringValue: String(replacementModelIdStr) } },
          { name: 'targetModelId', value: { stringValue: String(targetModelIdStr) } }
        ]
      });
    }

    // Note: tool_executions references are updated via chain_prompts.model_id
    // chain_prompts is linked to assistant_architects, and tool_executions uses those architects
    // So we update chain_prompts which will be handled by the chain_prompts update above
    // No separate update needed here since chain_prompts already updated
    
    // Update model_comparisons (both model1_id and model2_id)
    if (Number(counts.modelComparisonsCount) > 0) {
      statements.push({
        sql: `UPDATE model_comparisons SET model1_id = :replacementId, updated_at = NOW() WHERE model1_id = :targetId`,
        parameters: [
          { name: 'replacementId', value: { longValue: replacementModelId } },
          { name: 'targetId', value: { longValue: targetModelId } }
        ]
      });
      
      statements.push({
        sql: `UPDATE model_comparisons SET model2_id = :replacementId, updated_at = NOW() WHERE model2_id = :targetId`,
        parameters: [
          { name: 'replacementId', value: { longValue: replacementModelId } },
          { name: 'targetId', value: { longValue: targetModelId } }
        ]
      });
    }
    
    // Record in audit table (if it exists - may not be created yet)
    // For now, we'll skip the audit logging until the table schema is updated
    // TODO: Update model_replacement_audit table schema to include new columns:
    // - nexus_messages_updated
    // - nexus_conversations_updated
    // - tool_executions_updated
    
    // Delete the original model
    statements.push({
      sql: `DELETE FROM ai_models WHERE id = :targetId`,
      parameters: [{ name: 'targetId', value: { longValue: targetModelId } }]
    });
    
    // Execute all statements in a transaction
    await executeTransaction(statements);
    
    const result = {
      success: true,
      targetModel: { id: targetModelId, name: targetName },
      replacementModel: { id: replacementModelId, name: replacementName },
      recordsUpdated: {
        chainPrompts: Number(counts.chainPromptsCount || 0),
        nexusMessages: Number(counts.nexusMessagesCount || 0),
        nexusConversations: Number(counts.nexusConversationsCount || 0),
        toolExecutions: Number(counts.toolExecutionsCount || 0),
        modelComparisons: Number(counts.modelComparisonsCount || 0)
      },
      totalUpdated:
        Number(counts.chainPromptsCount || 0) +
        Number(counts.nexusMessagesCount || 0) +
        Number(counts.nexusConversationsCount || 0) +
        Number(counts.toolExecutionsCount || 0) +
        Number(counts.modelComparisonsCount || 0)
    };
    
    log.info("Model replacement completed successfully", result);
    timer({ status: "success", recordsUpdated: result.totalUpdated });
    
    return result;
    
  } catch (error) {
    log.error("Model replacement failed", { 
      error: error instanceof Error ? error.message : String(error),
      targetModelId,
      replacementModelId 
    });
    timer({ status: "error" });
    
    throw error;
  }
}

/**
 * Validate if a model can be used as a replacement for another
 */
export async function validateModelReplacement(targetModelId: number, replacementModelId: number) {
  // Prevent self-replacement
  if (targetModelId === replacementModelId) {
    return {
      valid: false,
      reason: "A model cannot replace itself"
    };
  }
  
  const sql = `
    SELECT 
      target.id as target_id,
      target.name as target_name,
      target.active as target_active,
      target.chat_enabled as target_chat_enabled,
      replacement.id as replacement_id,
      replacement.name as replacement_name,
      replacement.active as replacement_active,
      replacement.chat_enabled as replacement_chat_enabled
    FROM ai_models target
    CROSS JOIN ai_models replacement
    WHERE target.id = :targetId 
      AND replacement.id = :replacementId
  `;
  
  const parameters = [
    { name: 'targetId', value: { longValue: targetModelId } },
    { name: 'replacementId', value: { longValue: replacementModelId } }
  ];
  
  const result = await executeSQL(sql, parameters);
  
  if (!result || result.length === 0) {
    return {
      valid: false,
      reason: "One or both models not found"
    };
  }
  
  const models = result[0];
  
  // Check if replacement model is active (fields come back in camelCase from data-api-adapter)
  if (!models.replacementActive) {
    return {
      valid: false,
      reason: `Replacement model "${models.replacementName}" is not active`
    };
  }
  
  // Warn if chat capabilities differ
  const warnings = [];
  if (models.targetChatEnabled && !models.replacementChatEnabled) {
    warnings.push(`Target model has chat enabled but replacement model does not`);
  }
  
  return {
    valid: true,
    targetModel: {
      id: models.targetId,
      name: models.targetName,
      chatEnabled: models.targetChatEnabled
    },
    replacementModel: {
      id: models.replacementId,
      name: models.replacementName,
      chatEnabled: models.replacementChatEnabled
    },
    warnings
  };
}

export async function assignRoleToUser(userId: number, roleId: number) {
  const sql = `
    INSERT INTO user_roles (user_id, role_id, created_at, updated_at)
    VALUES (:userId, :roleId, NOW(), NOW())
    RETURNING *
  `
  const parameters = [
    { name: "userId", value: { longValue: userId } },
    { name: "roleId", value: { longValue: roleId } }
  ]
  return executeSQL(sql, parameters)
}

/**
 * Tools functions
 */
export async function getTools() {
  const sql = `
    SELECT id, identifier, name, description, 
           prompt_chain_tool_id as assistant_architect_id, is_active, 
           created_at, updated_at
    FROM tools
    WHERE is_active = true
    ORDER BY name ASC
  `;
  
  const result = await executeSQL(sql);
  return result;
}

/**
 * Create a new role
 */
export async function createRole(roleData: {
  name: string;
  description?: string;
  isSystem?: boolean;
}) {
  const sql = `
    INSERT INTO roles (name, description, is_system, created_at, updated_at)
    VALUES (:name, :description, :isSystem, NOW(), NOW())
    RETURNING id, name, description, is_system, created_at, updated_at
  `;
  
  const parameters: DataApiParameter[] = [
    { name: 'name', value: { stringValue: roleData.name } },
    { name: 'description', value: roleData.description ? { stringValue: roleData.description } : { isNull: true } },
    { name: 'isSystem', value: { booleanValue: roleData.isSystem ?? false } }
  ];
  
  const result = await executeSQL(sql, parameters);
  return result[0];
}

/**
 * Update an existing role
 */
export async function updateRole(id: number, updates: {
  name?: string;
  description?: string;
}) {
  const updateFields = [];
  const parameters: DataApiParameter[] = [
    { name: 'id', value: { longValue: id } }
  ];
  
  if (updates.name !== undefined) {
    updateFields.push('name = :name');
    parameters.push({ name: 'name', value: { stringValue: updates.name } });
  }
  
  if (updates.description !== undefined) {
    updateFields.push('description = :description');
    parameters.push({ 
      name: 'description', 
      value: updates.description ? { stringValue: updates.description } : { isNull: true }
    });
  }
  
  if (updateFields.length === 0) {
    throw new Error('No fields to update');
  }
  
  const sql = `
    UPDATE roles 
    SET ${updateFields.join(', ')}, updated_at = NOW()
    WHERE id = :id AND is_system = false
    RETURNING id, name, description, is_system, created_at, updated_at
  `;
  
  const result = await executeSQL(sql, parameters);
  if (result.length === 0) {
    throw new Error('Role not found or is a system role');
  }
  return result[0];
}

/**
 * Delete a role (only non-system roles)
 */
export async function deleteRole(id: number) {
  const sql = `
    DELETE FROM roles 
    WHERE id = :id AND is_system = false
    RETURNING *
  `;
  
  const parameters = [
    { name: 'id', value: { longValue: id } }
  ];
  
  const result = await executeSQL(sql, parameters);
  if (result.length === 0) {
    throw new Error('Role not found or is a system role');
  }
  return result[0];
}

/**
 * Get all tools assigned to a role
 */
export async function getRoleTools(roleId: number) {
  const sql = `
    SELECT t.id, t.identifier, t.name, t.description, 
           t.is_active, t.created_at, t.updated_at
    FROM tools t
    JOIN role_tools rt ON t.id = rt.tool_id
    WHERE rt.role_id = :roleId
    ORDER BY t.name ASC
  `;
  
  const parameters = [
    { name: 'roleId', value: { longValue: roleId } }
  ];
  
  const result = await executeSQL(sql, parameters);
  return result;
}

/**
 * Assign a tool to a role
 */
export async function assignToolToRole(roleId: string, toolId: string) {
  // First check if the assignment already exists
  const checkSql = `
    SELECT 1 FROM role_tools 
    WHERE role_id = :roleId AND tool_id = :toolId
  `;
  
  const checkParams = [
    { name: 'roleId', value: { longValue: Number.parseInt(roleId, 10) } },
    { name: 'toolId', value: { longValue: Number.parseInt(toolId, 10) } }
  ];
  
  const existing = await executeSQL(checkSql, checkParams);
  
  if (existing.length > 0) {
    return true; // Already assigned
  }
  
  // Insert the new assignment
  const insertSql = `
    INSERT INTO role_tools (role_id, tool_id, created_at)
    VALUES (:roleId, :toolId, NOW())
    RETURNING *
  `;
  
  const insertParams = [
    { name: 'roleId', value: { longValue: Number.parseInt(roleId, 10) } },
    { name: 'toolId', value: { longValue: Number.parseInt(toolId, 10) } }
  ];
  
  const result = await executeSQL(insertSql, insertParams);
  return result.length > 0;
}

/**
 * Remove a tool from a role
 */
export async function removeToolFromRole(roleId: string, toolId: string) {
  const sql = `
    DELETE FROM role_tools
    WHERE role_id = :roleId AND tool_id = :toolId
    RETURNING *
  `;
  
  const parameters = [
    { name: 'roleId', value: { longValue: Number.parseInt(roleId, 10) } },
    { name: 'toolId', value: { longValue: Number.parseInt(toolId, 10) } }
  ];
  
  const result = await executeSQL(sql, parameters);
  return result.length > 0;
}

/**
 * Assistant Architect functions
 */
export async function getAssistantArchitects() {
  const sql = `
    SELECT 
      a.id, 
      a.name, 
      a.description, 
      a.image_path,
      a.user_id,
      a.status, 
      a.created_at, 
      a.updated_at,
      u.first_name AS creator_first_name, 
      u.last_name AS creator_last_name, 
      u.email AS creator_email
    FROM assistant_architects a
    LEFT JOIN users u ON a.user_id = u.id
    ORDER BY a.created_at DESC
  `;
  
  const assistants = await executeSQL(sql);
  
  // Include creator info
  return assistants.map((assistant: FormattedRow) => ({
    ...assistant,
    userId: assistant.userId || 'unknown',
    creator: assistant.creatorFirstName || assistant.creatorLastName || assistant.creatorEmail
      ? {
          id: assistant.userId,
          firstName: assistant.creatorFirstName,
          lastName: assistant.creatorLastName,
          email: assistant.creatorEmail
        }
      : null
  }));
}

export async function createAssistantArchitect(data: {
  name: string;
  description?: string;
  userId: string;
  status?: string;
}) {
  // First get the user's database ID from their Cognito sub
  const userResult = await executeSQL(`
    SELECT id FROM users WHERE cognito_sub = :cognitoSub
  `, [{ name: 'cognitoSub', value: { stringValue: data.userId } }]);
  
  if (!userResult || userResult.length === 0) {
    throw new Error('User not found');
  }
  
  const userDbId = userResult[0].id;
  
  const sql = `
    INSERT INTO assistant_architects (name, description, user_id, status, created_at, updated_at)
    VALUES (:name, :description, :userId, :status::tool_status, NOW(), NOW())
    RETURNING *
  `;
  
  const parameters = [
    { name: 'name', value: { stringValue: data.name } },
    { name: 'description', value: data.description ? { stringValue: data.description } : { isNull: true } },
    { name: 'userId', value: { longValue: Number(userDbId) } },
    { name: 'status', value: { stringValue: data.status || 'draft' } }
  ];
  
  const result = await executeSQL(sql, parameters);
  return result[0];
}

export async function updateAssistantArchitect(id: number, updates: Record<string, string | number | boolean | null>) {
  const updateFields: string[] = [];
  const parameters: DataApiParameter[] = [
    { name: 'id', value: { longValue: id } }
  ];
  
  let paramIndex = 0;
  for (const [key, value] of Object.entries(updates)) {
    const snakeKey = toSnakeCase(key);
    updateFields.push(`${snakeKey} = :param${paramIndex}`);
    
    let paramValue;
    if (value === null || value === undefined) {
      paramValue = { isNull: true };
    } else if (snakeKey === 'status') {
      // Cast status enum
      updateFields[updateFields.length - 1] = `${snakeKey} = :param${paramIndex}::tool_status`;
      paramValue = { stringValue: String(value) };
    } else {
      paramValue = { stringValue: String(value) };
    }
    
    parameters.push({ name: `param${paramIndex}`, value: paramValue });
    paramIndex++;
  }
  
  if (updateFields.length === 0) {
    throw new Error('No fields to update');
  }
  
  const sql = `
    UPDATE assistant_architects 
    SET ${updateFields.join(', ')}, updated_at = NOW()
    WHERE id = :id
    RETURNING *
  `;
  
  const result = await executeSQL(sql, parameters);
  return result[0];
}

export async function deleteAssistantArchitect(id: number) {
  // Delete related records first to avoid foreign key constraint violations
  
  // First delete prompt_results (references chain_prompts)
  await executeSQL(`
    DELETE FROM prompt_results
    WHERE prompt_id IN (
      SELECT id FROM chain_prompts WHERE assistant_architect_id = :id
    )
  `, [{ name: 'id', value: { longValue: id } }]);
  
  // Then delete chain prompts
  await executeSQL(`
    DELETE FROM chain_prompts 
    WHERE assistant_architect_id = :id
  `, [{ name: 'id', value: { longValue: id } }]);
  
  // Delete tool input fields
  await executeSQL(`
    DELETE FROM tool_input_fields 
    WHERE assistant_architect_id = :id
  `, [{ name: 'id', value: { longValue: id } }]);
  
  // Delete tool executions (if any)
  await executeSQL(`
    DELETE FROM tool_executions 
    WHERE assistant_architect_id = :id
  `, [{ name: 'id', value: { longValue: id } }]);
  
  // Note: The tools table is linked differently - tools have their own lifecycle
  // and are not directly tied to assistant architects via foreign key
  
  // Finally delete the assistant architect
  const sql = `
    DELETE FROM assistant_architects 
    WHERE id = :id
    RETURNING *
  `;
  
  const parameters = [
    { name: 'id', value: { longValue: id } }
  ];
  
  const result = await executeSQL(sql, parameters);
  return result[0];
}

export async function approveAssistantArchitect(id: number) {
  const sql = `
    UPDATE assistant_architects 
    SET status = 'approved'::tool_status, updated_at = NOW()
    WHERE id = :id
    RETURNING *
  `;
  
  const parameters = [
    { name: 'id', value: { longValue: id } }
  ];
  
  const result = await executeSQL(sql, parameters);
  const assistant = result[0];
  
  // Also create the tool entry if needed
  await executeSQL(`
    INSERT INTO tools (identifier, name, description, prompt_chain_tool_id, is_active, created_at, updated_at)
    SELECT LOWER(REPLACE(name, ' ', '-')), 
           name, 
           description, 
           id, 
           true, 
           NOW(), 
           NOW()
    FROM assistant_architects
    WHERE id = :assistantId
    AND NOT EXISTS (
      SELECT 1 FROM tools WHERE prompt_chain_tool_id = :assistantId
    )
  `, [{ name: 'assistantId', value: { longValue: Number(assistant.id) } }]);
  
  return assistant;
}

export async function rejectAssistantArchitect(id: number) {
  const sql = `
    UPDATE assistant_architects 
    SET status = 'rejected'::tool_status, updated_at = NOW()
    WHERE id = :id
  `;
  
  const parameters = [
    { name: 'id', value: { longValue: id } }
  ];
  
  await executeSQL(sql, parameters);
}

/**
 * Validate AWS RDS Data API configuration and connectivity
 * Use this to debug connection issues in production
 */
export async function validateDataAPIConnection() {
  const log = createLogger({ context: "validateDataApiConfig" })
  try {
    // 1. Check environment variables
    const config = getDataApiConfig();
    log.info('Data API configuration loaded successfully', {
      hasResourceArn: !!config.resourceArn,
      hasSecretArn: !!config.secretArn,
      database: config.database
    });
    
    // 2. Check AWS credentials
    getRDSClient(); // Ensure client can be created
    const region = process.env.AWS_REGION || 
                   process.env.AWS_DEFAULT_REGION || 
                   process.env.NEXT_PUBLIC_AWS_REGION || 
                   'us-east-1';
    
    log.info('RDS Data API client initialized', { region });
    
    // 3. Test database connectivity with a simple query
    const testSql = 'SELECT 1 as test';
    const result = await executeSQL(testSql);
    
    if (result && result[0] && result[0].test === 1) {
      log.info('Database connectivity test passed');
      return {
        success: true,
        message: 'Data API connection validated successfully',
        config: {
          region,
          hasResourceArn: !!config.resourceArn,
          hasSecretArn: !!config.secretArn,
          database: config.database
        }
      };
    } else {
      throw new Error('Unexpected test query result');
    }
  } catch (error) {
    log.error('Data API validation failed', { error: (error as Error).message });
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack?.split('\n').slice(0, 5).join('\n')
      } : error
    };
  }
} 