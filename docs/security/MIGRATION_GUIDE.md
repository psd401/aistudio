# IAM Security Migration Guide

## Overview

This guide provides step-by-step instructions for migrating existing IAM roles to use the new security constructs with least privilege and permission boundaries.

## Prerequisites

- CDK CLI installed and configured
- AWS credentials with appropriate permissions
- Development environment set up

## Migration Checklist

- [ ] Run IAM policy audit
- [ ] Deploy permission boundaries
- [ ] Migrate high-risk roles (CRITICAL severity)
- [ ] Migrate medium-risk roles (HIGH severity)
- [ ] Deploy Access Analyzer
- [ ] Update remaining roles
- [ ] Verify functionality
- [ ] Monitor for access denied errors

## Step-by-Step Migration

### Step 1: Audit Current State

Run the audit script to identify all policy violations:

```bash
cd infra
bunx ts-node scripts/audit-iam-policies.ts > audit-results.txt
```

Review the output and identify:
- Total number of violations
- Files with most violations
- CRITICAL and HIGH severity issues

Expected output:
```
Found 116 policy violations
  ❌ CRITICAL: 12
  ❌ HIGH: 45
  ⚠️  MEDIUM: 38
  ⚠️  LOW: 21
```

### Step 2: Deploy Permission Boundaries

Deploy permission boundary policies for each environment:

```bash
cd infra

# Development
bunx cdk deploy AIStudio-PermissionBoundary-Dev --require-approval never

# Production (when ready)
bunx cdk deploy AIStudio-PermissionBoundary-Prod --require-approval never
```

Verify deployment:
```bash
aws iam get-policy \
  --policy-arn arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/AIStudio-PermissionBoundary-dev
```

### Step 3: Migrate Lambda Roles

#### Example: Document Processing Lambda

**Before (overly permissive):**

```typescript
// document-processing-stack.ts
const processorRole = new iam.Role(this, "ProcessorRole", {
  assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
  ],
})

processorRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ["s3:*"],
    resources: ["*"],
  })
)

processorRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ["textract:*", "comprehend:*"],
    resources: ["*"],
  })
)
```

**After (least privilege):**

```typescript
// document-processing-stack.ts
import { ServiceRoleFactory } from "../lib/constructs/security"

const processorRole = ServiceRoleFactory.createLambdaRole(
  this,
  "ProcessorRole",
  {
    functionName: "document-processor",
    environment: props.config.environment,
    region: this.region,
    account: this.account,
    vpcEnabled: true,
    s3Buckets: [
      documentBucket.bucketName,
      `processed-${props.config.environment}`,
    ],
    additionalPolicies: [
      new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              "textract:DetectDocumentText",
              "textract:AnalyzeDocument",
              "comprehend:DetectEntities",
              "comprehend:DetectSentiment",
            ],
            resources: ["*"], // Textract and Comprehend don't support resource-level permissions
          }),
        ],
      }),
    ],
  }
)
```

Deploy and test:
```bash
bunx cdk deploy AIStudio-DocumentProcessingStack-Dev
```

Test the Lambda function to ensure it still works.

#### Example: Email Notification Lambda

**Before:**

```typescript
const emailRole = new iam.Role(this, "EmailRole", {
  assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
})

emailRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ["ses:*"],
    resources: ["*"],
  })
)

emailRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ["sqs:*"],
    resources: ["*"],
  })
)
```

**After:**

