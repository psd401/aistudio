#!/usr/bin/env bash
# Build and push the PSD Agent base image to ECR.
#
# Usage:
#   ./build-and-push.sh                    # Uses default tag: YYYY-MM-DD-initial
#   ./build-and-push.sh my-custom-tag      # Uses custom tag
#
# Prerequisites:
#   - AWS CLI configured with appropriate credentials
#   - Docker running (with ARM64/linux/arm64 build support)
#   - CDK stacks deployed (ECR repository must exist)
#
# The script reads the ECR repository URI from CloudFormation outputs.

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-dev}"
STACK_NAME="AIStudio-AgentPlatformStack-${ENVIRONMENT^}"
REGION="${AWS_REGION:-us-east-1}"
TAG="${1:-$(date +%Y-%m-%d)-initial}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== PSD Agent Image Build & Push ==="
echo "Environment: ${ENVIRONMENT}"
echo "Tag: ${TAG}"
echo ""

# Get ECR repository URI from CloudFormation outputs
echo "Looking up ECR repository from stack ${STACK_NAME}..."
ECR_URI=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='ECRRepositoryUri'].OutputValue" \
  --output text \
  --region "${REGION}")

if [ -z "${ECR_URI}" ] || [ "${ECR_URI}" = "None" ]; then
  echo "ERROR: Could not find ECR repository URI. Is the stack deployed?"
  echo "  Deploy first: cd infra && bunx cdk deploy ${STACK_NAME}"
  exit 1
fi

# Extract registry (account.dkr.ecr.region.amazonaws.com)
ECR_REGISTRY="${ECR_URI%%/*}"

echo "ECR URI: ${ECR_URI}"
echo "Registry: ${ECR_REGISTRY}"
echo ""

# Authenticate Docker with ECR
echo "Authenticating with ECR..."
aws ecr get-login-password --region "${REGION}" | \
  docker login --username AWS --password-stdin "${ECR_REGISTRY}"

# Build the image (ARM64 for AgentCore)
echo ""
echo "Building image (ARM64)..."
docker build \
  --platform linux/arm64 \
  -t "${ECR_URI}:${TAG}" \
  -t "${ECR_URI}:latest" \
  "${SCRIPT_DIR}"

# Push both tags
echo ""
echo "Pushing ${ECR_URI}:${TAG}..."
docker push "${ECR_URI}:${TAG}"

echo "Pushing ${ECR_URI}:latest..."
docker push "${ECR_URI}:latest"

echo ""
echo "=== Done ==="
echo ""
echo "Image pushed: ${ECR_URI}:${TAG}"
echo ""
echo "Next steps:"
echo "  1. Deploy AgentCore Runtime with this image tag:"
echo "     cd infra && bunx cdk deploy ${STACK_NAME} --context agentImageTag=${TAG}"
echo ""
echo "  2. The Runtime ID will appear in stack outputs. The Router Lambda"
echo "     resolves it from SSM automatically — no manual config needed."
