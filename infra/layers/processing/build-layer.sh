#!/bin/bash
set -e

# Clean up previous builds
rm -rf nodejs/node_modules
rm -rf layer.zip

# Install production dependencies
cd nodejs
bun install --production

# Remove .bin directory which contains symlinks that cause issues
rm -rf node_modules/.bin

# Remove any other problematic files
find node_modules -type l -delete  # Remove all symlinks
find node_modules -name "*.md" -delete  # Remove markdown files
find node_modules -name "*.ts" -delete  # Remove TypeScript files
find node_modules -name "*.map" -delete  # Remove source maps

cd ..

echo "Layer build complete"