```typescript
const emailRole = ServiceRoleFactory.createLambdaRole(this, "EmailRole", {
  functionName: "email-notification",
  environment: props.config.environment,
  region: this.region,
  account: this.account,
  sqsQueues: [emailQueue.queueName],
  additionalPolicies: [
    new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ses:SendEmail", "ses:SendRawEmail"],
          resources: [
            `arn:aws:ses:${this.region}:${this.account}:identity/*`,
          ],
        }),
      ],
    }),
  ],
})
```

### Step 4: Migrate ECS Roles

#### Example: Frontend ECS Task

**Before:**

```typescript
const taskRole = new iam.Role(this, "TaskRole", {
  assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
})

taskRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ["s3:*"],
    resources: ["*"],
  })
)

taskRole.addToPolicy(
  new iam.PolicyStatement({
    actions: ["dynamodb:*"],
    resources: ["*"],
  })
)
```

**After:**

```typescript
const taskRole = ServiceRoleFactory.createECSTaskRole(this, "TaskRole", {
  taskName: "frontend-server",
  environment: props.config.environment,
  region: this.region,
  account: this.account,
  s3Buckets: [assetsBucket.bucketName],
  secrets: ["aistudio/frontend/api-keys"],
})

const taskExecutionRole = ServiceRoleFactory.createECSTaskExecutionRole(
  this,
  "ExecutionRole",
  {
    taskName: "frontend-server",
    environment: props.config.environment,
    region: this.region,
    account: this.account,
    ecrRepositories: ["frontend"],
    secrets: ["aistudio/frontend/api-keys"],
  }
)
```

### Step 5: Handle Custom Roles

For roles with unique requirements, use `BaseIAMRole`:

```typescript
import { BaseIAMRole } from "../lib/constructs/security"

const customRole = new BaseIAMRole(this, "CustomRole", {
  roleName: "custom-service-role",
  service: "lambda.amazonaws.com",
  description: "Custom role for specific service",
  environment: props.config.environment,
  policies: [
    new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "bedrock:InvokeModel",
            "bedrock:InvokeModelWithResponseStream",
          ],
          resources: [
            `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-*`,
          ],
        }),
      ],
    }),
  ],
})
```

### Step 6: Deploy Access Analyzer

Create a new stack file if not exists:

```typescript
// infra/bin/aistudio.ts
import { AccessAnalyzerStack } from "../lib/stacks/access-analyzer-stack"

// After other stacks
new AccessAnalyzerStack(app, "AIStudio-AccessAnalyzer-Dev", {
  config: devConfig,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
})
```

Deploy:
```bash
bunx cdk deploy AIStudio-AccessAnalyzer-Dev
```

Configure email subscription:
```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:ACCOUNT_ID:aistudio-dev-security-alerts \
  --protocol email \
  --notification-endpoint security@example.com
```

### Step 7: Test and Validate

After each migration:

1. **Deploy the stack:**
   ```bash
   bunx cdk deploy STACK_NAME
   ```

2. **Test functionality:**
   - Invoke Lambda functions
   - Check ECS task logs
   - Verify application features

3. **Monitor for errors:**
   ```bash
   # Check CloudWatch Logs for AccessDenied errors
   aws logs filter-log-events \
     --log-group-name /aws/lambda/FUNCTION_NAME \
     --filter-pattern "AccessDenied" \
     --start-time $(date -u -d '1 hour ago' +%s)000
   ```

4. **Review Access Analyzer findings:**
   ```bash
   aws accessanalyzer list-findings \
     --analyzer-arn arn:aws:access-analyzer:us-east-1:ACCOUNT_ID:analyzer/aistudio-dev-analyzer
   ```

### Step 8: Handle AccessDenied Errors

If you encounter AccessDenied errors:

1. **Identify the denied action:**
   From CloudWatch Logs, find the exact action that was denied.

2. **Add minimal permission:**
   ```typescript
   additionalPolicies: [
     new iam.PolicyDocument({
       statements: [
         new iam.PolicyStatement({
           effect: iam.Effect.ALLOW,
           actions: ["service:SpecificAction"],
           resources: ["arn:aws:service:region:account:resource/specific-id"],
         }),
       ],
     }),
   ]
   ```

3. **Redeploy and test:**
   ```bash
   bunx cdk deploy STACK_NAME
   ```

### Step 9: Production Deployment

Before deploying to production:

1. **Review all changes:**
   ```bash
   bunx cdk diff AIStudio-*-Prod
   ```

2. **Deploy permission boundary:**
   ```bash
   bunx cdk deploy AIStudio-PermissionBoundary-Prod
   ```

3. **Deploy stacks one by one:**
   ```bash
   bunx cdk deploy AIStudio-DatabaseStack-Prod
   bunx cdk deploy AIStudio-ProcessingStack-Prod
   # etc.
   ```

4. **Monitor closely:**
   - Watch CloudWatch Logs for errors
   - Check application metrics
   - Review Access Analyzer findings

5. **Deploy Access Analyzer:**
   ```bash
   bunx cdk deploy AIStudio-AccessAnalyzer-Prod
   ```

   **Note:** Auto-remediation is disabled in production for safety.

## Common Migration Patterns

### Pattern 1: S3 Full Access → Specific Buckets

```typescript
// Before
actions: ["s3:*"]
resources: ["*"]

// After
s3Buckets: ["bucket-name-1", "bucket-name-2"]
```

### Pattern 2: DynamoDB Full Access → Specific Tables

```typescript
// Before
actions: ["dynamodb:*"]
resources: ["*"]

// After
dynamodbTables: ["table-name-1", "table-name-2"]
```

### Pattern 3: Secrets Manager Access

```typescript
// Before
actions: ["secretsmanager:*"]
resources: ["*"]

// After
secrets: ["app/database/password", "app/api/key"]
```

### Pattern 4: Service-Specific Actions (No Resource-Level Permissions)

Some AWS services don't support resource-level permissions:

```typescript
// Textract, Comprehend, Bedrock, etc.
additionalPolicies: [
  new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "textract:DetectDocumentText",
          "bedrock:InvokeModel",
        ],
        resources: ["*"], // Required for these services
      }),
    ],
  }),
]
```

## Rollback Procedure

If issues occur during migration:

1. **Revert CDK code:**
   ```bash
   git revert HEAD
   ```

2. **Redeploy previous version:**
   ```bash
   bunx cdk deploy STACK_NAME
   ```

3. **Remove permission boundary (if needed):**
   ```bash
   aws iam delete-policy \
     --policy-arn arn:aws:iam::ACCOUNT_ID:policy/AIStudio-PermissionBoundary-env
   ```

4. **Document issue:**
   Create GitHub issue with:
   - Stack being migrated
   - Error encountered
   - CloudWatch Logs
   - Steps to reproduce

## Post-Migration Checklist

- [ ] All stacks deployed successfully
- [ ] No AccessDenied errors in logs (past 24 hours)
- [ ] Access Analyzer shows 0 or expected findings
- [ ] Application functionality verified
- [ ] Permission boundaries active on all new roles
- [ ] CloudWatch dashboard shows compliance metrics
- [ ] SNS alerts configured and tested
- [ ] Documentation updated

## Maintenance

### Monthly Tasks

- Review Access Analyzer findings
- Audit new roles for compliance
- Review and update permission boundaries
- Check for unused permissions (via CloudTrail)

### Quarterly Tasks

- Run full IAM audit script
- Review and update security documentation
- Security team review of critical roles
- Test disaster recovery with restricted permissions

## Troubleshooting

### Issue: CDK Deploy Fails with Policy Validation Error

**Solution:** Review the validation error, fix the policy to use specific resources:

```bash
# Error shows which statement and what needs fixing
Error: Policy validation failed: Statement 0 contains wildcard resource "*"

# Fix by specifying exact ARN
resources: [`arn:aws:s3:::my-bucket/*`]
```

### Issue: Lambda Function AccessDenied

**Solution:** Check CloudWatch Logs for the denied action, add it:

```bash
# Find the denied action
aws logs tail /aws/lambda/function-name --follow --filter-pattern "AccessDenied"

# Add the specific permission to additionalPolicies
```

### Issue: Permission Boundary Prevents Required Action

**Solution:** Update the permission boundary policy:

1. Edit `infra/lib/constructs/security/permission-boundaries/{env}-boundary.json`
2. Add the required action to the AllowedServices statement
3. Redeploy: `bunx cdk deploy AIStudio-PermissionBoundary-{env}`

### Issue: Access Analyzer Shows External Access Finding

**Solution:**

1. Review the finding in AWS Console
2. Determine if it's expected (e.g., CloudFront access to S3)
3. If expected, add archive rule:
   ```typescript
   archiveRules: [
     {
       ruleName: "ArchiveExpectedAccess",
       filter: [
         {
           property: "resourceType",
           eq: ["AWS::S3::Bucket"],
         },
         {
           property: "principal.Service",
           eq: ["cloudfront.amazonaws.com"],
         },
       ],
     },
   ]
   ```

## Support

For migration assistance:

- GitHub Issues: Label with `security` and `migration`
- Security Team: @security-team
- Platform Team: @platform-team

## Additional Resources

- [Main Security Documentation](./IAM_LEAST_PRIVILEGE.md)
- [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [CDK IAM Documentation](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_iam-readme.html)
