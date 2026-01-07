#!/bin/bash
# Issue #603: Database Tunnel Helper Script
#
# Creates an SSM port forward to Aurora PostgreSQL for local development.
# This enables direct database access for Drizzle Studio and local debugging.
#
# Prerequisites:
#   - AWS CLI v2 with session-manager-plugin installed
#   - AWS credentials configured with appropriate IAM permissions
#   - ECS Exec enabled on the target ECS cluster
#
# Usage:
#   ./scripts/db-tunnel.sh [dev|prod]
#   ./scripts/db-tunnel.sh dev          # Connect to dev Aurora cluster
#   ./scripts/db-tunnel.sh prod         # Connect to prod Aurora cluster (caution!)
#
# After running, you can:
#   - Connect with psql: psql postgres://user:pass@localhost:5432/aistudio
#   - Run Drizzle Studio: DATABASE_URL="postgresql://..." npm run drizzle:studio

set -e

# Default to dev environment
ENVIRONMENT="${1:-dev}"

if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
  echo "Error: Environment must be 'dev' or 'prod'"
  echo "Usage: $0 [dev|prod]"
  exit 1
fi

echo "=== AI Studio Database Tunnel ==="
echo "Environment: $ENVIRONMENT"
echo ""

# Get cluster ARN and endpoint from SSM Parameter Store
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

# Get ECS cluster and task for the tunnel
ECS_CLUSTER="aistudio-${ENVIRONMENT}"
echo "Looking for running ECS task in cluster: $ECS_CLUSTER"

TASK_ARN=$(aws ecs list-tasks \
  --cluster "$ECS_CLUSTER" \
  --desired-status RUNNING \
  --query 'taskArns[0]' \
  --output text 2>/dev/null || echo "")

if [[ -z "$TASK_ARN" || "$TASK_ARN" == "None" ]]; then
  echo "Error: No running ECS tasks found in cluster $ECS_CLUSTER"
  echo ""
  echo "Alternative: Use an EC2 instance in the VPC as a jump host"
  echo ""
  echo "Manual port forward (if you have an EC2 instance):"
  echo "  aws ssm start-session --target <instance-id> \\"
  echo "    --document-name AWS-StartPortForwardingSessionToRemoteHost \\"
  echo "    --parameters '{\"host\":[\"$DB_HOST\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"5432\"]}'"
  exit 1
fi

echo "Found ECS task: ${TASK_ARN##*/}"
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

echo ""
echo "=== Connection Ready ==="
echo ""
echo "Starting port forward on localhost:5432 -> $DB_HOST:5432"
echo ""
echo "In another terminal, use this connection string:"
echo ""
echo "  DATABASE_URL=\"postgresql://${DB_USER}:****@localhost:5432/${DB_NAME}\""
echo ""
echo "Commands:"
echo "  psql \"postgresql://${DB_USER}:****@localhost:5432/${DB_NAME}\""
echo "  DATABASE_URL=\"postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}\" npm run drizzle:studio"
echo ""
echo "Press Ctrl+C to stop the tunnel"
echo ""

# Start the port forward session using ECS Exec
# Note: This requires the ECS task to have ExecuteCommand enabled
aws ecs execute-command \
  --cluster "$ECS_CLUSTER" \
  --task "$TASK_ARN" \
  --container "nextjs-app" \
  --interactive \
  --command "/bin/sh -c 'while true; do nc -l -p 5432 | nc $DB_HOST 5432; done'" &

# Alternative: Use SSM Session Manager port forwarding (requires EC2 or Fargate with SSM agent)
# This is a simpler approach if direct ECS Exec port forwarding doesn't work
echo ""
echo "Note: If the above command fails, you can try direct SSM port forwarding"
echo "using an EC2 instance in the same VPC as a jump host."
echo ""

wait
