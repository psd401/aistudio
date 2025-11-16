import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const rdsClient = new RDSDataClient({});
const secretsClient = new SecretsManagerClient({});

interface CustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: {
    ClusterArn: string;
    SecretArn: string;
    DatabaseName: string;
    Environment: string;
  };
  PhysicalResourceId?: string;
}

/**
 * CRITICAL: Database Initialization and Migration Handler
 * 
 * This Lambda handles TWO distinct scenarios:
 * 1. Fresh Installation: Runs all initial setup files (001-005)
 * 2. Existing Database: ONLY runs migration files (010+)
 * 
 * WARNING: The initial setup files (001-005) MUST exactly match the existing
 * database structure or they will cause data corruption!
 * 
 * @see /docs/database-restoration/DATABASE-MIGRATIONS.md for full details
 */

// Migration files that should ALWAYS run (additive only)
// These files should ONLY create new objects, never modify existing ones
const MIGRATION_FILES = [
  '010-knowledge-repositories.sql',
  '11_textract_jobs.sql',
  '12_textract_usage.sql',
  '013-add-knowledge-repositories-tool.sql',
  '014-model-comparisons.sql',
  '015-add-model-compare-tool.sql',
  '016-assistant-architect-repositories.sql',
  '017-add-user-roles-updated-at.sql',
  '018-model-replacement-audit.sql',
  '019-fix-navigation-role-display.sql',
  '020-add-user-role-version.sql',
  '023-navigation-multi-roles.sql',
  '024-model-role-restrictions.sql',
  '026-add-model-compare-source.sql',
  '027-messages-model-tracking.sql',
  '028-nexus-schema.sql',
  '029-ai-models-nexus-enhancements.sql',
  '030-nexus-provider-metrics.sql',
  '031-nexus-messages.sql',
  '032-remove-nexus-provider-constraint.sql',
  '033-ai-streaming-jobs.sql',
  '034-assistant-architect-enabled-tools.sql',
  '035-schedule-management-schema.sql',
  '036-remove-legacy-chat-tables.sql',
  '037-assistant-architect-events.sql',
  '039-prompt-library-schema.sql'
  // ADD NEW MIGRATIONS HERE - they will run once and be tracked
];

// Initial setup files (only run on empty database)
// WARNING: These must EXACTLY match existing database structure!
const INITIAL_SETUP_FILES = [
  '001-enums.sql',      // Creates enum types
  '002-tables.sql',     // Creates all core tables
  '003-constraints.sql', // Adds foreign key constraints
  '004-indexes.sql',     // Creates performance indexes
  '005-initial-data.sql' // Inserts required seed data
];

export async function handler(event: CustomResourceEvent): Promise<any> {
  console.log('Database initialization event:', JSON.stringify(event, null, 2));
  console.log('Handler version: 2025-10-26-v9 - Latimer AI migration 040');
  
  // SAFETY CHECK: Log what mode we're in
  console.log(`🔍 Checking database state for safety...`);

  // Only run on Create or Update
  if (event.RequestType === 'Delete') {
    return {
      PhysicalResourceId: event.PhysicalResourceId || 'db-init',
      Status: 'SUCCESS',
      Reason: 'Delete not required for database initialization'
    };
  }

  const { ClusterArn, SecretArn, DatabaseName, Environment } = event.ResourceProperties;

  try {
    // CRITICAL: Check if this is a fresh database or existing one
    const isDatabaseEmpty = await checkIfDatabaseEmpty(ClusterArn, SecretArn, DatabaseName);
    
    if (isDatabaseEmpty) {
      console.log('🆕 Empty database detected - running full initialization');
      
      // Run initial setup files for fresh installation
      for (const sqlFile of INITIAL_SETUP_FILES) {
        console.log(`Executing initial setup: ${sqlFile}`);
        await executeFileStatements(ClusterArn, SecretArn, DatabaseName, sqlFile);
      }
    } else {
      console.log('✅ Existing database detected - skipping initial setup files');
      console.log('⚠️  ONLY migration files will be processed');
    }

    // ALWAYS run migrations (they should be idempotent and safe)
    console.log('🔄 Processing migrations...');
    
    // Ensure migration tracking table exists
    await ensureMigrationTable(ClusterArn, SecretArn, DatabaseName);
    
    // Run each migration that hasn't been run yet
    for (const migrationFile of MIGRATION_FILES) {
      const hasRun = await checkMigrationRun(ClusterArn, SecretArn, DatabaseName, migrationFile);
      
      if (!hasRun) {
        console.log(`▶️  Running migration: ${migrationFile}`);
        const startTime = Date.now();
        
        try {
          await executeFileStatements(ClusterArn, SecretArn, DatabaseName, migrationFile);
          
          // Record successful migration
          await recordMigration(ClusterArn, SecretArn, DatabaseName, migrationFile, true, Date.now() - startTime);
          console.log(`✅ Migration ${migrationFile} completed successfully`);
          
        } catch (error: any) {
          // Record failed migration
          await recordMigration(ClusterArn, SecretArn, DatabaseName, migrationFile, false, Date.now() - startTime, error.message);
          throw new Error(`Migration ${migrationFile} failed: ${error.message}`);
        }
      } else {
        console.log(`⏭️  Skipping migration ${migrationFile} - already run`);
      }
    }

    return {
      PhysicalResourceId: 'db-init',
      Status: 'SUCCESS',
      Reason: 'Database initialization/migration completed successfully'
    };

  } catch (error) {
    console.error('❌ Database operation failed:', error);
    return {
      PhysicalResourceId: 'db-init',
      Status: 'FAILED',
      Reason: `Database operation failed: ${error}`
    };
  }
}

