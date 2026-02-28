# Deployment Safety Checklist

## Pre-Deployment Verification

### ✅ What Will Change
Based on the test output:

1. **DatabaseStack-Dev**:
   - ✅ Adds 2 new SSM parameters (non-breaking)
   - ✅ Updates Lambda code (normal update)
   - ❌ No resources deleted

2. **StorageStack-Dev**:
   - ✅ Adds 1 new SSM parameter (non-breaking)
   - ❌ No resources deleted

3. **ProcessingStack-Dev**:
   - ✅ Adds SSM parameter lookups (backward compatible)
   - ✅ IAM policy update (normal)
   - ❌ No resources deleted

4. **FrontendStack-Dev**:
   - ✅ Adds SSM parameter lookup (backward compatible)
   - ✅ IAM role update to reference SSM parameter
   - ❌ No resources deleted

### ✅ Safety Guarantees

1. **No Breaking Changes**:
   - All changes are additive (new SSM parameters)
   - Existing CloudFormation exports remain
   - Props made optional for backward compatibility

2. **Rollback Safety**:
   - Can revert to previous code and redeploy
   - SSM parameters will remain but won't cause issues
   - No data loss or service interruption

3. **Application Continuity**:
   - Running applications continue to work
   - No environment variable changes
   - No database or storage changes

## Deployment Steps

### Option 1: Safe Full Deployment (Recommended)
```bash
# Deploy all stacks together to ensure SSM parameters are created
bunx cdk deploy --all --context baseDomain=aistudio.psd401.ai

# This will:
# 1. Create SSM parameters in Database and Storage stacks
# 2. Update Processing and Frontend stacks to use them
# 3. Maintain all existing functionality
```

### Option 2: Staged Deployment (More Control)
```bash
# 1. Deploy stacks that create SSM parameters first
bunx cdk deploy AIStudio-DatabaseStack-Dev AIStudio-StorageStack-Dev --context baseDomain=aistudio.psd401.ai

# 2. Verify SSM parameters were created
aws ssm get-parameters-by-path --path '/aistudio/dev' --recursive

# 3. Deploy stacks that consume SSM parameters
bunx cdk deploy AIStudio-ProcessingStack-Dev AIStudio-FrontendStack-Dev --context baseDomain=aistudio.psd401.ai
```

## Post-Deployment Verification

### 1. Check SSM Parameters
```bash
# Should see 3 parameters
aws ssm get-parameters-by-path --path '/aistudio/dev' --recursive --query 'Parameters[*].Name'

# Expected output:
# - /aistudio/dev/db-cluster-arn
# - /aistudio/dev/db-secret-arn  
# - /aistudio/dev/documents-bucket-name
```

### 2. Verify Application Health
```bash
# Check Amplify app status
aws amplify get-app --app-id $(aws amplify list-apps --query 'apps[?name==`aistudio-dev`].appId' --output text)

# Check Lambda functions
aws lambda list-functions --query 'Functions[?starts_with(FunctionName, `AIStudio-ProcessingStack-Dev`)].FunctionName'
```

### 3. Test Independent Stack Deployment
```bash
# After initial deployment, test updating a single stack
bunx cdk deploy AIStudio-DatabaseStack-Dev --exclusively --context baseDomain=aistudio.psd401.ai
```

## Troubleshooting

### If Deployment Fails

1. **SSM Parameter Not Found Error**:
   ```bash
   # Deploy Database and Storage stacks first
   bunx cdk deploy AIStudio-DatabaseStack-Dev AIStudio-StorageStack-Dev
   ```

2. **CloudFormation Rollback**:
   ```bash
   # Check stack events for error details
   aws cloudformation describe-stack-events --stack-name AIStudio-ProcessingStack-Dev --query 'StackEvents[?ResourceStatus==`CREATE_FAILED`]'
   ```

3. **Emergency Rollback**:
   ```bash
   # Revert to previous commit
   git checkout dev
   
   # Deploy with old code
   bunx cdk deploy --all --context baseDomain=aistudio.psd401.ai
   ```

## Success Indicators

✅ All stacks show UPDATE_COMPLETE status
✅ SSM parameters exist in Parameter Store  
✅ Application remains accessible
✅ No CloudFormation rollbacks
✅ Future deployments can use --exclusively flag

## Next Steps After Success

1. Test independent deployment of each stack
2. Update team documentation
3. Monitor for any issues over next 24 hours
4. Consider applying same pattern to production