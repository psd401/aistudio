#!/bin/bash

# Exit on error
set -e

echo "Building Lambda functions..."

# NOTE: file-processor, url-processor, and textract-processor compile at CDK
# synth time (bundledLambdaAsset in lib/processing-stack.ts), as does the
# secret-cache layer (lib/constructs/compute/secret-cache-layer.ts) and the
# db-init Lambda (lib/database-stack.ts). None of them need a pre-deploy
# build step here, and their compiled output is no longer committed.

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

# Populate the shared processing layer from its committed manifest.
# layers/processing/nodejs/package.json pins the dependency versions
# (node-fetch is deliberately held at ^2.7.0 — see B-013 / PR #1130).
# Never install packages here by name: that rewrites the manifest with
# whatever the latest versions happen to be.
echo "Building processing layer..."
cd layers/processing
./build-layer.sh
cd ../..

echo "Lambda build complete!"
