import { executeSQL as executeRawSQL, executeTransaction } from '@/lib/db/data-api-adapter';
import type { SqlParameter, Field } from '@aws-sdk/client-rds-data';

/**
 * Database row types for common queries
 */
export interface DatabaseRow {
  [key: string]: unknown;
}

/**
 * Supported parameter value types
 */
export type ParameterValue = string | number | boolean | Date | Uint8Array | null | undefined | Record<string, unknown>;

/**
 * Helper function to execute SQL with simple parameter passing
 * Wraps the AWS RDS Data API parameter format
 */
export async function executeSQL<T extends DatabaseRow = DatabaseRow>(
  sql: string, 
  params?: ParameterValue[]
): Promise<T[]> {
  if (!params || params.length === 0) {
    return executeRawSQL<T>(sql);
  }
  
  // Convert simple params to RDS Data API format
  const rdsParams: SqlParameter[] = params.map((value, index) => {
    const param: SqlParameter = {
      name: `param${index + 1}`,
      value: convertToRdsValue(value)
    };

    // Update SQL to use named parameters
    // eslint-disable-next-line security/detect-non-literal-regexp -- index is a number, not user input
    sql = sql.replace(new RegExp(`\\$${index + 1}`, 'g'), `:param${index + 1}`);
    
    return param;
  });
  
  return executeRawSQL<T>(sql, rdsParams);
}

/**
 * Convert a JavaScript value to RDS Data API format
 */
function convertToRdsValue(value: ParameterValue): Field {
  if (value === null || value === undefined) {
    return { isNull: true };
  }
  
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { longValue: value };
    }
    return { doubleValue: value };
  }
  
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  
  if (value instanceof Date) {
    return { stringValue: value.toISOString() };
  }
  
  if (value instanceof Uint8Array) {
    return { blobValue: value };
  }
  
  // For complex types, stringify as JSON
  return { stringValue: JSON.stringify(value) };
}

/**
 * Execute multiple SQL statements in a transaction with simple parameter passing
 *
 * NOTE: This function uses the legacy raw SQL Data API transaction executor,
 * not the Drizzle ORM transaction wrapper. This is intentional as it provides
 * a simplified interface for raw SQL transactions in the Nexus streaming system.
 *
 * For new code using Drizzle ORM, use executeTransaction from drizzle-client.ts instead.
 */
export async function executeSQLTransaction<T extends DatabaseRow = DatabaseRow>(
  statements: Array<{ sql: string; params?: ParameterValue[] }>
): Promise<T[][]> {
  // Convert simple params to RDS Data API format for each statement
  const rdsStatements = statements.map(({ sql, params }) => {
    if (!params || params.length === 0) {
      return { sql };
    }

    // Convert simple params to RDS Data API format
    const rdsParams: SqlParameter[] = params.map((value, index) => {
      const param: SqlParameter = {
        name: `param${index + 1}`,
        value: convertToRdsValue(value)
      };

      // Update SQL to use named parameters
      // eslint-disable-next-line security/detect-non-literal-regexp -- index is a number, not user input
      sql = sql.replace(new RegExp(`\\$${index + 1}`, 'g'), `:param${index + 1}`);

      return param;
    });

    return { sql, parameters: rdsParams };
  });

  return executeTransaction<T>(rdsStatements);
}

/**
 * Extract a value from RDS Data API result field
 */
export function extractValue(field: Field | null | undefined): unknown {
  if (!field) return null;
  
  if (field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.blobValue !== undefined) return field.blobValue;
  if (field.arrayValue !== undefined) return field.arrayValue;
  
  return field;
}