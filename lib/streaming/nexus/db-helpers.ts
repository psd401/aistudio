import { executeQuery, executeTransaction as executeQueryTransaction } from '@/lib/db/drizzle-client';
import { sql } from 'drizzle-orm';

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
 * Uses Drizzle ORM with sql template tag
 */
export async function executeSQL<T extends DatabaseRow = DatabaseRow>(
  sqlString: string,
  params?: ParameterValue[]
): Promise<T[]> {
  const result = await executeQuery(
    (db) => {
      if (!params || params.length === 0) {
        return db.execute(sql.raw(sqlString));
      }

      // Build sql template with interpolated parameters
      // Replace $1, $2, etc with actual values
      const parts: (string | unknown)[] = [];
      let lastIndex = 0;

      // Find all $N placeholders and replace with parameters
      for (let i = 1; i <= params.length; i++) {
        const placeholder = `$${i}`;
        const index = sqlString.indexOf(placeholder, lastIndex);

        if (index !== -1) {
          // Add the string part before the placeholder
          parts.push(sqlString.substring(lastIndex, index));
          // Add the parameter value
          parts.push(params[i - 1]);
          lastIndex = index + placeholder.length;
        }
      }

      // Add remaining string
      if (lastIndex < sqlString.length) {
        parts.push(sqlString.substring(lastIndex));
      }

      // Build the sql template dynamically
      const strings = parts.filter((_, i) => i % 2 === 0) as string[];
      const values = parts.filter((_, i) => i % 2 === 1);

      // Use sql template tag - strings must be TemplateStringsArray
      return db.execute(sql(strings as unknown as TemplateStringsArray, ...values));
    },
    'executeSQL'
  );

  return result.rows as T[];
}

/**
 * Execute multiple SQL statements in a transaction with simple parameter passing
 * Uses Drizzle ORM transaction wrapper
 */
export async function executeSQLTransaction<T extends DatabaseRow = DatabaseRow>(
  statements: Array<{ sql: string; params?: ParameterValue[] }>
): Promise<T[][]> {
  return executeQueryTransaction(
    async (tx) => {
      const results: T[][] = [];

      for (const { sql: sqlString, params } of statements) {
        let result;

        if (!params || params.length === 0) {
          result = await tx.execute(sql.raw(sqlString));
        } else {
          // Build sql template with interpolated parameters
          const parts: (string | unknown)[] = [];
          let lastIndex = 0;

          // Find all $N placeholders and replace with parameters
          for (let i = 1; i <= params.length; i++) {
            const placeholder = `$${i}`;
            const index = sqlString.indexOf(placeholder, lastIndex);

            if (index !== -1) {
              parts.push(sqlString.substring(lastIndex, index));
              parts.push(params[i - 1]);
              lastIndex = index + placeholder.length;
            }
          }

          if (lastIndex < sqlString.length) {
            parts.push(sqlString.substring(lastIndex));
          }

          const strings = parts.filter((_, i) => i % 2 === 0) as string[];
          const values = parts.filter((_, i) => i % 2 === 1);

          result = await tx.execute(sql(strings as unknown as TemplateStringsArray, ...values));
        }

        results.push(result.rows as T[]);
      }

      return results;
    },
    'executeSQLTransaction'
  );
}