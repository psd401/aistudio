#!/bin/bash
# Docker Cleanup Script for Local Development
# Run weekly to prevent disk space issues
#
# Usage:
#   ./scripts/docker-cleanup.sh          # Quick cleanup (safe while running)
#   ./scripts/docker-cleanup.sh --deep   # Deep cleanup (stops containers)

set -e

echo "🐳 Docker Cleanup Starting..."
echo ""

# Show current usage
echo "📊 Current Docker disk usage:"
docker system df
echo ""

if [ "$1" == "--deep" ]; then
    echo "🔴 Deep cleanup requested - this will stop containers temporarily"
    echo ""

    # Check if we're in a directory with docker-compose
    if [ -f "docker-compose.yml" ] || [ -f "compose.yaml" ]; then
        echo "⏹️  Stopping containers..."
        docker compose down 2>/dev/null || docker-compose down 2>/dev/null || true

        echo "🧹 Pruning unused volumes..."
        docker volume prune -f

        echo "🚀 Restarting containers..."
        docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null || true
    else
        echo "⚠️  No docker-compose.yml found - pruning volumes without restart"
        docker volume prune -f
    fi
else
    echo "🟢 Quick cleanup (containers stay running)"
fi

echo ""
echo "🧹 Pruning build cache..."
docker builder prune -f

echo ""
echo "🧹 Pruning dangling images..."
docker image prune -f

echo ""
echo "📊 Docker disk usage after cleanup:"
docker system df

echo ""
echo "✅ Docker cleanup complete!"
