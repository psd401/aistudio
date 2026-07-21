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
                    // CREATE TYPE … AS ENUM cannot be written `IF NOT EXISTS` (PostgreSQL
                    // has no such form) and the statement splitter cannot handle the
                    // DO $$ … $$ guard pattern (it closes the block on the inner `);`).
                    // So an enum CREATE TYPE is inherently non-idempotent: on a partial-
                    // failure re-run it raises "type … already exists" (SQLSTATE 42710),
                    // which would otherwise hit the throw below and permanently wedge the
                    // migration. Treat that specific case as already-applied, matching the
                    // idempotency the migration header promises. Scoped to CREATE TYPE so
                    // genuine "already exists" failures in other statements still surface.
                    const isCreateType = statement.trim().toUpperCase().startsWith('CREATE TYPE');
                    if (isCreateType && error.message?.includes('already exists')) {
                        console.log(`⚠️  Skipping (type already exists): ${error.message}`);
                        continue;
                    }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGItaW5pdC1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZGItaW5pdC1oYW5kbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBb0RBLDBCQWdGQztBQXBJRDs7O0dBR0c7QUFDSCw4REFBa0Y7QUFDbEYsNEVBQThGO0FBQzlGLHVFQUF1RTtBQUN2RSw4RkFBOEY7QUFDOUYsaUVBQWlFO0FBQ2pFLE1BQU0sZ0JBQWdCLEdBQUcsT0FBTyxDQUFDLG1CQUFtQixDQUtuRCxDQUFDO0FBRUYsTUFBTSxTQUFTLEdBQUcsSUFBSSwrQkFBYSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3hDLE1BQU0sYUFBYSxHQUFHLElBQUksNkNBQW9CLENBQUMsRUFBRSxDQUFDLENBQUM7QUFhbkQ7Ozs7Ozs7Ozs7O0dBV0c7QUFFSCxxREFBcUQ7QUFDckQsNERBQTREO0FBQzVELDRFQUE0RTtBQUM1RSxNQUFNLGVBQWUsR0FBRyxnQkFBZ0IsQ0FBQyxjQUFjLENBQUM7QUFFeEQsbURBQW1EO0FBQ25ELGlFQUFpRTtBQUNqRSxNQUFNLG1CQUFtQixHQUFHLGdCQUFnQixDQUFDLGlCQUFpQixDQUFDO0FBRXhELEtBQUssVUFBVSxPQUFPLENBQUMsS0FBMEI7SUFDdEQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQ0FBZ0MsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM5RSxPQUFPLENBQUMsR0FBRyxDQUFDLDJFQUEyRSxDQUFDLENBQUM7SUFFekYsdUNBQXVDO0lBQ3ZDLE9BQU8sQ0FBQyxHQUFHLENBQUMsMENBQTBDLENBQUMsQ0FBQztJQUV4RCwrQkFBK0I7SUFDL0IsSUFBSSxLQUFLLENBQUMsV0FBVyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQ25DLE9BQU87WUFDTCxrQkFBa0IsRUFBRSxLQUFLLENBQUMsa0JBQWtCLElBQUksU0FBUztZQUN6RCxNQUFNLEVBQUUsU0FBUztZ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LEtBQUssVUFBVSxhQUFhLENBQUMsUUFBZ0I7SUFDM0MsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLFFBQVEsQ0FBQztJQUNsQyxNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUM7SUFFN0IsSUFBSSxDQUFDO1FBQ0gsMkRBQTJEO1FBQzNELE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLFFBQVEsRUFBRSxRQUFRLENBQUMsQ0FBQztRQUM1RCxNQUFNLE9BQU8sR0FBRyxNQUFNLEVBQUUsQ0FBQyxRQUFRLENBQUMsVUFBVSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ3RELE9BQU8sT0FBTyxDQUFDO0lBQ2pCLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsT0FBTyxDQUFDLEtBQUssQ0FBQywyQkFBMkIsUUFBUSxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDN0QsTUFBTSxJQUFJLEtBQUssQ0FBQyw0QkFBNEIsUUFBUSxFQUFFLENBQUMsQ0FBQztJQUMxRCxDQUFDO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRGF0YWJhc2UgSW5pdGlhbGl6YXRpb24gSGFuZGxlciAtIFZlcnNpb24gMjAyNi0wMS0wNy0xMDowMFxuICogVXBkYXRlZCB0byBpbXBvcnQgbWlncmF0aW9ucyBmcm9tIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGggKG1pZ3JhdGlvbnMuanNvbilcbiAqL1xuaW1wb3J0IHsgUkRTRGF0YUNsaWVudCwgRXhlY3V0ZVN0YXRlbWVudENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtcmRzLWRhdGEnO1xuaW1wb3J0IHsgR2V0U2VjcmV0VmFsdWVDb21tYW5kLCBTZWNyZXRzTWFuYWdlckNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zZWNyZXRzLW1hbmFnZXInO1xuLy8gbWlncmF0aW9ucy5qc29uIGlzIGNvcGllZCB0byB0aGUgTGFtYmRhIHBhY2thZ2Ugcm9vdCBkdXJpbmcgYnVuZGxpbmdcbi8vIFVzaW5nIHJlcXVpcmUgZm9yIHJ1bnRpbWUgcmVzb2x1dGlvbiAoZmlsZSBkb2Vzbid0IGV4aXN0IGluIHNvdXJjZSwgb25seSBpbiBMYW1iZGEgcGFja2FnZSlcbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzXG5jb25zdCBtaWdyYXRpb25zQ29uZmlnID0gcmVxdWlyZSgnLi9taWdyYXRpb25zLmpzb24nKSBhcyB7XG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIHNjaGVtYURpcjogc3RyaW5nO1xuICBpbml0aWFsU2V0dXBGaWxlczogc3RyaW5nW107XG4gIG1pZ3JhdGlvbkZpbGVzOiBzdHJpbmdbXTtcbn07XG5cbmNvbnN0IHJkc0NsaWVudCA9IG5ldyBSRFNEYXRhQ2xpZW50KHt9KTtcbmNvbnN0IHNlY3JldHNDbGllbnQgPSBuZXcgU2VjcmV0c01hbmFnZXJDbGllbnQoe30pO1xuXG5pbnRlcmZhY2UgQ3VzdG9tUmVzb3VyY2VFdmVudCB7XG4gIFJlcXVlc3RUeXBlOiAnQ3JlYXRlJyB8ICdVcGRhdGUnIHwgJ0RlbGV0ZSc7XG4gIFJlc291cmNlUHJvcGVydGllczoge1xuICAgIENsdXN0ZXJBcm46IHN0cmluZztcbiAgICBTZWNyZXRBcm46IHN0cmluZztcbiAgICBEYXRhYmFzZU5hbWU6IHN0cmluZztcbiAgICBFbnZpcm9ubWVudDogc3RyaW5nO1xuICB9O1xuICBQaHlzaWNhbFJlc291cmNlSWQ/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogQ1JJVElDQUw6IERhdGFiYXNlIEluaXRpYWxpemF0aW9uIGFuZCBNaWdyYXRpb24gSGFuZGxlclxuICogXG4gKiBUaGlzIExhbWJkYSBoYW5kbGVzIFRXTyBkaXN0aW5jdCBzY2VuYXJpb3M6XG4gKiAxLiBGcmVzaCBJbnN0YWxsYXRpb246IFJ1bnMgYWxsIGluaXRpYWwgc2V0dXAgZmlsZXMgKDAwMS0wMDUpXG4gKiAyLiBFeGlzdGluZyBEYXRhYmFzZTogT05MWSBydW5zIG1pZ3JhdGlvbiBmaWxlcyAoMDEwKylcbiAqIFxuICogV0FSTklORzogVGhlIGluaXRpYWwgc2V0dXAgZmlsZXMgKDAwMS0wMDUpIE1VU1QgZXhhY3RseSBtYXRjaCB0aGUgZXhpc3RpbmdcbiAqIGRhdGFiYXNlIHN0cnVjdHVyZSBvciB0aGV5IHdpbGwgY2F1c2UgZGF0YSBjb3JydXB0aW9uIVxuICogXG4gKiBAc2VlIC9kb2NzL2RhdGFiYXNlLXJlc3RvcmF0aW9uL0RBVEFCQVNFLU1JR1JBVElPTlMubWQgZm9yIGZ1bGwgZGV0YWlsc1xuICovXG5cbi8vIEltcG9ydCBtaWdyYXRpb24gbGlzdHMgZnJvbSBzaW5nbGUgc291cmNlIG9mIHRydXRoXG4vLyBTZWUgL2luZnJhL2RhdGFiYXNlL21pZ3JhdGlvbnMuanNvbiBmb3IgdGhlIGNvbXBsZXRlIGxpc3Rcbi8vIEFERCBORVcgTUlHUkFUSU9OUyB0byBtaWdyYXRpb25zLmpzb24gLSB0aGV5IHdpbGwgcnVuIG9uY2UgYW5kIGJlIHRyYWNrZWRcbmNvbnN0IE1JR1JBVElPTl9GSUxFUyA9IG1pZ3JhdGlvbnNDb25maWcubWlncmF0aW9uRmlsZXM7XG5cbi8vIEluaXRpYWwgc2V0dXAgZmlsZXMgKG9ubHkgcnVuIG9uIGVtcHR5IGRhdGFiYXNlKVxuLy8gV0FSTklORzogVGhlc2UgbXVzdCBFWEFDVExZIG1hdGNoIGV4aXN0aW5nIGRhdGFiYXNlIHN0cnVjdHVyZSFcbmNvbnN0IElOSVRJQUxfU0VUVVBfRklMRVMgPSBtaWdyYXRpb25zQ29uZmlnLmluaXRpYWxTZXR1cEZpbGVzO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihldmVudDogQ3VzdG9tUmVzb3VyY2VFdmVudCk6IFByb21pc2U8YW55PiB7XG4gIGNvbnNvbGUubG9nKCdEYXRhYmFzZSBpbml0aWFsaXphdGlvbiBldmVudDonLCBKU09OLnN0cmluZ2lmeShldmVudCwgbnVsbCwgMikpO1xuICBjb25zb2xlLmxvZygnSGFuZGxlciB2ZXJzaW9uOiAyMDI2LTAyLTE4LXYxNSAtIEFkZCBuZXh1cyBNQ1AgdXNlciB0b2tlbnMgbWlncmF0aW9uIDA1OCcpO1xuICBcbiAgLy8gU0FGRVRZIENIRUNLOiBMb2cgd2hhdCBtb2RlIHdlJ3JlIGluXG4gIGNvbnNvbGUubG9nKGDwn5SNIENoZWNraW5nIGRhdGFiYXNlIHN0YXRlIGZvciBzYWZldHkuLi5gKTtcblxuICAvLyBPbmx5IHJ1biBvbiBDcmVhdGUgb3IgVXBkYXRlXG4gIGlmIChldmVudC5SZXF1ZXN0VHlwZSA9PT0gJ0RlbGV0ZScpIHtcbiAgICByZXR1cm4ge1xuICAgICAgUGh5c2ljYWxSZXNvdXJjZUlkOiBldmVudC5QaHlzaWNhbFJlc291cmNlSWQgfHwgJ2RiLWluaXQnLFxuICAgICAgU3RhdHVzOiAnU1VDQ0VTUycsXG4gICAgICBSZWFzb246ICdEZWxldGUgbm90IHJlcXVpcmVkIGZvciBkYXRhYmFzZSBpbml0aWFsaXphdGlvbidcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgeyBDbHVzdGVyQXJuLCBTZWNyZXRBcm4sIERhdGFiYXNlTmFtZSwgRW52aXJvbm1lbnQgfSA9IGV2ZW50LlJlc291cmNlUHJvcGVydGllcztcblxuICB0cnkge1xuICAgIC8vIENSSVRJQ0FMOiBDaGVjayBpZiB0aGlzIGlzIGEgZnJlc2ggZGF0YWJhc2Ugb3IgZXhpc3Rpbmcgb25lXG4gICAgY29uc3QgaXNEYXRhYmFzZUVtcHR5ID0gYXdhaXQgY2hlY2tJZkRhdGFiYXNlRW1wdHkoQ2x1c3RlckFybiwgU2VjcmV0QXJuLCBEYXRhYmFzZU5hbWUpO1xuICAgIFxuICAgIGlmIChpc0RhdGFiYXNlRW1wdHkpIHtcbiAgICAgIGNvbnNvbGUubG9nKCfwn4aVIEVtcHR5IGRhdGFiYXNlIGRldGVjdGVkIC0gcnVubmluZyBmdWxsIGluaXRpYWxpemF0aW9uJyk7XG4gICAgICBcbiAgICAgIC8vIFJ1biBpbml0aWFsIHNldHVwIGZpbGVzIGZvciBmcmVzaCBpbnN0YWxsYXRpb25cbiAgICAgIGZvciAoY29uc3Qgc3FsRmlsZSBvZiBJTklUSUFMX1NFVFVQX0ZJTEVTKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGBFeGVjdXRpbmcgaW5pdGlhbCBzZXR1cDogJHtzcWxGaWxlfWApO1xuICAgICAgICBhd2FpdCBleGVjdXRlRmlsZVN0YXRlbWVudHMoQ2x1c3RlckFybiwgU2VjcmV0QXJuLCBEYXRhYmFzZU5hbWUsIHNxbEZpbGUpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBjb25zb2xlLmxvZygn4pyFIEV4aXN0aW5nIGRhdGFiYXNlIGRldGVjdGVkIC0gc2tpcHBpbmcgaW5pdGlhbCBzZXR1cCBmaWxlcycpO1xuICAgICAgY29uc29sZS5sb2coJ+KaoO+4jyAgT05MWSBtaWdyYXRpb24gZmlsZXMgd2lsbCBiZSBwcm9jZXNzZWQnKTtcbiAgICB9XG5cbiAgICAvLyBBTFdBWVMgcnVuIG1pZ3JhdGlvbnMgKHRoZXkgc2hvdWxkIGJlIGlkZW1wb3RlbnQgYW5kIHNhZmUpXG4gICAgY29uc29sZS5sb2coJ/CflIQgUHJvY2Vzc2luZyBtaWdyYXRpb25zLi4uJyk7XG4gICAgXG4gICAgLy8gRW5zdXJlIG1pZ3JhdGlvbiB0cmFja2luZyB0YWJsZSBleGlzdHNcbiAgICBhd2FpdCBlbnN1cmVNaWdyYXRpb25UYWJsZShDbHVzdGVyQXJuLCBTZWNyZXRBcm4sIERhdGFiYXNlTmFtZSk7XG4gICAgXG4gICAgLy8gUnVuIGVhY2ggbWlncmF0aW9uIHRoYXQgaGFzbid0IGJlZW4gcnVuIHlldFxuICAgIGZvciAoY29uc3QgbWlncmF0aW9uRmlsZSBvZiBNSUdSQVRJT05fRklMRVMpIHtcbiAgICAgIGNvbnN0IGhhc1J1biA9IGF3YWl0IGNoZWNrTWlncmF0aW9uUnVuKENsdXN0ZXJBcm4sIFNlY3JldEFybiwgRGF0YWJhc2VOYW1lLCBtaWdyYXRpb25GaWxlKTtcbiAgICAgIFxuICAgICAgaWYgKCFoYXNSdW4pIHtcbiAgICAgICAgY29uc29sZS5sb2coYOKWtu+4jyAgUnVubmluZyBtaWdyYXRpb246ICR7bWlncmF0aW9uRmlsZX1gKTtcbiAgICAgICAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcbiAgICAgICAgXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgZXhlY3V0ZUZpbGVTdGF0ZW1lbnRzKENsdXN0ZXJBcm4sIFNlY3JldEFybiwgRGF0YWJhc2VOYW1lLCBtaWdyYXRpb25GaWxlKTtcbiAgICAgICAgICBcbiAgICAgICAgICAvLyBSZWNvcmQgc3VjY2Vzc2Z1bCBtaWdyYXRpb25cbiAgICAgICAgICBhd2FpdCByZWNvcmRNaWdyYXRpb24oQ2x1c3RlckFybiwgU2VjcmV0QXJuLCBEYXRhYmFzZU5hbWUsIG1pZ3JhdGlvbkZpbGUsIHRydWUsIERhdGUubm93KCkgLSBzdGFydFRpbWUpO1xuICAgICAgICAgIGNvbnNvbGUubG9nKGDinIUgTWlncmF0aW9uICR7bWlncmF0aW9uRmlsZX0gY29tcGxldGVkIHN1Y2Nlc3NmdWxseWApO1xuICAgICAgICAgIFxuICAgICAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICAgICAgLy8gUmVjb3JkIGZhaWxlZCBtaWdyYXRpb25cbiAgICAgICAgICBhd2FpdCByZWNvcmRNaWdyYXRpb24oQ2x1c3RlckFybiwgU2VjcmV0QXJuLCBEYXRhYmFzZU5hbWUsIG1pZ3JhdGlvbkZpbGUsIGZhbHNlLCBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLCBlcnJvci5tZXNzYWdlKTtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE1pZ3JhdGlvbiAke21pZ3JhdGlvbkZpbGV9IGZhaWxlZDogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZyhg4o+t77iPICBTa2lwcGluZyBtaWdyYXRpb24gJHttaWdyYXRpb25GaWxlfSAtIGFscmVhZHkgcnVuYCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIFBoeXNpY2FsUmVzb3VyY2VJZDogJ2RiLWluaXQnLFxuICAgICAgU3RhdHVzOiAnU1VDQ0VTUycsXG4gICAgICBSZWFzb246ICdEYXRhYmFzZSBpbml0aWFsaXphdGlvbi9taWdyYXRpb24gY29tcGxldGVkIHN1Y2Nlc3NmdWxseSdcbiAgICB9O1xuXG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcign4p2MIERhdGFiYXNlIG9wZXJhdGlvbiBmYWlsZWQ6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBQaHlzaWNhbFJlc291cmNlSWQ6ICdkYi1pbml0JyxcbiAgICAgIFN0YXR1czogJ0ZBSUxFRCcsXG4gICAgICBSZWFzb246IGBEYXRhYmFzZSBvcGVyYXRpb24gZmFpbGVkOiAke2Vycm9yfWBcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgZGF0YWJhc2UgaXMgZW1wdHkgKGZyZXNoIGluc3RhbGxhdGlvbilcbiAqIFJldHVybnMgdHJ1ZSBpZiBubyBjb3JlIHRhYmxlcyBleGlzdCwgZmFsc2UgaWYgZGF0YWJhc2UgaGFzIGJlZW4gaW5pdGlhbGl6ZWRcbiAqL1xuYXN5bmMgZnVuY3Rpb24gY2hlY2tJZkRhdGFiYXNlRW1wdHkoXG4gIGNsdXN0ZXJBcm46IHN0cmluZyxcbiAgc2VjcmV0QXJuOiBzdHJpbmcsXG4gIGRhdGFiYXNlOiBzdHJpbmdcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICB0cnkge1xuICAgIC8vIENoZWNrIGlmIHVzZXJzIHRhYmxlIGV4aXN0cyAoY29yZSB0YWJsZSB0aGF0IHNob3VsZCBhbHdheXMgZXhpc3QpXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZXhlY3V0ZVNxbChcbiAgICAgIGNsdXN0ZXJBcm4sXG4gICAgICBzZWNyZXRBcm4sXG4gICAgICBkYXRhYmFzZSxcbiAgICAgIGBTRUxFQ1QgQ09VTlQoKikgRlJPTSBpbmZvcm1hdGlvbl9zY2hlbWEudGFibGVzIFxuICAgICAgIFdIRVJFIHRhYmxlX3NjaGVtYSA9ICdwdWJsaWMnIFxuICAgICAgIEFORCB0YWJsZV9uYW1lID0gJ3VzZXJzJ2BcbiAgICApO1xuICAgIFxuICAgIGNvbnN0IGNvdW50ID0gcmVzdWx0LnJlY29yZHM/LlswXT8uWzBdPy5sb25nVmFsdWUgfHwgMDtcbiAgICByZXR1cm4gY291bnQgPT09IDA7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgLy8gSWYgd2UgY2FuJ3QgY2hlY2ssIGFzc3VtZSBlbXB0eSBmb3Igc2FmZXR5XG4gICAgY29uc29sZS5sb2coJ0NvdWxkIG5vdCBjaGVjayBpZiBkYXRhYmFzZSBpcyBlbXB0eSwgYXNzdW1pbmcgZnJlc2ggaW5zdGFsbCcpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5cbi8qKlxuICogRW5zdXJlIG1pZ3JhdGlvbiB0cmFja2luZyB0YWJsZSBleGlzdHNcbiAqIFRoaXMgdGFibGUgdHJhY2tzIHdoaWNoIG1pZ3JhdGlvbnMgaGF2ZSBiZWVuIHJ1blxuICovXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVNaWdyYXRpb25UYWJsZShcbiAgY2x1c3RlckFybjogc3RyaW5nLFxuICBzZWNyZXRBcm46IHN0cmluZyxcbiAgZGF0YWJhc2U6IHN0cmluZ1xuKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIFRoaXMgZXhhY3RseSBtYXRjaGVzIHRoZSBleGlzdGluZyBtaWdyYXRpb25fbG9nIHN0cnVjdHVyZSBmcm9tIEp1bmUgMjAyNSBkYXRhYmFzZVxuICBjb25zdCBzcWwgPSBgXG4gICAgQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgbWlncmF0aW9uX2xvZyAoXG4gICAgICBpZCBTRVJJQUwgUFJJTUFSWSBLRVksXG4gICAgICBzdGVwX251bWJlciBJTlRFR0VSIE5PVCBOVUxMLFxuICAgICAgZGVzY3JpcHRpb24gVEVYVCBOT1QgTlVMTCxcbiAgICAgIHNxbF9leGVjdXRlZCBURVhULFxuICAgICAgc3RhdHVzIFZBUkNIQVIoMjApIERFRkFVTFQgJ3BlbmRpbmcnLFxuICAgICAgZXJyb3JfbWVzc2FnZSBURVhULFxuICAgICAgZXhlY3V0ZWRfYXQgVElNRVNUQU1QIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVBcbiAgICApXG4gIGA7XG4gIFxuICBhd2FpdCBleGVjdXRlU3FsKGNsdXN0ZXJBcm4sIHNlY3JldEFybiwgZGF0YWJhc2UsIHNxbCk7XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYSBzcGVjaWZpYyBtaWdyYXRpb24gaGFzIGFscmVhZHkgYmVlbiBydW5cbiAqXG4gKiBTZWN1cml0eSBOb3RlOiBTdHJpbmcgY29uY2F0ZW5hdGlvbiBpcyBzYWZlIGhlcmUgYmVjYXVzZSBtaWdyYXRpb25GaWxlXG4gKiBjb21lcyBmcm9tIHRoZSBoYXJkY29kZWQgTUlHUkFUSU9OX0ZJTEVTIGFycmF5LCBub3QgdXNlciBpbnB1dC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY2hlY2tNaWdyYXRpb25SdW4oXG4gIGNsdXN0ZXJBcm46IHN0cmluZyxcbiAgc2VjcmV0QXJuOiBzdHJpbmcsXG4gIGRhdGFiYXNlOiBzdHJpbmcsXG4gIG1pZ3JhdGlvbkZpbGU6IHN0cmluZ1xuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZXhlY3V0ZVNxbChcbiAgICAgIGNsdXN0ZXJBcm4sXG4gICAgICBzZWNyZXRBcm4sXG4gICAgICBkYXRhYmFzZSxcbiAgICAgIGBTRUxFQ1QgQ09VTlQoKikgRlJPTSBtaWdyYXRpb25fbG9nXG4gICAgICAgV0hFUkUgZGVzY3JpcHRpb24gPSAnJHttaWdyYXRpb25GaWxlfSdcbiAgICAgICBBTkQgc3RhdHVzID0gJ2NvbXBsZXRlZCdgXG4gICAgKTtcblxuICAgIGNvbnN0IGNvdW50ID0gcmVzdWx0LnJlY29yZHM/LlswXT8uWzBdPy5sb25nVmFsdWUgfHwgMDtcbiAgICByZXR1cm4gY291bnQgPiAwO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIElmIHdlIGNhbid0IGNoZWNrLCBhc3N1bWUgbm90IHJ1blxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIFJlY29yZCBhIG1pZ3JhdGlvbiBleGVjdXRpb24gKHN1Y2Nlc3Mgb3IgZmFpbHVyZSlcbiAqXG4gKiBTZWN1cml0eSBOb3RlOiBTdHJpbmcgY29uY2F0ZW5hdGlvbiBpcyBzYWZlIGhlcmUgYmVjYXVzZTpcbiAqIC0gbWlncmF0aW9uRmlsZSBjb21lcyBmcm9tIGhhcmRjb2RlZCBNSUdSQVRJT05fRklMRVMgYXJyYXlcbiAqIC0gZXJyb3JNZXNzYWdlIGlzIGZyb20gY2F1Z2h0IGV4Y2VwdGlvbnMsIG5vdCB1c2VyIGlucHV0XG4gKiAtIExhbWJkYSBoYXMgbm8gZXh0ZXJuYWwgaW5wdXQgdmVjdG9yc1xuICovXG5hc3luYyBmdW5jdGlvbiByZWNvcmRNaWdyYXRpb24oXG4gIGNsdXN0ZXJBcm46IHN0cmluZyxcbiAgc2VjcmV0QXJuOiBzdHJpbmcsXG4gIGRhdGFiYXNlOiBzdHJpbmcsXG4gIG1pZ3JhdGlvbkZpbGU6IHN0cmluZyxcbiAgc3VjY2VzczogYm9vbGVhbixcbiAgZXhlY3V0aW9uVGltZTogbnVtYmVyLFxuICBlcnJvck1lc3NhZ2U/OiBzdHJpbmdcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBtYXhTdGVwUmVzdWx0ID0gYXdhaXQgZXhlY3V0ZVNxbChcbiAgICBjbHVzdGVyQXJuLFxuICAgIHNlY3JldEFybixcbiAgICBkYXRhYmFzZSxcbiAgICBgU0VMRUNUIENPQUxFU0NFKE1BWChzdGVwX251bWJlciksIDApICsgMSBhcyBuZXh0X3N0ZXAgRlJPTSBtaWdyYXRpb25fbG9nYFxuICApO1xuXG4gIGNvbnN0IG5leHRTdGVwID0gbWF4U3RlcFJlc3VsdC5yZWNvcmRzPy5bMF0/LlswXT8ubG9uZ1ZhbHVlIHx8IDE7XG4gIGNvbnN0IHN0YXR1cyA9IHN1Y2Nlc3MgPyAnY29tcGxldGVkJyA6ICdmYWlsZWQnO1xuXG4gIGF3YWl0IGV4ZWN1dGVTcWwoXG4gICAgY2x1c3RlckFybixcbiAgICBzZWNyZXRBcm4sXG4gICAgZGF0YWJhc2UsXG4gICAgYElOU0VSVCBJTlRPIG1pZ3JhdGlvbl9sb2cgKHN0ZXBfbnVtYmVyLCBkZXNjcmlwdGlvbiwgc3FsX2V4ZWN1dGVkLCBzdGF0dXMke2Vycm9yTWVzc2FnZSA/ICcsIGVycm9yX21lc3NhZ2UnIDogJyd9KVxuICAgICBWQUxVRVMgKCR7bmV4dFN0ZXB9LCAnJHttaWdyYXRpb25GaWxlfScsICdNaWdyYXRpb24gZmlsZSBleGVjdXRlZCcsICcke3N0YXR1c30nJHtlcnJvck1lc3NhZ2UgPyBgLCAnJHtlcnJvck1lc3NhZ2UucmVwbGFjZSgvJy9nLCBcIicnXCIpfSdgIDogJyd9KWBcbiAgKTtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBTUUwgc3RhdGVtZW50cyBmb3IgUkRTIERhdGEgQVBJIGluY29tcGF0aWJpbGl0aWVzXG4gKlxuICogRGV0ZWN0cyBwYXR0ZXJucyB0aGF0IGNhbm5vdCBydW4gcHJvcGVybHkgdGhyb3VnaCBSRFMgRGF0YSBBUEk6XG4gKiAtIENSRUFURSBJTkRFWCBDT05DVVJSRU5UTFkgKHJlcXVpcmVzIGF1dG9jb21taXQsIG11bHRpLXRyYW5zYWN0aW9uKVxuICogLSBEUk9QIElOREVYIENPTkNVUlJFTlRMWVxuICogLSBSRUlOREVYIENPTkNVUlJFTlRMWVxuICpcbiAqIEB0aHJvd3MgRXJyb3IgaWYgaW5jb21wYXRpYmxlIHBhdHRlcm4gZGV0ZWN0ZWRcbiAqL1xuZnVuY3Rpb24gdmFsaWRhdGVTdGF0ZW1lbnRzKHN0YXRlbWVudHM6IHN0cmluZ1tdLCBmaWxlbmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGZvciAoY29uc3Qgc3RhdGVtZW50IG9mIHN0YXRlbWVudHMpIHtcbiAgICAvLyBDaGVjayBmb3IgQ09OQ1VSUkVOVExZIGtleXdvcmQgKGluY29tcGF0aWJsZSB3aXRoIFJEUyBEYXRhIEFQSSlcbiAgICBpZiAoL1xcYkNPTkNVUlJFTlRMWVxcYi9pLnRlc3Qoc3RhdGVtZW50KSkge1xuICAgICAgY29uc29sZS5lcnJvcign4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSBJyk7XG4gICAgICBjb25zb2xlLmVycm9yKCfinYwgUkRTIERhdGEgQVBJIEluY29tcGF0aWJpbGl0eSBEZXRlY3RlZCcpO1xuICAgICAgY29uc29sZS5lcnJvcign4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSBJyk7XG4gICAgICBjb25zb2xlLmVycm9yKGBGaWxlOiAke2ZpbGVuYW1lfWApO1xuICAgICAgY29uc29sZS5lcnJvcihgU3RhdGVtZW50OiAke3N0YXRlbWVudC5zdWJzdHJpbmcoMCwgMTUwKX0uLi5gKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJycpO1xuICAgICAgY29uc29sZS5lcnJvcignSVNTVUU6IENPTkNVUlJFTlRMWSBvcGVyYXRpb25zIGNhbm5vdCBydW4gdGhyb3VnaCBSRFMgRGF0YSBBUEknKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1JFQVNPTjogQ09OQ1VSUkVOVExZIHJlcXVpcmVzIGF1dG9jb21taXQgbW9kZSBhbmQgdXNlcyBtdWx0aXBsZScpO1xuICAgICAgY29uc29sZS5lcnJvcignICAgICAgICBpbnRlcm5hbCB0cmFuc2FjdGlvbnMsIHdoaWNoIGlzIGluY29tcGF0aWJsZSB3aXRoIERhdGEgQVBJJyk7XG4gICAgICBjb25zb2xlLmVycm9yKCcnKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1NPTFVUSU9OOiBSZW1vdmUgQ09OQ1VSUkVOVExZIGtleXdvcmQgZnJvbSB0aGUgc3RhdGVtZW50OicpO1xuICAgICAgY29uc29sZS5lcnJvcignICAtIFVzZTogQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgaWR4X25hbWUgT04gdGFibGUgKGNvbHVtbik7Jyk7XG4gICAgICBjb25zb2xlLmVycm9yKCcgIC0gVGhpcyB3aWxsIGJyaWVmbHkgbG9jayB3cml0ZXMgYnV0IHdvcmtzIHdpdGggRGF0YSBBUEknKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJycpO1xuICAgICAgY29uc29sZS5lcnJvcignRk9SIFpFUk8tRE9XTlRJTUUgSU5ERVggQ1JFQVRJT046Jyk7XG4gICAgICBjb25zb2xlLmVycm9yKCcgIC0gVXNlIHBzcWwgZGlyZWN0bHkgZHVyaW5nIG1haW50ZW5hbmNlIHdpbmRvdycpO1xuICAgICAgY29uc29sZS5lcnJvcignICAtIENvbnNpZGVyIGEgc2VwYXJhdGUgbWFpbnRlbmFuY2Ugc2NyaXB0IG91dHNpZGUgTGFtYmRhJyk7XG4gICAgICBjb25zb2xlLmVycm9yKCfilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIHilIEnKTtcblxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgTWlncmF0aW9uICR7ZmlsZW5hbWV9IGNvbnRhaW5zIENPTkNVUlJFTlRMWSBrZXl3b3JkIHdoaWNoIGlzIGluY29tcGF0aWJsZSBgICtcbiAgICAgICAgYHdpdGggUkRTIERhdGEgQVBJLiBVc2UgJ0NSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTJyBpbnN0ZWFkLiBgICtcbiAgICAgICAgYEZvciB6ZXJvLWRvd250aW1lIGluZGV4IGNyZWF0aW9uIG9uIGxhcmdlIHRhYmxlcywgdXNlIHBzcWwgZGlyZWN0bHkuYFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBFeGVjdXRlIGFsbCBzdGF0ZW1lbnRzIGluIGEgU1FMIGZpbGVcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZUZpbGVTdGF0ZW1lbnRzKFxuICBjbHVzdGVyQXJuOiBzdHJpbmcsXG4gIHNlY3JldEFybjogc3RyaW5nLFxuICBkYXRhYmFzZTogc3RyaW5nLFxuICBmaWxlbmFtZTogc3RyaW5nXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc3FsID0gYXdhaXQgZ2V0U3FsQ29udGVudChmaWxlbmFtZSk7XG4gIGNvbnN0IHN0YXRlbWVudHMgPSBzcGxpdFNxbFN0YXRlbWVudHMoc3FsKTtcblxuICAvLyBWYWxpZGF0ZSBzdGF0ZW1lbnRzIGJlZm9yZSBleGVjdXRpb24gLSBkZXRlY3QgaW5jb21wYXRpYmxlIHBhdHRlcm5zXG4gIHZhbGlkYXRlU3RhdGVtZW50cyhzdGF0ZW1lbnRzLCBmaWxlbmFtZSk7XG5cbiAgZm9yIChjb25zdCBzdGF0ZW1lbnQgb2Ygc3RhdGVtZW50cykge1xuICAgIGlmIChzdGF0ZW1lbnQudHJpbSgpKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBleGVjdXRlU3FsKGNsdXN0ZXJBcm4sIHNlY3JldEFybiwgZGF0YWJhc2UsIHN0YXRlbWVudCk7XG4gICAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICAgIC8vIEZvciBpbml0aWFsIHNldHVwIGZpbGVzLCB3ZSBtaWdodCB3YW50IHRvIGNvbnRpbnVlIG9uIFwiYWxyZWFkeSBleGlzdHNcIiBlcnJvcnNcbiAgICAgICAgLy8gRm9yIG1pZ3JhdGlvbnMsIHdlIHNob3VsZCBmYWlsIGZhc3RcbiAgICAgICAgaWYgKElOSVRJQUxfU0VUVVBfRklMRVMuaW5jbHVkZXMoZmlsZW5hbWUpICYmIFxuICAgICAgICAgICAgKGVycm9yLm1lc3NhZ2U/LmluY2x1ZGVzKCdhbHJlYWR5IGV4aXN0cycpIHx8IFxuICAgICAgICAgICAgIGVycm9yLm1lc3NhZ2U/LmluY2x1ZGVzKCdkdXBsaWNhdGUga2V5JykpKSB7XG4gICAgICAgICAgY29uc29sZS5sb2coYOKaoO+4jyAgU2tpcHBpbmcgKGFscmVhZHkgZXhpc3RzKTogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgICB9IGVsc2UgaWYgKE1JR1JBVElPTl9GSUxFUy5pbmNsdWRlcyhmaWxlbmFtZSkpIHtcbiAgICAgICAgICAvLyBDUkVBVEUgVFlQRSDigKYgQVMgRU5VTSBjYW5ub3QgYmUgd3JpdHRlbiBgSUYgTk9UIEVYSVNUU2AgKFBvc3RncmVTUUxcbiAgICAgICAgICAvLyBoYXMgbm8gc3VjaCBmb3JtKSBhbmQgdGhlIHN0YXRlbWVudCBzcGxpdHRlciBjYW5ub3QgaGFuZGxlIHRoZVxuICAgICAgICAgIC8vIERPICQkIOKApiAkJCBndWFyZCBwYXR0ZXJuIChpdCBjbG9zZXMgdGhlIGJsb2NrIG9uIHRoZSBpbm5lciBgKTtgKS5cbiAgICAgICAgICAvLyBTbyBhbiBlbnVtIENSRUFURSBUWVBFIGlzIGluaGVyZW50bHkgbm9uLWlkZW1wb3RlbnQ6IG9uIGEgcGFydGlhbC1cbiAgICAgICAgICAvLyBmYWlsdXJlIHJlLXJ1biBpdCByYWlzZXMgXCJ0eXBlIOKApiBhbHJlYWR5IGV4aXN0c1wiIChTUUxTVEFURSA0MjcxMCksXG4gICAgICAgICAgLy8gd2hpY2ggd291bGQgb3RoZXJ3aXNlIGhpdCB0aGUgdGhyb3cgYmVsb3cgYW5kIHBlcm1hbmVudGx5IHdlZGdlIHRoZVxuICAgICAgICAgIC8vIG1pZ3JhdGlvbi4gVHJlYXQgdGhhdCBzcGVjaWZpYyBjYXNlIGFzIGFscmVhZHktYXBwbGllZCwgbWF0Y2hpbmcgdGhlXG4gICAgICAgICAgLy8gaWRlbXBvdGVuY3kgdGhlIG1pZ3JhdGlvbiBoZWFkZXIgcHJvbWlzZXMuIFNjb3BlZCB0byBDUkVBVEUgVFlQRSBzb1xuICAgICAgICAgIC8vIGdlbnVpbmUgXCJhbHJlYWR5IGV4aXN0c1wiIGZhaWx1cmVzIGluIG90aGVyIHN0YXRlbWVudHMgc3RpbGwgc3VyZmFjZS5cbiAgICAgICAgICBjb25zdCBpc0NyZWF0ZVR5cGUgPSBzdGF0ZW1lbnQudHJpbSgpLnRvVXBwZXJDYXNlKCkuc3RhcnRzV2l0aCgnQ1JFQVRFIFRZUEUnKTtcbiAgICAgICAgICBpZiAoaXNDcmVhdGVUeXBlICYmIGVycm9yLm1lc3NhZ2U/LmluY2x1ZGVzKCdhbHJlYWR5IGV4aXN0cycpKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhg4pqg77iPICBTa2lwcGluZyAodHlwZSBhbHJlYWR5IGV4aXN0cyk6ICR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIEZvciBtaWdyYXRpb24gZmlsZXMsIGNoZWNrIGlmIGl0J3MgYW4gQUxURVIgVEFCTEUgdGhhdCBhY3R1YWxseSBzdWNjZWVkZWRcbiAgICAgICAgICAvLyBSRFMgRGF0YSBBUEkgc29tZXRpbWVzIHJldHVybnMgYW4gZXJyb3ItbGlrZSByZXNwb25zZSBmb3Igc3VjY2Vzc2Z1bCBBTFRFUiBUQUJMRXNcbiAgICAgICAgICBjb25zdCBpc0FsdGVyVGFibGUgPSBzdGF0ZW1lbnQudHJpbSgpLnRvVXBwZXJDYXNlKCkuc3RhcnRzV2l0aCgnQUxURVIgVEFCTEUnKTtcblxuICAgICAgICAgIGlmIChpc0FsdGVyVGFibGUpIHtcbiAgICAgICAgICAgIC8vIFZlcmlmeSBpZiB0aGUgQUxURVIgYWN0dWFsbHkgc3VjY2VlZGVkIGJ5IGNoZWNraW5nIHRoZSB0YWJsZSBzdHJ1Y3R1cmVcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGDimqDvuI8gIEFMVEVSIFRBQkxFIG1heSBoYXZlIHN1Y2NlZWRlZCBkZXNwaXRlIGVycm9yIHJlc3BvbnNlLiBWZXJpZnlpbmcuLi5gKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gRXh0cmFjdCB0YWJsZSBuYW1lIGFuZCBjb2x1bW4gZnJvbSBBTFRFUiBzdGF0ZW1lbnRcbiAgICAgICAgICAgIGNvbnN0IGFsdGVyTWF0Y2ggPSBzdGF0ZW1lbnQubWF0Y2goL0FMVEVSXFxzK1RBQkxFXFxzKyhcXHcrKVxccytBRERcXHMrQ09MVU1OXFxzKyhJRlxccytOT1RcXHMrRVhJU1RTXFxzKyk/KFxcdyspL2kpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoYWx0ZXJNYXRjaCkge1xuICAgICAgICAgICAgICBjb25zdCB0YWJsZU5hbWUgPSBhbHRlck1hdGNoWzFdO1xuICAgICAgICAgICAgICBjb25zdCBjb2x1bW5OYW1lID0gYWx0ZXJNYXRjaFszXTtcbiAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgLy8gQ2hlY2sgaWYgdGhlIGNvbHVtbiBleGlzdHNcbiAgICAgICAgICAgICAgICBjb25zdCBjaGVja1Jlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTcWwoXG4gICAgICAgICAgICAgICAgICBjbHVzdGVyQXJuLFxuICAgICAgICAgICAgICAgICAgc2VjcmV0QXJuLFxuICAgICAgICAgICAgICAgICAgZGF0YWJhc2UsXG4gICAgICAgICAgICAgICAgICBgU0VMRUNUIGNvbHVtbl9uYW1lIEZST00gaW5mb3JtYXRpb25fc2NoZW1hLmNvbHVtbnMgXG4gICAgICAgICAgICAgICAgICAgV0hFUkUgdGFibGVfc2NoZW1hID0gJ3B1YmxpYycgXG4gICAgICAgICAgICAgICAgICAgQU5EIHRhYmxlX25hbWUgPSAnJHt0YWJsZU5hbWV9JyBcbiAgICAgICAgICAgICAgICAgICBBTkQgY29sdW1uX25hbWUgPSAnJHtjb2x1bW5OYW1lfSdgXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAoY2hlY2tSZXN1bHQucmVjb3JkcyAmJiBjaGVja1Jlc3VsdC5yZWNvcmRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGDinIUgQ29sdW1uICR7Y29sdW1uTmFtZX0gZXhpc3RzIGluIHRhYmxlICR7dGFibGVOYW1lfSAtIEFMVEVSIHN1Y2NlZWRlZGApO1xuICAgICAgICAgICAgICAgICAgLy8gQ29sdW1uIGV4aXN0cywgc28gdGhlIEFMVEVSIHdvcmtlZCAtIGNvbnRpbnVlXG4gICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGNoZWNrRXJyb3IpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgQ291bGQgbm90IHZlcmlmeSBjb2x1bW4gZXhpc3RlbmNlOiAke2NoZWNrRXJyb3J9YCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgXG4gICAgICAgICAgLy8gSWYgd2UgY291bGRuJ3QgdmVyaWZ5IHN1Y2Nlc3MsIHRocm93IHRoZSBvcmlnaW5hbCBlcnJvclxuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVTcWwoXG4gIGNsdXN0ZXJBcm46IHN0cmluZyxcbiAgc2VjcmV0QXJuOiBzdHJpbmcsXG4gIGRhdGFiYXNlOiBzdHJpbmcsXG4gIHNxbDogc3RyaW5nXG4pOiBQcm9taXNlPGFueT4ge1xuICBjb25zdCBjb21tYW5kID0gbmV3IEV4ZWN1dGVTdGF0ZW1lbnRDb21tYW5kKHtcbiAgICByZXNvdXJjZUFybjogY2x1c3RlckFybixcbiAgICBzZWNyZXRBcm46IHNlY3JldEFybixcbiAgICBkYXRhYmFzZTogZGF0YWJhc2UsXG4gICAgc3FsOiBzcWwsXG4gICAgaW5jbHVkZVJlc3VsdE1ldGFkYXRhOiB0cnVlXG4gIH0pO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZHNDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAvLyBMb2cgdGhlIGZ1bGwgZXJyb3IgZm9yIGRlYnVnZ2luZ1xuICAgIGNvbnNvbGUuZXJyb3IoYFNRTCBleGVjdXRpb24gZXJyb3IgZm9yIHN0YXRlbWVudDogJHtzcWwuc3Vic3RyaW5nKDAsIDEwMCl9Li4uYCk7XG4gICAgY29uc29sZS5lcnJvcihgRXJyb3IgZGV0YWlsczpgLCBKU09OLnN0cmluZ2lmeShlcnJvciwgbnVsbCwgMikpO1xuICAgIFxuICAgIC8vIENoZWNrIGlmIHRoaXMgaXMgYSBmYWxzZS1wb3NpdGl2ZSBlcnJvciBmb3IgQUxURVIgVEFCTEVcbiAgICAvLyBSRFMgRGF0YSBBUEkgc29tZXRpbWVzIHJldHVybnMgZXJyb3JzIGZvciBzdWNjZXNzZnVsIERETCBvcGVyYXRpb25zXG4gICAgaWYgKHNxbC50cmltKCkudG9VcHBlckNhc2UoKS5zdGFydHNXaXRoKCdBTFRFUiBUQUJMRScpICYmIFxuICAgICAgICBlcnJvci5tZXNzYWdlICYmIFxuICAgICAgICAoZXJyb3IubWVzc2FnZS5pbmNsdWRlcygnRGF0YWJhc2UgcmV0dXJuZWQgU1FMIGV4Y2VwdGlvbicpIHx8IFxuICAgICAgICAgZXJyb3IubWVzc2FnZS5pbmNsdWRlcygnQmFkUmVxdWVzdEV4Y2VwdGlvbicpKSkge1xuICAgICAgY29uc29sZS5sb2coYOKaoO+4jyAgUG90ZW50aWFsIGZhbHNlLXBvc2l0aXZlIGVycm9yIGZvciBBTFRFUiBUQUJMRSAtIHdpbGwgdmVyaWZ5IGluIGNhbGxlcmApO1xuICAgIH1cbiAgICBcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG5mdW5jdGlvbiBzcGxpdFNxbFN0YXRlbWVudHMoc3FsOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIC8vIFJlbW92ZSBjb21tZW50c1xuICBjb25zdCB3aXRob3V0Q29tbWVudHMgPSBzcWxcbiAgICAuc3BsaXQoJ1xcbicpXG4gICAgLmZpbHRlcihsaW5lID0+ICFsaW5lLnRyaW0oKS5zdGFydHNXaXRoKCctLScpKVxuICAgIC5qb2luKCdcXG4nKTtcblxuICAvLyBTcGxpdCBieSBzZW1pY29sb24gYnV0IGhhbmRsZSBDUkVBVEUgVFlQRS9GVU5DVElPTiBibG9ja3Mgc3BlY2lhbGx5XG4gIGNvbnN0IHN0YXRlbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGxldCBjdXJyZW50U3RhdGVtZW50ID0gJyc7XG4gIGxldCBpbkJsb2NrID0gZmFsc2U7XG4gIFxuICBjb25zdCBsaW5lcyA9IHdpdGhvdXRDb21tZW50cy5zcGxpdCgnXFxuJyk7XG4gIFxuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICBjb25zdCB0cmltbWVkTGluZSA9IGxpbmUudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgXG4gICAgLy8gQ2hlY2sgaWYgd2UncmUgZW50ZXJpbmcgYSBibG9jayAoQ1JFQVRFIFRZUEUsIENSRUFURSBGVU5DVElPTiwgZXRjLilcbiAgICBpZiAodHJpbW1lZExpbmUuc3RhcnRzV2l0aCgnQ1JFQVRFIFRZUEUnKSB8fCBcbiAgICAgICAgdHJpbW1lZExpbmUuc3RhcnRzV2l0aCgnQ1JFQVRFIEZVTkNUSU9OJykgfHxcbiAgICAgICAgdHJpbW1lZExpbmUuc3RhcnRzV2l0aCgnQ1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04nKSB8fFxuICAgICAgICB0cmltbWVkTGluZS5zdGFydHNXaXRoKCdEUk9QIFRZUEUnKSkge1xuICAgICAgaW5CbG9jayA9IHRydWU7XG4gICAgfVxuICAgIFxuICAgIGN1cnJlbnRTdGF0ZW1lbnQgKz0gbGluZSArICdcXG4nO1xuICAgIFxuICAgIC8vIENoZWNrIGlmIHRoaXMgbGluZSBlbmRzIHdpdGggYSBzZW1pY29sb25cbiAgICBpZiAobGluZS50cmltKCkuZW5kc1dpdGgoJzsnKSkge1xuICAgICAgLy8gSWYgd2UncmUgaW4gYSBibG9jaywgY2hlY2sgaWYgdGhpcyBpcyB0aGUgZW5kXG4gICAgICBpZiAoaW5CbG9jayAmJiAodHJpbW1lZExpbmUgPT09ICcpOycgfHwgdHJpbW1lZExpbmUuZW5kc1dpdGgoJyk7JykgfHwgdHJpbW1lZExpbmUuZW5kc1dpdGgoXCInIExBTkdVQUdFIFBMUEdTUUw7XCIpKSkge1xuICAgICAgICBpbkJsb2NrID0gZmFsc2U7XG4gICAgICB9XG4gICAgICBcbiAgICAgIC8vIElmIG5vdCBpbiBhIGJsb2NrLCB0aGlzIHN0YXRlbWVudCBpcyBjb21wbGV0ZVxuICAgICAgaWYgKCFpbkJsb2NrKSB7XG4gICAgICAgIHN0YXRlbWVudHMucHVzaChjdXJyZW50U3RhdGVtZW50LnRyaW0oKSk7XG4gICAgICAgIGN1cnJlbnRTdGF0ZW1lbnQgPSAnJztcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgXG4gIC8vIEFkZCBhbnkgcmVtYWluaW5nIHN0YXRlbWVudFxuICBpZiAoY3VycmVudFN0YXRlbWVudC50cmltKCkpIHtcbiAgICBzdGF0ZW1lbnRzLnB1c2goY3VycmVudFN0YXRlbWVudC50cmltKCkpO1xuICB9XG4gIFxuICByZXR1cm4gc3RhdGVtZW50cztcbn1cblxuLy8gTG9hZCBTUUwgY29udGVudCBmcm9tIGJ1bmRsZWQgc2NoZW1hIGZpbGVzXG5hc3luYyBmdW5jdGlvbiBnZXRTcWxDb250ZW50KGZpbGVuYW1lOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBmcyA9IHJlcXVpcmUoJ2ZzJykucHJvbWlzZXM7XG4gIGNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG4gIFxuICB0cnkge1xuICAgIC8vIFNjaGVtYSBmaWxlcyBhcmUgY29waWVkIHRvIHRoZSBMYW1iZGEgZGVwbG95bWVudCBwYWNrYWdlXG4gICAgY29uc3Qgc2NoZW1hUGF0aCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICdzY2hlbWEnLCBmaWxlbmFtZSk7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IGZzLnJlYWRGaWxlKHNjaGVtYVBhdGgsICd1dGY4Jyk7XG4gICAgcmV0dXJuIGNvbnRlbnQ7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcihgRmFpbGVkIHRvIHJlYWQgU1FMIGZpbGUgJHtmaWxlbmFtZX06YCwgZXJyb3IpO1xuICAgIHRocm93IG5ldyBFcnJvcihgQ291bGQgbm90IGxvYWQgU1FMIGZpbGU6ICR7ZmlsZW5hbWV9YCk7XG4gIH1cbn1cblxuIl19