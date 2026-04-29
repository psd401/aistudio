#!/bin/bash

# Exit on error
set -e

echo "Building Lambda functions..."

# Compile TypeScript files with strict settings
echo "Compiling TypeScript..."
bunx tsc lambdas/file-processor/index.ts --outDir lambdas/file-processor --lib es2022 --target es2022 --module commonjs --esModuleInterop --strict
bunx tsc lambdas/url-processor/index.ts --outDir lambdas/url-processor --lib es2022 --target es2022 --module commonjs --esModuleInterop --strict

# Install dependencies for file-processor
echo "Installing dependencies for file-processor..."
cd lambdas/file-processor
bun install --production
cd ../..

# Install dependencies for url-processor
echo "Installing dependencies for url-processor..."
cd lambdas/url-processor
bun install --production
cd ../..

# Install dependencies and build agent-router
echo "Building agent-router..."
cd lambdas/agent-router
# Install all deps (including devDependencies for tsc build)
bun install
bunx tsc
# Prune to production-only for smaller Lambda package
rm -rf node_modules
bun install --production
cd ../..

# Create processing layer
echo "Creating processing layer..."
mkdir -p layers/processing/nodejs
cd layers/processing/nodejs
if [ ! -f "package.json" ]; then
    echo '{"name":"processing-layer","version":"1.0.0","private":true}' > package.json
fi
bun install pdf-parse mammoth xlsx csv-parse marked cheerio node-fetch @types/node-fetch
cd ../../..

echo "Lambda build complete!"
