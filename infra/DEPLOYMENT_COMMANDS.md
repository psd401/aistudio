# CDK Deployment Commands Reference

## Stack Requirements

### Parameters Required by Each Stack:

| Stack | GoogleClientId | baseDomain | Notes |
|-------|---------------|------------|-------|
| DatabaseStack | ❌ | ❌ | No parameters needed |
| AuthStack | ✅ | ✅ (indirect) | Needs GoogleClientId parameter, baseDomain used for callback URLs |
| StorageStack | ❌ | ❌ | No parameters needed |
| ProcessingStack | ❌ | ❌ | No parameters needed |
| FrontendStack | ❌ | ✅ | Only created when baseDomain is provided |

## Full Deployment Commands

### Deploy All Stacks (Dev Environment)
```bash
# With all required parameters
bunx cdk deploy --all \
  --parameters AIStudio-AuthStack-Dev:GoogleClientId=YOUR_GOOGLE_CLIENT_ID \
  --context baseDomain=aistudio.psd401.ai

# Or use the helper script
./deploy-dev.sh YOUR_GOOGLE_CLIENT_ID aistudio.psd401.ai
```

### Deploy All Stacks (Prod Environment)
```bash
bunx cdk deploy \
  AIStudio-DatabaseStack-Prod \
  AIStudio-AuthStack-Prod \
  AIStudio-StorageStack-Prod \
  AIStudio-ProcessingStack-Prod \
  AIStudio-FrontendStack-Prod \
  --parameters AIStudio-AuthStack-Prod:GoogleClientId=YOUR_PROD_GOOGLE_CLIENT_ID \
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

### AuthStack (Requires GoogleClientId)
```bash
# Dev
bunx cdk deploy AIStudio-AuthStack-Dev \
  --parameters AIStudio-AuthStack-Dev:GoogleClientId=YOUR_GOOGLE_CLIENT_ID \
  --context baseDomain=aistudio.psd401.ai \
  --exclusively

# Prod
bunx cdk deploy AIStudio-AuthStack-Prod \
  --parameters AIStudio-AuthStack-Prod:GoogleClientId=YOUR_PROD_GOOGLE_CLIENT_ID \
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

### ProcessingStack (No parameters needed after SSM setup)
```bash
# Dev
bunx cdk deploy AIStudio-ProcessingStack-Dev --exclusively

# Prod
bunx cdk deploy AIStudio-ProcessingStack-Prod --exclusively
```

### FrontendStack (Requires baseDomain)
```bash
# Dev
bunx cdk deploy AIStudio-FrontendStack-Dev \
  --context baseDomain=aistudio.psd401.ai \
  --exclusively

# Prod
bunx cdk deploy AIStudio-FrontendStack-Prod \
  --context baseDomain=aistudio.psd401.ai \
  --exclusively
```

## Important Notes

### 1. Google Client ID
- Required for AuthStack only
- Get from Google Cloud Console
- Different IDs for dev/prod environments
- Stored in Secrets Manager as `aistudio-dev-google-oauth` and `aistudio-prod-google-oauth`

### 2. Base Domain
- Required when deploying FrontendStack
- Used by AuthStack for callback URLs (passed via context)
- If not provided, FrontendStack won't be created

### 3. First Deployment After SSM Changes
```bash
# Deploy all at once to ensure SSM parameters are created
bunx cdk deploy --all \
  --parameters AIStudio-AuthStack-Dev:GoogleClientId=YOUR_GOOGLE_CLIENT_ID \
  --context baseDomain=aistudio.psd401.ai
```

### 4. Deployment Order (if deploying individually)
1. DatabaseStack & StorageStack (can be parallel, no dependencies)
2. AuthStack (no dependencies, but needs GoogleClientId)
3. ProcessingStack (depends on SSM from Database & Storage)
4. FrontendStack (depends on SSM from Storage, needs baseDomain)

## Quick Reference

### Most Common Commands

```bash
# Deploy everything (dev)
./deploy-dev.sh YOUR_GOOGLE_CLIENT_ID aistudio.psd401.ai

# Update just the database
bunx cdk deploy AIStudio-DatabaseStack-Dev --exclusively

# Update just the frontend
bunx cdk deploy AIStudio-FrontendStack-Dev --context baseDomain=aistudio.psd401.ai --exclusively

# Update auth (if Google OAuth changes)
bunx cdk deploy AIStudio-AuthStack-Dev \
  --parameters AIStudio-AuthStack-Dev:GoogleClientId=NEW_GOOGLE_CLIENT_ID \
  --context baseDomain=aistudio.psd401.ai \
  --exclusively
```

## Environment Variables in Amplify

Remember to set these in the Amplify Console for each app:
- All environment variables from the stack outputs
- Database credentials from Secrets Manager
- Any other app-specific configuration

See `/docs/ENVIRONMENT_VARIABLES.md` for the full list.