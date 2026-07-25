# CDK Deployment Commands Reference

## Stack Requirements

### Parameters Required by Each Stack:

| Stack | GoogleClientId | GooglePickerApiKey | baseDomain | Notes |
|-------|---------------|--------------------|------------|-------|
| DatabaseStack | ❌ | ❌ | ❌ | No parameters needed |
| AuthStack | ✅ | ✅ | ✅ (indirect) | Creates the application OAuth/Picker secret; baseDomain is used for callback URLs |
| StorageStack | ❌ | ❌ | ❌ | No parameters needed |
| ProcessingStack | ❌ | ❌ | ❌ | Depends on the AuthStack content OAuth secret |
| FrontendStack | ❌ | ❌ | ✅ | Only created when baseDomain is provided |

## Full Deployment Commands

### Deploy All Stacks (Dev Environment)
```bash
# With all required parameters
bunx cdk deploy --all \
  --parameters AIStudio-AuthStack-Dev:GoogleClientId=YOUR_GOOGLE_CLIENT_ID \
  --parameters AIStudio-AuthStack-Dev:GooglePickerApiKey=YOUR_RESTRICTED_PICKER_KEY \
  --context baseDomain=aistudio.psd401.ai

# Or use the helper script
GOOGLE_PICKER_API_KEY=YOUR_RESTRICTED_PICKER_KEY \
  ./deploy-dev.sh YOUR_GOOGLE_CLIENT_ID aistudio.psd401.ai
```

### Deploy All Stacks (Prod Environment)
```bash
bunx cdk deploy \
  AIStudio-DatabaseStack-Prod \
  AIStudio-AuthStack-Prod \
  AIStudio-StorageStack-Prod \
  AIStudio-ProcessingStack-Prod \
  AIStudio-FrontendStack-ECS-Prod \
  --parameters AIStudio-AuthStack-Prod:GoogleClientId=YOUR_PROD_GOOGLE_CLIENT_ID \
  --parameters AIStudio-AuthStack-Prod:GooglePickerApiKey=YOUR_PROD_RESTRICTED_PICKER_KEY \
  --context baseDomain=aistudio.psd401.ai
```

## Individual Stack Deployment Commands

### DatabaseStack (No parameters needed)
```bash
# Dev
bunx cdk deploy AIStudio-DatabaseStack-Dev --exclusively

# Prod
bunx cdk deploy AIStudio-DatabaseStack-Prod --exclusively
```

### AuthStack (Requires GoogleClientId and GooglePickerApiKey)
```bash
# Dev
bunx cdk deploy AIStudio-AuthStack-Dev \
  --parameters AIStudio-AuthStack-Dev:GoogleClientId=YOUR_GOOGLE_CLIENT_ID \
  --parameters AIStudio-AuthStack-Dev:GooglePickerApiKey=YOUR_RESTRICTED_PICKER_KEY \
  --context baseDomain=aistudio.psd401.ai \
  --exclusively

# Prod
bunx cdk deploy AIStudio-AuthStack-Prod \
  --parameters AIStudio-AuthStack-Prod:GoogleClientId=YOUR_PROD_GOOGLE_CLIENT_ID \
  --parameters AIStudio-AuthStack-Prod:GooglePickerApiKey=YOUR_PROD_RESTRICTED_PICKER_KEY \
  --context baseDomain=aistudio.psd401.ai \
  --exclusively
```

### StorageStack (No parameters needed)
```bash
# Dev
bunx cdk deploy AIStudio-StorageStack-Dev --exclusively

# Prod
bunx cdk deploy AIStudio-StorageStack-Prod --exclusively
```

### ProcessingStack (No parameters needed)
```bash
# Dev
bunx cdk deploy AIStudio-ProcessingStack-Dev \
  --exclusively

# Prod
bunx cdk deploy AIStudio-ProcessingStack-Prod \
  --exclusively
```

Group-sync alarms publish to the shared
`aistudio-<environment>-monitoring-alarms` topic owned by MonitoringStack.
Configure and confirm delivery endpoints when deploying MonitoringStack; a
focused ProcessingStack deployment never creates or removes subscriptions.

### FrontendStack (Requires baseDomain)
```bash
# Dev
bunx cdk deploy AIStudio-FrontendStack-ECS-Dev \
  --context baseDomain=aistudio.psd401.ai \
  --exclusively

# Prod
bunx cdk deploy AIStudio-FrontendStack-ECS-Prod \
  --context baseDomain=aistudio.psd401.ai \
  --exclusively
```

## Important Notes

### 1. Google Client ID
- Required for AuthStack only
- Get from Google Cloud Console
- Different IDs for dev/prod environments
- Stored in Secrets Manager as `aistudio-dev-google-oauth` and `aistudio-prod-google-oauth`

### 2. Google Picker API Key
- Required for AuthStack only
- Use a browser key restricted to the environment's exact HTTPS origin and the Google Picker/Drive APIs
- Passed as a NoEcho CloudFormation parameter; never commit it or place it in a shell script
- AuthStack combines it with the existing client ID/client secret in the retained `aistudio/{environment}/google-content-oauth` secret

### 3. Base Domain
- Required when deploying FrontendStack
- Used by AuthStack for callback URLs (passed via context)
- If not provided, FrontendStack won't be created

### 4. First Deployment After OAuth Deployment Changes
```bash
# Deploy all at once to ensure SSM parameters are created
bunx cdk deploy --all \
  --parameters AIStudio-AuthStack-Dev:GoogleClientId=YOUR_GOOGLE_CLIENT_ID \
  --parameters AIStudio-AuthStack-Dev:GooglePickerApiKey=YOUR_RESTRICTED_PICKER_KEY \
  --context baseDomain=aistudio.psd401.ai
```

### 5. Deployment Order (if deploying individually)
1. DatabaseStack & StorageStack (can be parallel, no dependencies)
2. AuthStack (needs GoogleClientId and GooglePickerApiKey)
3. ProcessingStack (depends on Database, Storage, and the AuthStack content OAuth secret)
4. FrontendStack (depends on SSM from Storage, needs baseDomain)

## Quick Reference

### Most Common Commands

```bash
# Deploy everything (dev)
GOOGLE_PICKER_API_KEY=YOUR_RESTRICTED_PICKER_KEY \
  ./deploy-dev.sh YOUR_GOOGLE_CLIENT_ID aistudio.psd401.ai

# Update just the database
bunx cdk deploy AIStudio-DatabaseStack-Dev --exclusively

# Update just the frontend
bunx cdk deploy AIStudio-FrontendStack-ECS-Dev --context baseDomain=aistudio.psd401.ai --exclusively

# Update auth (if Google OAuth changes)
bunx cdk deploy AIStudio-AuthStack-Dev \
  --parameters AIStudio-AuthStack-Dev:GoogleClientId=NEW_GOOGLE_CLIENT_ID \
  --parameters AIStudio-AuthStack-Dev:GooglePickerApiKey=YOUR_RESTRICTED_PICKER_KEY \
  --context baseDomain=aistudio.psd401.ai \
  --exclusively
```

## Environment Variables in Amplify

Remember to set these in the Amplify Console for each app:
- All environment variables from the stack outputs
- Database credentials from Secrets Manager
- Any other app-specific configuration

See `/docs/ENVIRONMENT_VARIABLES.md` for the full list.
