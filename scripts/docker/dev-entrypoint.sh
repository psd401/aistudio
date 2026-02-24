#!/bin/sh
# dev-entrypoint.sh — Clear stale Turbopack cache when source code changes.
#
# Problem: The .next anonymous Docker volume persists across container
# stop/start cycles. When source files change on the host (e.g., git pull,
# branch switch), Turbopack hot reload can fail to fully recompile renamed
# or moved symbols. This leaves stale compiled chunks that reference old
# function names, causing runtime 404s.
#
# Fix: On container start, compare a checksum of source files against the
# last saved checksum. If they differ, delete .next to force a clean build.
# Turbopack recompiles in seconds, so the startup cost is negligible.
#
# Issue #800 — MCP OAuth 404 caused by stale assertUserAccess reference

# Store checksum inside the .next volume so it's co-located with the cache.
# When .next is deleted the checksum goes with it, keeping logic self-consistent.
# /tmp/ would survive container stop/start but not image rebuild, leaving stale
# .next volumes undetected after Dockerfile changes.
CHECKSUM_FILE="/app/.next/.source-checksum"

# Ensure the directory exists (first run or after cache clear)
mkdir -p /app/.next

# Checksum all TypeScript source files that Turbopack compiles
CURRENT=$(find /app/app /app/lib /app/actions /app/components \
  -name '*.ts' -o -name '*.tsx' 2>/dev/null \
  | sort \
  | xargs sha256sum 2>/dev/null \
  | sha256sum \
  | cut -d' ' -f1)

if [ -f "$CHECKSUM_FILE" ]; then
  PREVIOUS=$(cat "$CHECKSUM_FILE")
  if [ "$CURRENT" != "$PREVIOUS" ]; then
    echo "[dev-entrypoint] Source files changed since last start — clearing .next cache"
    rm -rf /app/.next
  else
    echo "[dev-entrypoint] Source files unchanged — keeping .next cache"
  fi
else
  echo "[dev-entrypoint] First start — recording source checksum"
fi

echo "$CURRENT" > "$CHECKSUM_FILE"

exec "$@"
