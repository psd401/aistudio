"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = handler;
/**
 * Database Initialization Handler - Version 2026-01-07-10:00
 * Updated to import migrations from single source of truth (migrations.json)
 */
const client_rds_data_1 = require("@aws-sdk/client-rds-data");
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
// migrations.json is copied to the Lambda package root during bundling
// Using require for runtime resolution (file doesn't exist in source, only in Lambda package)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migrationsConfig = require('./migrations.json');
const rdsClient = new client_rds_data_1.RDSDataClient({});
const secretsClient = new client_secrets_manager_1.SecretsManagerClient({});
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
// Import migration lists from single source of truth
// See /infra/database/migrations.json for the complete list
// ADD NEW MIGRATIONS to migrations.json - they will run once and be tracked
const MIGRATION_FILES = migrationsConfig.migrationFiles;
// Initial setup files (only run on empty database)
// WARNING: These must EXACTLY match existing database structure!
const INITIAL_SETUP_FILES = migrationsConfig.initialSetupFiles;
async function handler(event) {
    console.log('Database initialization event:', JSON.stringify(event, null, 2));
    console.log('Handler version: 2026-02-18-v15 - Add nexus MCP user tokens migration 058');
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
        }
        else {
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
                }
                catch (error) {
                    // Record failed migration
                    await recordMigration(ClusterArn, SecretArn, DatabaseName, migrationFile, false, Date.now() - startTime, error.message);
                    throw new Error(`Migration ${migrationFile} failed: ${error.message}`);
                }
            }
            else {
                console.log(`⏭️  Skipping migration ${migrationFile} - already run`);
            }
        }
        return {
            PhysicalResourceId: 'db-init',
            Status: 'SUCCESS',
            Reason: 'Database initialization/migration completed successfully'
        };
    }
    catch (error) {
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
async function checkIfDatabaseEmpty(clusterArn, secretArn, database) {
    try {
        // Check if users table exists (core table that should always exist)
        const result = await executeSql(clusterArn, secretArn, database, `SELECT COUNT(*) FROM information_schema.tables 
       WHERE table_schema = 'public' 
       AND table_name = 'users'`);
        const count = result.records?.[0]?.[0]?.longValue || 0;
        return count === 0;
    }
    catch (error) {
        // If we can't check, assume empty for safety
        console.log('Could not check if database is empty, assuming fresh install');
        return true;
    }
}
/**
 * Ensure migration tracking table exists
 * This table tracks which migrations have been run
 */
async function ensureMigrationTable(clusterArn, secretArn, database) {
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
async function checkMigrationRun(clusterArn, secretArn, database, migrationFile) {
    try {
        const result = await executeSql(clusterArn, secretArn, database, `SELECT COUNT(*) FROM migration_log
       WHERE description = '${migrationFile}'
       AND status = 'completed'`);
        const count = result.records?.[0]?.[0]?.longValue || 0;
        return count > 0;
    }
    catch (error) {
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
async function recordMigration(clusterArn, secretArn, database, migrationFile, success, executionTime, errorMessage) {
    const maxStepResult = await executeSql(clusterArn, secretArn, database, `SELECT COALESCE(MAX(step_number), 0) + 1 as next_step FROM migration_log`);
    const nextStep = maxStepResult.records?.[0]?.[0]?.longValue || 1;
    const status = success ? 'completed' : 'failed';
    await executeSql(clusterArn, secretArn, database, `INSERT INTO migration_log (step_number, description, sql_executed, status${errorMessage ? ', error_message' : ''})
     VALUES (${nextStep}, '${migrationFile}', 'Migration file executed', '${status}'${errorMessage ? `, '${errorMessage.replace(/'/g, "''")}'` : ''})`);
}
/**
 * Validate SQL statements for RDS Data API incompatibilities
 *
 * Detects patterns that cannot run properly through RDS Data API:
 * - CREATE INDEX CONCURRENTLY (requires autocommit, multi-transaction)
 * - DROP INDEX CONCURRENTLY
 * - REINDEX CONCURRENTLY
 *
 * @throws Error if incompatible pattern detected
 */
function validateStatements(statements, filename) {
    for (const statement of statements) {
        // Check for CONCURRENTLY keyword (incompatible with RDS Data API)
        if (/\bCONCURRENTLY\b/i.test(statement)) {
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('❌ RDS Data API Incompatibility Detected');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error(`File: ${filename}`);
            console.error(`Statement: ${statement.substring(0, 150)}...`);
            console.error('');
            console.error('ISSUE: CONCURRENTLY operations cannot run through RDS Data API');
            console.error('REASON: CONCURRENTLY requires autocommit mode and uses multiple');
            console.error('        internal transactions, which is incompatible with Data API');
            console.error('');
            console.error('SOLUTION: Remove CONCURRENTLY keyword from the statement:');
            console.error('  - Use: CREATE INDEX IF NOT EXISTS idx_name ON table (column);');
            console.error('  - This will briefly lock writes but works with Data API');
            console.error('');
            console.error('FOR ZERO-DOWNTIME INDEX CREATION:');
            console.error('  - Use psql directly during maintenance window');
            console.error('  - Consider a separate maintenance script outside Lambda');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            throw new Error(`Migration ${filename} contains CONCURRENTLY keyword which is incompatible ` +
                `with RDS Data API. Use 'CREATE INDEX IF NOT EXISTS' instead. ` +
                `For zero-downtime index creation on large tables, use psql directly.`);
        }
    }
}
/**
 * Execute all statements in a SQL file
 */
async function executeFileStatements(clusterArn, secretArn, database, filename) {
    const sql = await getSqlContent(filename);
    const statements = splitSqlStatements(sql);
    // Validate statements before execution - detect incompatible patterns
    validateStatements(statements, filename);
    for (const statement of statements) {
        if (statement.trim()) {
            try {
                await executeSql(clusterArn, secretArn, database, statement);
            }
            catch (error) {
                // For initial setup files, we might want to continue on "already exists" errors
                // For migrations, we should fail fast
                if (INITIAL_SETUP_FILES.includes(filename) &&
                    (error.message?.includes('already exists') ||
                        error.message?.includes('duplicate key'))) {
                    console.log(`⚠️  Skipping (already exists): ${error.message}`);
                }
                else if (MIGRATION_FILES.includes(filename)) {
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
                                const checkResult = await executeSql(clusterArn, secretArn, database, `SELECT column_name FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = '${tableName}' 
                   AND column_name = '${columnName}'`);
                                if (checkResult.records && checkResult.records.length > 0) {
                                    console.log(`✅ Column ${columnName} exists in table ${tableName} - ALTER succeeded`);
                                    // Column exists, so the ALTER worked - continue
                                    continue;
                                }
                            }
                            catch (checkError) {
                                console.log(`Could not verify column existence: ${checkError}`);
                            }
                        }
                    }
                    // If we couldn't verify success, throw the original error
                    throw error;
                }
                else {
                    throw error;
                }
            }
        }
    }
}
async function executeSql(clusterArn, secretArn, database, sql) {
    const command = new client_rds_data_1.ExecuteStatementCommand({
        resourceArn: clusterArn,
        secretArn: secretArn,
        database: database,
        sql: sql,
        includeResultMetadata: true
    });
    try {
        const response = await rdsClient.send(command);
        return response;
    }
    catch (error) {
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
function splitSqlStatements(sql) {
    // Remove comments
    const withoutComments = sql
        .split('\n')
        .filter(line => !line.trim().startsWith('--'))
        .join('\n');
    // Split by semicolon but handle CREATE TYPE/FUNCTION blocks specially
    const statements = [];
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
async function getSqlContent(filename) {
    const fs = require('fs').promises;
    const path = require('path');
    try {
        // Schema files are copied to the Lambda deployment package
        const schemaPath = path.join(__dirname, 'schema', filename);
        const content = await fs.readFile(schemaPath, 'utf8');
        return content;
    }
    catch (error) {
        console.error(`Failed to read SQL file ${filename}:`, error);
        throw new Error(`Could not load SQL file: ${filename}`);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGItaW5pdC1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZGItaW5pdC1oYW5kbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBb0RBLDBCQWdGQztBQXBJRDs7O0dBR0c7QUFDSCw4REFBa0Y7QUFDbEYsNEVBQThGO0FBQzlGLHVFQUF1RTtBQUN2RSw4RkFBOEY7QUFDOUYsaUVBQWlFO0FBQ2pFLE1BQU0sZ0JBQWdCLEdBQUcsT0FBTyxDQUFDLG1CQUFtQixDQUtuRCxDQUFDO0FBRUYsTUFBTSxTQUFTLEdBQUcsSUFBSSwrQkFBYSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3hDLE1BQU0sYUFBYSxHQUFHLElBQUksNkNBQW9CLENBQUMsRUFBRSxDQUFDLENBQUM7QUFhbkQ7Ozs7Ozs7Ozs7O0dBV0c7QUFFSCxxREFBcUQ7QUFDckQsNERBQTREO0FBQzVELDRFQUE0RTtBQUM1RSxNQUFNLGVBQWUsR0FBRyxnQkFBZ0IsQ0FBQyxjQUFjLENBQUM7QUFFeEQsbURBQW1EO0FBQ25ELGlFQUFpRTtBQUNqRSxNQUFNLG1CQUFtQixHQUFHLGdCQUFnQixDQUFDLGlCQUFpQixDQUFDO0FBRXhELEtBQUssVUFBVSxPQUFPLENBQUMsS0FBMEI7SUFDdEQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQ0FBZ0MsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM5RSxPQUFPLENBQUMsR0FBRyxDQUFDLDJFQUEyRSxDQUFDLENBQUM7SUFFekYsdUNBQXVDO0lBQ3ZDLE9BQU8sQ0FBQyxHQUFHLENBQUMsMENBQTBDLENBQUMsQ0FBQztJQUV4RCwrQkFBK0I7SUFDL0IsSUFBSSxLQUFLLENBQUMsV0FBVyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQ25DLE9BQU87WUFDTCxrQkFBa0IsRUFBRSxLQUFLLENBQUMsa0JBQWtCLElBQUksU0FBUztZQUN6RCxNQUFNLEVBQUUsU0FBUztZ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QUMsS0FBSyxDQUFDLDJCQUEyQixRQUFRLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUM3RCxNQUFNLElBQUksS0FBSyxDQUFDLDRCQUE0QixRQUFRLEVBQUUsQ0FBQyxDQUFDO0lBQzFELENBQUM7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEYXRhYmFzZSBJbml0aWFsaXphdGlvbiBIYW5kbGVyIC0gVmVyc2lvbiAyMDI2LTAxLTA3LTEwOjAwXG4gKiBVcGRhdGVkIHRvIGltcG9ydCBtaWdyYXRpb25zIGZyb20gc2luZ2xlIHNvdXJjZSBvZiB0cnV0aCAobWlncmF0aW9ucy5qc29uKVxuICovXG5pbXBvcnQgeyBSRFNEYXRhQ2xpZW50LCBFeGVjdXRlU3RhdGVtZW50Q29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1yZHMtZGF0YSc7XG5pbXBvcnQgeyBHZXRTZWNyZXRWYWx1ZUNvbW1hbmQsIFNlY3JldHNNYW5hZ2VyQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXNlY3JldHMtbWFuYWdlcic7XG4vLyBtaWdyYXRpb25zLmpzb24gaXMgY29waWVkIHRvIHRoZSBMYW1iZGEgcGFja2FnZSByb290IGR1cmluZyBidW5kbGluZ1xuLy8gVXNpbmcgcmVxdWlyZSBmb3IgcnVudGltZSByZXNvbHV0aW9uIChmaWxlIGRvZXNuJ3QgZXhpc3QgaW4gc291cmNlLCBvbmx5IGluIExhbWJkYSBwYWNrYWdlKVxuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHNcbmNvbnN0IG1pZ3JhdGlvbnNDb25maWcgPSByZXF1aXJlKCcuL21pZ3JhdGlvbnMuanNvbicpIGFzIHtcbiAgZGVzY3JpcHRpb246IHN0cmluZztcbiAgc2NoZW1hRGlyOiBzdHJpbmc7XG4gIGluaXRpYWxTZXR1cEZpbGVzOiBzdHJpbmdbXTtcbiAgbWlncmF0aW9uRmlsZXM6IHN0cmluZ1tdO1xufTtcblxuY29uc3QgcmRzQ2xpZW50ID0gbmV3IFJEU0RhdGFDbGllbnQoe30pO1xuY29uc3Qgc2VjcmV0c0NsaWVudCA9IG5ldyBTZWNyZXRzTWFuYWdlckNsaWVudCh7fSk7XG5cbmludGVyZmFjZSBDdXN0b21SZXNvdXJjZUV2ZW50IHtcbiAgUmVxdWVzdFR5cGU6ICdDcmVhdGUnIHwgJ1VwZGF0ZScgfCAnRGVsZXRlJztcbiAgUmVzb3VyY2VQcm9wZXJ0aWVzOiB7XG4gICAgQ2x1c3RlckFybjogc3RyaW5nO1xuICAgIFNlY3JldEFybjogc3RyaW5nO1xuICAgIERhdGFiYXNlTmFtZTogc3RyaW5nO1xuICAgIEVudmlyb25tZW50OiBzdHJpbmc7XG4gIH07XG4gIFBoeXNpY2FsUmVzb3VyY2VJZD86IHN0cmluZztcbn1cblxuLyoqXG4gKiBDUklUSUNBTDogRGF0YWJhc2UgSW5pdGlhbGl6YXRpb24gYW5kIE1pZ3JhdGlvbiBIYW5kbGVyXG4gKiBcbiAqIFRoaXMgTGFtYmRhIGhhbmRsZXMgVFdPIGRpc3RpbmN0IHNjZW5hcmlvczpcbiAqIDEuIEZyZXNoIEluc3RhbGxhdGlvbjogUnVucyBhbGwgaW5pdGlhbCBzZXR1cCBmaWxlcyAoMDAxLTAwNSlcbiAqIDIuIEV4aXN0aW5nIERhdGFiYXNlOiBPTkxZIHJ1bnMgbWlncmF0aW9uIGZpbGVzICgwMTArKVxuICogXG4gKiBXQVJOSU5HOiBUaGUgaW5pdGlhbCBzZXR1cCBmaWxlcyAoMDAxLTAwNSkgTVVTVCBleGFjdGx5IG1hdGNoIHRoZSBleGlzdGluZ1xuICogZGF0YWJhc2Ugc3RydWN0dXJlIG9yIHRoZXkgd2lsbCBjYXVzZSBkYXRhIGNvcnJ1cHRpb24hXG4gKiBcbiAqIEBzZWUgL2RvY3MvZGF0YWJhc2UtcmVzdG9yYXRpb24vREFUQUJBU0UtTUlHUkFUSU9OUy5tZCBmb3IgZnVsbCBkZXRhaWxzXG4gKi9cblxuLy8gSW1wb3J0IG1pZ3JhdGlvbiBsaXN0cyBmcm9tIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGhcbi8vIFNlZSAvaW5mcmEvZGF0YWJhc2UvbWlncmF0aW9ucy5qc29uIGZvciB0aGUgY29tcGxldGUgbGlzdFxuLy8gQUREIE5FVyBNSUdSQVRJT05TIHRvIG1pZ3JhdGlvbnMuanNvbiAtIHRoZXkgd2lsbCBydW4gb25jZSBhbmQgYmUgdHJhY2tlZFxuY29uc3QgTUlHUkFUSU9OX0ZJTEVTID0gbWlncmF0aW9uc0NvbmZpZy5taWdyYXRpb25GaWxlcztcblxuLy8gSW5pdGlhbCBzZXR1cCBmaWxlcyAob25seSBydW4gb24gZW1wdHkgZGF0YWJhc2UpXG4vLyBXQVJOSU5HOiBUaGVzZSBtdXN0IEVYQUNUTFkgbWF0Y2ggZXhpc3RpbmcgZGF0YWJhc2Ugc3RydWN0dXJlIVxuY29uc3QgSU5JVElBTF9TRVRVUF9GSUxFUyA9IG1pZ3JhdGlvbnNDb25maWcuaW5pdGlhbFNldHVwRmlsZXM7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVyKGV2ZW50OiBDdXN0b21SZXNvdXJjZUV2ZW50KTogUHJvbWlzZTxhbnk+IHtcbiAgY29uc29sZS5sb2coJ0RhdGFiYXNlIGluaXRpYWxpemF0aW9uIGV2ZW50OicsIEpTT04uc3RyaW5naWZ5KGV2ZW50LCBudWxsLCAyKSk7XG4gIGNvbnNvbGUubG9nKCdIYW5kbGVyIHZlcnNpb246IDIwMjYtMDItMTgtdjE1IC0gQWRkIG5leHVzIE1DUCB1c2VyIHRva2VucyBtaWdyYXRpb24gMDU4Jyk7XG4gIFxuICAvLyBTQUZFVFkgQ0hFQ0s6IExvZyB3aGF0IG1vZGUgd2UncmUgaW5cbiAgY29uc29sZS5sb2coYPCflI0gQ2hlY2tpbmcgZGF0YWJhc2Ugc3RhdGUgZm9yIHNhZmV0eS4uLmApO1xuXG4gIC8vIE9ubHkgcnVuIG9uIENyZWF0ZSBvciBVcGRhdGVcbiAgaWYgKGV2ZW50LlJlcXVlc3RUeXBlID09PSAnRGVsZXRlJykge1xuICAgIHJldHVybiB7XG4gICAgICBQaHlzaWNhbFJlc291cmNlSWQ6IGV2ZW50LlBoeXNpY2FsUmVzb3VyY2VJZCB8fCAnZGItaW5pdCcsXG4gICAgICBTdGF0dXM6ICdTVUNDRVNTJyxcbiAgICAgIFJlYXNvbjogJ0RlbGV0ZSBub3QgcmVxdWlyZWQgZm9yIGRhdGFiYXNlIGluaXRpYWxpemF0aW9uJ1xuICAgIH07XG4gIH1cblxuICBjb25zdCB7IENsdXN0ZXJBcm4sIFNlY3JldEFybiwgRGF0YWJhc2VOYW1lLCBFbnZpcm9ubWVudCB9ID0gZXZlbnQuUmVzb3VyY2VQcm9wZXJ0aWVzO1xuXG4gIHRyeSB7XG4gICAgLy8gQ1JJVElDQUw6IENoZWNrIGlmIHRoaXMgaXMgYSBmcmVzaCBkYXRhYmFzZSBvciBleGlzdGluZyBvbmVcbiAgICBjb25zdCBpc0RhdGFiYXNlRW1wdHkgPSBhd2FpdCBjaGVja0lmRGF0YWJhc2VFbXB0eShDbHVzdGVyQXJuLCBTZWNyZXRBcm4sIERhdGFiYXNlTmFtZSk7XG4gICAgXG4gICAgaWYgKGlzRGF0YWJhc2VFbXB0eSkge1xuICAgICAgY29uc29sZS5sb2coJ/CfhpUgRW1wdHkgZGF0YWJhc2UgZGV0ZWN0ZWQgLSBydW5uaW5nIGZ1bGwgaW5pdGlhbGl6YXRpb24nKTtcbiAgICAgIFxuICAgICAgLy8gUnVuIGluaXRpYWwgc2V0dXAgZmlsZXMgZm9yIGZyZXNoIGluc3RhbGxhdGlvblxuICAgICAgZm9yIChjb25zdCBzcWxGaWxlIG9mIElOSVRJQUxfU0VUVVBfRklMRVMpIHtcbiAgICAgICAgY29uc29sZS5sb2coYEV4ZWN1dGluZyBpbml0aWFsIHNldHVwOiAke3NxbEZpbGV9YCk7XG4gICAgICAgIGF3YWl0IGV4ZWN1dGVGaWxlU3RhdGVtZW50cyhDbHVzdGVyQXJuLCBTZWNyZXRBcm4sIERhdGFiYXNlTmFtZSwgc3FsRmlsZSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnNvbGUubG9nKCfinIUgRXhpc3RpbmcgZGF0YWJhc2UgZGV0ZWN0ZWQgLSBza2lwcGluZyBpbml0aWFsIHNldHVwIGZpbGVzJyk7XG4gICAgICBjb25zb2xlLmxvZygn4pqg77iPICBPTkxZIG1pZ3JhdGlvbiBmaWxlcyB3aWxsIGJlIHByb2Nlc3NlZCcpO1xuICAgIH1cblxuICAgIC8vIEFMV0FZUyBydW4gbWlncmF0aW9ucyAodGhleSBzaG91bGQgYmUgaWRlbXBvdGVudCBhbmQgc2FmZSlcbiAgICBjb25zb2xlLmxvZygn8J+UhCBQcm9jZXNzaW5nIG1pZ3JhdGlvbnMuLi4nKTtcbiAgICBcbiAgICAvLyBFbnN1cmUgbWlncmF0aW9uIHRyYWNraW5nIHRhYmxlIGV4aXN0c1xuICAgIGF3YWl0IGVuc3VyZU1pZ3JhdGlvblRhYmxlKENsdXN0ZXJBcm4sIFNlY3JldEFybiwgRGF0YWJhc2VOYW1lKTtcbiAgICBcbiAgICAvLyBSdW4gZWFjaCBtaWdyYXRpb24gdGhhdCBoYXNuJ3QgYmVlbiBydW4geWV0XG4gICAgZm9yIChjb25zdCBtaWdyYXRpb25GaWxlIG9mIE1JR1JBVElPTl9GSUxFUykge1xuICAgICAgY29uc3QgaGFzUnVuID0gYXdhaXQgY2hlY2tNaWdyYXRpb25SdW4oQ2x1c3RlckFybiwgU2VjcmV0QXJuLCBEYXRhYmFzZU5hbWUsIG1pZ3JhdGlvbkZpbGUpO1xuICAgICAgXG4gICAgICBpZiAoIWhhc1J1bikge1xuICAgICAgICBjb25zb2xlLmxvZyhg4pa277iPICBSdW5uaW5nIG1pZ3JhdGlvbjogJHttaWdyYXRpb25GaWxlfWApO1xuICAgICAgICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuICAgICAgICBcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCBleGVjdXRlRmlsZVN0YXRlbWVudHMoQ2x1c3RlckFybiwgU2VjcmV0QXJuLCBEYXRhYmFzZU5hbWUsIG1pZ3JhdGlvbkZpbGUpO1xuICAgICAgICAgIFxuICAgICAgICAgIC8vIFJlY29yZCBzdWNjZXNzZnVsIG1pZ3JhdGlvblxuICAgICAgICAgIGF3YWl0IHJlY29yZE1pZ3JhdGlvbihDbHVzdGVyQXJuLCBTZWNyZXRBcm4sIERhdGFiYXNlTmFtZSwgbWlncmF0aW9uRmlsZSwgdHJ1ZSwgRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSk7XG4gICAgICAgICAgY29uc29sZS5sb2coYOKchSBNaWdyYXRpb24gJHttaWdyYXRpb25GaWxlfSBjb21wbGV0ZWQgc3VjY2Vzc2Z1bGx5YCk7XG4gICAgICAgICAgXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgICAgICAvLyBSZWNvcmQgZmFpbGVkIG1pZ3JhdGlvblxuICAgICAgICAgIGF3YWl0IHJlY29yZE1pZ3JhdGlvbihDbHVzdGVyQXJuLCBTZWNyZXRBcm4sIERhdGFiYXNlTmFtZSwgbWlncmF0aW9uRmlsZSwgZmFsc2UsIERhdGUubm93KCkgLSBzdGFydFRpbWUsIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgTWlncmF0aW9uICR7bWlncmF0aW9uRmlsZX0gZmFpbGVkOiAke2Vycm9yLm1lc3NhZ2V9YCk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGDij63vuI8gIFNraXBwaW5nIG1pZ3JhdGlvbiAke21pZ3JhdGlvbkZpbGV9IC0gYWxyZWFkeSBydW5gKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgUGh5c2ljYWxSZXNvdXJjZUlkOiAnZGItaW5pdCcsXG4gICAgICBTdGF0dXM6ICdTVUNDRVNTJyxcbiAgICAgIFJlYXNvbjogJ0RhdGFiYXNlIGluaXRpYWxpemF0aW9uL21pZ3JhdGlvbiBjb21wbGV0ZWQgc3VjY2Vzc2Z1bGx5J1xuICAgIH07XG5cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCfinYwgRGF0YWJhc2Ugb3BlcmF0aW9uIGZhaWxlZDonLCBlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIFBoeXNpY2FsUmVzb3VyY2VJZDogJ2RiLWluaXQnLFxuICAgICAgU3RhdHVzOiAnRkFJTEVEJyxcbiAgICAgIFJlYXNvbjogYERhdGFiYXNlIG9wZXJhdGlvbiBmYWlsZWQ6ICR7ZXJyb3J9YFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBDaGVjayBpZiBkYXRhYmFzZSBpcyBlbXB0eSAoZnJlc2ggaW5zdGFsbGF0aW9uKVxuICogUmV0dXJucyB0cnVlIGlmIG5vIGNvcmUgdGFibGVzIGV4aXN0LCBmYWxzZSBpZiBkYXRhYmFzZSBoYXMgYmVlbiBpbml0aWFsaXplZFxuICovXG5hc3luYyBmdW5jdGlvbiBjaGVja0lmRGF0YWJhc2VFbXB0eShcbiAgY2x1c3RlckFybjogc3RyaW5nLFxuICBzZWNyZXRBcm46IHN0cmluZyxcbiAgZGF0YWJhc2U6IHN0cmluZ1xuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgLy8gQ2hlY2sgaWYgdXNlcnMgdGFibGUgZXhpc3RzIChjb3JlIHRhYmxlIHRoYXQgc2hvdWxkIGFsd2F5cyBleGlzdClcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRlU3FsKFxuICAgICAgY2x1c3RlckFybixcbiAgICAgIHNlY3JldEFybixcbiAgICAgIGRhdGFiYXNlLFxuICAgICAgYFNFTEVDVCBDT1VOVCgqKSBGUk9NIGluZm9ybWF0aW9uX3NjaGVtYS50YWJsZXMgXG4gICAgICAgV0hFUkUgdGFibGVfc2NoZW1hID0gJ3B1YmxpYycgXG4gICAgICAgQU5EIHRhYmxlX25hbWUgPSAndXNlcnMnYFxuICAgICk7XG4gICAgXG4gICAgY29uc3QgY291bnQgPSByZXN1bHQucmVjb3Jkcz8uWzBdPy5bMF0/LmxvbmdWYWx1ZSB8fCAwO1xuICAgIHJldHVybiBjb3VudCA9PT0gMDtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBJZiB3ZSBjYW4ndCBjaGVjaywgYXNzdW1lIGVtcHR5IGZvciBzYWZldHlcbiAgICBjb25zb2xlLmxvZygnQ291bGQgbm90IGNoZWNrIGlmIGRhdGFiYXNlIGlzIGVtcHR5LCBhc3N1bWluZyBmcmVzaCBpbnN0YWxsJyk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuLyoqXG4gKiBFbnN1cmUgbWlncmF0aW9uIHRyYWNraW5nIHRhYmxlIGV4aXN0c1xuICogVGhpcyB0YWJsZSB0cmFja3Mgd2hpY2ggbWlncmF0aW9ucyBoYXZlIGJlZW4gcnVuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZU1pZ3JhdGlvblRhYmxlKFxuICBjbHVzdGVyQXJuOiBzdHJpbmcsXG4gIHNlY3JldEFybjogc3RyaW5nLFxuICBkYXRhYmFzZTogc3RyaW5nXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgLy8gVGhpcyBleGFjdGx5IG1hdGNoZXMgdGhlIGV4aXN0aW5nIG1pZ3JhdGlvbl9sb2cgc3RydWN0dXJlIGZyb20gSnVuZSAyMDI1IGRhdGFiYXNlXG4gIGNvbnN0IHNxbCA9IGBcbiAgICBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBtaWdyYXRpb25fbG9nIChcbiAgICAgIGlkIFNFUklBTCBQUklNQVJZIEtFWSxcbiAgICAgIHN0ZXBfbnVtYmVyIElOVEVHRVIgTk9UIE5VTEwsXG4gICAgICBkZXNjcmlwdGlvbiBURVhUIE5PVCBOVUxMLFxuICAgICAgc3FsX2V4ZWN1dGVkIFRFWFQsXG4gICAgICBzdGF0dXMgVkFSQ0hBUigyMCkgREVGQVVMVCAncGVuZGluZycsXG4gICAgICBlcnJvcl9tZXNzYWdlIFRFWFQsXG4gICAgICBleGVjdXRlZF9hdCBUSU1FU1RBTVAgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUFxuICAgIClcbiAgYDtcbiAgXG4gIGF3YWl0IGV4ZWN1dGVTcWwoY2x1c3RlckFybiwgc2VjcmV0QXJuLCBkYXRhYmFzZSwgc3FsKTtcbn1cblxuLyoqXG4gKiBDaGVjayBpZiBhIHNwZWNpZmljIG1pZ3JhdGlvbiBoYXMgYWxyZWFkeSBiZWVuIHJ1blxuICpcbiAqIFNlY3VyaXR5IE5vdGU6IFN0cmluZyBjb25jYXRlbmF0aW9uIGlzIHNhZmUgaGVyZSBiZWNhdXNlIG1pZ3JhdGlvbkZpbGVcbiAqIGNvbWVzIGZyb20gdGhlIGhhcmRjb2RlZCBNSUdSQVRJT05fRklMRVMgYXJyYXksIG5vdCB1c2VyIGlucHV0LlxuICovXG5hc3luYyBmdW5jdGlvbiBjaGVja01pZ3JhdGlvblJ1bihcbiAgY2x1c3RlckFybjogc3RyaW5nLFxuICBzZWNyZXRBcm46IHN0cmluZyxcbiAgZGF0YWJhc2U6IHN0cmluZyxcbiAgbWlncmF0aW9uRmlsZTogc3RyaW5nXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRlU3FsKFxuICAgICAgY2x1c3RlckFybixcbiAgICAgIHNlY3JldEFybixcbiAgICAgIGRhdGFiYXNlLFxuICAgICAgYFNFTEVDVCBDT1VOVCgqKSBGUk9NIG1pZ3JhdGlvbl9sb2dcbiAgICAgICBXSEVSRSBkZXNjcmlwdGlvbiA9ICcke21pZ3JhdGlvbkZpbGV9J1xuICAgICAgIEFORCBzdGF0dXMgPSAnY29tcGxldGVkJ2BcbiAgICApO1xuXG4gICAgY29uc3QgY291bnQgPSByZXN1bHQucmVjb3Jkcz8uWzBdPy5bMF0/LmxvbmdWYWx1ZSB8fCAwO1xuICAgIHJldHVybiBjb3VudCA+IDA7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgLy8gSWYgd2UgY2FuJ3QgY2hlY2ssIGFzc3VtZSBub3QgcnVuXG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogUmVjb3JkIGEgbWlncmF0aW9uIGV4ZWN1dGlvbiAoc3VjY2VzcyBvciBmYWlsdXJlKVxuICpcbiAqIFNlY3VyaXR5IE5vdGU6IFN0cmluZyBjb25jYXRlbmF0aW9uIGlzIHNhZmUgaGVyZSBiZWNhdXNlOlxuICogLSBtaWdyYXRpb25GaWxlIGNvbWVzIGZyb20gaGFyZGNvZGVkIE1JR1JBVElPTl9GSUxFUyBhcnJheVxuICogLSBlcnJvck1lc3NhZ2UgaXMgZnJvbSBjYXVnaHQgZXhjZXB0aW9ucywgbm90IHVzZXIgaW5wdXRcbiAqIC0gTGFtYmRhIGhhcyBubyBleHRlcm5hbCBpbnB1dCB2ZWN0b3JzXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlY29yZE1pZ3JhdGlvbihcbiAgY2x1c3RlckFybjogc3RyaW5nLFxuICBzZWNyZXRBcm46IHN0cmluZyxcbiAgZGF0YWJhc2U6IHN0cmluZyxcbiAgbWlncmF0aW9uRmlsZTogc3RyaW5nLFxuICBzdWNjZXNzOiBib29sZWFuLFxuICBleGVjdXRpb25UaW1lOiBudW1iZXIsXG4gIGVycm9yTWVzc2FnZT86IHN0cmluZ1xuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG1heFN0ZXBSZXN1bHQgPSBhd2FpdCBleGVjdXRlU3FsKFxuICAgIGNsdXN0ZXJBcm4sXG4gICAgc2VjcmV0QXJuLFxuICAgIGRhdGFiYXNlLFxuICAgIGBTRUxFQ1QgQ09BTEVTQ0UoTUFYKHN0ZXBfbnVtYmVyKSwgMCkgKyAxIGFzIG5leHRfc3RlcCBGUk9NIG1pZ3JhdGlvbl9sb2dgXG4gICk7XG5cbiAgY29uc3QgbmV4dFN0ZXAgPSBtYXhTdGVwUmVzdWx0LnJlY29yZHM/LlswXT8uWzBdPy5sb25nVmFsdWUgfHwgMTtcbiAgY29uc3Qgc3RhdHVzID0gc3VjY2VzcyA/ICdjb21wbGV0ZWQnIDogJ2ZhaWxlZCc7XG5cbiAgYXdhaXQgZXhlY3V0ZVNxbChcbiAgICBjbHVzdGVyQXJuLFxuICAgIHNlY3JldEFybixcbiAgICBkYXRhYmFzZSxcbiAgICBgSU5TRVJUIElOVE8gbWlncmF0aW9uX2xvZyAoc3RlcF9udW1iZXIsIGRlc2NyaXB0aW9uLCBzcWxfZXhlY3V0ZWQsIHN0YXR1cyR7ZXJyb3JNZXNzYWdlID8gJywgZXJyb3JfbWVzc2FnZScgOiAnJ30pXG4gICAgIFZBTFVFUyAoJHtuZXh0U3RlcH0sICcke21pZ3JhdGlvbkZpbGV9JywgJ01pZ3JhdGlvbiBmaWxlIGV4ZWN1dGVkJywgJyR7c3RhdHVzfScke2Vycm9yTWVzc2FnZSA/IGAsICcke2Vycm9yTWVzc2FnZS5yZXBsYWNlKC8nL2csIFwiJydcIil9J2AgOiAnJ30pYFxuICApO1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIFNRTCBzdGF0ZW1lbnRzIGZvciBSRFMgRGF0YSBBUEkgaW5jb21wYXRpYmlsaXRpZXNcbiAqXG4gKiBEZXRlY3RzIHBhdHRlcm5zIHRoYXQgY2Fubm90IHJ1biBwcm9wZXJseSB0aHJvdWdoIFJEUyBEYXRhIEFQSTpcbiAqIC0gQ1JFQVRFIElOREVYIENPTkNVUlJFTlRMWSAocmVxdWlyZXMgYXV0b2NvbW1pdCwgbXVsdGktdHJhbnNhY3Rpb24pXG4gKiAtIERST1AgSU5ERVggQ09OQ1VSUkVOVExZXG4gKiAtIFJFSU5ERVggQ09OQ1VSUkVOVExZXG4gKlxuICogQHRocm93cyBFcnJvciBpZiBpbmNvbXBhdGlibGUgcGF0dGVybiBkZXRlY3RlZFxuICovXG5mdW5jdGlvbiB2YWxpZGF0ZVN0YXRlbWVudHMoc3RhdGVtZW50czogc3RyaW5nW10sIGZpbGVuYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgZm9yIChjb25zdCBzdGF0ZW1lbnQgb2Ygc3RhdGVtZW50cykge1xuICAgIC8vIENoZWNrIGZvciBDT05DVVJSRU5UTFkga2V5d29yZCAoaW5jb21wYXRpYmxlIHdpdGggUkRTIERhdGEgQVBJKVxuICAgIGlmICgvXFxiQ09OQ1VSUkVOVExZXFxiL2kudGVzdChzdGF0ZW1lbnQpKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCfilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIEnKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ+KdjCBSRFMgRGF0YSBBUEkgSW5jb21wYXRpYmlsaXR5IERldGVjdGVkJyk7XG4gICAgICBjb25zb2xlLmVycm9yKCfilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIEnKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoYEZpbGU6ICR7ZmlsZW5hbWV9YCk7XG4gICAgICBjb25zb2xlLmVycm9yKGBTdGF0ZW1lbnQ6ICR7c3RhdGVtZW50LnN1YnN0cmluZygwLCAxNTApfS4uLmApO1xuICAgICAgY29uc29sZS5lcnJvcignJyk7XG4gICAgICBjb25zb2xlLmVycm9yKCdJU1NVRTogQ09OQ1VSUkVOVExZIG9wZXJhdGlvbnMgY2Fubm90IHJ1biB0aHJvdWdoIFJEUyBEYXRhIEFQSScpO1xuICAgICAgY29uc29sZS5lcnJvcignUkVBU09OOiBDT05DVVJSRU5UTFkgcmVxdWlyZXMgYXV0b2NvbW1pdCBtb2RlIGFuZCB1c2VzIG11bHRpcGxlJyk7XG4gICAgICBjb25zb2xlLmVycm9yKCcgICAgICAgIGludGVybmFsIHRyYW5zYWN0aW9ucywgd2hpY2ggaXMgaW5jb21wYXRpYmxlIHdpdGggRGF0YSBBUEknKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJycpO1xuICAgICAgY29uc29sZS5lcnJvcignU09MVVRJT046IFJlbW92ZSBDT05DVVJSRU5UTFkga2V5d29yZCBmcm9tIHRoZSBzdGF0ZW1lbnQ6Jyk7XG4gICAgICBjb25zb2xlLmVycm9yKCcgIC0gVXNlOiBDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyBpZHhfbmFtZSBPTiB0YWJsZSAoY29sdW1uKTsnKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJyAgLSBUaGlzIHdpbGwgYnJpZWZseSBsb2NrIHdyaXRlcyBidXQgd29ya3Mgd2l0aCBEYXRhIEFQSScpO1xuICAgICAgY29uc29sZS5lcnJvcignJyk7XG4gICAgICBjb25zb2xlLmVycm9yKCdGT1IgWkVSTy1ET1dOVElNRSBJTkRFWCBDUkVBVElPTjonKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJyAgLSBVc2UgcHNxbCBkaXJlY3RseSBkdXJpbmcgbWFpbnRlbmFuY2Ugd2luZG93Jyk7XG4gICAgICBjb25zb2xlLmVycm9yKCcgIC0gQ29uc2lkZXIgYSBzZXBhcmF0ZSBtYWludGVuYW5jZSBzY3JpcHQgb3V0c2lkZSBMYW1iZGEnKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ+KUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgScpO1xuXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBNaWdyYXRpb24gJHtmaWxlbmFtZX0gY29udGFpbnMgQ09OQ1VSUkVOVExZIGtleXdvcmQgd2hpY2ggaXMgaW5jb21wYXRpYmxlIGAgK1xuICAgICAgICBgd2l0aCBSRFMgRGF0YSBBUEkuIFVzZSAnQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMnIGluc3RlYWQuIGAgK1xuICAgICAgICBgRm9yIHplcm8tZG93bnRpbWUgaW5kZXggY3JlYXRpb24gb24gbGFyZ2UgdGFibGVzLCB1c2UgcHNxbCBkaXJlY3RseS5gXG4gICAgICApO1xuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIEV4ZWN1dGUgYWxsIHN0YXRlbWVudHMgaW4gYSBTUUwgZmlsZVxuICovXG5hc3luYyBmdW5jdGlvbiBleGVjdXRlRmlsZVN0YXRlbWVudHMoXG4gIGNsdXN0ZXJBcm46IHN0cmluZyxcbiAgc2VjcmV0QXJuOiBzdHJpbmcsXG4gIGRhdGFiYXNlOiBzdHJpbmcsXG4gIGZpbGVuYW1lOiBzdHJpbmdcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzcWwgPSBhd2FpdCBnZXRTcWxDb250ZW50KGZpbGVuYW1lKTtcbiAgY29uc3Qgc3RhdGVtZW50cyA9IHNwbGl0U3FsU3RhdGVtZW50cyhzcWwpO1xuXG4gIC8vIFZhbGlkYXRlIHN0YXRlbWVudHMgYmVmb3JlIGV4ZWN1dGlvbiAtIGRldGVjdCBpbmNvbXBhdGlibGUgcGF0dGVybnNcbiAgdmFsaWRhdGVTdGF0ZW1lbnRzKHN0YXRlbWVudHMsIGZpbGVuYW1lKTtcblxuICBmb3IgKGNvbnN0IHN0YXRlbWVudCBvZiBzdGF0ZW1lbnRzKSB7XG4gICAgaWYgKHN0YXRlbWVudC50cmltKCkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGV4ZWN1dGVTcWwoY2x1c3RlckFybiwgc2VjcmV0QXJuLCBkYXRhYmFzZSwgc3RhdGVtZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgICAgLy8gRm9yIGluaXRpYWwgc2V0dXAgZmlsZXMsIHdlIG1pZ2h0IHdhbnQgdG8gY29udGludWUgb24gXCJhbHJlYWR5IGV4aXN0c1wiIGVycm9yc1xuICAgICAgICAvLyBGb3IgbWlncmF0aW9ucywgd2Ugc2hvdWxkIGZhaWwgZmFzdFxuICAgICAgICBpZiAoSU5JVElBTF9TRVRVUF9GSUxFUy5pbmNsdWRlcyhmaWxlbmFtZSkgJiYgXG4gICAgICAgICAgICAoZXJyb3IubWVzc2FnZT8uaW5jbHVkZXMoJ2FscmVhZHkgZXhpc3RzJykgfHwgXG4gICAgICAgICAgICAgZXJyb3IubWVzc2FnZT8uaW5jbHVkZXMoJ2R1cGxpY2F0ZSBrZXknKSkpIHtcbiAgICAgICAgICBjb25zb2xlLmxvZyhg4pqg77iPICBTa2lwcGluZyAoYWxyZWFkeSBleGlzdHMpOiAke2Vycm9yLm1lc3NhZ2V9YCk7XG4gICAgICAgIH0gZWxzZSBpZiAoTUlHUkFUSU9OX0ZJTEVTLmluY2x1ZGVzKGZpbGVuYW1lKSkge1xuICAgICAgICAgIC8vIEZvciBtaWdyYXRpb24gZmlsZXMsIGNoZWNrIGlmIGl0J3MgYW4gQUxURVIgVEFCTEUgdGhhdCBhY3R1YWxseSBzdWNjZWVkZWRcbiAgICAgICAgICAvLyBSRFMgRGF0YSBBUEkgc29tZXRpbWVzIHJldHVybnMgYW4gZXJyb3ItbGlrZSByZXNwb25zZSBmb3Igc3VjY2Vzc2Z1bCBBTFRFUiBUQUJMRXNcbiAgICAgICAgICBjb25zdCBpc0FsdGVyVGFibGUgPSBzdGF0ZW1lbnQudHJpbSgpLnRvVXBwZXJDYXNlKCkuc3RhcnRzV2l0aCgnQUxURVIgVEFCTEUnKTtcbiAgICAgICAgICBcbiAgICAgICAgICBpZiAoaXNBbHRlclRhYmxlKSB7XG4gICAgICAgICAgICAvLyBWZXJpZnkgaWYgdGhlIEFMVEVSIGFjdHVhbGx5IHN1Y2NlZWRlZCBieSBjaGVja2luZyB0aGUgdGFibGUgc3RydWN0dXJlXG4gICAgICAgICAgICBjb25zb2xlLmxvZyhg4pqg77iPICBBTFRFUiBUQUJMRSBtYXkgaGF2ZSBzdWNjZWVkZWQgZGVzcGl0ZSBlcnJvciByZXNwb25zZS4gVmVyaWZ5aW5nLi4uYCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIEV4dHJhY3QgdGFibGUgbmFtZSBhbmQgY29sdW1uIGZyb20gQUxURVIgc3RhdGVtZW50XG4gICAgICAgICAgICBjb25zdCBhbHRlck1hdGNoID0gc3RhdGVtZW50Lm1hdGNoKC9BTFRFUlxccytUQUJMRVxccysoXFx3KylcXHMrQUREXFxzK0NPTFVNTlxccysoSUZcXHMrTk9UXFxzK0VYSVNUU1xccyspPyhcXHcrKS9pKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGFsdGVyTWF0Y2gpIHtcbiAgICAgICAgICAgICAgY29uc3QgdGFibGVOYW1lID0gYWx0ZXJNYXRjaFsxXTtcbiAgICAgICAgICAgICAgY29uc3QgY29sdW1uTmFtZSA9IGFsdGVyTWF0Y2hbM107XG4gICAgICAgICAgICAgIFxuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIC8vIENoZWNrIGlmIHRoZSBjb2x1bW4gZXhpc3RzXG4gICAgICAgICAgICAgICAgY29uc3QgY2hlY2tSZXN1bHQgPSBhd2FpdCBleGVjdXRlU3FsKFxuICAgICAgICAgICAgICAgICAgY2x1c3RlckFybixcbiAgICAgICAgICAgICAgICAgIHNlY3JldEFybixcbiAgICAgICAgICAgICAgICAgIGRhdGFiYXNlLFxuICAgICAgICAgICAgICAgICAgYFNFTEVDVCBjb2x1bW5fbmFtZSBGUk9NIGluZm9ybWF0aW9uX3NjaGVtYS5jb2x1bW5zIFxuICAgICAgICAgICAgICAgICAgIFdIRVJFIHRhYmxlX3NjaGVtYSA9ICdwdWJsaWMnIFxuICAgICAgICAgICAgICAgICAgIEFORCB0YWJsZV9uYW1lID0gJyR7dGFibGVOYW1lfScgXG4gICAgICAgICAgICAgICAgICAgQU5EIGNvbHVtbl9uYW1lID0gJyR7Y29sdW1uTmFtZX0nYFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKGNoZWNrUmVzdWx0LnJlY29yZHMgJiYgY2hlY2tSZXN1bHQucmVjb3Jkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhg4pyFIENvbHVtbiAke2NvbHVtbk5hbWV9IGV4aXN0cyBpbiB0YWJsZSAke3RhYmxlTmFtZX0gLSBBTFRFUiBzdWNjZWVkZWRgKTtcbiAgICAgICAgICAgICAgICAgIC8vIENvbHVtbiBleGlzdHMsIHNvIHRoZSBBTFRFUiB3b3JrZWQgLSBjb250aW51ZVxuICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGNhdGNoIChjaGVja0Vycm9yKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYENvdWxkIG5vdCB2ZXJpZnkgY29sdW1uIGV4aXN0ZW5jZTogJHtjaGVja0Vycm9yfWApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIFxuICAgICAgICAgIC8vIElmIHdlIGNvdWxkbid0IHZlcmlmeSBzdWNjZXNzLCB0aHJvdyB0aGUgb3JpZ2luYWwgZXJyb3JcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBleGVjdXRlU3FsKFxuICBjbHVzdGVyQXJuOiBzdHJpbmcsXG4gIHNlY3JldEFybjogc3RyaW5nLFxuICBkYXRhYmFzZTogc3RyaW5nLFxuICBzcWw6IHN0cmluZ1xuKTogUHJvbWlzZTxhbnk+IHtcbiAgY29uc3QgY29tbWFuZCA9IG5ldyBFeGVjdXRlU3RhdGVtZW50Q29tbWFuZCh7XG4gICAgcmVzb3VyY2VBcm46IGNsdXN0ZXJBcm4sXG4gICAgc2VjcmV0QXJuOiBzZWNyZXRBcm4sXG4gICAgZGF0YWJhc2U6IGRhdGFiYXNlLFxuICAgIHNxbDogc3FsLFxuICAgIGluY2x1ZGVSZXN1bHRNZXRhZGF0YTogdHJ1ZVxuICB9KTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmRzQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgcmV0dXJuIHJlc3BvbnNlO1xuICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgLy8gTG9nIHRoZSBmdWxsIGVycm9yIGZvciBkZWJ1Z2dpbmdcbiAgICBjb25zb2xlLmVycm9yKGBTUUwgZXhlY3V0aW9uIGVycm9yIGZvciBzdGF0ZW1lbnQ6ICR7c3FsLnN1YnN0cmluZygwLCAxMDApfS4uLmApO1xuICAgIGNvbnNvbGUuZXJyb3IoYEVycm9yIGRldGFpbHM6YCwgSlNPTi5zdHJpbmdpZnkoZXJyb3IsIG51bGwsIDIpKTtcbiAgICBcbiAgICAvLyBDaGVjayBpZiB0aGlzIGlzIGEgZmFsc2UtcG9zaXRpdmUgZXJyb3IgZm9yIEFMVEVSIFRBQkxFXG4gICAgLy8gUkRTIERhdGEgQVBJIHNvbWV0aW1lcyByZXR1cm5zIGVycm9ycyBmb3Igc3VjY2Vzc2Z1bCBEREwgb3BlcmF0aW9uc1xuICAgIGlmIChzcWwudHJpbSgpLnRvVXBwZXJDYXNlKCkuc3RhcnRzV2l0aCgnQUxURVIgVEFCTEUnKSAmJiBcbiAgICAgICAgZXJyb3IubWVzc2FnZSAmJiBcbiAgICAgICAgKGVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoJ0RhdGFiYXNlIHJldHVybmVkIFNRTCBleGNlcHRpb24nKSB8fCBcbiAgICAgICAgIGVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoJ0JhZFJlcXVlc3RFeGNlcHRpb24nKSkpIHtcbiAgICAgIGNvbnNvbGUubG9nKGDimqDvuI8gIFBvdGVudGlhbCBmYWxzZS1wb3NpdGl2ZSBlcnJvciBmb3IgQUxURVIgVEFCTEUgLSB3aWxsIHZlcmlmeSBpbiBjYWxsZXJgKTtcbiAgICB9XG4gICAgXG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn1cblxuZnVuY3Rpb24gc3BsaXRTcWxTdGF0ZW1lbnRzKHNxbDogc3RyaW5nKTogc3RyaW5nW10ge1xuICAvLyBSZW1vdmUgY29tbWVudHNcbiAgY29uc3Qgd2l0aG91dENvbW1lbnRzID0gc3FsXG4gICAgLnNwbGl0KCdcXG4nKVxuICAgIC5maWx0ZXIobGluZSA9PiAhbGluZS50cmltKCkuc3RhcnRzV2l0aCgnLS0nKSlcbiAgICAuam9pbignXFxuJyk7XG5cbiAgLy8gU3BsaXQgYnkgc2VtaWNvbG9uIGJ1dCBoYW5kbGUgQ1JFQVRFIFRZUEUvRlVOQ1RJT04gYmxvY2tzIHNwZWNpYWxseVxuICBjb25zdCBzdGF0ZW1lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgY3VycmVudFN0YXRlbWVudCA9ICcnO1xuICBsZXQgaW5CbG9jayA9IGZhbHNlO1xuICBcbiAgY29uc3QgbGluZXMgPSB3aXRob3V0Q29tbWVudHMuc3BsaXQoJ1xcbicpO1xuICBcbiAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgY29uc3QgdHJpbW1lZExpbmUgPSBsaW5lLnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICAgIFxuICAgIC8vIENoZWNrIGlmIHdlJ3JlIGVudGVyaW5nIGEgYmxvY2sgKENSRUFURSBUWVBFLCBDUkVBVEUgRlVOQ1RJT04sIGV0Yy4pXG4gICAgaWYgKHRyaW1tZWRMaW5lLnN0YXJ0c1dpdGgoJ0NSRUFURSBUWVBFJykgfHwgXG4gICAgICAgIHRyaW1tZWRMaW5lLnN0YXJ0c1dpdGgoJ0NSRUFURSBGVU5DVElPTicpIHx8XG4gICAgICAgIHRyaW1tZWRMaW5lLnN0YXJ0c1dpdGgoJ0NSRUFURSBPUiBSRVBMQUNFIEZVTkNUSU9OJykgfHxcbiAgICAgICAgdHJpbW1lZExpbmUuc3RhcnRzV2l0aCgnRFJPUCBUWVBFJykpIHtcbiAgICAgIGluQmxvY2sgPSB0cnVlO1xuICAgIH1cbiAgICBcbiAgICBjdXJyZW50U3RhdGVtZW50ICs9IGxpbmUgKyAnXFxuJztcbiAgICBcbiAgICAvLyBDaGVjayBpZiB0aGlzIGxpbmUgZW5kcyB3aXRoIGEgc2VtaWNvbG9uXG4gICAgaWYgKGxpbmUudHJpbSgpLmVuZHNXaXRoKCc7JykpIHtcbiAgICAgIC8vIElmIHdlJ3JlIGluIGEgYmxvY2ssIGNoZWNrIGlmIHRoaXMgaXMgdGhlIGVuZFxuICAgICAgaWYgKGluQmxvY2sgJiYgKHRyaW1tZWRMaW5lID09PSAnKTsnIHx8IHRyaW1tZWRMaW5lLmVuZHNXaXRoKCcpOycpIHx8IHRyaW1tZWRMaW5lLmVuZHNXaXRoKFwiJyBMQU5HVUFHRSBQTFBHU1FMO1wiKSkpIHtcbiAgICAgICAgaW5CbG9jayA9IGZhbHNlO1xuICAgICAgfVxuICAgICAgXG4gICAgICAvLyBJZiBub3QgaW4gYSBibG9jaywgdGhpcyBzdGF0ZW1lbnQgaXMgY29tcGxldGVcbiAgICAgIGlmICghaW5CbG9jaykge1xuICAgICAgICBzdGF0ZW1lbnRzLnB1c2goY3VycmVudFN0YXRlbWVudC50cmltKCkpO1xuICAgICAgICBjdXJyZW50U3RhdGVtZW50ID0gJyc7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIFxuICAvLyBBZGQgYW55IHJlbWFpbmluZyBzdGF0ZW1lbnRcbiAgaWYgKGN1cnJlbnRTdGF0ZW1lbnQudHJpbSgpKSB7XG4gICAgc3RhdGVtZW50cy5wdXNoKGN1cnJlbnRTdGF0ZW1lbnQudHJpbSgpKTtcbiAgfVxuICBcbiAgcmV0dXJuIHN0YXRlbWVudHM7XG59XG5cbi8vIExvYWQgU1FMIGNvbnRlbnQgZnJvbSBidW5kbGVkIHNjaGVtYSBmaWxlc1xuYXN5bmMgZnVuY3Rpb24gZ2V0U3FsQ29udGVudChmaWxlbmFtZTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgZnMgPSByZXF1aXJlKCdmcycpLnByb21pc2VzO1xuICBjb25zdCBwYXRoID0gcmVxdWlyZSgncGF0aCcpO1xuICBcbiAgdHJ5IHtcbiAgICAvLyBTY2hlbWEgZmlsZXMgYXJlIGNvcGllZCB0byB0aGUgTGFtYmRhIGRlcGxveW1lbnQgcGFja2FnZVxuICAgIGNvbnN0IHNjaGVtYVBhdGggPSBwYXRoLmpvaW4oX19kaXJuYW1lLCAnc2NoZW1hJywgZmlsZW5hbWUpO1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBmcy5yZWFkRmlsZShzY2hlbWFQYXRoLCAndXRmOCcpO1xuICAgIHJldHVybiBjb250ZW50O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoYEZhaWxlZCB0byByZWFkIFNRTCBmaWxlICR7ZmlsZW5hbWV9OmAsIGVycm9yKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYENvdWxkIG5vdCBsb2FkIFNRTCBmaWxlOiAke2ZpbGVuYW1lfWApO1xuICB9XG59XG5cbiJdfQ==