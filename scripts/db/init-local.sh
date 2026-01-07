#!/bin/bash
# Database Initialization Script for Local Development
# Issue #607 - Local Development Environment
#
# This script runs automatically when the PostgreSQL container starts
# for the first time (via /docker-entrypoint-initdb.d).
#
# It executes all SQL migration files in order to set up the database schema.
#
# Note: This only runs on container first start. To re-run migrations:
#   1. bun run db:reset   (destroys all data)
#   2. bun run db:migrate (runs migrations on existing db)

set -e

echo "=========================================="
echo "AI Studio - Local Database Initialization"
echo "=========================================="
echo ""

# Schema files are mounted at /docker-entrypoint-initdb.d/schema/
SCHEMA_DIR="/docker-entrypoint-initdb.d/schema"

# Check if schema directory exists and has files
if [ ! -d "$SCHEMA_DIR" ]; then
    echo "ERROR: Schema directory not found at $SCHEMA_DIR"
    echo "Make sure docker-compose.dev.yml mounts the schema directory correctly."
    exit 1
fi

# Initial setup files (run first, in order)
INITIAL_FILES=(
    "001-enums.sql"
    "002-tables.sql"
    "003-constraints.sql"
    "004-indexes.sql"
    "005-initial-data.sql"
)

# Migration files (run after initial setup, in order)
MIGRATION_FILES=(
    "010-knowledge-repositories.sql"
    "11_textract_jobs.sql"
    "12_textract_usage.sql"
    "013-add-knowledge-repositories-tool.sql"
    "014-model-comparisons.sql"
    "015-add-model-compare-tool.sql"
    "016-assistant-architect-repositories.sql"
    "017-add-user-roles-updated-at.sql"
    "018-model-replacement-audit.sql"
    "019-fix-navigation-role-display.sql"
    "020-add-user-role-version.sql"
    "023-navigation-multi-roles.sql"
    "024-model-role-restrictions.sql"
    "026-add-model-compare-source.sql"
    "027-messages-model-tracking.sql"
    "028-nexus-schema.sql"
    "029-ai-models-nexus-enhancements.sql"
    "030-nexus-provider-metrics.sql"
    "031-nexus-messages.sql"
    "032-remove-nexus-provider-constraint.sql"
    "033-ai-streaming-jobs.sql"
    "034-assistant-architect-enabled-tools.sql"
    "035-schedule-management-schema.sql"
    "036-remove-legacy-chat-tables.sql"
    "037-assistant-architect-events.sql"
    "039-prompt-library-schema.sql"
    "040-update-model-replacement-audit.sql"
    "041-add-user-cascade-constraints.sql"
    "042-ai-streaming-jobs-pending-index.sql"
    "043-migrate-documents-conversation-uuid.sql"
    "044-add-model-availability-flags.sql"
    "045-remove-chat-enabled-column.sql"
    "046-remove-nexus-capabilities-column.sql"
    "047-add-jsonb-defaults.sql"
    "048-remove-jsonb-not-null.sql"
)

# Create migration_log table first (to track what's been run)
echo "Creating migration_log table..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE TABLE IF NOT EXISTS migration_log (
        id SERIAL PRIMARY KEY,
        step_number INTEGER NOT NULL,
        description TEXT NOT NULL,
        sql_executed TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        error_message TEXT,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
EOSQL

# Function to run a SQL file and log the result
run_sql_file() {
    local filename=$1
    local filepath="$SCHEMA_DIR/$filename"

    if [ ! -f "$filepath" ]; then
        echo "WARNING: File not found: $filepath"
        return 0
    fi

    echo "Running: $filename"

    # Execute the SQL file
    if psql -v ON_ERROR_STOP=0 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$filepath" 2>&1; then
        # Log success
        psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
            INSERT INTO migration_log (step_number, description, sql_executed, status)
            SELECT COALESCE(MAX(step_number), 0) + 1, '$filename', 'File executed', 'completed'
            FROM migration_log;
EOSQL
        echo "  SUCCESS"
    else
        echo "  WARNING: Some statements in $filename may have failed (likely 'already exists' errors)"
        # Still log it as completed since we continue on errors for idempotency
        psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
            INSERT INTO migration_log (step_number, description, sql_executed, status)
            SELECT COALESCE(MAX(step_number), 0) + 1, '$filename', 'File executed with warnings', 'completed'
            FROM migration_log;
EOSQL
    fi
}

echo ""
echo "Running initial setup files..."
echo "------------------------------"
for file in "${INITIAL_FILES[@]}"; do
    run_sql_file "$file"
done

echo ""
echo "Running migration files..."
echo "--------------------------"
for file in "${MIGRATION_FILES[@]}"; do
    run_sql_file "$file"
done

echo ""
echo "=========================================="
echo "Database initialization complete!"
echo "=========================================="
echo ""
echo "Database: $POSTGRES_DB"
echo "User: $POSTGRES_USER"
echo "Host: localhost:5432"
echo ""
echo "Connection string:"
echo "  postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:5432/$POSTGRES_DB"
echo ""
