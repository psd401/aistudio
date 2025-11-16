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
    '040-latimer-ai-models.sql'
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
    console.log('Handler version: 2025-07-31-v8 - Added required icon field');
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
 * Execute all statements in a SQL file
 */
async function executeFileStatements(clusterArn, secretArn, database, filename) {
    const sql = await getSqlContent(filename);
    const statements = splitSqlStatements(sql);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGItaW5pdC1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZGItaW5pdC1oYW5kbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBeUVBLDBCQWdGQztBQXpKRCw4REFBa0Y7QUFDbEYsNEVBQThGO0FBRTlGLE1BQU0sU0FBUyxHQUFHLElBQUksK0JBQWEsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN4QyxNQUFNLGFBQWEsR0FBRyxJQUFJLDZDQUFvQixDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBYW5EOzs7Ozs7Ozs7OztHQVdHO0FBRUgseURBQXlEO0FBQ3pELHlFQUF5RTtBQUN6RSxNQUFNLGVBQWUsR0FBRztJQUN0QixnQ0FBZ0M7SUFDaEMsc0JBQXNCO0lBQ3RCLHVCQUF1QjtJQUN2Qix5Q0FBeUM7SUFDekMsMkJBQTJCO0lBQzNCLGdDQUFnQztJQUNoQywwQ0FBMEM7SUFDMUMsbUNBQW1DO0lBQ25DLGlDQUFpQztJQUNqQyxxQ0FBcUM7SUFDckMsK0JBQStCO0lBQy9CLGdDQUFnQztJQUNoQyxpQ0FBaUM7SUFDakMsa0NBQWtDO0lBQ2xDLGlDQUFpQztJQUNqQyxzQkFBc0I7SUFDdEIsc0NBQXNDO0lBQ3RDLGdDQUFnQztJQUNoQyx3QkFBd0I7SUFDeEIsMENBQTBDO0lBQzFDLDJCQUEyQjtJQUMzQiwyQ0FBMkM7SUFDM0Msb0NBQW9DO0lBQ3BDLG1DQUFtQztJQUNuQyxvQ0FBb0M7SUFDcEMsK0JBQStCO0lBQy9CLDJCQUEyQjtJQUMzQiw4REFBOEQ7Q0FDL0QsQ0FBQztBQUVGLG1EQUFtRDtBQUNuRCxpRUFBaUU7QUFDakUsTUFBTSxtQkFBbUIsR0FBRztJQUMxQixlQUFlLEVBQU8scUJBQXFCO0lBQzNDLGdCQUFnQixFQUFNLDBCQUEwQjtJQUNoRCxxQkFBcUIsRUFBRSwrQkFBK0I7SUFDdEQsaUJBQWlCLEVBQU0sOEJBQThCO0lBQ3JELHNCQUFzQixDQUFDLDZCQUE2QjtDQUNyRCxDQUFDO0FBRUssS0FBSyxVQUFVLE9B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QyxVQUFVLEVBQUUsTUFBTSxDQUFDLENBQUM7UUFDdEQsT0FBTyxPQUFPLENBQUM7SUFDakIsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLENBQUMsS0FBSyxDQUFDLDJCQUEyQixRQUFRLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUM3RCxNQUFNLElBQUksS0FBSyxDQUFDLDRCQUE0QixRQUFRLEVBQUUsQ0FBQyxDQUFDO0lBQzFELENBQUM7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUkRTRGF0YUNsaWVudCwgRXhlY3V0ZVN0YXRlbWVudENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtcmRzLWRhdGEnO1xuaW1wb3J0IHsgR2V0U2VjcmV0VmFsdWVDb21tYW5kLCBTZWNyZXRzTWFuYWdlckNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zZWNyZXRzLW1hbmFnZXInO1xuXG5jb25zdCByZHNDbGllbnQgPSBuZXcgUkRTRGF0YUNsaWVudCh7fSk7XG5jb25zdCBzZWNyZXRzQ2xpZW50ID0gbmV3IFNlY3JldHNNYW5hZ2VyQ2xpZW50KHt9KTtcblxuaW50ZXJmYWNlIEN1c3RvbVJlc291cmNlRXZlbnQge1xuICBSZXF1ZXN0VHlwZTogJ0NyZWF0ZScgfCAnVXBkYXRlJyB8ICdEZWxldGUnO1xuICBSZXNvdXJjZVByb3BlcnRpZXM6IHtcbiAgICBDbHVzdGVyQXJuOiBzdHJpbmc7XG4gICAgU2VjcmV0QXJuOiBzdHJpbmc7XG4gICAgRGF0YWJhc2VOYW1lOiBzdHJpbmc7XG4gICAgRW52aXJvbm1lbnQ6IHN0cmluZztcbiAgfTtcbiAgUGh5c2ljYWxSZXNvdXJjZUlkPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIENSSVRJQ0FMOiBEYXRhYmFzZSBJbml0aWFsaXphdGlvbiBhbmQgTWlncmF0aW9uIEhhbmRsZXJcbiAqIFxuICogVGhpcyBMYW1iZGEgaGFuZGxlcyBUV08gZGlzdGluY3Qgc2NlbmFyaW9zOlxuICogMS4gRnJlc2ggSW5zdGFsbGF0aW9uOiBSdW5zIGFsbCBpbml0aWFsIHNldHVwIGZpbGVzICgwMDEtMDA1KVxuICogMi4gRXhpc3RpbmcgRGF0YWJhc2U6IE9OTFkgcnVucyBtaWdyYXRpb24gZmlsZXMgKDAxMCspXG4gKiBcbiAqIFdBUk5JTkc6IFRoZSBpbml0aWFsIHNldHVwIGZpbGVzICgwMDEtMDA1KSBNVVNUIGV4YWN0bHkgbWF0Y2ggdGhlIGV4aXN0aW5nXG4gKiBkYXRhYmFzZSBzdHJ1Y3R1cmUgb3IgdGhleSB3aWxsIGNhdXNlIGRhdGEgY29ycnVwdGlvbiFcbiAqIFxuICogQHNlZSAvZG9jcy9kYXRhYmFzZS1yZXN0b3JhdGlvbi9EQVRBQkFTRS1NSUdSQVRJT05TLm1kIGZvciBmdWxsIGRldGFpbHNcbiAqL1xuXG4vLyBNaWdyYXRpb24gZmlsZXMgdGhhdCBzaG91bGQgQUxXQVlTIHJ1biAoYWRkaXRpdmUgb25seSlcbi8vIFRoZXNlIGZpbGVzIHNob3VsZCBPTkxZIGNyZWF0ZSBuZXcgb2JqZWN0cywgbmV2ZXIgbW9kaWZ5IGV4aXN0aW5nIG9uZXNcbmNvbnN0IE1JR1JBVElPTl9GSUxFUyA9IFtcbiAgJzAxMC1rbm93bGVkZ2UtcmVwb3NpdG9yaWVzLnNxbCcsXG4gICcxMV90ZXh0cmFjdF9qb2JzLnNxbCcsXG4gICcxMl90ZXh0cmFjdF91c2FnZS5zcWwnLFxuICAnMDEzLWFkZC1rbm93bGVkZ2UtcmVwb3NpdG9yaWVzLXRvb2wuc3FsJyxcbiAgJzAxNC1tb2RlbC1jb21wYXJpc29ucy5zcWwnLFxuICAnMDE1LWFkZC1tb2RlbC1jb21wYXJlLXRvb2wuc3FsJyxcbiAgJzAxNi1hc3Npc3RhbnQtYXJjaGl0ZWN0LXJlcG9zaXRvcmllcy5zcWwnLFxuICAnMDE3LWFkZC11c2VyLXJvbGVzLXVwZGF0ZWQtYXQuc3FsJyxcbiAgJzAxOC1tb2RlbC1yZXBsYWNlbWVudC1hdWRpdC5zcWwnLFxuICAnMDE5LWZpeC1uYXZpZ2F0aW9uLXJvbGUtZGlzcGxheS5zcWwnLFxuICAnMDIwLWFkZC11c2VyLXJvbGUtdmVyc2lvbi5zcWwnLFxuICAnMDIzLW5hdmlnYXRpb24tbXVsdGktcm9sZXMuc3FsJyxcbiAgJzAyNC1tb2RlbC1yb2xlLXJlc3RyaWN0aW9ucy5zcWwnLFxuICAnMDI2LWFkZC1tb2RlbC1jb21wYXJlLXNvdXJjZS5zcWwnLFxuICAnMDI3LW1lc3NhZ2VzLW1vZGVsLXRyYWNraW5nLnNxbCcsXG4gICcwMjgtbmV4dXMtc2NoZW1hLnNxbCcsXG4gICcwMjktYWktbW9kZWxzLW5leHVzLWVuaGFuY2VtZW50cy5zcWwnLFxuICAnMDMwLW5leHVzLXByb3ZpZGVyLW1ldHJpY3Muc3FsJyxcbiAgJzAzMS1uZXh1cy1tZXNzYWdlcy5zcWwnLFxuICAnMDMyLXJlbW92ZS1uZXh1cy1wcm92aWRlci1jb25zdHJhaW50LnNxbCcsXG4gICcwMzMtYWktc3RyZWFtaW5nLWpvYnMuc3FsJyxcbiAgJzAzNC1hc3Npc3RhbnQtYXJjaGl0ZWN0LWVuYWJsZWQtdG9vbHMuc3FsJyxcbiAgJzAzNS1zY2hlZHVsZS1tYW5hZ2VtZW50LXNjaGVtYS5zcWwnLFxuICAnMDM2LXJlbW92ZS1sZWdhY3ktY2hhdC10YWJsZXMuc3FsJyxcbiAgJzAzNy1hc3Npc3RhbnQtYXJjaGl0ZWN0LWV2ZW50cy5zcWwnLFxuICAnMDM5LXByb21wdC1saWJyYXJ5LXNjaGVtYS5zcWwnLFxuICAnMDQwLWxhdGltZXItYWktbW9kZWxzLnNxbCdcbiAgLy8gQUREIE5FVyBNSUdSQVRJT05TIEhFUkUgLSB0aGV5IHdpbGwgcnVuIG9uY2UgYW5kIGJlIHRyYWNrZWRcbl07XG5cbi8vIEluaXRpYWwgc2V0dXAgZmlsZXMgKG9ubHkgcnVuIG9uIGVtcHR5IGRhdGFiYXNlKVxuLy8gV0FSTklORzogVGhlc2UgbXVzdCBFWEFDVExZIG1hdGNoIGV4aXN0aW5nIGRhdGFiYXNlIHN0cnVjdHVyZSFcbmNvbnN0IElOSVRJQUxfU0VUVVBfRklMRVMgPSBbXG4gICcwMDEtZW51bXMuc3FsJywgICAgICAvLyBDcmVhdGVzIGVudW0gdHlwZXNcbiAgJzAwMi10YWJsZXMuc3FsJywgICAgIC8vIENyZWF0ZXMgYWxsIGNvcmUgdGFibGVzXG4gICcwMDMtY29uc3RyYWludHMuc3FsJywgLy8gQWRkcyBmb3JlaWduIGtleSBjb25zdHJhaW50c1xuICAnMDA0LWluZGV4ZXMuc3FsJywgICAgIC8vIENyZWF0ZXMgcGVyZm9ybWFuY2UgaW5kZXhlc1xuICAnMDA1LWluaXRpYWwtZGF0YS5zcWwnIC8vIEluc2VydHMgcmVxdWlyZWQgc2VlZCBkYXRhXG5dO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihldmVudDogQ3VzdG9tUmVzb3VyY2VFdmVudCk6IFByb21pc2U8YW55PiB7XG4gIGNvbnNvbGUubG9nKCdEYXRhYmFzZSBpbml0aWFsaXphdGlvbiBldmVudDonLCBKU09OLnN0cmluZ2lmeShldmVudCwgbnVsbCwgMikpO1xuICBjb25zb2xlLmxvZygnSGFuZGxlciB2ZXJzaW9uOiAyMDI1LTA3LTMxLXY4IC0gQWRkZWQgcmVxdWlyZWQgaWNvbiBmaWVsZCcpO1xuICBcbiAgLy8gU0FGRVRZIENIRUNLOiBMb2cgd2hhdCBtb2RlIHdlJ3JlIGluXG4gIGNvbnNvbGUubG9nKGDwn5SNIENoZWNraW5nIGRhdGFiYXNlIHN0YXRlIGZvciBzYWZldHkuLi5gKTtcblxuICAvLyBPbmx5IHJ1biBvbiBDcmVhdGUgb3IgVXBkYXRlXG4gIGlmIChldmVudC5SZXF1ZXN0VHlwZSA9PT0gJ0RlbGV0ZScpIHtcbiAgICByZXR1cm4ge1xuICAgICAgUGh5c2ljYWxSZXNvdXJjZUlkOiBldmVudC5QaHlzaWNhbFJlc291cmNlSWQgfHwgJ2RiLWluaXQnLFxuICAgICAgU3RhdHVzOiAnU1VDQ0VTUycsXG4gICAgICBSZWFzb246ICdEZWxldGUgbm90IHJlcXVpcmVkIGZvciBkYXRhYmFzZSBpbml0aWFsaXphdGlvbidcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgeyBDbHVzdGVyQXJuLCBTZWNyZXRBcm4sIERhdGFiYXNlTmFtZSwgRW52aXJvbm1lbnQgfSA9IGV2ZW50LlJlc291cmNlUHJvcGVydGllcztcblxuICB0cnkge1xuICAgIC8vIENSSVRJQ0FMOiBDaGVjayBpZiB0aGlzIGlzIGEgZnJlc2ggZGF0YWJhc2Ugb3IgZXhpc3Rpbmcgb25lXG4gICAgY29uc3QgaXNEYXRhYmFzZUVtcHR5ID0gYXdhaXQgY2hlY2tJZkRhdGFiYXNlRW1wdHkoQ2x1c3RlckFybiwgU2VjcmV0QXJuLCBEYXRhYmFzZU5hbWUpO1xuICAgIFxuICAgIGlmIChpc0RhdGFiYXNlRW1wdHkpIHtcbiAgICAgIGNvbnNvbGUubG9nKCfwn4aVIEVtcHR5IGRhdGFiYXNlIGRldGVjdGVkIC0gcnVubmluZyBmdWxsIGluaXRpYWxpemF0aW9uJyk7XG4gICAgICBcbiAgICAgIC8vIFJ1biBpbml0aWFsIHNldHVwIGZpbGVzIGZvciBmcmVzaCBpbnN0YWxsYXRpb25cbiAgICAgIGZvciAoY29uc3Qgc3FsRmlsZSBvZiBJTklUSUFMX1NFVFVQX0ZJTEVTKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGBFeGVjdXRpbmcgaW5pdGlhbCBzZXR1cDogJHtzcWxGaWxlfWApO1xuICAgICAgICBhd2FpdCBleGVjdXRlRmlsZVN0YXRlbWVudHMoQ2x1c3RlckFybiwgU2VjcmV0QXJuLCBEYXRhYmFzZU5hbWUsIHNxbEZpbGUpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBjb25zb2xlLmxvZygn4pyFIEV4aXN0aW5nIGRhdGFiYXNlIGRldGVjdGVkIC0gc2tpcHBpbmcgaW5pdGlhbCBzZXR1cCBmaWxlcycpO1xuICAgICAgY29uc29sZS5sb2coJ+KaoO+4jyAgT05MWSBtaWdyYXRpb24gZmlsZXMgd2lsbCBiZSBwcm9jZXNzZWQnKTtcbiAgICB9XG5cbiAgICAvLyBBTFdBWVMgcnVuIG1pZ3JhdGlvbnMgKHRoZXkgc2hvdWxkIGJlIGlkZW1wb3RlbnQgYW5kIHNhZmUpXG4gICAgY29uc29sZS5sb2coJ/CflIQgUHJvY2Vzc2luZyBtaWdyYXRpb25zLi4uJyk7XG4gICAgXG4gICAgLy8gRW5zdXJlIG1pZ3JhdGlvbiB0cmFja2luZyB0YWJsZSBleGlzdHNcbiAgICBhd2FpdCBlbnN1cmVNaWdyYXRpb25UYWJsZShDbHVzdGVyQXJuLCBTZWNyZXRBcm4sIERhdGFiYXNlTmFtZSk7XG4gICAgXG4gICAgLy8gUnVuIGVhY2ggbWlncmF0aW9uIHRoYXQgaGFzbid0IGJlZW4gcnVuIHlldFxuICAgIGZvciAoY29uc3QgbWlncmF0aW9uRmlsZSBvZiBNSUdSQVRJT05fRklMRVMpIHtcbiAgICAgIGNvbnN0IGhhc1J1biA9IGF3YWl0IGNoZWNrTWlncmF0aW9uUnVuKENsdXN0ZXJBcm4sIFNlY3JldEFybiwgRGF0YWJhc2VOYW1lLCBtaWdyYXRpb25GaWxlKTtcbiAgICAgIFxuICAgICAgaWYgKCFoYXNSdW4pIHtcbiAgICAgICAgY29uc29sZS5sb2coYOKWtu+4jyAgUnVubmluZyBtaWdyYXRpb246ICR7bWlncmF0aW9uRmlsZX1gKTtcbiAgICAgICAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcbiAgICAgICAgXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgZXhlY3V0ZUZpbGVTdGF0ZW1lbnRzKENsdXN0ZXJBcm4sIFNlY3JldEFybiwgRGF0YWJhc2VOYW1lLCBtaWdyYXRpb25GaWxlKTtcbiAgICAgICAgICBcbiAgICAgICAgICAvLyBSZWNvcmQgc3VjY2Vzc2Z1bCBtaWdyYXRpb25cbiAgICAgICAgICBhd2FpdCByZWNvcmRNaWdyYXRpb24oQ2x1c3RlckFybiwgU2VjcmV0QXJuLCBEYXRhYmFzZU5hbWUsIG1pZ3JhdGlvbkZpbGUsIHRydWUsIERhdGUubm93KCkgLSBzdGFydFRpbWUpO1xuICAgICAgICAgIGNvbnNvbGUubG9nKGDinIUgTWlncmF0aW9uICR7bWlncmF0aW9uRmlsZX0gY29tcGxldGVkIHN1Y2Nlc3NmdWxseWApO1xuICAgICAgICAgIFxuICAgICAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICAgICAgLy8gUmVjb3JkIGZhaWxlZCBtaWdyYXRpb25cbiAgICAgICAgICBhd2FpdCByZWNvcmRNaWdyYXRpb24oQ2x1c3RlckFybiwgU2VjcmV0QXJuLCBEYXRhYmFzZU5hbWUsIG1pZ3JhdGlvbkZpbGUsIGZhbHNlLCBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLCBlcnJvci5tZXNzYWdlKTtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE1pZ3JhdGlvbiAke21pZ3JhdGlvbkZpbGV9IGZhaWxlZDogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZyhg4o+t77iPICBTa2lwcGluZyBtaWdyYXRpb24gJHttaWdyYXRpb25GaWxlfSAtIGFscmVhZHkgcnVuYCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIFBoeXNpY2FsUmVzb3VyY2VJZDogJ2RiLWluaXQnLFxuICAgICAgU3RhdHVzOiAnU1VDQ0VTUycsXG4gICAgICBSZWFzb246ICdEYXRhYmFzZSBpbml0aWFsaXphdGlvbi9taWdyYXRpb24gY29tcGxldGVkIHN1Y2Nlc3NmdWxseSdcbiAgICB9O1xuXG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcign4p2MIERhdGFiYXNlIG9wZXJhdGlvbiBmYWlsZWQ6JywgZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBQaHlzaWNhbFJlc291cmNlSWQ6ICdkYi1pbml0JyxcbiAgICAgIFN0YXR1czogJ0ZBSUxFRCcsXG4gICAgICBSZWFzb246IGBEYXRhYmFzZSBvcGVyYXRpb24gZmFpbGVkOiAke2Vycm9yfWBcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgZGF0YWJhc2UgaXMgZW1wdHkgKGZyZXNoIGluc3RhbGxhdGlvbilcbiAqIFJldHVybnMgdHJ1ZSBpZiBubyBjb3JlIHRhYmxlcyBleGlzdCwgZmFsc2UgaWYgZGF0YWJhc2UgaGFzIGJlZW4gaW5pdGlhbGl6ZWRcbiAqL1xuYXN5bmMgZnVuY3Rpb24gY2hlY2tJZkRhdGFiYXNlRW1wdHkoXG4gIGNsdXN0ZXJBcm46IHN0cmluZyxcbiAgc2VjcmV0QXJuOiBzdHJpbmcsXG4gIGRhdGFiYXNlOiBzdHJpbmdcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICB0cnkge1xuICAgIC8vIENoZWNrIGlmIHVzZXJzIHRhYmxlIGV4aXN0cyAoY29yZSB0YWJsZSB0aGF0IHNob3VsZCBhbHdheXMgZXhpc3QpXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZXhlY3V0ZVNxbChcbiAgICAgIGNsdXN0ZXJBcm4sXG4gICAgICBzZWNyZXRBcm4sXG4gICAgICBkYXRhYmFzZSxcbiAgICAgIGBTRUxFQ1QgQ09VTlQoKikgRlJPTSBpbmZvcm1hdGlvbl9zY2hlbWEudGFibGVzIFxuICAgICAgIFdIRVJFIHRhYmxlX3NjaGVtYSA9ICdwdWJsaWMnIFxuICAgICAgIEFORCB0YWJsZV9uYW1lID0gJ3VzZXJzJ2BcbiAgICApO1xuICAgIFxuICAgIGNvbnN0IGNvdW50ID0gcmVzdWx0LnJlY29yZHM/LlswXT8uWzBdPy5sb25nVmFsdWUgfHwgMDtcbiAgICByZXR1cm4gY291bnQgPT09IDA7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgLy8gSWYgd2UgY2FuJ3QgY2hlY2ssIGFzc3VtZSBlbXB0eSBmb3Igc2FmZXR5XG4gICAgY29uc29sZS5sb2coJ0NvdWxkIG5vdCBjaGVjayBpZiBkYXRhYmFzZSBpcyBlbXB0eSwgYXNzdW1pbmcgZnJlc2ggaW5zdGFsbCcpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5cbi8qKlxuICogRW5zdXJlIG1pZ3JhdGlvbiB0cmFja2luZyB0YWJsZSBleGlzdHNcbiAqIFRoaXMgdGFibGUgdHJhY2tzIHdoaWNoIG1pZ3JhdGlvbnMgaGF2ZSBiZWVuIHJ1blxuICovXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVNaWdyYXRpb25UYWJsZShcbiAgY2x1c3RlckFybjogc3RyaW5nLFxuICBzZWNyZXRBcm46IHN0cmluZyxcbiAgZGF0YWJhc2U6IHN0cmluZ1xuKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIFRoaXMgZXhhY3RseSBtYXRjaGVzIHRoZSBleGlzdGluZyBtaWdyYXRpb25fbG9nIHN0cnVjdHVyZSBmcm9tIEp1bmUgMjAyNSBkYXRhYmFzZVxuICBjb25zdCBzcWwgPSBgXG4gICAgQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgbWlncmF0aW9uX2xvZyAoXG4gICAgICBpZCBTRVJJQUwgUFJJTUFSWSBLRVksXG4gICAgICBzdGVwX251bWJlciBJTlRFR0VSIE5PVCBOVUxMLFxuICAgICAgZGVzY3JpcHRpb24gVEVYVCBOT1QgTlVMTCxcbiAgICAgIHNxbF9leGVjdXRlZCBURVhULFxuICAgICAgc3RhdHVzIFZBUkNIQVIoMjApIERFRkFVTFQgJ3BlbmRpbmcnLFxuICAgICAgZXJyb3JfbWVzc2FnZSBURVhULFxuICAgICAgZXhlY3V0ZWRfYXQgVElNRVNUQU1QIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVBcbiAgICApXG4gIGA7XG4gIFxuICBhd2FpdCBleGVjdXRlU3FsKGNsdXN0ZXJBcm4sIHNlY3JldEFybiwgZGF0YWJhc2UsIHNxbCk7XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYSBzcGVjaWZpYyBtaWdyYXRpb24gaGFzIGFscmVhZHkgYmVlbiBydW5cbiAqXG4gKiBTZWN1cml0eSBOb3RlOiBTdHJpbmcgY29uY2F0ZW5hdGlvbiBpcyBzYWZlIGhlcmUgYmVjYXVzZSBtaWdyYXRpb25GaWxlXG4gKiBjb21lcyBmcm9tIHRoZSBoYXJkY29kZWQgTUlHUkFUSU9OX0ZJTEVTIGFycmF5LCBub3QgdXNlciBpbnB1dC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY2hlY2tNaWdyYXRpb25SdW4oXG4gIGNsdXN0ZXJBcm46IHN0cmluZyxcbiAgc2VjcmV0QXJuOiBzdHJpbmcsXG4gIGRhdGFiYXNlOiBzdHJpbmcsXG4gIG1pZ3JhdGlvbkZpbGU6IHN0cmluZ1xuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZXhlY3V0ZVNxbChcbiAgICAgIGNsdXN0ZXJBcm4sXG4gICAgICBzZWNyZXRBcm4sXG4gICAgICBkYXRhYmFzZSxcbiAgICAgIGBTRUxFQ1QgQ09VTlQoKikgRlJPTSBtaWdyYXRpb25fbG9nXG4gICAgICAgV0hFUkUgZGVzY3JpcHRpb24gPSAnJHttaWdyYXRpb25GaWxlfSdcbiAgICAgICBBTkQgc3RhdHVzID0gJ2NvbXBsZXRlZCdgXG4gICAgKTtcblxuICAgIGNvbnN0IGNvdW50ID0gcmVzdWx0LnJlY29yZHM/LlswXT8uWzBdPy5sb25nVmFsdWUgfHwgMDtcbiAgICByZXR1cm4gY291bnQgPiAwO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIElmIHdlIGNhbid0IGNoZWNrLCBhc3N1bWUgbm90IHJ1blxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIFJlY29yZCBhIG1pZ3JhdGlvbiBleGVjdXRpb24gKHN1Y2Nlc3Mgb3IgZmFpbHVyZSlcbiAqXG4gKiBTZWN1cml0eSBOb3RlOiBTdHJpbmcgY29uY2F0ZW5hdGlvbiBpcyBzYWZlIGhlcmUgYmVjYXVzZTpcbiAqIC0gbWlncmF0aW9uRmlsZSBjb21lcyBmcm9tIGhhcmRjb2RlZCBNSUdSQVRJT05fRklMRVMgYXJyYXlcbiAqIC0gZXJyb3JNZXNzYWdlIGlzIGZyb20gY2F1Z2h0IGV4Y2VwdGlvbnMsIG5vdCB1c2VyIGlucHV0XG4gKiAtIExhbWJkYSBoYXMgbm8gZXh0ZXJuYWwgaW5wdXQgdmVjdG9yc1xuICovXG5hc3luYyBmdW5jdGlvbiByZWNvcmRNaWdyYXRpb24oXG4gIGNsdXN0ZXJBcm46IHN0cmluZyxcbiAgc2VjcmV0QXJuOiBzdHJpbmcsXG4gIGRhdGFiYXNlOiBzdHJpbmcsXG4gIG1pZ3JhdGlvbkZpbGU6IHN0cmluZyxcbiAgc3VjY2VzczogYm9vbGVhbixcbiAgZXhlY3V0aW9uVGltZTogbnVtYmVyLFxuICBlcnJvck1lc3NhZ2U/OiBzdHJpbmdcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBtYXhTdGVwUmVzdWx0ID0gYXdhaXQgZXhlY3V0ZVNxbChcbiAgICBjbHVzdGVyQXJuLFxuICAgIHNlY3JldEFybixcbiAgICBkYXRhYmFzZSxcbiAgICBgU0VMRUNUIENPQUxFU0NFKE1BWChzdGVwX251bWJlciksIDApICsgMSBhcyBuZXh0X3N0ZXAgRlJPTSBtaWdyYXRpb25fbG9nYFxuICApO1xuXG4gIGNvbnN0IG5leHRTdGVwID0gbWF4U3RlcFJlc3VsdC5yZWNvcmRzPy5bMF0/LlswXT8ubG9uZ1ZhbHVlIHx8IDE7XG4gIGNvbnN0IHN0YXR1cyA9IHN1Y2Nlc3MgPyAnY29tcGxldGVkJyA6ICdmYWlsZWQnO1xuXG4gIGF3YWl0IGV4ZWN1dGVTcWwoXG4gICAgY2x1c3RlckFybixcbiAgICBzZWNyZXRBcm4sXG4gICAgZGF0YWJhc2UsXG4gICAgYElOU0VSVCBJTlRPIG1pZ3JhdGlvbl9sb2cgKHN0ZXBfbnVtYmVyLCBkZXNjcmlwdGlvbiwgc3FsX2V4ZWN1dGVkLCBzdGF0dXMke2Vycm9yTWVzc2FnZSA/ICcsIGVycm9yX21lc3NhZ2UnIDogJyd9KVxuICAgICBWQUxVRVMgKCR7bmV4dFN0ZXB9LCAnJHttaWdyYXRpb25GaWxlfScsICdNaWdyYXRpb24gZmlsZSBleGVjdXRlZCcsICcke3N0YXR1c30nJHtlcnJvck1lc3NhZ2UgPyBgLCAnJHtlcnJvck1lc3NhZ2UucmVwbGFjZSgvJy9nLCBcIicnXCIpfSdgIDogJyd9KWBcbiAgKTtcbn1cblxuLyoqXG4gKiBFeGVjdXRlIGFsbCBzdGF0ZW1lbnRzIGluIGEgU1FMIGZpbGVcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZUZpbGVTdGF0ZW1lbnRzKFxuICBjbHVzdGVyQXJuOiBzdHJpbmcsXG4gIHNlY3JldEFybjogc3RyaW5nLFxuICBkYXRhYmFzZTogc3RyaW5nLFxuICBmaWxlbmFtZTogc3RyaW5nXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc3FsID0gYXdhaXQgZ2V0U3FsQ29udGVudChmaWxlbmFtZSk7XG4gIGNvbnN0IHN0YXRlbWVudHMgPSBzcGxpdFNxbFN0YXRlbWVudHMoc3FsKTtcbiAgXG4gIGZvciAoY29uc3Qgc3RhdGVtZW50IG9mIHN0YXRlbWVudHMpIHtcbiAgICBpZiAoc3RhdGVtZW50LnRyaW0oKSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZXhlY3V0ZVNxbChjbHVzdGVyQXJuLCBzZWNyZXRBcm4sIGRhdGFiYXNlLCBzdGF0ZW1lbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgICAvLyBGb3IgaW5pdGlhbCBzZXR1cCBmaWxlcywgd2UgbWlnaHQgd2FudCB0byBjb250aW51ZSBvbiBcImFscmVhZHkgZXhpc3RzXCIgZXJyb3JzXG4gICAgICAgIC8vIEZvciBtaWdyYXRpb25zLCB3ZSBzaG91bGQgZmFpbCBmYXN0XG4gICAgICAgIGlmIChJTklUSUFMX1NFVFVQX0ZJTEVTLmluY2x1ZGVzKGZpbGVuYW1lKSAmJiBcbiAgICAgICAgICAgIChlcnJvci5tZXNzYWdlPy5pbmNsdWRlcygnYWxyZWFkeSBleGlzdHMnKSB8fCBcbiAgICAgICAgICAgICBlcnJvci5tZXNzYWdlPy5pbmNsdWRlcygnZHVwbGljYXRlIGtleScpKSkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKGDimqDvuI8gIFNraXBwaW5nIChhbHJlYWR5IGV4aXN0cyk6ICR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgICAgfSBlbHNlIGlmIChNSUdSQVRJT05fRklMRVMuaW5jbHVkZXMoZmlsZW5hbWUpKSB7XG4gICAgICAgICAgLy8gRm9yIG1pZ3JhdGlvbiBmaWxlcywgY2hlY2sgaWYgaXQncyBhbiBBTFRFUiBUQUJMRSB0aGF0IGFjdHVhbGx5IHN1Y2NlZWRlZFxuICAgICAgICAgIC8vIFJEUyBEYXRhIEFQSSBzb21ldGltZXMgcmV0dXJucyBhbiBlcnJvci1saWtlIHJlc3BvbnNlIGZvciBzdWNjZXNzZnVsIEFMVEVSIFRBQkxFc1xuICAgICAgICAgIGNvbnN0IGlzQWx0ZXJUYWJsZSA9IHN0YXRlbWVudC50cmltKCkudG9VcHBlckNhc2UoKS5zdGFydHNXaXRoKCdBTFRFUiBUQUJMRScpO1xuICAgICAgICAgIFxuICAgICAgICAgIGlmIChpc0FsdGVyVGFibGUpIHtcbiAgICAgICAgICAgIC8vIFZlcmlmeSBpZiB0aGUgQUxURVIgYWN0dWFsbHkgc3VjY2VlZGVkIGJ5IGNoZWNraW5nIHRoZSB0YWJsZSBzdHJ1Y3R1cmVcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGDimqDvuI8gIEFMVEVSIFRBQkxFIG1heSBoYXZlIHN1Y2NlZWRlZCBkZXNwaXRlIGVycm9yIHJlc3BvbnNlLiBWZXJpZnlpbmcuLi5gKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy8gRXh0cmFjdCB0YWJsZSBuYW1lIGFuZCBjb2x1bW4gZnJvbSBBTFRFUiBzdGF0ZW1lbnRcbiAgICAgICAgICAgIGNvbnN0IGFsdGVyTWF0Y2ggPSBzdGF0ZW1lbnQubWF0Y2goL0FMVEVSXFxzK1RBQkxFXFxzKyhcXHcrKVxccytBRERcXHMrQ09MVU1OXFxzKyhJRlxccytOT1RcXHMrRVhJU1RTXFxzKyk/KFxcdyspL2kpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoYWx0ZXJNYXRjaCkge1xuICAgICAgICAgICAgICBjb25zdCB0YWJsZU5hbWUgPSBhbHRlck1hdGNoWzFdO1xuICAgICAgICAgICAgICBjb25zdCBjb2x1bW5OYW1lID0gYWx0ZXJNYXRjaFszXTtcbiAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgLy8gQ2hlY2sgaWYgdGhlIGNvbHVtbiBleGlzdHNcbiAgICAgICAgICAgICAgICBjb25zdCBjaGVja1Jlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTcWwoXG4gICAgICAgICAgICAgICAgICBjbHVzdGVyQXJuLFxuICAgICAgICAgICAgICAgICAgc2VjcmV0QXJuLFxuICAgICAgICAgICAgICAgICAgZGF0YWJhc2UsXG4gICAgICAgICAgICAgICAgICBgU0VMRUNUIGNvbHVtbl9uYW1lIEZST00gaW5mb3JtYXRpb25fc2NoZW1hLmNvbHVtbnMgXG4gICAgICAgICAgICAgICAgICAgV0hFUkUgdGFibGVfc2NoZW1hID0gJ3B1YmxpYycgXG4gICAgICAgICAgICAgICAgICAgQU5EIHRhYmxlX25hbWUgPSAnJHt0YWJsZU5hbWV9JyBcbiAgICAgICAgICAgICAgICAgICBBTkQgY29sdW1uX25hbWUgPSAnJHtjb2x1bW5OYW1lfSdgXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAoY2hlY2tSZXN1bHQucmVjb3JkcyAmJiBjaGVja1Jlc3VsdC5yZWNvcmRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGDinIUgQ29sdW1uICR7Y29sdW1uTmFtZX0gZXhpc3RzIGluIHRhYmxlICR7dGFibGVOYW1lfSAtIEFMVEVSIHN1Y2NlZWRlZGApO1xuICAgICAgICAgICAgICAgICAgLy8gQ29sdW1uIGV4aXN0cywgc28gdGhlIEFMVEVSIHdvcmtlZCAtIGNvbnRpbnVlXG4gICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGNoZWNrRXJyb3IpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgQ291bGQgbm90IHZlcmlmeSBjb2x1bW4gZXhpc3RlbmNlOiAke2NoZWNrRXJyb3J9YCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgXG4gICAgICAgICAgLy8gSWYgd2UgY291bGRuJ3QgdmVyaWZ5IHN1Y2Nlc3MsIHRocm93IHRoZSBvcmlnaW5hbCBlcnJvclxuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVTcWwoXG4gIGNsdXN0ZXJBcm46IHN0cmluZyxcbiAgc2VjcmV0QXJuOiBzdHJpbmcsXG4gIGRhdGFiYXNlOiBzdHJpbmcsXG4gIHNxbDogc3RyaW5nXG4pOiBQcm9taXNlPGFueT4ge1xuICBjb25zdCBjb21tYW5kID0gbmV3IEV4ZWN1dGVTdGF0ZW1lbnRDb21tYW5kKHtcbiAgICByZXNvdXJjZUFybjogY2x1c3RlckFybixcbiAgICBzZWNyZXRBcm46IHNlY3JldEFybixcbiAgICBkYXRhYmFzZTogZGF0YWJhc2UsXG4gICAgc3FsOiBzcWwsXG4gICAgaW5jbHVkZVJlc3VsdE1ldGFkYXRhOiB0cnVlXG4gIH0pO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZHNDbGllbnQuc2VuZChjb21tYW5kKTtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAvLyBMb2cgdGhlIGZ1bGwgZXJyb3IgZm9yIGRlYnVnZ2luZ1xuICAgIGNvbnNvbGUuZXJyb3IoYFNRTCBleGVjdXRpb24gZXJyb3IgZm9yIHN0YXRlbWVudDogJHtzcWwuc3Vic3RyaW5nKDAsIDEwMCl9Li4uYCk7XG4gICAgY29uc29sZS5lcnJvcihgRXJyb3IgZGV0YWlsczpgLCBKU09OLnN0cmluZ2lmeShlcnJvciwgbnVsbCwgMikpO1xuICAgIFxuICAgIC8vIENoZWNrIGlmIHRoaXMgaXMgYSBmYWxzZS1wb3NpdGl2ZSBlcnJvciBmb3IgQUxURVIgVEFCTEVcbiAgICAvLyBSRFMgRGF0YSBBUEkgc29tZXRpbWVzIHJldHVybnMgZXJyb3JzIGZvciBzdWNjZXNzZnVsIERETCBvcGVyYXRpb25zXG4gICAgaWYgKHNxbC50cmltKCkudG9VcHBlckNhc2UoKS5zdGFydHNXaXRoKCdBTFRFUiBUQUJMRScpICYmIFxuICAgICAgICBlcnJvci5tZXNzYWdlICYmIFxuICAgICAgICAoZXJyb3IubWVzc2FnZS5pbmNsdWRlcygnRGF0YWJhc2UgcmV0dXJuZWQgU1FMIGV4Y2VwdGlvbicpIHx8IFxuICAgICAgICAgZXJyb3IubWVzc2FnZS5pbmNsdWRlcygnQmFkUmVxdWVzdEV4Y2VwdGlvbicpKSkge1xuICAgICAgY29uc29sZS5sb2coYOKaoO+4jyAgUG90ZW50aWFsIGZhbHNlLXBvc2l0aXZlIGVycm9yIGZvciBBTFRFUiBUQUJMRSAtIHdpbGwgdmVyaWZ5IGluIGNhbGxlcmApO1xuICAgIH1cbiAgICBcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG5mdW5jdGlvbiBzcGxpdFNxbFN0YXRlbWVudHMoc3FsOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIC8vIFJlbW92ZSBjb21tZW50c1xuICBjb25zdCB3aXRob3V0Q29tbWVudHMgPSBzcWxcbiAgICAuc3BsaXQoJ1xcbicpXG4gICAgLmZpbHRlcihsaW5lID0+ICFsaW5lLnRyaW0oKS5zdGFydHNXaXRoKCctLScpKVxuICAgIC5qb2luKCdcXG4nKTtcblxuICAvLyBTcGxpdCBieSBzZW1pY29sb24gYnV0IGhhbmRsZSBDUkVBVEUgVFlQRS9GVU5DVElPTiBibG9ja3Mgc3BlY2lhbGx5XG4gIGNvbnN0IHN0YXRlbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGxldCBjdXJyZW50U3RhdGVtZW50ID0gJyc7XG4gIGxldCBpbkJsb2NrID0gZmFsc2U7XG4gIFxuICBjb25zdCBsaW5lcyA9IHdpdGhvdXRDb21tZW50cy5zcGxpdCgnXFxuJyk7XG4gIFxuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICBjb25zdCB0cmltbWVkTGluZSA9IGxpbmUudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgXG4gICAgLy8gQ2hlY2sgaWYgd2UncmUgZW50ZXJpbmcgYSBibG9jayAoQ1JFQVRFIFRZUEUsIENSRUFURSBGVU5DVElPTiwgZXRjLilcbiAgICBpZiAodHJpbW1lZExpbmUuc3RhcnRzV2l0aCgnQ1JFQVRFIFRZUEUnKSB8fCBcbiAgICAgICAgdHJpbW1lZExpbmUuc3RhcnRzV2l0aCgnQ1JFQVRFIEZVTkNUSU9OJykgfHxcbiAgICAgICAgdHJpbW1lZExpbmUuc3RhcnRzV2l0aCgnQ1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04nKSB8fFxuICAgICAgICB0cmltbWVkTGluZS5zdGFydHNXaXRoKCdEUk9QIFRZUEUnKSkge1xuICAgICAgaW5CbG9jayA9IHRydWU7XG4gICAgfVxuICAgIFxuICAgIGN1cnJlbnRTdGF0ZW1lbnQgKz0gbGluZSArICdcXG4nO1xuICAgIFxuICAgIC8vIENoZWNrIGlmIHRoaXMgbGluZSBlbmRzIHdpdGggYSBzZW1pY29sb25cbiAgICBpZiAobGluZS50cmltKCkuZW5kc1dpdGgoJzsnKSkge1xuICAgICAgLy8gSWYgd2UncmUgaW4gYSBibG9jaywgY2hlY2sgaWYgdGhpcyBpcyB0aGUgZW5kXG4gICAgICBpZiAoaW5CbG9jayAmJiAodHJpbW1lZExpbmUgPT09ICcpOycgfHwgdHJpbW1lZExpbmUuZW5kc1dpdGgoJyk7JykgfHwgdHJpbW1lZExpbmUuZW5kc1dpdGgoXCInIExBTkdVQUdFIFBMUEdTUUw7XCIpKSkge1xuICAgICAgICBpbkJsb2NrID0gZmFsc2U7XG4gICAgICB9XG4gICAgICBcbiAgICAgIC8vIElmIG5vdCBpbiBhIGJsb2NrLCB0aGlzIHN0YXRlbWVudCBpcyBjb21wbGV0ZVxuICAgICAgaWYgKCFpbkJsb2NrKSB7XG4gICAgICAgIHN0YXRlbWVudHMucHVzaChjdXJyZW50U3RhdGVtZW50LnRyaW0oKSk7XG4gICAgICAgIGN1cnJlbnRTdGF0ZW1lbnQgPSAnJztcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgXG4gIC8vIEFkZCBhbnkgcmVtYWluaW5nIHN0YXRlbWVudFxuICBpZiAoY3VycmVudFN0YXRlbWVudC50cmltKCkpIHtcbiAgICBzdGF0ZW1lbnRzLnB1c2goY3VycmVudFN0YXRlbWVudC50cmltKCkpO1xuICB9XG4gIFxuICByZXR1cm4gc3RhdGVtZW50cztcbn1cblxuLy8gTG9hZCBTUUwgY29udGVudCBmcm9tIGJ1bmRsZWQgc2NoZW1hIGZpbGVzXG5hc3luYyBmdW5jdGlvbiBnZXRTcWxDb250ZW50KGZpbGVuYW1lOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBmcyA9IHJlcXVpcmUoJ2ZzJykucHJvbWlzZXM7XG4gIGNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG4gIFxuICB0cnkge1xuICAgIC8vIFNjaGVtYSBmaWxlcyBhcmUgY29waWVkIHRvIHRoZSBMYW1iZGEgZGVwbG95bWVudCBwYWNrYWdlXG4gICAgY29uc3Qgc2NoZW1hUGF0aCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICdzY2hlbWEnLCBmaWxlbmFtZSk7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IGZzLnJlYWRGaWxlKHNjaGVtYVBhdGgsICd1dGY4Jyk7XG4gICAgcmV0dXJuIGNvbnRlbnQ7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcihgRmFpbGVkIHRvIHJlYWQgU1FMIGZpbGUgJHtmaWxlbmFtZX06YCwgZXJyb3IpO1xuICAgIHRocm93IG5ldyBFcnJvcihgQ291bGQgbm90IGxvYWQgU1FMIGZpbGU6ICR7ZmlsZW5hbWV9YCk7XG4gIH1cbn1cblxuIl19