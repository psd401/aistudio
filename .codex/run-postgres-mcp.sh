#!/usr/bin/env bash
set -euo pipefail

: "${AISTUDIO_DB_CLUSTER_ARN:?Set AISTUDIO_DB_CLUSTER_ARN before starting Codex}"
: "${AISTUDIO_DB_SECRET_ARN:?Set AISTUDIO_DB_SECRET_ARN before starting Codex}"

exec uvx awslabs.postgres-mcp-server@1.0.9 \
  --resource_arn "${AISTUDIO_DB_CLUSTER_ARN}" \
  --secret_arn "${AISTUDIO_DB_SECRET_ARN}" \
  --database "${AISTUDIO_DB_NAME:-aistudio}" \
  --region "${AWS_REGION:-us-east-1}" \
  --readonly True
