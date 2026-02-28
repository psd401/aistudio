# Testing Guide for Base CDK Constructs Library (PR #412)

This guide explains how to test and validate the base CDK constructs library before and after merging.

## Overview

**PR #412** introduces a foundational constructs library without modifying existing infrastructure. This means:
- ✅ **Safe to merge** - No breaking changes
- ✅ **Safe to deploy** - Creates new resources only if you explicitly use them
- ⚠️ **Not yet used** - Existing stacks continue using old patterns until migrated

## Testing Approaches

### 1. Unit Tests (No AWS Account Required)

**Best for:** Validating logic, configuration, and patterns

```bash
cd infra

# Run all tests
npm test

# Run specific test suite
npm test -- base-stack.test.ts
npm test -- tagging-aspect.test.ts
npm test -- environment-config.test.ts

# Run with coverage report
npm test -- --coverage

# Watch mode for development
npm test -- --watch
```

**Expected Results:**
- ✅ All 150+ tests pass
- ✅ Coverage >90% for all components
- ✅ No TypeScript or linting errors

**What This Tests:**
- BaseStack applies tags correctly
- EnvironmentConfig returns correct values for each environment
- TaggingAspect classifies resources properly
- LambdaConstruct creates functions with optimal settings
- Helper methods work as expected

---

### 2. CloudFormation Synthesis (No Deployment)

**Best for:** Verifying the constructs generate valid CloudFormation

```bash
cd infra

# Create a test app file
cat > bin/test-new-constructs.ts << 'EOF'
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StorageStackV2 } from '../lib/stacks/storage-stack-v2';
import { EnvironmentConfig } from '../lib/constructs';

const app = new cdk.App();

const testStack = new StorageStackV2(app, 'TestStack', {
  environment: 'dev',
  config: EnvironmentConfig.get('dev'),
  allowedOrigins: [
    'https://dev.example.com',
    'http://localhost:3000'
  ],
  env: {
    account: '123456789012', // Dummy account
    region: 'us-east-1',
  },
});

app.synth();
EOF

# Synthesize the CloudFormation template
bunx cdk synth -a "bunx ts-node bin/test-new-constructs.ts"
```

**What to Verify in Output:**

1. **Tags are Applied:**
```yaml
Tags:
  - Key: Environment
    Value: Dev
  - Key: Project
    Value: AIStudio
  - Key: Owner
    Value: TSD Engineering
  - Key: ManagedBy
    Value: CDK
  # ... more tags
```

2. **Resources Created:**
- AWS::S3::Bucket (with encryption, versioning, CORS)
- AWS::SSM::Parameter (for bucket name)
- CloudFormation Outputs

3. **Correct Removal Policy:**
```yaml
DeletionPolicy: Delete  # For dev
UpdateReplacePolicy: Delete
```

4. **CORS Configuration:**
```yaml
CorsConfiguration:
  CorsRules:
    - AllowedOrigins:
        - https://dev.example.com
        - http://localhost:3000
```

---

### 3. Isolated Stack Deployment (Safe AWS Test)

**Best for:** Verifying the stack actually deploys to AWS correctly

**Prerequisites:**
- AWS credentials configured
- CDK bootstrapped in your account/region

```bash
cd infra

# Step 1: Create a test stack that won't interfere with existing infrastructure
cat > bin/test-deployment.ts << 'EOF'
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StorageStackV2 } from '../lib/stacks/storage-stack-v2';
import { EnvironmentConfig } from '../lib/constructs';

const app = new cdk.App();

// Create a test stack with unique name
new StorageStackV2(app, 'TestNewConstructs', {
  environment: 'dev',
  config: EnvironmentConfig.get('dev'),
  allowedOrigins: [
    'http://localhost:3000'
  ],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
EOF

# Step 2: Deploy the test stack
bunx cdk deploy -a "bunx ts-node bin/test-deployment.ts" TestNewConstructs

# Step 3: Verify in AWS Console
# - Check S3 bucket was created with correct tags
# - Check SSM parameter exists
# - Verify CloudFormation stack outputs

# Step 4: Clean up when done testing
bunx cdk destroy -a "bunx ts-node bin/test-deployment.ts" TestNewConstructs
```

**What to Verify in AWS Console:**

1. **CloudFormation Stack:**
   - Stack name: `AIStudio-TestNewConstructs-dev`
   - Status: `CREATE_COMPLETE`
   - Termination protection: `Disabled` (dev environment)

2. **S3 Bucket:**
   - Block public access: Enabled
   - Encryption: Enabled
   - Versioning: Enabled
   - Tags: All 10 tags present (Environment, Project, Owner, etc.)
   - CORS: Configured with localhost:3000

3. **SSM Parameter:**
   - Path: `/aistudio/dev/documents-bucket-name`
   - Value: The bucket name
   - Tags: Applied

4. **CloudFormation Outputs:**
   - `StackEnvironment`: dev
   - `StackVersion`: CDK version
   - `DocumentsBucketName`: Bucket name

---

### 4. Integration with Existing Infrastructure

**Best for:** Verifying constructs work alongside existing stacks

**⚠️ Important:** This doesn't replace existing stacks, just adds new ones for testing.

