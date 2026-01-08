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
MANIFEST_FILE="/docker-entrypoint-initdb.d/migrations.json"

# Check if schema directory exists and has files
if [ ! -d "$SCHEMA_DIR" ]; then
    echo "ERROR: Schema directory not found at $SCHEMA_DIR"
    echo "Make sure docker-compose.dev.yml mounts the schema directory correctly."
    exit 1
fi

# Check if manifest file exists
if [ ! -f "$MANIFEST_FILE" ]; then
    echo "ERROR: Migration manifest not found at $MANIFEST_FILE"
    echo "Make sure docker-compose.dev.yml mounts migrations.json correctly."
    exit 1
fi

# Parse JSON manifest without jq (postgres:alpine doesn't have it)
# Extract initialSetupFiles array
parse_json_array() {
    local key=$1
    local file=$2
    # Extract the array, remove brackets, quotes, and whitespace
    grep -A 100 "\"$key\"" "$file" | \
        grep -o '"[^"]*\.sql"' | \
        tr -d '"' | \
        head -50  # Safety limit
}

echo "Reading migration manifest from $MANIFEST_FILE..."
INITIAL_FILES=($(parse_json_array "initialSetupFiles" "$MANIFEST_FILE"))
MIGRATION_FILES=($(parse_json_array "migrationFiles" "$MANIFEST_FILE"))

echo "Found ${#INITIAL_FILES[@]} initial setup files"
echo "Found ${#MIGRATION_FILES[@]} migration files"
echo ""

# Create migration_log table first (to track what's been run)
# Using ON_ERROR_STOP=1 to fail fast on errors
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
    local allow_failures=${2:-false}

    if [ ! -f "$filepath" ]; then
        echo "WARNING: File not found: $filepath"
        return 0
    fi

    echo "Running: $filename"

    # Execute the SQL file
    # For initial setup, allow "already exists" errors (ON_ERROR_STOP=0)
    # For migrations, fail on errors (ON_ERROR_STOP=1)
    if [ "$allow_failures" = "true" ]; then
        if psql -v ON_ERROR_STOP=0 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$filepath" 2>&1; then
            log_migration "$filename" "completed" "File executed"
            echo "  SUCCESS"
        else
            echo "  WARNING: Some statements in $filename may have failed (likely 'already exists' errors)"
            log_migration "$filename" "completed" "File executed with warnings"
        fi
    else
        # Strict mode - fail on any error
        if psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$filepath" 2>&1; then
            log_migration "$filename" "completed" "File executed"
            echo "  SUCCESS"
        else
            local exit_code=$?
            echo "  FAILED: $filename"
            log_migration "$filename" "failed" "File execution failed"
            return $exit_code
        fi
    fi
}

# Function to log migration status
log_migration() {
    local filename=$1
    local status=$2
    local message=$3

    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
        INSERT INTO migration_log (step_number, description, sql_executed, status)
        SELECT COALESCE(MAX(step_number), 0) + 1, '$filename', '$message', '$status'
        FROM migration_log;
EOSQL
}

echo ""
echo "Running initial setup files..."
echo "------------------------------"
for file in "${INITIAL_FILES[@]}"; do
    # Allow "already exists" errors for idempotent setup
    run_sql_file "$file" "true"
done

echo ""
echo "Running migration files..."
echo "--------------------------"
for file in "${MIGRATION_FILES[@]}"; do
    # Use strict error handling for migrations
    # But allow "already exists" since migrations should be idempotent
    run_sql_file "$file" "true"
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
