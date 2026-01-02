/**
 * Column validation utilities to prevent SQL injection
 * Define allowed columns for each table that can be updated dynamically
 */

import logger from '@/lib/logger';

export const ALLOWED_UPDATE_COLUMNS = {
  users: [
    'email', 'first_name', 'last_name', 'avatar_url', 
    'is_active', 'last_sign_in_at', 'updated_at'
  ],
  
  navigation_items: [
    'label', 'icon', 'link', 'description', 'type', 
    'parent_id', 'tool_id', 'requires_role', 'position', 
    'is_active', 'updated_at'
  ],
  
  ai_models: [
    'name', 'provider', 'model_id', 'description',
    'capabilities', 'max_tokens', 'active', 'nexus_enabled',
    'architect_enabled', 'updated_at'
  ],
  
  roles: [
    'name', 'description', 'updated_at'
  ],
  
  assistant_architects: [
    'name', 'description', 'status', 'image_path', 
    'input_schema', 'output_schema', 'updated_at'
  ],
  
  tools: [
    'name', 'description', 'is_active', 'updated_at'
  ],
  
  jobs: [
    'status', 'output', 'error', 'updated_at'
  ],
  
  settings: [
    'provider', 'model', 'temperature', 'max_tokens', 
    'api_key', 'region', 'updated_at'
  ],
  
  conversations: [
    'name', 'system_prompt', 'model_id', 'updated_at'
  ],
  
  messages: [
    'content', 'updated_at'
  ]
} as const;

/**
 * Validates that column names are in the allowed list for a table
 * @param tableName The table being updated
 * @param columns Array of column names to validate
 * @returns Array of valid column names
 * @throws Error if table is not configured
 */
export function validateColumns(tableName: keyof typeof ALLOWED_UPDATE_COLUMNS, columns: string[]): string[] {
  const allowedColumns = ALLOWED_UPDATE_COLUMNS[tableName];
  
  if (!allowedColumns) {
    throw new Error(`No column validation configured for table: ${tableName}`);
  }
  
  const validColumns = columns.filter(col => (allowedColumns as readonly string[]).includes(col));
  
  // Log any rejected columns in development
  if (process.env.NODE_ENV === 'development') {
    const rejected = columns.filter(col => !(allowedColumns as readonly string[]).includes(col));
    if (rejected.length > 0) {
      logger.warn(`Rejected columns for ${tableName}:`, rejected);
    }
  }
  
  return validColumns;
}

/**
 * Converts camelCase to snake_case
 */
export function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * Sanitizes and validates columns for a dynamic update query
 * @param tableName The table being updated
 * @param data Object with column:value pairs
 * @returns Object with validated snake_case columns
 */
export function sanitizeUpdateData<T extends Record<string, unknown>>(
  tableName: keyof typeof ALLOWED_UPDATE_COLUMNS, 
  data: T
): Record<string, unknown> {
  const snakeCaseData: Record<string, unknown> = {};
  
  // Convert to snake_case
  for (const [key, value] of Object.entries(data)) {
    const snakeKey = toSnakeCase(key);
    snakeCaseData[snakeKey] = value;
  }
  
  // Validate columns
  const validColumns = validateColumns(tableName, Object.keys(snakeCaseData));
  
  // Filter to only valid columns
  const sanitizedData: Record<string, unknown> = {};
  for (const col of validColumns) {
    sanitizedData[col] = snakeCaseData[col];
  }
  
  return sanitizedData;
}