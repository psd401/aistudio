"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = handler;
const client_rds_data_1 = require("@aws-sdk/client-rds-data");
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
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
    '039-prompt-library-schema.sql',
    '040-update-model-replacement-audit.sql',
    '041-add-user-cascade-constraints.sql',
    '042-ai-streaming-jobs-pending-index.sql'
    // ADD NEW MIGRATIONS HERE - they will run once and be tracked
];
// Initial setup files (only run on empty database)
// WARNING: These must EXACTLY match existing database structure!
const INITIAL_SETUP_FILES = [
    '001-enums.sql', // Creates enum types
    '002-tables.sql', // Creates all core tables
    '003-constraints.sql', // Adds foreign key constraints
    '004-indexes.sql', // Creates performance indexes
    '005-initial-data.sql' // Inserts required seed data
];
async function handler(event) {
    console.log('Database initialization event:', JSON.stringify(event, null, 2));
    console.log('Handler version: 2025-12-24-v12 - Add CONCURRENTLY detection, fix migration 042');
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGItaW5pdC1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZGItaW5pdC1oYW5kbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBMkVBLDBCQWdGQztBQTNKRCw4REFBa0Y7QUFDbEYsNEVBQThGO0FBRTlGLE1BQU0sU0FBUyxHQUFHLElBQUksK0JBQWEsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN4QyxNQUFNLGFBQWEsR0FBRyxJQUFJLDZDQUFvQixDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBYW5EOzs7Ozs7Ozs7OztHQVdHO0FBRUgseURBQXlEO0FBQ3pELHlFQUF5RTtBQUN6RSxNQUFNLGVBQWUsR0FBRztJQUN0QixnQ0FBZ0M7SUFDaEMsc0JBQXNCO0lBQ3RCLHVCQUF1QjtJQUN2Qix5Q0FBeUM7SUFDekMsMkJBQTJCO0lBQzNCLGdDQUFnQztJQUNoQywwQ0FBMEM7SUFDMUMsbUNBQW1DO0lBQ25DLGlDQUFpQztJQUNqQyxxQ0FBcUM7SUFDckMsK0JBQStCO0lBQy9CLGdDQUFnQztJQUNoQyxpQ0FBaUM7SUFDakMsa0NBQWtDO0lBQ2xDLGlDQUFpQztJQUNqQyxzQkFBc0I7SUFDdEIsc0NBQXNDO0lBQ3RDLGdDQUFnQztJQUNoQyx3QkFBd0I7SUFDeEIsMENBQTBDO0lBQzFDLDJCQUEyQjtJQUMzQiwyQ0FBMkM7SUFDM0Msb0NBQW9DO0lBQ3BDLG1DQUFtQztJQUNuQyxvQ0FBb0M7SUFDcEMsK0JBQStCO0lBQy9CLHdDQUF3QztJQUN4QyxzQ0FBc0M7SUFDdEMseUNBQXlDO0lBQ3pDLDhEQUE4RDtDQUMvRCxDQUFDO0FBRUYsbURBQW1EO0FBQ25ELGlFQUFpRTtBQUNqRSxNQUFNLG1CQUFtQixHQUFHO0lBQzFCLGVBQWUsRUFBTyxxQkFBcUI7SUFDM0MsZ0JBQWdCLEVBQU0sMEJBQTBCO0lBQ2hELHFCQUFxQixFQUFFLCtCQUErQjtJQUN0RCxpQkFBaUIsRUFBTSw4QkFBOEI7SUFDckQsc0JBQXNCLENBQUMsNkJBQTZCO0NB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LEtBQUssVUFBVSxhQUFhLENBQUMsUUFBZ0I7SUFDM0MsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLFFBQVEsQ0FBQztJQUNsQyxNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUM7SUFFN0IsSUFBSSxDQUFDO1FBQ0gsMkRBQTJEO1FBQzNELE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLFFBQVEsRUFBRSxRQUFRLENBQUMsQ0FBQztRQUM1RCxNQUFNLE9BQU8sR0FBRyxNQUFNLEVBQUUsQ0FBQyxRQUFRLENBQUMsVUFBVSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ3RELE9BQU8sT0FBTyxDQUFDO0lBQ2pCLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsT0FBTyxDQUFDLEtBQUssQ0FBQywyQkFBMkIsUUFBUSxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDN0QsTUFBTSxJQUFJLEtBQUssQ0FBQyw0QkFBNEIsUUFBUSxFQUFFLENBQUMsQ0FBQztJQUMxRCxDQUFDO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJEU0RhdGFDbGllbnQsIEV4ZWN1dGVTdGF0ZW1lbnRDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXJkcy1kYXRhJztcbmltcG9ydCB7IEdldFNlY3JldFZhbHVlQ29tbWFuZCwgU2VjcmV0c01hbmFnZXJDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtc2VjcmV0cy1tYW5hZ2VyJztcblxuY29uc3QgcmRzQ2xpZW50ID0gbmV3IFJEU0RhdGFDbGllbnQoe30pO1xuY29uc3Qgc2VjcmV0c0NsaWVudCA9IG5ldyBTZWNyZXRzTWFuYWdlckNsaWVudCh7fSk7XG5cbmludGVyZmFjZSBDdXN0b21SZXNvdXJjZUV2ZW50IHtcbiAgUmVxdWVzdFR5cGU6ICdDcmVhdGUnIHwgJ1VwZGF0ZScgfCAnRGVsZXRlJztcbiAgUmVzb3VyY2VQcm9wZXJ0aWVzOiB7XG4gICAgQ2x1c3RlckFybjogc3RyaW5nO1xuICAgIFNlY3JldEFybjogc3RyaW5nO1xuICAgIERhdGFiYXNlTmFtZTogc3RyaW5nO1xuICAgIEVudmlyb25tZW50OiBzdHJpbmc7XG4gIH07XG4gIFBoeXNpY2FsUmVzb3VyY2VJZD86IHN0cmluZztcbn1cblxuLyoqXG4gKiBDUklUSUNBTDogRGF0YWJhc2UgSW5pdGlhbGl6YXRpb24gYW5kIE1pZ3JhdGlvbiBIYW5kbGVyXG4gKiBcbiAqIFRoaXMgTGFtYmRhIGhhbmRsZXMgVFdPIGRpc3RpbmN0IHNjZW5hcmlvczpcbiAqIDEuIEZyZXNoIEluc3RhbGxhdGlvbjogUnVucyBhbGwgaW5pdGlhbCBzZXR1cCBmaWxlcyAoMDAxLTAwNSlcbiAqIDIuIEV4aXN0aW5nIERhdGFiYXNlOiBPTkxZIHJ1bnMgbWlncmF0aW9uIGZpbGVzICgwMTArKVxuICogXG4gKiBXQVJOSU5HOiBUaGUgaW5pdGlhbCBzZXR1cCBmaWxlcyAoMDAxLTAwNSkgTVVTVCBleGFjdGx5IG1hdGNoIHRoZSBleGlzdGluZ1xuICogZGF0YWJhc2Ugc3RydWN0dXJlIG9yIHRoZXkgd2lsbCBjYXVzZSBkYXRhIGNvcnJ1cHRpb24hXG4gKiBcbiAqIEBzZWUgL2RvY3MvZGF0YWJhc2UtcmVzdG9yYXRpb24vREFUQUJBU0UtTUlHUkFUSU9OUy5tZCBmb3IgZnVsbCBkZXRhaWxzXG4gKi9cblxuLy8gTWlncmF0aW9uIGZpbGVzIHRoYXQgc2hvdWxkIEFMV0FZUyBydW4gKGFkZGl0aXZlIG9ubHkpXG4vLyBUaGVzZSBmaWxlcyBzaG91bGQgT05MWSBjcmVhdGUgbmV3IG9iamVjdHMsIG5ldmVyIG1vZGlmeSBleGlzdGluZyBvbmVzXG5jb25zdCBNSUdSQVRJT05fRklMRVMgPSBbXG4gICcwMTAta25vd2xlZGdlLXJlcG9zaXRvcmllcy5zcWwnLFxuICAnMTFfdGV4dHJhY3Rfam9icy5zcWwnLFxuICAnMTJfdGV4dHJhY3RfdXNhZ2Uuc3FsJyxcbiAgJzAxMy1hZGQta25vd2xlZGdlLXJlcG9zaXRvcmllcy10b29sLnNxbCcsXG4gICcwMTQtbW9kZWwtY29tcGFyaXNvbnMuc3FsJyxcbiAgJzAxNS1hZGQtbW9kZWwtY29tcGFyZS10b29sLnNxbCcsXG4gICcwMTYtYXNzaXN0YW50LWFyY2hpdGVjdC1yZXBvc2l0b3JpZXMuc3FsJyxcbiAgJzAxNy1hZGQtdXNlci1yb2xlcy11cGRhdGVkLWF0LnNxbCcsXG4gICcwMTgtbW9kZWwtcmVwbGFjZW1lbnQtYXVkaXQuc3FsJyxcbiAgJzAxOS1maXgtbmF2aWdhdGlvbi1yb2xlLWRpc3BsYXkuc3FsJyxcbiAgJzAyMC1hZGQtdXNlci1yb2xlLXZlcnNpb24uc3FsJyxcbiAgJzAyMy1uYXZpZ2F0aW9uLW11bHRpLXJvbGVzLnNxbCcsXG4gICcwMjQtbW9kZWwtcm9sZS1yZXN0cmljdGlvbnMuc3FsJyxcbiAgJzAyNi1hZGQtbW9kZWwtY29tcGFyZS1zb3VyY2Uuc3FsJyxcbiAgJzAyNy1tZXNzYWdlcy1tb2RlbC10cmFja2luZy5zcWwnLFxuICAnMDI4LW5leHVzLXNjaGVtYS5zcWwnLFxuICAnMDI5LWFpLW1vZGVscy1uZXh1cy1lbmhhbmNlbWVudHMuc3FsJyxcbiAgJzAzMC1uZXh1cy1wcm92aWRlci1tZXRyaWNzLnNxbCcsXG4gICcwMzEtbmV4dXMtbWVzc2FnZXMuc3FsJyxcbiAgJzAzMi1yZW1vdmUtbmV4dXMtcHJvdmlkZXItY29uc3RyYWludC5zcWwnLFxuICAnMDMzLWFpLXN0cmVhbWluZy1qb2JzLnNxbCcsXG4gICcwMzQtYXNzaXN0YW50LWFyY2hpdGVjdC1lbmFibGVkLXRvb2xzLnNxbCcsXG4gICcwMzUtc2NoZWR1bGUtbWFuYWdlbWVudC1zY2hlbWEuc3FsJyxcbiAgJzAzNi1yZW1vdmUtbGVnYWN5LWNoYXQtdGFibGVzLnNxbCcsXG4gICcwMzctYXNzaXN0YW50LWFyY2hpdGVjdC1ldmVudHMuc3FsJyxcbiAgJzAzOS1wcm9tcHQtbGlicmFyeS1zY2hlbWEuc3FsJyxcbiAgJzA0MC11cGRhdGUtbW9kZWwtcmVwbGFjZW1lbnQtYXVkaXQuc3FsJyxcbiAgJzA0MS1hZGQtdXNlci1jYXNjYWRlLWNvbnN0cmFpbnRzLnNxbCcsXG4gICcwNDItYWktc3RyZWFtaW5nLWpvYnMtcGVuZGluZy1pbmRleC5zcWwnXG4gIC8vIEFERCBORVcgTUlHUkFUSU9OUyBIRVJFIC0gdGhleSB3aWxsIHJ1biBvbmNlIGFuZCBiZSB0cmFja2VkXG5dO1xuXG4vLyBJbml0aWFsIHNldHVwIGZpbGVzIChvbmx5IHJ1biBvbiBlbXB0eSBkYXRhYmFzZSlcbi8vIFdBUk5JTkc6IFRoZXNlIG11c3QgRVhBQ1RMWSBtYXRjaCBleGlzdGluZyBkYXRhYmFzZSBzdHJ1Y3R1cmUhXG5jb25zdCBJTklUSUFMX1NFVFVQX0ZJTEVTID0gW1xuICAnMDAxLWVudW1zLnNxbCcsICAgICAgLy8gQ3JlYXRlcyBlbnVtIHR5cGVzXG4gICcwMDItdGFibGVzLnNxbCcsICAgICAvLyBDcmVhdGVzIGFsbCBjb3JlIHRhYmxlc1xuICAnMDAzLWNvbnN0cmFpbnRzLnNxbCcsIC8vIEFkZHMgZm9yZWlnbiBrZXkgY29uc3RyYWludHNcbiAgJzAwNC1pbmRleGVzLnNxbCcsICAgICAvLyBDcmVhdGVzIHBlcmZvcm1hbmNlIGluZGV4ZXNcbiAgJzAwNS1pbml0aWFsLWRhdGEuc3FsJyAvLyBJbnNlcnRzIHJlcXVpcmVkIHNlZWQgZGF0YVxuXTtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZXIoZXZlbnQ6IEN1c3RvbVJlc291cmNlRXZlbnQpOiBQcm9taXNlPGFueT4ge1xuICBjb25zb2xlLmxvZygnRGF0YWJhc2UgaW5pdGlhbGl6YXRpb24gZXZlbnQ6JywgSlNPTi5zdHJpbmdpZnkoZXZlbnQsIG51bGwsIDIpKTtcbiAgY29uc29sZS5sb2coJ0hhbmRsZXIgdmVyc2lvbjogMjAyNS0xMi0yNC12MTIgLSBBZGQgQ09OQ1VSUkVOVExZIGRldGVjdGlvbiwgZml4IG1pZ3JhdGlvbiAwNDInKTtcbiAgXG4gIC8vIFNBRkVUWSBDSEVDSzogTG9nIHdoYXQgbW9kZSB3ZSdyZSBpblxuICBjb25zb2xlLmxvZyhg8J+UjSBDaGVja2luZyBkYXRhYmFzZSBzdGF0ZSBmb3Igc2FmZXR5Li4uYCk7XG5cbiAgLy8gT25seSBydW4gb24gQ3JlYXRlIG9yIFVwZGF0ZVxuICBpZiAoZXZlbnQuUmVxdWVzdFR5cGUgPT09ICdEZWxldGUnKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIFBoeXNpY2FsUmVzb3VyY2VJZDogZXZlbnQuUGh5c2ljYWxSZXNvdXJjZUlkIHx8ICdkYi1pbml0JyxcbiAgICAgIFN0YXR1czogJ1NVQ0NFU1MnLFxuICAgICAgUmVhc29uOiAnRGVsZXRlIG5vdCByZXF1aXJlZCBmb3IgZGF0YWJhc2UgaW5pdGlhbGl6YXRpb24nXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHsgQ2x1c3RlckFybiwgU2VjcmV0QXJuLCBEYXRhYmFzZU5hbWUsIEVudmlyb25tZW50IH0gPSBldmVudC5SZXNvdXJjZVByb3BlcnRpZXM7XG5cbiAgdHJ5IHtcbiAgICAvLyBDUklUSUNBTDogQ2hlY2sgaWYgdGhpcyBpcyBhIGZyZXNoIGRhdGFiYXNlIG9yIGV4aXN0aW5nIG9uZVxuICAgIGNvbnN0IGlzRGF0YWJhc2VFbXB0eSA9IGF3YWl0IGNoZWNrSWZEYXRhYmFzZUVtcHR5KENsdXN0ZXJBcm4sIFNlY3JldEFybiwgRGF0YWJhc2VOYW1lKTtcbiAgICBcbiAgICBpZiAoaXNEYXRhYmFzZUVtcHR5KSB7XG4gICAgICBjb25zb2xlLmxvZygn8J+GlSBFbXB0eSBkYXRhYmFzZSBkZXRlY3RlZCAtIHJ1bm5pbmcgZnVsbCBpbml0aWFsaXphdGlvbicpO1xuICAgICAgXG4gICAgICAvLyBSdW4gaW5pdGlhbCBzZXR1cCBmaWxlcyBmb3IgZnJlc2ggaW5zdGFsbGF0aW9uXG4gICAgICBmb3IgKGNvbnN0IHNxbEZpbGUgb2YgSU5JVElBTF9TRVRVUF9GSUxFUykge1xuICAgICAgICBjb25zb2xlLmxvZyhgRXhlY3V0aW5nIGluaXRpYWwgc2V0dXA6ICR7c3FsRmlsZX1gKTtcbiAgICAgICAgYXdhaXQgZXhlY3V0ZUZpbGVTdGF0ZW1lbnRzKENsdXN0ZXJBcm4sIFNlY3JldEFybiwgRGF0YWJhc2VOYW1lLCBzcWxGaWxlKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5sb2coJ+KchSBFeGlzdGluZyBkYXRhYmFzZSBkZXRlY3RlZCAtIHNraXBwaW5nIGluaXRpYWwgc2V0dXAgZmlsZXMnKTtcbiAgICAgIGNvbnNvbGUubG9nKCfimqDvuI8gIE9OTFkgbWlncmF0aW9uIGZpbGVzIHdpbGwgYmUgcHJvY2Vzc2VkJyk7XG4gICAgfVxuXG4gICAgLy8gQUxXQVlTIHJ1biBtaWdyYXRpb25zICh0aGV5IHNob3VsZCBiZSBpZGVtcG90ZW50IGFuZCBzYWZlKVxuICAgIGNvbnNvbGUubG9nKCfwn5SEIFByb2Nlc3NpbmcgbWlncmF0aW9ucy4uLicpO1xuICAgIFxuICAgIC8vIEVuc3VyZSBtaWdyYXRpb24gdHJhY2tpbmcgdGFibGUgZXhpc3RzXG4gICAgYXdhaXQgZW5zdXJlTWlncmF0aW9uVGFibGUoQ2x1c3RlckFybiwgU2VjcmV0QXJuLCBEYXRhYmFzZU5hbWUpO1xuICAgIFxuICAgIC8vIFJ1biBlYWNoIG1pZ3JhdGlvbiB0aGF0IGhhc24ndCBiZWVuIHJ1biB5ZXRcbiAgICBmb3IgKGNvbnN0IG1pZ3JhdGlvbkZpbGUgb2YgTUlHUkFUSU9OX0ZJTEVTKSB7XG4gICAgICBjb25zdCBoYXNSdW4gPSBhd2FpdCBjaGVja01pZ3JhdGlvblJ1bihDbHVzdGVyQXJuLCBTZWNyZXRBcm4sIERhdGFiYXNlTmFtZSwgbWlncmF0aW9uRmlsZSk7XG4gICAgICBcbiAgICAgIGlmICghaGFzUnVuKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGDilrbvuI8gIFJ1bm5pbmcgbWlncmF0aW9uOiAke21pZ3JhdGlvbkZpbGV9YCk7XG4gICAgICAgIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG4gICAgICAgIFxuICAgICAgICB0cnkge1xuICAgICAgICAgIGF3YWl0IGV4ZWN1dGVGaWxlU3RhdGVtZW50cyhDbHVzdGVyQXJuLCBTZWNyZXRBcm4sIERhdGFiYXNlTmFtZSwgbWlncmF0aW9uRmlsZSk7XG4gICAgICAgICAgXG4gICAgICAgICAgLy8gUmVjb3JkIHN1Y2Nlc3NmdWwgbWlncmF0aW9uXG4gICAgICAgICAgYXdhaXQgcmVjb3JkTWlncmF0aW9uKENsdXN0ZXJBcm4sIFNlY3JldEFybiwgRGF0YWJhc2VOYW1lLCBtaWdyYXRpb25GaWxlLCB0cnVlLCBEYXRlLm5vdygpIC0gc3RhcnRUaW1lKTtcbiAgICAgICAgICBjb25zb2xlLmxvZyhg4pyFIE1pZ3JhdGlvbiAke21pZ3JhdGlvbkZpbGV9IGNvbXBsZXRlZCBzdWNjZXNzZnVsbHlgKTtcbiAgICAgICAgICBcbiAgICAgICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgICAgIC8vIFJlY29yZCBmYWlsZWQgbWlncmF0aW9uXG4gICAgICAgICAgYXdhaXQgcmVjb3JkTWlncmF0aW9uKENsdXN0ZXJBcm4sIFNlY3JldEFybiwgRGF0YWJhc2VOYW1lLCBtaWdyYXRpb25GaWxlLCBmYWxzZSwgRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSwgZXJyb3IubWVzc2FnZSk7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBNaWdyYXRpb24gJHttaWdyYXRpb25GaWxlfSBmYWlsZWQ6ICR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc29sZS5sb2coYOKPre+4jyAgU2tpcHBpbmcgbWlncmF0aW9uICR7bWlncmF0aW9uRmlsZX0gLSBhbHJlYWR5IHJ1bmApO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBQaHlzaWNhbFJlc291cmNlSWQ6ICdkYi1pbml0JyxcbiAgICAgIFN0YXR1czogJ1NVQ0NFU1MnLFxuICAgICAgUmVhc29uOiAnRGF0YWJhc2UgaW5pdGlhbGl6YXRpb24vbWlncmF0aW9uIGNvbXBsZXRlZCBzdWNjZXNzZnVsbHknXG4gICAgfTtcblxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ+KdjCBEYXRhYmFzZSBvcGVyYXRpb24gZmFpbGVkOicsIGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgUGh5c2ljYWxSZXNvdXJjZUlkOiAnZGItaW5pdCcsXG4gICAgICBTdGF0dXM6ICdGQUlMRUQnLFxuICAgICAgUmVhc29uOiBgRGF0YWJhc2Ugb3BlcmF0aW9uIGZhaWxlZDogJHtlcnJvcn1gXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIENoZWNrIGlmIGRhdGFiYXNlIGlzIGVtcHR5IChmcmVzaCBpbnN0YWxsYXRpb24pXG4gKiBSZXR1cm5zIHRydWUgaWYgbm8gY29yZSB0YWJsZXMgZXhpc3QsIGZhbHNlIGlmIGRhdGFiYXNlIGhhcyBiZWVuIGluaXRpYWxpemVkXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNoZWNrSWZEYXRhYmFzZUVtcHR5KFxuICBjbHVzdGVyQXJuOiBzdHJpbmcsXG4gIHNlY3JldEFybjogc3RyaW5nLFxuICBkYXRhYmFzZTogc3RyaW5nXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgdHJ5IHtcbiAgICAvLyBDaGVjayBpZiB1c2VycyB0YWJsZSBleGlzdHMgKGNvcmUgdGFibGUgdGhhdCBzaG91bGQgYWx3YXlzIGV4aXN0KVxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTcWwoXG4gICAgICBjbHVzdGVyQXJuLFxuICAgICAgc2VjcmV0QXJuLFxuICAgICAgZGF0YWJhc2UsXG4gICAgICBgU0VMRUNUIENPVU5UKCopIEZST00gaW5mb3JtYXRpb25fc2NoZW1hLnRhYmxlcyBcbiAgICAgICBXSEVSRSB0YWJsZV9zY2hlbWEgPSAncHVibGljJyBcbiAgICAgICBBTkQgdGFibGVfbmFtZSA9ICd1c2VycydgXG4gICAgKTtcbiAgICBcbiAgICBjb25zdCBjb3VudCA9IHJlc3VsdC5yZWNvcmRzPy5bMF0/LlswXT8ubG9uZ1ZhbHVlIHx8IDA7XG4gICAgcmV0dXJuIGNvdW50ID09PSAwO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIElmIHdlIGNhbid0IGNoZWNrLCBhc3N1bWUgZW1wdHkgZm9yIHNhZmV0eVxuICAgIGNvbnNvbGUubG9nKCdDb3VsZCBub3QgY2hlY2sgaWYgZGF0YWJhc2UgaXMgZW1wdHksIGFzc3VtaW5nIGZyZXNoIGluc3RhbGwnKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxufVxuXG4vKipcbiAqIEVuc3VyZSBtaWdyYXRpb24gdHJhY2tpbmcgdGFibGUgZXhpc3RzXG4gKiBUaGlzIHRhYmxlIHRyYWNrcyB3aGljaCBtaWdyYXRpb25zIGhhdmUgYmVlbiBydW5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZW5zdXJlTWlncmF0aW9uVGFibGUoXG4gIGNsdXN0ZXJBcm46IHN0cmluZyxcbiAgc2VjcmV0QXJuOiBzdHJpbmcsXG4gIGRhdGFiYXNlOiBzdHJpbmdcbik6IFByb21pc2U8dm9pZD4ge1xuICAvLyBUaGlzIGV4YWN0bHkgbWF0Y2hlcyB0aGUgZXhpc3RpbmcgbWlncmF0aW9uX2xvZyBzdHJ1Y3R1cmUgZnJvbSBKdW5lIDIwMjUgZGF0YWJhc2VcbiAgY29uc3Qgc3FsID0gYFxuICAgIENSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIG1pZ3JhdGlvbl9sb2cgKFxuICAgICAgaWQgU0VSSUFMIFBSSU1BUlkgS0VZLFxuICAgICAgc3RlcF9udW1iZXIgSU5URUdFUiBOT1QgTlVMTCxcbiAgICAgIGRlc2NyaXB0aW9uIFRFWFQgTk9UIE5VTEwsXG4gICAgICBzcWxfZXhlY3V0ZWQgVEVYVCxcbiAgICAgIHN0YXR1cyBWQVJDSEFSKDIwKSBERUZBVUxUICdwZW5kaW5nJyxcbiAgICAgIGVycm9yX21lc3NhZ2UgVEVYVCxcbiAgICAgIGV4ZWN1dGVkX2F0IFRJTUVTVEFNUCBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QXG4gICAgKVxuICBgO1xuICBcbiAgYXdhaXQgZXhlY3V0ZVNxbChjbHVzdGVyQXJuLCBzZWNyZXRBcm4sIGRhdGFiYXNlLCBzcWwpO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGEgc3BlY2lmaWMgbWlncmF0aW9uIGhhcyBhbHJlYWR5IGJlZW4gcnVuXG4gKlxuICogU2VjdXJpdHkgTm90ZTogU3RyaW5nIGNvbmNhdGVuYXRpb24gaXMgc2FmZSBoZXJlIGJlY2F1c2UgbWlncmF0aW9uRmlsZVxuICogY29tZXMgZnJvbSB0aGUgaGFyZGNvZGVkIE1JR1JBVElPTl9GSUxFUyBhcnJheSwgbm90IHVzZXIgaW5wdXQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNoZWNrTWlncmF0aW9uUnVuKFxuICBjbHVzdGVyQXJuOiBzdHJpbmcsXG4gIHNlY3JldEFybjogc3RyaW5nLFxuICBkYXRhYmFzZTogc3RyaW5nLFxuICBtaWdyYXRpb25GaWxlOiBzdHJpbmdcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTcWwoXG4gICAgICBjbHVzdGVyQXJuLFxuICAgICAgc2VjcmV0QXJuLFxuICAgICAgZGF0YWJhc2UsXG4gICAgICBgU0VMRUNUIENPVU5UKCopIEZST00gbWlncmF0aW9uX2xvZ1xuICAgICAgIFdIRVJFIGRlc2NyaXB0aW9uID0gJyR7bWlncmF0aW9uRmlsZX0nXG4gICAgICAgQU5EIHN0YXR1cyA9ICdjb21wbGV0ZWQnYFxuICAgICk7XG5cbiAgICBjb25zdCBjb3VudCA9IHJlc3VsdC5yZWNvcmRzPy5bMF0/LlswXT8ubG9uZ1ZhbHVlIHx8IDA7XG4gICAgcmV0dXJuIGNvdW50ID4gMDtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBJZiB3ZSBjYW4ndCBjaGVjaywgYXNzdW1lIG5vdCBydW5cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBSZWNvcmQgYSBtaWdyYXRpb24gZXhlY3V0aW9uIChzdWNjZXNzIG9yIGZhaWx1cmUpXG4gKlxuICogU2VjdXJpdHkgTm90ZTogU3RyaW5nIGNvbmNhdGVuYXRpb24gaXMgc2FmZSBoZXJlIGJlY2F1c2U6XG4gKiAtIG1pZ3JhdGlvbkZpbGUgY29tZXMgZnJvbSBoYXJkY29kZWQgTUlHUkFUSU9OX0ZJTEVTIGFycmF5XG4gKiAtIGVycm9yTWVzc2FnZSBpcyBmcm9tIGNhdWdodCBleGNlcHRpb25zLCBub3QgdXNlciBpbnB1dFxuICogLSBMYW1iZGEgaGFzIG5vIGV4dGVybmFsIGlucHV0IHZlY3RvcnNcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVjb3JkTWlncmF0aW9uKFxuICBjbHVzdGVyQXJuOiBzdHJpbmcsXG4gIHNlY3JldEFybjogc3RyaW5nLFxuICBkYXRhYmFzZTogc3RyaW5nLFxuICBtaWdyYXRpb25GaWxlOiBzdHJpbmcsXG4gIHN1Y2Nlc3M6IGJvb2xlYW4sXG4gIGV4ZWN1dGlvblRpbWU6IG51bWJlcixcbiAgZXJyb3JNZXNzYWdlPzogc3RyaW5nXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgbWF4U3RlcFJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTcWwoXG4gICAgY2x1c3RlckFybixcbiAgICBzZWNyZXRBcm4sXG4gICAgZGF0YWJhc2UsXG4gICAgYFNFTEVDVCBDT0FMRVNDRShNQVgoc3RlcF9udW1iZXIpLCAwKSArIDEgYXMgbmV4dF9zdGVwIEZST00gbWlncmF0aW9uX2xvZ2BcbiAgKTtcblxuICBjb25zdCBuZXh0U3RlcCA9IG1heFN0ZXBSZXN1bHQucmVjb3Jkcz8uWzBdPy5bMF0/LmxvbmdWYWx1ZSB8fCAxO1xuICBjb25zdCBzdGF0dXMgPSBzdWNjZXNzID8gJ2NvbXBsZXRlZCcgOiAnZmFpbGVkJztcblxuICBhd2FpdCBleGVjdXRlU3FsKFxuICAgIGNsdXN0ZXJBcm4sXG4gICAgc2VjcmV0QXJuLFxuICAgIGRhdGFiYXNlLFxuICAgIGBJTlNFUlQgSU5UTyBtaWdyYXRpb25fbG9nIChzdGVwX251bWJlciwgZGVzY3JpcHRpb24sIHNxbF9leGVjdXRlZCwgc3RhdHVzJHtlcnJvck1lc3NhZ2UgPyAnLCBlcnJvcl9tZXNzYWdlJyA6ICcnfSlcbiAgICAgVkFMVUVTICgke25leHRTdGVwfSwgJyR7bWlncmF0aW9uRmlsZX0nLCAnTWlncmF0aW9uIGZpbGUgZXhlY3V0ZWQnLCAnJHtzdGF0dXN9JyR7ZXJyb3JNZXNzYWdlID8gYCwgJyR7ZXJyb3JNZXNzYWdlLnJlcGxhY2UoLycvZywgXCInJ1wiKX0nYCA6ICcnfSlgXG4gICk7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgU1FMIHN0YXRlbWVudHMgZm9yIFJEUyBEYXRhIEFQSSBpbmNvbXBhdGliaWxpdGllc1xuICpcbiAqIERldGVjdHMgcGF0dGVybnMgdGhhdCBjYW5ub3QgcnVuIHByb3Blcmx5IHRocm91Z2ggUkRTIERhdGEgQVBJOlxuICogLSBDUkVBVEUgSU5ERVggQ09OQ1VSUkVOVExZIChyZXF1aXJlcyBhdXRvY29tbWl0LCBtdWx0aS10cmFuc2FjdGlvbilcbiAqIC0gRFJPUCBJTkRFWCBDT05DVVJSRU5UTFlcbiAqIC0gUkVJTkRFWCBDT05DVVJSRU5UTFlcbiAqXG4gKiBAdGhyb3dzIEVycm9yIGlmIGluY29tcGF0aWJsZSBwYXR0ZXJuIGRldGVjdGVkXG4gKi9cbmZ1bmN0aW9uIHZhbGlkYXRlU3RhdGVtZW50cyhzdGF0ZW1lbnRzOiBzdHJpbmdbXSwgZmlsZW5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBmb3IgKGNvbnN0IHN0YXRlbWVudCBvZiBzdGF0ZW1lbnRzKSB7XG4gICAgLy8gQ2hlY2sgZm9yIENPTkNVUlJFTlRMWSBrZXl3b3JkIChpbmNvbXBhdGlibGUgd2l0aCBSRFMgRGF0YSBBUEkpXG4gICAgaWYgKC9cXGJDT05DVVJSRU5UTFlcXGIvaS50ZXN0KHN0YXRlbWVudCkpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ+KUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgScpO1xuICAgICAgY29uc29sZS5lcnJvcign4p2MIFJEUyBEYXRhIEFQSSBJbmNvbXBhdGliaWxpdHkgRGV0ZWN0ZWQnKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ+KUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgeKUgScpO1xuICAgICAgY29uc29sZS5lcnJvcihgRmlsZTogJHtmaWxlbmFtZX1gKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoYFN0YXRlbWVudDogJHtzdGF0ZW1lbnQuc3Vic3RyaW5nKDAsIDE1MCl9Li4uYCk7XG4gICAgICBjb25zb2xlLmVycm9yKCcnKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0lTU1VFOiBDT05DVVJSRU5UTFkgb3BlcmF0aW9ucyBjYW5ub3QgcnVuIHRocm91Z2ggUkRTIERhdGEgQVBJJyk7XG4gICAgICBjb25zb2xlLmVycm9yKCdSRUFTT046IENPTkNVUlJFTlRMWSByZXF1aXJlcyBhdXRvY29tbWl0IG1vZGUgYW5kIHVzZXMgbXVsdGlwbGUnKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJyAgICAgICAgaW50ZXJuYWwgdHJhbnNhY3Rpb25zLCB3aGljaCBpcyBpbmNvbXBhdGlibGUgd2l0aCBEYXRhIEFQSScpO1xuICAgICAgY29uc29sZS5lcnJvcignJyk7XG4gICAgICBjb25zb2xlLmVycm9yKCdTT0xVVElPTjogUmVtb3ZlIENPTkNVUlJFTlRMWSBrZXl3b3JkIGZyb20gdGhlIHN0YXRlbWVudDonKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJyAgLSBVc2U6IENSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIGlkeF9uYW1lIE9OIHRhYmxlIChjb2x1bW4pOycpO1xuICAgICAgY29uc29sZS5lcnJvcignICAtIFRoaXMgd2lsbCBicmllZmx5IGxvY2sgd3JpdGVzIGJ1dCB3b3JrcyB3aXRoIERhdGEgQVBJJyk7XG4gICAgICBjb25zb2xlLmVycm9yKCcnKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0ZPUiBaRVJPLURPV05USU1FIElOREVYIENSRUFUSU9OOicpO1xuICAgICAgY29uc29sZS5lcnJvcignICAtIFVzZSBwc3FsIGRpcmVjdGx5IGR1cmluZyBtYWludGVuYW5jZSB3aW5kb3cnKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJyAgLSBDb25zaWRlciBhIHNlcGFyYXRlIG1haW50ZW5hbmNlIHNjcmlwdCBvdXRzaWRlIExhbWJkYScpO1xuICAgICAgY29uc29sZS5lcnJvcign4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSB4pSBJyk7XG5cbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYE1pZ3JhdGlvbiAke2ZpbGVuYW1lfSBjb250YWlucyBDT05DVVJSRU5UTFkga2V5d29yZCB3aGljaCBpcyBpbmNvbXBhdGlibGUgYCArXG4gICAgICAgIGB3aXRoIFJEUyBEYXRhIEFQSS4gVXNlICdDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUycgaW5zdGVhZC4gYCArXG4gICAgICAgIGBGb3IgemVyby1kb3dudGltZSBpbmRleCBjcmVhdGlvbiBvbiBsYXJnZSB0YWJsZXMsIHVzZSBwc3FsIGRpcmVjdGx5LmBcbiAgICAgICk7XG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogRXhlY3V0ZSBhbGwgc3RhdGVtZW50cyBpbiBhIFNRTCBmaWxlXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVGaWxlU3RhdGVtZW50cyhcbiAgY2x1c3RlckFybjogc3RyaW5nLFxuICBzZWNyZXRBcm46IHN0cmluZyxcbiAgZGF0YWJhc2U6IHN0cmluZyxcbiAgZmlsZW5hbWU6IHN0cmluZ1xuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNxbCA9IGF3YWl0IGdldFNxbENvbnRlbnQoZmlsZW5hbWUpO1xuICBjb25zdCBzdGF0ZW1lbnRzID0gc3BsaXRTcWxTdGF0ZW1lbnRzKHNxbCk7XG5cbiAgLy8gVmFsaWRhdGUgc3RhdGVtZW50cyBiZWZvcmUgZXhlY3V0aW9uIC0gZGV0ZWN0IGluY29tcGF0aWJsZSBwYXR0ZXJuc1xuICB2YWxpZGF0ZVN0YXRlbWVudHMoc3RhdGVtZW50cywgZmlsZW5hbWUpO1xuXG4gIGZvciAoY29uc3Qgc3RhdGVtZW50IG9mIHN0YXRlbWVudHMpIHtcbiAgICBpZiAoc3RhdGVtZW50LnRyaW0oKSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZXhlY3V0ZVNxbChjbHVzdGVyQXJuLCBzZWNyZXRBcm4sIGRhdGFiYXNlLCBzdGF0ZW1lbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgICAvLyBGb3IgaW5pdGlhbCBzZXR1cCBmaWxlcywgd2UgbWlnaHQgd2FudCB0byBjb250aW51ZSBvbiBcImFscmVhZHkgZXhpc3RzXCIgZXJyb3JzXG4gICAgICAgIC8vIEZvciBtaWdyYXRpb25zLCB3ZSBzaG91bGQgZmFpbCBmYXN0XG4gICAgICAgIGlmIChJTklUSUFMX1NFVFVQX0ZJTEVTLmluY2x1ZGVzKGZpbGVuYW1lKSAmJiBcbiAgICAgICAgICAgIChlcnJvci5tZXNzYWdlPy5pbmNsdWRlcygnYWxyZWFkeSBleGlzdHMnKSB8fCBcbiAgICAgICAgICAgICBlcnJvci5tZXNzYWdlPy5pbmNsdWRlcygnZHVwbGljYXRlIGtleScpKSkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKGDimqDvuI8gIFNraXBwaW5nIChhbHJlYWR5IGV4aXN0cyk6ICR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgICAgfSBlbHNlIGlmIChNSUdSQVRJT05fRklMRVMuaW5jbHVkZXMoZmlsZW5hbWUpKSB7XG4gICAgICAgICAgLy8gRm9yIG1pZ3JhdGlvbiBmaWxlcywgY2hlY2sgaWYgaXQncyBhbiBBTFRFUiBUQUJMRSB0aGF0IGFjdHVhbGx5IHN1Y2NlZWRlZFxuICAgICAgICAgIC8vIFJEUyBEYXRhIEFQSSBzb21ldGltZXMgcmV0dXJucyBhbiBlcnJvci1saWtlIHJlc3BvbnNlIGZvciBzdWNjZXNzZnVsIEFMVEVSIFRBQkxFc1xuICAgICAgICAgIGNvbnN0IGlzQWx0ZXJUYWJsZSA9IHN0YXRlbWVudC50cmltKCkudG9VcHBlckNhc2UoKS5zdGFydHNXaXRoKCdBTFRFUiBUQUJMRScpO1xuICAgICAgICAgIFxuICAgICAgICAgIGlmIChpc0FsdGVyVGFibGUpIHtcbiAgICAgICAgICAgIC8vIFZlcmlmeSBpZiB0aGUgQUxURVIgYWN0dWFsbHkgc3VjY2VlZGVkIGJ5IGNoZWNraW5nIHRoZSB0YWJsZSBzdHJ1Y3R1cmVcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGDimqDvuI8gIEFMVEVSIFRBQkxFIG1heSBoYXZlIHN1Y2NlZWRlZCBkZXNwaXRlIGVycm9yIHJlc3BvbnNlLiBWZXJpZnlpbmcuLi5gKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gRXh0cmFjdCB0YWJsZSBuYW1lIGFuZCBjb2x1bW4gZnJvbSBBTFRFUiBzdGF0ZW1lbnRcbiAgICAgICAgICAgIGNvbnN0IGFsdGVyTWF0Y2ggPSBzdGF0ZW1lbnQubWF0Y2goL0FMVEVSXFxzK1RBQkxFXFxzKyhcXHcrKVxccytBRERcXHMrQ09MVU1OXFxzKyhJRlxccytOT1RcXHMrRVhJU1RTXFxzKyk/KFxcdyspL2kpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoYWx0ZXJNYXRjaCkge1xuICAgICAgICAgICAgICBjb25zdCB0YWJsZU5hbWUgPSBhbHRlck1hdGNoWzFdO1xuICAgICAgICAgICAgICBjb25zdCBjb2x1bW5OYW1lID0gYWx0ZXJNYXRjaFszXTtcbiAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgLy8gQ2hlY2sgaWYgdGhlIGNvbHVtbiBleGlzdHNcbiAgICAgICAgICAgICAgICBjb25zdCBjaGVja1Jlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTcWwoXG4gICAgICAgICAgICAgICAgICBjbHVzdGVyQXJuLFxuICAgICAgICAgICAgICAgICAgc2VjcmV0QXJuLFxuICAgICAgICAgICAgICAgICAgZGF0YWJhc2UsXG4gICAgICAgICAgICAgICAgICBgU0VMRUNUIGNvbHVtbl9uYW1lIEZST00gaW5mb3JtYXRpb25fc2NoZW1hLmNvbHVtbnMgXG4gICAgICAgICAgICAgICAgICAgV0hFUkUgdGFibGVfc2NoZW1hID0gJ3B1YmxpYycgXG4gICAgICAgICAgICAgICAgICAgQU5EIHRhYmxlX25hbWUgPSAnJHt0YWJsZU5hbWV9JyBcbiAgICAgICAgICAgICAgICAgICBBTkQgY29sdW1uX25hbWUgPSAnJHtjb2x1bW5OYW1lfSdgXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAoY2hlY2tSZXN1bHQucmVjb3JkcyAmJiBjaGVja1Jlc3VsdC5yZWNvcmRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGDinIUgQ29sdW1uICR7Y29sdW1uTmFtZX0gZXhpc3RzIGluIHRhYmxlICR7dGFibGVOYW1lfSAtIEFMVEVSIHN1Y2NlZWRlZGApO1xuICAgICAgICAgICAgICAgICAgLy8gQ29sdW1uIGV4aXN0cywgc28gdGhlIEFMVEVSIHdvcmtlZCAtIGNvbnRpbnVlXG4gICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGNoZWNrRXJyb3IpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgQ291bGQgbm90IHZlcmlmeSBjb2x1bW4gZXhpc3RlbmNlOiAke2NoZWNrRXJyb3J9YCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgXG4gICAgICAgICAgLy8gSWYgd2UgY291bGRuJ3QgdmVyaWZ5IHN1Y2Nlc3MsIHRocm93IHRoZSBvcmlnaW5hbCBlcnJvclxuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVTcWwoXG4gIGNsdXN0ZXJBcm46IHN0cmluZyxcbiAgc2VjcmV0QXJuOiBzdHJpbmcsXG4gIGRhdGFiYXNlOiBzdHJpbmcsXG4gIHNxbDogc3RyaW5nXG4pOiBQcm9taXNlPGFueT4ge1xuICBjb25zdCBjb21tYW5kID0gbmV3IEV4ZWN1dGVTdGF0ZW1lbnRDb21tYW5kKHtcbiAgICByZXNvdXJjZUFybjogY2x1c3RlckFybixcbiAgICBzZWNyZXRBcm46IHNlY3JldEFybixcbiAgICBkYXRhYmFzZTogZGF0YWJhc2UsXG4gICAgc3FsOiBzcWwsXG4gICAgaW5jbHVkZVJlc3VsdE1ldGFkYXRhOiB0cnVlXG4gIH0pO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZHNDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAvLyBMb2cgdGhlIGZ1bGwgZXJyb3IgZm9yIGRlYnVnZ2luZ1xuICAgIGNvbnNvbGUuZXJyb3IoYFNRTCBleGVjdXRpb24gZXJyb3IgZm9yIHN0YXRlbWVudDogJHtzcWwuc3Vic3RyaW5nKDAsIDEwMCl9Li4uYCk7XG4gICAgY29uc29sZS5lcnJvcihgRXJyb3IgZGV0YWlsczpgLCBKU09OLnN0cmluZ2lmeShlcnJvciwgbnVsbCwgMikpO1xuICAgIFxuICAgIC8vIENoZWNrIGlmIHRoaXMgaXMgYSBmYWxzZS1wb3NpdGl2ZSBlcnJvciBmb3IgQUxURVIgVEFCTEVcbiAgICAvLyBSRFMgRGF0YSBBUEkgc29tZXRpbWVzIHJldHVybnMgZXJyb3JzIGZvciBzdWNjZXNzZnVsIERETCBvcGVyYXRpb25zXG4gICAgaWYgKHNxbC50cmltKCkudG9VcHBlckNhc2UoKS5zdGFydHNXaXRoKCdBTFRFUiBUQUJMRScpICYmIFxuICAgICAgICBlcnJvci5tZXNzYWdlICYmIFxuICAgICAgICAoZXJyb3IubWVzc2FnZS5pbmNsdWRlcygnRGF0YWJhc2UgcmV0dXJuZWQgU1FMIGV4Y2VwdGlvbicpIHx8IFxuICAgICAgICAgZXJyb3IubWVzc2FnZS5pbmNsdWRlcygnQmFkUmVxdWVzdEV4Y2VwdGlvbicpKSkge1xuICAgICAgY29uc29sZS5sb2coYOKaoO+4jyAgUG90ZW50aWFsIGZhbHNlLXBvc2l0aXZlIGVycm9yIGZvciBBTFRFUiBUQUJMRSAtIHdpbGwgdmVyaWZ5IGluIGNhbGxlcmApO1xuICAgIH1cbiAgICBcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG5mdW5jdGlvbiBzcGxpdFNxbFN0YXRlbWVudHMoc3FsOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIC8vIFJlbW92ZSBjb21tZW50c1xuICBjb25zdCB3aXRob3V0Q29tbWVudHMgPSBzcWxcbiAgICAuc3BsaXQoJ1xcbicpXG4gICAgLmZpbHRlcihsaW5lID0+ICFsaW5lLnRyaW0oKS5zdGFydHNXaXRoKCctLScpKVxuICAgIC5qb2luKCdcXG4nKTtcblxuICAvLyBTcGxpdCBieSBzZW1pY29sb24gYnV0IGhhbmRsZSBDUkVBVEUgVFlQRS9GVU5DVElPTiBibG9ja3Mgc3BlY2lhbGx5XG4gIGNvbnN0IHN0YXRlbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGxldCBjdXJyZW50U3RhdGVtZW50ID0gJyc7XG4gIGxldCBpbkJsb2NrID0gZmFsc2U7XG4gIFxuICBjb25zdCBsaW5lcyA9IHdpdGhvdXRDb21tZW50cy5zcGxpdCgnXFxuJyk7XG4gIFxuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICBjb25zdCB0cmltbWVkTGluZSA9IGxpbmUudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgXG4gICAgLy8gQ2hlY2sgaWYgd2UncmUgZW50ZXJpbmcgYSBibG9jayAoQ1JFQVRFIFRZUEUsIENSRUFURSBGVU5DVElPTiwgZXRjLilcbiAgICBpZiAodHJpbW1lZExpbmUuc3RhcnRzV2l0aCgnQ1JFQVRFIFRZUEUnKSB8fCBcbiAgICAgICAgdHJpbW1lZExpbmUuc3RhcnRzV2l0aCgnQ1JFQVRFIEZVTkNUSU9OJykgfHxcbiAgICAgICAgdHJpbW1lZExpbmUuc3RhcnRzV2l0aCgnQ1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04nKSB8fFxuICAgICAgICB0cmltbWVkTGluZS5zdGFydHNXaXRoKCdEUk9QIFRZUEUnKSkge1xuICAgICAgaW5CbG9jayA9IHRydWU7XG4gICAgfVxuICAgIFxuICAgIGN1cnJlbnRTdGF0ZW1lbnQgKz0gbGluZSArICdcXG4nO1xuICAgIFxuICAgIC8vIENoZWNrIGlmIHRoaXMgbGluZSBlbmRzIHdpdGggYSBzZW1pY29sb25cbiAgICBpZiAobGluZS50cmltKCkuZW5kc1dpdGgoJzsnKSkge1xuICAgICAgLy8gSWYgd2UncmUgaW4gYSBibG9jaywgY2hlY2sgaWYgdGhpcyBpcyB0aGUgZW5kXG4gICAgICBpZiAoaW5CbG9jayAmJiAodHJpbW1lZExpbmUgPT09ICcpOycgfHwgdHJpbW1lZExpbmUuZW5kc1dpdGgoJyk7JykgfHwgdHJpbW1lZExpbmUuZW5kc1dpdGgoXCInIExBTkdVQUdFIFBMUEdTUUw7XCIpKSkge1xuICAgICAgICBpbkJsb2NrID0gZmFsc2U7XG4gICAgICB9XG4gICAgICBcbiAgICAgIC8vIElmIG5vdCBpbiBhIGJsb2NrLCB0aGlzIHN0YXRlbWVudCBpcyBjb21wbGV0ZVxuICAgICAgaWYgKCFpbkJsb2NrKSB7XG4gICAgICAgIHN0YXRlbWVudHMucHVzaChjdXJyZW50U3RhdGVtZW50LnRyaW0oKSk7XG4gICAgICAgIGN1cnJlbnRTdGF0ZW1lbnQgPSAnJztcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgXG4gIC8vIEFkZCBhbnkgcmVtYWluaW5nIHN0YXRlbWVudFxuICBpZiAoY3VycmVudFN0YXRlbWVudC50cmltKCkpIHtcbiAgICBzdGF0ZW1lbnRzLnB1c2goY3VycmVudFN0YXRlbWVudC50cmltKCkpO1xuICB9XG4gIFxuICByZXR1cm4gc3RhdGVtZW50cztcbn1cblxuLy8gTG9hZCBTUUwgY29udGVudCBmcm9tIGJ1bmRsZWQgc2NoZW1hIGZpbGVzXG5hc3luYyBmdW5jdGlvbiBnZXRTcWxDb250ZW50KGZpbGVuYW1lOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBmcyA9IHJlcXVpcmUoJ2ZzJykucHJvbWlzZXM7XG4gIGNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG4gIFxuICB0cnkge1xuICAgIC8vIFNjaGVtYSBmaWxlcyBhcmUgY29waWVkIHRvIHRoZSBMYW1iZGEgZGVwbG95bWVudCBwYWNrYWdlXG4gICAgY29uc3Qgc2NoZW1hUGF0aCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICdzY2hlbWEnLCBmaWxlbmFtZSk7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IGZzLnJlYWRGaWxlKHNjaGVtYVBhdGgsICd1dGY4Jyk7XG4gICAgcmV0dXJuIGNvbnRlbnQ7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcihgRmFpbGVkIHRvIHJlYWQgU1FMIGZpbGUgJHtmaWxlbmFtZX06YCwgZXJyb3IpO1xuICAgIHRocm93IG5ldyBFcnJvcihgQ291bGQgbm90IGxvYWQgU1FMIGZpbGU6ICR7ZmlsZW5hbWV9YCk7XG4gIH1cbn1cblxuIl19