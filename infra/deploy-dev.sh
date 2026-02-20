#!/bin/bash

# Exit on error
set -e

# Check if Google Client ID is provided
if [ -z "$1" ]; then
    echo "Usage: ./deploy-dev.sh <GOOGLE_CLIENT_ID> [BASE_DOMAIN]"
    echo "Example: ./deploy-dev.sh 905669698724-xxx.apps.googleusercontent.com aistudio.psd401.ai"
    exit 1
fi

GOOGLE_CLIENT_ID=$1
BASE_DOMAIN=${2:-"aistudio.psd401.ai"}

echo "Deploying Dev stacks..."
echo "Google Client ID: $GOOGLE_CLIENT_ID"
echo "Base Domain: $BASE_DOMAIN"

# Deploy all dev stacks
bunx cdk deploy \
  AIStudio-DatabaseStack-Dev \
  AIStudio-AuthStack-Dev \
  AIStudio-StorageStack-Dev \
  AIStudio-ProcessingStack-Dev \
  AIStudio-FrontendStack-Dev \
  --parameters AIStudio-AuthStack-Dev:GoogleClientId=$GOOGLE_CLIENT_ID \
  --context baseDomain=$BASE_DOMAIN \
  --require-approval never
