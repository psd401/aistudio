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
# Capitalize first letter for stack name (portable — no bashisms or GNU sed)
ENV_CAPITALIZED="$(echo "${ENVIRONMENT}" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
STACK_NAME="AIStudio-AgentPlatformStack-${ENV_CAPITALIZED}"
REGION="${AWS_REGION:-us-east-1}"
TAG="${1:-$(date +%Y-%m-%d)-initial}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== PSD Agent Image Build & Push ==="
echo "Environment: ${ENVIRONMENT}"
echo "Tag: ${TAG}"
echo ""

# Supply-chain enforcement gate (SEC-009): the agent image must ship no
# unresolved BLOCKER(prod) markers. Every install in the Dockerfile is
# expected to be checksum- or hash-verified; a lingering BLOCKER(prod)
# comment means a known supply-chain gap is still open. Fail the build
# before doing any expensive work if any marker remains.
echo "Checking for unresolved BLOCKER(prod) markers in Dockerfile..."
# Fail closed if the Dockerfile can't be read: an `if grep ...` condition is
# exempt from `set -e`, and grep's "no match" (exit 1) and "error" (exit 2,
# e.g. unreadable/missing file) are indistinguishable to the `if`. Without
# this guard a broken checkout would silently report "OK" and skip the gate.
if [ ! -r "${SCRIPT_DIR}/Dockerfile" ]; then
  echo "ERROR: cannot read ${SCRIPT_DIR}/Dockerfile — the supply-chain gate could not run." >&2
  exit 1
fi
if grep -n 'BLOCKER(prod)' "${SCRIPT_DIR}/Dockerfile"; then
  echo "ERROR: BLOCKER(prod) marker(s) found in Dockerfile (see above)." >&2
  echo "       Resolve the supply-chain gap (checksum/hash verification) and" >&2
  echo "       remove the marker before building." >&2
  exit 1
fi
echo "  OK — no BLOCKER(prod) markers."
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
  "${SCRIPT_DIR}"

echo ""
echo "Pushing ${ECR_URI}:${TAG}..."
docker push "${ECR_URI}:${TAG}"

# Resolve the immutable digest so the caller can pin AgentCore by digest.
# Tag-based pinning has produced stale image serving in AgentCore — see PR #902.
echo ""
echo "Resolving image digest..."
DIGEST=$(aws ecr describe-images \
  --region "${REGION}" \
  --repository-name "${ECR_URI##*/}" \
  --image-ids "imageTag=${TAG}" \
  --query 'imageDetails[0].imageDigest' \
  --output text)

echo ""
echo "=== Done ==="
echo ""
echo "Image:  ${ECR_URI}:${TAG}"
echo "Digest: ${DIGEST}"
echo ""
echo "Next step — deploy AgentCore Runtime pinned to the immutable digest:"
echo ""
echo "  cd infra && bunx cdk deploy ${STACK_NAME} \\"
echo "    --context agentImageTag=${TAG} \\"
echo "    --context agentImageDigest=${DIGEST}"
echo ""
echo "After deploy, confirm the running build via CloudWatch:"
echo "  aws logs tail /aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT \\"
echo "    --region ${REGION} --since 5m | grep BUILD_MARKER"
