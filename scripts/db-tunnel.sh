#!/bin/bash
# Issue #603: Database Tunnel Helper Script
#
# Creates an SSM port forward to Aurora PostgreSQL for local development.
# This enables direct database access for Drizzle Studio and local debugging.
#
# Prerequisites:
#   - AWS CLI v2 with session-manager-plugin installed
#   - jq installed (for JSON parsing)
#   - AWS credentials configured with appropriate IAM permissions
#   - An EC2 instance or ECS task in the VPC for tunneling
#
# Usage:
#   ./scripts/db-tunnel.sh [dev|prod]
#   ./scripts/db-tunnel.sh dev          # Connect to dev Aurora cluster
#   ./scripts/db-tunnel.sh prod         # Connect to prod Aurora cluster (caution!)
#
# After running, you can:
#   - Connect with psql: psql "$DATABASE_URL"
#   - Run Drizzle Studio: npm run drizzle:studio
#
# The script creates a secure temp file with credentials that auto-deletes on exit.

set -e

# Default to dev environment
ENVIRONMENT="${1:-dev}"

if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
  echo "Error: Environment must be 'dev' or 'prod'"
  echo "Usage: $0 [dev|prod]"
  exit 1
fi

# Check for required tools
if ! command -v jq &> /dev/null; then
  echo "Error: jq is required but not installed"
  echo "Install with: brew install jq (macOS) or apt-get install jq (Ubuntu)"
  exit 1
fi

if ! command -v aws &> /dev/null; then
  echo "Error: AWS CLI is required but not installed"
  echo "See: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  exit 1
fi

echo "=== AI Studio Database Tunnel ==="
echo "Environment: $ENVIRONMENT"
echo ""

# Get cluster endpoint from SSM Parameter Store
echo "Fetching database parameters from SSM..."

DB_HOST=$(aws ssm get-parameter \
  --name "/aistudio/${ENVIRONMENT}/db-host" \
  --query 'Parameter.Value' \
  --output text 2>/dev/null || echo "")

if [[ -z "$DB_HOST" ]]; then
  echo "Error: Could not retrieve database host from SSM parameter /aistudio/${ENVIRONMENT}/db-host"
  echo ""
  echo "Make sure:"
  echo "  1. The database stack has been deployed"
  echo "  2. You have AWS credentials configured"
  echo "  3. Your IAM role has ssm:GetParameter permission"
  exit 1
fi

# Get the secret ARN for credentials
DB_SECRET_ARN=$(aws ssm get-parameter \
  --name "/aistudio/${ENVIRONMENT}/db-secret-arn" \
  --query 'Parameter.Value' \
  --output text 2>/dev/null || echo "")

echo "Database Host: $DB_HOST"
echo "Secret ARN: ${DB_SECRET_ARN:0:50}..."
echo ""

# Get the credentials from Secrets Manager
echo "Retrieving database credentials..."
CREDENTIALS=$(aws secretsmanager get-secret-value \
  --secret-id "$DB_SECRET_ARN" \
  --query 'SecretString' \
  --output text 2>/dev/null || echo "")

if [[ -z "$CREDENTIALS" ]]; then
  echo "Error: Could not retrieve database credentials from Secrets Manager"
  exit 1
fi

DB_USER=$(echo "$CREDENTIALS" | jq -r '.username // .user // "master"')
DB_PASS=$(echo "$CREDENTIALS" | jq -r '.password')
DB_NAME="aistudio"

# Create a secure temp file for the connection string (auto-cleaned on exit)
TEMP_FILE=$(mktemp)
chmod 600 "$TEMP_FILE"

# Cleanup temp file on script exit
cleanup() {
  rm -f "$TEMP_FILE"
  echo ""
  echo "Tunnel closed. Temporary credentials file removed."
}
trap cleanup EXIT

# Write connection string to temp file (never echoed to terminal)
echo "export DATABASE_URL=\"postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}\"" > "$TEMP_FILE"

echo ""
echo "=== Finding Tunnel Target ==="
echo ""

# Method 1: Try to find a bastion/jumpbox EC2 instance
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Environment,Values=${ENVIRONMENT}" \
            "Name=instance-state-name,Values=running" \
  --query 'Reservations[*].Instances[*].[InstanceId,Tags[?Key==`Name`].Value|[0]]' \
  --output text 2>/dev/null | grep -i -E "bastion|jumpbox|tunnel" | head -1 | awk '{print $1}' || echo "")

if [[ -n "$INSTANCE_ID" && "$INSTANCE_ID" != "None" ]]; then
  echo "Found bastion instance: $INSTANCE_ID"
  echo ""
  echo "=== Connection Ready ==="
  echo ""
  echo "Starting port forward on localhost:5432 -> $DB_HOST:5432"
  echo ""
  echo "To use the connection, source the credentials file in another terminal:"
  echo ""
  echo "  source $TEMP_FILE"
  echo "  psql \"\$DATABASE_URL\""
  echo "  # or"
  echo "  npm run drizzle:studio"
  echo ""
  echo "Press Ctrl+C to stop the tunnel"
  echo ""

  aws ssm start-session \
    --target "$INSTANCE_ID" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "{\"host\":[\"$DB_HOST\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"5432\"]}"
  exit 0
fi

# Method 2: No bastion found, provide manual instructions
echo "No bastion/jumpbox instance found with Environment=$ENVIRONMENT tag."
echo ""
echo "=== Alternative Methods ==="
echo ""
echo "Option 1: Deploy a bastion host in the VPC"
echo "  - Create an EC2 instance in a private subnet with SSM Agent"
echo "  - Tag it with Environment=${ENVIRONMENT} and Name=*bastion*"
echo "  - Re-run this script"
echo ""
echo "Option 2: Use AWS Console for RDS connection"
echo "  - Open AWS Console -> RDS -> Databases"
echo "  - Select your Aurora cluster"
echo "  - Use 'Query Editor' or 'Connect' features"
echo ""
echo "Option 3: Manual SSM port forwarding (if you have an EC2 instance)"
echo "  aws ssm start-session --target <instance-id> \\"
echo "    --document-name AWS-StartPortForwardingSessionToRemoteHost \\"
echo "    --parameters '{\"host\":[\"$DB_HOST\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"5432\"]}'"
echo ""
echo "Once connected, source credentials with:"
echo "  source $TEMP_FILE"
echo ""

# Keep temp file available for manual use
read -p "Press Enter to exit (temp credentials file will be deleted)..."
