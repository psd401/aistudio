#!/bin/sh
# Entrypoint script for Next.js application in ECS Fargate
# Fixes permissions on volume mounts before starting the application
#
# Issue #509: Next.js Image Optimization requires writable /app/.next/cache/images
# directory, but ECS volume mounts are created with root ownership.
#
# This script runs as root at container startup to fix ownership before
# exec'ing to the main application process as the nextjs user.

set -e

echo "[entrypoint] Setting correct ownership on /app/.next/cache volume..."

# Ensure the cache directory exists and is owned by nextjs:nodejs
# This handles the case where the volume mount is empty or root-owned
if [ -d "/app/.next/cache" ]; then
  # Log current state for debugging
  echo "[entrypoint] Current ownership: $(stat -c '%U:%G %a' /app/.next/cache 2>/dev/null || echo 'unknown')"

  # Only fix ownership of the cache directory itself (non-recursive for performance)
  # Subdirectories will be created by nextjs user with correct ownership
  if ! chown nextjs:nodejs /app/.next/cache; then
    echo "[entrypoint] ERROR: Failed to set ownership on /app/.next/cache"
    exit 1
  fi

  if ! chmod 750 /app/.next/cache; then
    echo "[entrypoint] ERROR: Failed to set permissions on /app/.next/cache"
    exit 1
  fi

  # Create images subdirectory if it doesn't exist (idempotent)
  if ! mkdir -p /app/.next/cache/images; then
    echo "[entrypoint] ERROR: Failed to create /app/.next/cache/images"
    exit 1
  fi

  if ! chown nextjs:nodejs /app/.next/cache/images; then
    echo "[entrypoint] ERROR: Failed to set ownership on /app/.next/cache/images"
    exit 1
  fi

  if ! chmod 750 /app/.next/cache/images; then
    echo "[entrypoint] ERROR: Failed to set permissions on /app/.next/cache/images"
    exit 1
  fi

  echo "[entrypoint] Permissions fixed: /app/.next/cache owned by nextjs:nodejs (750)"
else
  echo "[entrypoint] WARNING: /app/.next/cache directory not found - image caching disabled"
  # Non-fatal: Container can still start, but image optimization will be disabled
fi

# Execute the container's original command as the nextjs user
# The "exec" replaces this shell process with the target process,
# ensuring proper signal handling (SIGTERM, SIGINT)
echo "[entrypoint] Starting application: $@"
exec "$@"
