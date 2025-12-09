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

echo "=== Docker Integration Test: Image Cache Permissions (#509) ==="

# Detect platform for Docker build
PLATFORM="linux/amd64"
if [ "$(uname -m)" = "arm64" ] || [ "$(uname -m)" = "aarch64" ]; then
  PLATFORM="linux/arm64"
fi

echo "Building for platform: $PLATFORM"

# Build the Docker image
echo "Building Docker image..."
docker build -f Dockerfile --platform="$PLATFORM" -t aistudio-test:latest . || {
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

# Test 3: Verify permissions are 755 (after entrypoint creates directory)
echo ""
echo "Test 3: Verifying directory permissions..."
PERMS=$(docker run --rm --platform="$PLATFORM" -v /tmp/nextjs-cache-test:/app/.next/cache aistudio-test:latest sh -c 'stat -c "%a" /app/.next/cache/images')
if [ "$PERMS" = "755" ]; then
  echo "✓ Permissions correct: 755"
else
  echo "ERROR: Incorrect permissions - Expected: 755, Got: $PERMS"
  exit 1
fi

# Test 4: Verify ownership is nextjs:nodejs (after entrypoint fixes ownership)
echo ""
echo "Test 4: Verifying ownership..."
OWNER=$(docker run --rm --platform="$PLATFORM" -v /tmp/nextjs-cache-test:/app/.next/cache aistudio-test:latest sh -c 'stat -c "%U:%G" /app/.next/cache/images')
if [ "$OWNER" = "nextjs:nodejs" ]; then
  echo "✓ Ownership correct: nextjs:nodejs"
else
  echo "ERROR: Incorrect ownership - Expected: nextjs:nodejs, Got: $OWNER"
  exit 1
fi

# Cleanup
rm -rf /tmp/nextjs-cache-test

echo ""
echo "=== All Tests Passed ✓ ==="
echo "The container is ready for deployment to ECS."