```bash
cd infra

# Add test stack to existing app (temporarily)
# Edit bin/infra.ts to add:

import { StorageStackV2 } from '../lib/stacks/storage-stack-v2';

// At the end of the file, add:
const testNewStack = new StorageStackV2(app, 'StorageStackV2-Test', {
  environment: 'dev',
  config: EnvironmentConfig.get('dev'),
  allowedOrigins: [
    'http://localhost:3000'
  ],
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

# Then deploy just this new stack
bunx cdk deploy AIStudio-StorageStackV2-Test-dev --context baseDomain=example.com

# Verify it works, then destroy
bunx cdk destroy AIStudio-StorageStackV2-Test-dev
```

---

## When Should You Deploy?

### **Immediate Deployment (This PR)**

**Safe to deploy if:**
- ✅ Unit tests pass
- ✅ You want to validate the constructs in your AWS environment
- ✅ You're comfortable with additive-only changes

**What gets deployed:**
- ⚠️ **Nothing automatically** - The library exists but isn't used yet
- ✅ **Only if you explicitly create stacks** using the new constructs

### **Wait for Later PRs (Recommended)**

**Wait if:**
- ❌ You want to see the full migration in action first
- ❌ You prefer to deploy after other team members review
- ❌ You want to wait for subsequent PRs that actually **use** these constructs

**What to wait for:**
- Issue #374+: PRs that migrate existing stacks to use the new constructs
- Full migration: When `infra/bin/infra.ts` is refactored to use the library

---

## Recommended Testing Sequence

### **Before Merging PR #412:**

1. ✅ **Run unit tests** (5 minutes)
   ```bash
   cd infra && npm test
   ```

2. ✅ **Synthesize CloudFormation** (2 minutes)
   ```bash
   bunx cdk synth -a "bunx ts-node bin/test-new-constructs.ts"
   ```

3. ✅ **Optional: Deploy test stack** (5 minutes)
   - Deploy to dev environment
   - Verify tags and configuration
   - Destroy test stack

### **After Merging (Before Using in Production):**

1. Wait for subsequent PRs that migrate existing stacks
2. Test migrations in dev environment first
3. Gradually roll out to staging, then prod

---

## Validation Checklist

Use this checklist to verify the constructs work correctly:

### **Unit Tests**
- [ ] All 150+ tests pass
- [ ] Coverage >90% for all components
- [ ] No TypeScript compilation errors
- [ ] No ESLint warnings

### **CloudFormation Synthesis**
- [ ] Template generates without errors
- [ ] All expected resources present
- [ ] Tags applied to all resources
- [ ] Outputs defined correctly
- [ ] Removal policies correct (DESTROY for dev, RETAIN for prod)

### **AWS Deployment (Optional)**
- [ ] Stack deploys successfully
- [ ] S3 bucket created with correct configuration
- [ ] SSM parameter created
- [ ] All resources tagged correctly
- [ ] CloudFormation outputs visible
- [ ] Stack can be destroyed cleanly

### **Code Quality**
- [ ] TypeScript strict mode enabled
- [ ] All exports properly typed
- [ ] JSDoc comments comprehensive
- [ ] Examples work as documented

---

## Common Issues & Solutions

### Issue: "Module not found: @/lib/constructs"

**Solution:**
```bash
# Ensure you're in the infra directory
cd infra

# Rebuild TypeScript
npm run build

# Try again
npm test
```

### Issue: "CDK bootstrap required"

**Solution:**
```bash
# Bootstrap your AWS account/region for CDK
bunx cdk bootstrap aws://ACCOUNT-ID/REGION
```

### Issue: "Tests fail with import errors"

**Solution:**
```bash
# Clear node_modules and reinstall
cd infra
rm -rf node_modules package-lock.json
npm install
npm run build
npm test
```

### Issue: "CloudFormation synthesis fails"

**Solution:**
```bash
# Ensure test file has correct imports
# Check that all required props are provided
# Verify TypeScript compilation works first
npm run build
```

---

## Next Steps After Testing

### **If Tests Pass:**
1. ✅ Merge PR #412 to `dev` branch
2. ✅ Document that the library is available for use
3. ✅ Wait for subsequent PRs to migrate existing stacks

### **If Tests Fail:**
1. ❌ Review test output for specific errors
2. ❌ Fix issues and push updates to PR
3. ❌ Re-run tests until all pass

### **For Future Migrations:**
Each subsequent PR that uses these constructs should:
1. Migrate one stack at a time
2. Test in dev first
3. Verify side-by-side with old stack
4. Gradually replace old pattern

---

## Questions?

- **"Is this safe to merge?"** → Yes, it's completely additive
- **"Will this break anything?"** → No, existing infrastructure is unchanged
- **"When will we see benefits?"** → After subsequent PRs migrate existing stacks
- **"Can I use this now?"** → Yes, for new stacks; existing stacks migrate later

---

## Summary

**This PR is foundation-only:**
- Creates the library
- Doesn't use it yet
- Safe to merge and deploy
- Benefits come in subsequent PRs

**Recommended path:**
1. Run unit tests locally
2. Merge PR #412
3. Wait for migration PRs (Issues #374+)
4. Test migrations in dev
5. Roll out to prod incrementally