/**
 * Check if database is empty (fresh installation)
 * Returns true if no core tables exist, false if database has been initialized
 */
async function checkIfDatabaseEmpty(
  clusterArn: string,
  secretArn: string,
  database: string
): Promise<boolean> {
  try {
    // Check if users table exists (core table that should always exist)
    const result = await executeSql(
      clusterArn,
      secretArn,
      database,
      `SELECT COUNT(*) FROM information_schema.tables 
       WHERE table_schema = 'public' 
       AND table_name = 'users'`
    );
    
    const count = result.records?.[0]?.[0]?.longValue || 0;
    return count === 0;
  } catch (error) {
    // If we can't check, assume empty for safety
    console.log('Could not check if database is empty, assuming fresh install');
    return true;
  }
}

/**
 * Ensure migration tracking table exists
 * This table tracks which migrations have been run
 */
async function ensureMigrationTable(
  clusterArn: string,
  secretArn: string,
  database: string
): Promise<void> {
  // This exactly matches the existing migration_log structure from June 2025 database
  const sql = `
    CREATE TABLE IF NOT EXISTS migration_log (
      id SERIAL PRIMARY KEY,
      step_number INTEGER NOT NULL,
      description TEXT NOT NULL,
      sql_executed TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      error_message TEXT,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  
  await executeSql(clusterArn, secretArn, database, sql);
}

/**
 * Check if a specific migration has already been run
 *
 * Security Note: String concatenation is safe here because migrationFile
 * comes from the hardcoded MIGRATION_FILES array, not user input.
 */
async function checkMigrationRun(
  clusterArn: string,
  secretArn: string,
  database: string,
  migrationFile: string
): Promise<boolean> {
  try {
    const result = await executeSql(
      clusterArn,
      secretArn,
      database,
      `SELECT COUNT(*) FROM migration_log
       WHERE description = '${migrationFile}'
       AND status = 'completed'`
    );

    const count = result.records?.[0]?.[0]?.longValue || 0;
    return count > 0;
  } catch (error) {
    // If we can't check, assume not run
    return false;
  }
}

/**
 * Record a migration execution (success or failure)
 *
 * Security Note: String concatenation is safe here because:
 * - migrationFile comes from hardcoded MIGRATION_FILES array
 * - errorMessage is from caught exceptions, not user input
 * - Lambda has no external input vectors
 */
async function recordMigration(
  clusterArn: string,
  secretArn: string,
  database: string,
  migrationFile: string,
  success: boolean,
  executionTime: number,
  errorMessage?: string
): Promise<void> {
  const maxStepResult = await executeSql(
    clusterArn,
    secretArn,
    database,
    `SELECT COALESCE(MAX(step_number), 0) + 1 as next_step FROM migration_log`
  );

  const nextStep = maxStepResult.records?.[0]?.[0]?.longValue || 1;
  const status = success ? 'completed' : 'failed';

  await executeSql(
    clusterArn,
    secretArn,
    database,
    `INSERT INTO migration_log (step_number, description, sql_executed, status${errorMessage ? ', error_message' : ''})
     VALUES (${nextStep}, '${migrationFile}', 'Migration file executed', '${status}'${errorMessage ? `, '${errorMessage.replace(/'/g, "''")}'` : ''})`
  );
}

/**
 * Execute all statements in a SQL file
 */
async function executeFileStatements(
  clusterArn: string,
  secretArn: string,
  database: string,
  filename: string
): Promise<void> {
  const sql = await getSqlContent(filename);
  const statements = splitSqlStatements(sql);
  
  for (const statement of statements) {
    if (statement.trim()) {
      try {
        await executeSql(clusterArn, secretArn, database, statement);
      } catch (error: any) {
        // For initial setup files, we might want to continue on "already exists" errors
        // For migrations, we should fail fast
        if (INITIAL_SETUP_FILES.includes(filename) && 
            (error.message?.includes('already exists') || 
             error.message?.includes('duplicate key'))) {
          console.log(`⚠️  Skipping (already exists): ${error.message}`);
        } else if (MIGRATION_FILES.includes(filename)) {
          // For migration files, check if it's an ALTER TABLE that actually succeeded
          // RDS Data API sometimes returns an error-like response for successful ALTER TABLEs
          const isAlterTable = statement.trim().toUpperCase().startsWith('ALTER TABLE');
          
          if (isAlterTable) {
            // Verify if the ALTER actually succeeded by checking the table structure
            console.log(`⚠️  ALTER TABLE may have succeeded despite error response. Verifying...`);
            
            // Extract table name and column from ALTER statement
            const alterMatch = statement.match(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
            
            if (alterMatch) {
              const tableName = alterMatch[1];
              const columnName = alterMatch[3];
              
              try {
                // Check if the column exists
                const checkResult = await executeSql(
                  clusterArn,
                  secretArn,
                  database,
                  `SELECT column_name FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = '${tableName}' 
                   AND column_name = '${columnName}'`
                );
                
                if (checkResult.records && checkResult.records.length > 0) {
                  console.log(`✅ Column ${columnName} exists in table ${tableName} - ALTER succeeded`);
                  // Column exists, so the ALTER worked - continue
                  continue;
                }
              } catch (checkError) {
                console.log(`Could not verify column existence: ${checkError}`);
              }
            }
          }
          
          // If we couldn't verify success, throw the original error
          throw error;
        } else {
          throw error;
        }
      }
    }
  }
}

async function executeSql(
  clusterArn: string,
  secretArn: string,
  database: string,
  sql: string
): Promise<any> {
  const command = new ExecuteStatementCommand({
    resourceArn: clusterArn,
    secretArn: secretArn,
    database: database,
    sql: sql,
    includeResultMetadata: true
  });

  try {
    const response = await rdsClient.send(command);
    return response;
  } catch (error: any) {
    // Log the full error for debugging
    console.error(`SQL execution error for statement: ${sql.substring(0, 100)}...`);
    console.error(`Error details:`, JSON.stringify(error, null, 2));
    
    // Check if this is a false-positive error for ALTER TABLE
    // RDS Data API sometimes returns errors for successful DDL operations
    if (sql.trim().toUpperCase().startsWith('ALTER TABLE') && 
        error.message && 
        (error.message.includes('Database returned SQL exception') || 
         error.message.includes('BadRequestException'))) {
      console.log(`⚠️  Potential false-positive error for ALTER TABLE - will verify in caller`);
    }
    
    throw error;
  }
}

function splitSqlStatements(sql: string): string[] {
  // Remove comments
  const withoutComments = sql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');

  // Split by semicolon but handle CREATE TYPE/FUNCTION blocks specially
  const statements: string[] = [];
  let currentStatement = '';
  let inBlock = false;
  
  const lines = withoutComments.split('\n');
  
  for (const line of lines) {
    const trimmedLine = line.trim().toUpperCase();
    
    // Check if we're entering a block (CREATE TYPE, CREATE FUNCTION, etc.)
    if (trimmedLine.startsWith('CREATE TYPE') || 
        trimmedLine.startsWith('CREATE FUNCTION') ||
        trimmedLine.startsWith('CREATE OR REPLACE FUNCTION') ||
        trimmedLine.startsWith('DROP TYPE')) {
      inBlock = true;
    }
    
    currentStatement += line + '\n';
    
    // Check if this line ends with a semicolon
    if (line.trim().endsWith(';')) {
      // If we're in a block, check if this is the end
      if (inBlock && (trimmedLine === ');' || trimmedLine.endsWith(');') || trimmedLine.endsWith("' LANGUAGE PLPGSQL;"))) {
        inBlock = false;
      }
      
      // If not in a block, this statement is complete
      if (!inBlock) {
        statements.push(currentStatement.trim());
        currentStatement = '';
      }
    }
  }
  
  // Add any remaining statement
  if (currentStatement.trim()) {
    statements.push(currentStatement.trim());
  }
  
  return statements;
}

// Load SQL content from bundled schema files
async function getSqlContent(filename: string): Promise<string> {
  const fs = require('fs').promises;
  const path = require('path');
  
  try {
    // Schema files are copied to the Lambda deployment package
    const schemaPath = path.join(__dirname, 'schema', filename);
    const content = await fs.readFile(schemaPath, 'utf8');
    return content;
  } catch (error) {
    console.error(`Failed to read SQL file ${filename}:`, error);
    throw new Error(`Could not load SQL file: ${filename}`);
  }
}

