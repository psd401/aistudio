#!/bin/bash
# Integration test for Next.js image cache directory creation
# Tests fix for issue #509: EACCES errors in production ECS containers
#
# Validates:
# 1. /app/.next/cache/images directory exists in container
# 2. Directory has correct ownership (nextjs:nodejs)
# 3. Directory is writable by nextjs user
# 4. Container runs with readonly root filesystem

set -e

# Ensure cleanup runs even if tests fail
cleanup() {
  echo "Cleaning up test artifacts..."
  docker rmi aistudio-test:latest 2>/dev/null || true
  rm -rf /tmp/nextjs-cache-test
}
trap cleanup EXIT

echo "=== Docker Integration Test: Image Cache Permissions (#509) ==="

# Verify Docker is available
if ! command -v docker &> /dev/null; then
  echo "ERROR: Docker not found. Please install Docker to run this test."
  echo "See: https://docs.docker.com/get-docker/"
  exit 1
fi

# Verify Docker daemon is running
if ! docker info &> /dev/null; then
  echo "ERROR: Docker daemon not running. Please start Docker."
  exit 1
fi

echo "✓ Docker is available and running"

# Detect platform for Docker build
PLATFORM="linux/amd64"
if [ "$(uname -m)" = "arm64" ] || [ "$(uname -m)" = "aarch64" ]; then
  PLATFORM="linux/arm64"
fi

echo "Building for platform: $PLATFORM"

# Determine which Dockerfile to test (default: Dockerfile, can override with DOCKERFILE env var)
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
echo "Testing Dockerfile: $DOCKERFILE"

# Build the Docker image
echo "Building Docker image..."
docker build -f "$DOCKERFILE" --platform="$PLATFORM" -t aistudio-test:latest . || {
  echo "ERROR: Docker build failed"
  exit 1
}

# Test 1: Verify entrypoint script exists and is executable
echo ""
echo "Test 1: Checking entrypoint script..."
docker run --rm \
  --platform="$PLATFORM" \
  aistudio-test:latest \
  sh -c 'ls -la /usr/local/bin/entrypoint.sh && file /usr/local/bin/entrypoint.sh' || {
  echo "ERROR: Entrypoint script check failed"
  exit 1
}

# Test 2: Run container with readonly root filesystem and volume mount (simulates ECS)
# The entrypoint script should create /app/.next/cache/images and fix ownership
echo ""
echo "Test 2: Testing with readonly filesystem and volume mount..."

# Explicitly create volume mount directory with proper permissions
mkdir -p /tmp/nextjs-cache-test
chmod 755 /tmp/nextjs-cache-test

docker run --rm \
  --platform="$PLATFORM" \
  --read-only \
  -v /tmp/nextjs-cache-test:/app/.next/cache \
  --name aistudio-test-cache \
  -e DOCUMENTS_BUCKET_NAME=test-bucket \
  -e RDS_RESOURCE_ARN=arn:aws:rds:us-east-1:000000000000:cluster:test \
  -e RDS_SECRET_ARN=arn:aws:secretsmanager:us-east-1:000000000000:secret:test \
  -e AUTH_SECRET=test-secret-12345678901234567890123456789012 \
  -e AUTH_URL=http://localhost:3000 \
  -e AUTH_COGNITO_CLIENT_ID=test-client \
  -e AUTH_COGNITO_ISSUER=https://cognito.amazonaws.com/test \
  aistudio-test:latest \
  sh -c 'ls -la /app/.next/cache && ls -la /app/.next/cache/images && touch /app/.next/cache/images/test.txt && echo "SUCCESS: Image cache writable"' || {
  echo "ERROR: Write test failed"
  exit 1
}

# Test 3: Verify permissions are 750 (after entrypoint creates directory)
# Alpine BusyBox stat compatible: use ls -ld and parse
echo ""
echo "Test 3: Verifying directory permissions..."
PERMS=$(docker run --rm --platform="$PLATFORM" -v /tmp/nextjs-cache-test:/app/.next/cache aistudio-test:latest sh -c 'ls -ld /app/.next/cache/images | cut -c1-10')
if [ "$PERMS" = "drwxr-x---" ]; then
  echo "✓ Permissions correct: 750 (owner+group only, more secure)"
else
  echo "ERROR: Incorrect permissions - Expected: drwxr-x--- (750), Got: $PERMS"
  exit 1
fi

# Test 4: Verify ownership is nextjs:nodejs (numeric UID/GID for Alpine compatibility)
# Alpine/BusyBox uses numeric IDs: nextjs=1001, nodejs=1001
echo ""
echo "Test 4: Verifying ownership (numeric UID/GID)..."
OWNER_UID=$(docker run --rm --platform="$PLATFORM" -v /tmp/nextjs-cache-test:/app/.next/cache aistudio-test:latest sh -c 'stat -c "%u:%g" /app/.next/cache/images 2>/dev/null || ls -ldn /app/.next/cache/images | awk "{print \$3\":\"\$4}"')
if [ "$OWNER_UID" = "1001:1001" ]; then
  echo "✓ Ownership correct: 1001:1001 (nextjs:nodejs)"
else
  echo "ERROR: Incorrect ownership - Expected: 1001:1001 (nextjs:nodejs), Got: $OWNER_UID"
  exit 1
fi

# Test 5: Verify entrypoint properly execs to Node.js (PID 1 verification)
echo ""
echo "Test 5: Verifying PID 1 is node process (not shell)..."

# Start container in background for 5 seconds, check PID 1
CONTAINER_ID=$(docker run -d --rm \
  --platform="$PLATFORM" \
  -v /tmp/nextjs-cache-test:/app/.next/cache \
  -e DOCUMENTS_BUCKET_NAME=test-bucket \
  -e RDS_RESOURCE_ARN=arn:aws:rds:us-east-1:000000000000:cluster:test \
  -e RDS_SECRET_ARN=arn:aws:secretsmanager:us-east-1:000000000000:secret:test \
  -e AUTH_SECRET=test-secret-12345678901234567890123456789012 \
  -e AUTH_URL=http://localhost:3000 \
  -e AUTH_COGNITO_CLIENT_ID=test-client \
  -e AUTH_COGNITO_ISSUER=https://cognito.amazonaws.com/test \
  aistudio-test:latest)

# Wait for container to start
sleep 3

# Check PID 1 process name
PID1_CMD=$(docker exec "$CONTAINER_ID" ps -o pid,comm 2>/dev/null | awk '$1 == 1 {print $2}')

# Stop container
docker stop "$CONTAINER_ID" >/dev/null 2>&1 || true

if [ "$PID1_CMD" = "node" ]; then
  echo "✓ PID 1 is node process (entrypoint exec working correctly)"
else
  echo "ERROR: PID 1 is not node process - Got: $PID1_CMD"
  echo "This indicates entrypoint is not properly exec'ing to CMD"
  exit 1
fi

echo ""
echo "=== All Tests Passed ✓ ==="
echo "The container is ready for deployment to ECS."
echo ""
echo "Note: Cleanup (image removal, temp files) happens automatically on exit."
