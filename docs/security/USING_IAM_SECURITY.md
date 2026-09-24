# Using the IAM Security Framework

## ✅ What's Deployed

The IAM security infrastructure is now active in the **dev environment**:

- **Permission Boundary**: `AIStudio-PermissionBoundary-dev` - Sets maximum permissions for all IAM roles
- **Access Analyzer**: `aistudio-dev-analyzer` - Continuously scans for security violations
- **Remediation Lambda**: Automatically fixes critical violations in dev
- **CloudWatch Dashboard**: `IAM-Compliance-dev` - Monitor security posture

## 🎯 How to Use It

### For New Lambda Functions

**Instead of this** (old pattern):
```typescript
const myFunction = new lambda.Function(this, 'MyFunction', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambdas/my-function'),
});

// Manual permission grants
myFunction.addToRolePolicy(new iam.PolicyStatement({
  actions: ['s3:*'],
  resources: ['*'],  // ❌ VIOLATION
}));
```

**Use this** (new secure pattern):
```typescript
import { ServiceRoleFactory } from '../lib/constructs/security';

// ServiceRoleFactory creates the role with proper permissions
const functionRole = ServiceRoleFactory.createLambdaRole(this, 'MyFunctionRole', {
  functionName: 'my-function',
  environment: props.environment,
  region: this.region,
  account: this.account,
  vpcEnabled: true,  // If function needs VPC access
  s3Buckets: ['my-specific-bucket'],  // Specific bucket names
  dynamodbTables: ['my-table'],  // Specific table names
  secrets: ['app/my-function/config'],  // Specific secret paths
  // additionalPolicies: [...] // If you need custom permissions
});

const myFunction = new lambda.Function(this, 'MyFunction', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambdas/my-function'),
  role: functionRole.role,  // Use the secure role
});
```

### For New ECS Tasks

```typescript
import { ServiceRoleFactory } from '../lib/constructs/security';

const taskRole = ServiceRoleFactory.createECSTaskRole(this, 'APITaskRole', {
  taskName: 'api-server',
  environment: props.environment,
  region: this.region,
  account: this.account,
  s3Buckets: ['uploads-bucket'],
  secrets: ['app/api/keys'],
  ecrRepositories: ['api-server'],
});

// Use taskRole.role for your ECS task definition
```

### For Custom IAM Roles

```typescript
import { BaseIAMRole } from '../lib/constructs/security';

const customRole = new BaseIAMRole(this, 'CustomRole', {
  roleName: 'my-custom-role',
  service: 'lambda.amazonaws.com',
  description: 'Custom role with specific permissions',
  policies: [
    new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
          resources: [`arn:aws:dynamodb:${region}:${account}:table/MyTable`],
        }),
      ],
    }),
  ],
  environment: props.environment,
  securityLevel: 'high',  // critical, high, medium, low
});

// Use customRole.role
```

## 🔍 Monitoring

### CloudWatch Dashboard

View compliance metrics:
```
https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards/dashboard/IAM-Compliance-dev
```

Metrics tracked:
- `AccessAnalyzerFindings`: Total active findings
- `CriticalFindings`: Critical severity findings
- `AutomaticRemediations`: Successful auto-fixes
- `RemediationFailures`: Failed remediation attempts

### Access Analyzer Findings

Check for violations:
```bash
aws accessanalyzer list-findings \
  --analyzer-arn "arn:aws:access-analyzer:us-east-1:<AWS_ACCOUNT_ID>:analyzer/aistudio-dev-analyzer" \
  --filter 'status={eq=["ACTIVE"]}'
```

### Alerts

If you provided `alertEmail` context during deployment, you'll receive SNS alerts for:
- Critical Access Analyzer findings
- Remediation failures (3+ errors in 15 minutes)

## 🚨 What Happens to Existing Roles?

**Good news**: You don't need to migrate everything immediately!

1. **Existing roles continue to work** - No breaking changes
2. **Access Analyzer monitors everything** - Will flag violations in existing roles
3. **Permission boundary applies to new roles** - Automatically enforced
4. **Gradual migration** - Fix violations as you touch the code

### Migration Priority

1. **High Priority** (migrate first):
   - Roles with `resources: ['*']` for sensitive services (IAM, S3, DynamoDB)
   - Roles with admin-level wildcards (`iam:*`, `s3:*`)
   - Roles in production environment

2. **Medium Priority**:
   - Roles with wildcards for observability (X-Ray, CloudWatch)
   - Roles with overly broad actions

3. **Low Priority**:
   - Roles that already follow least privilege
   - Service roles that are rarely modified

### Example: Migrating ProcessingStack

Current code (processing-stack.ts:233-242):
```typescript
// ❌ VIOLATION: Textract with wildcard resources
const textractPolicy = new iam.PolicyStatement({
  actions: [
    'textract:StartDocumentTextDetection',
    'textract:StartDocumentAnalysis',
    'textract:GetDocumentTextDetection',
    'textract:GetDocumentAnalysis',
  ],
  resources: ['*'],  // VIOLATION
});
fileProcessor.addToRolePolicy(textractPolicy);
```

**Two options to fix**:

**Option 1**: Use ServiceRoleFactory (recommended for new code):
```typescript
const fileProcessorRole = ServiceRoleFactory.createLambdaRole(this, 'FileProcessorRole', {
  functionName: 'file-processor',
  environment: props.environment,
  region: this.region,
  account: this.account,
  vpcEnabled: false,
  s3Buckets: [documentsBucket.bucketName],
  dynamodbTables: [this.jobStatusTable.tableName],
  sqsQueues: [this.embeddingQueue.queueArn],
  secrets: [databaseSecretArn],
  additionalPolicies: [
    new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ['rds-data:*'],
          resources: [databaseResourceArn],
        }),
        // Textract requires wildcard (documented exception)
        new iam.PolicyStatement({
          actions: [
            'textract:StartDocumentTextDetection',
            'textract:StartDocumentAnalysis',
            'textract:GetDocumentTextDetection',
            'textract:GetDocumentAnalysis',
          ],
          resources: ['*'],  // OK: Textract doesn't support resource-level permissions
        }),
      ],
    }),
  ],
});

const fileProcessor = new lambda.Function(this, 'FileProcessor', {
  // ... other props
  role: fileProcessorRole.role,
});
```

**Option 2**: Document the exception (for legacy code):
```typescript
// Textract permissions require wildcard resources because AWS Textract
// does not support resource-level permissions. This is a documented
// exception to the no-wildcard-resources rule.
// See: https://docs.aws.amazon.com/textract/latest/dg/security_iam_service-with-iam.html
const textractPolicy = new iam.PolicyStatement({
  actions: [
    'textract:StartDocumentTextDetection',
    'textract:StartDocumentAnalysis',
    'textract:GetDocumentTextDetection',
    'textract:GetDocumentAnalysis',
  ],
  resources: ['*'],  // Required by Textract (no resource-level permissions)
});
fileProcessor.addToRolePolicy(textractPolicy);
```

## 📋 Common Violations and Fixes

### 1. Wildcard Resources

❌ **Violation**:
```typescript
actions: ['s3:GetObject'],
resources: ['*']
```

✅ **Fix**:
```typescript
actions: ['s3:GetObject'],
resources: [`arn:aws:s3:::${bucketName}/*`]
```

### 2. Overly Broad Actions

❌ **Violation**:
```typescript
actions: ['s3:*'],
resources: [`arn:aws:s3:::${bucketName}/*`]
```

✅ **Fix**:
```typescript
actions: ['s3:GetObject', 's3:PutObject'],
resources: [`arn:aws:s3:::${bucketName}/*`]
```

### 3. Missing Conditions

❌ **Violation**:
```typescript
actions: ['iam:CreateRole'],
resources: ['*']
```

✅ **Fix**:
```typescript
actions: ['iam:CreateRole'],
resources: ['*'],
conditions: {
  StringEquals: {
    'iam:PermissionsBoundary': `arn:aws:iam::${account}:policy/AIStudio-PermissionBoundary-${environment}`
  }
}
```

## 🧪 Testing

Before deploying to production:

1. **Deploy to dev** with new secure role
2. **Check CloudWatch Logs** for AccessDenied errors
3. **View Access Analyzer findings** for new violations
4. **Adjust permissions** if needed
5. **Re-deploy and verify** functionality

## 📚 Resources

- **Architecture**: `docs/security/IAM_LEAST_PRIVILEGE.md`
- **Migration Guide**: `docs/security/MIGRATION_GUIDE.md`
- **API Reference**: `infra/lib/constructs/security/`
- **Examples**: `infra/lib/stacks/example-usage.ts`

## 💡 Best Practices

1. **Always use ServiceRoleFactory** for Lambda and ECS
2. **Specify exact resources** - no wildcards unless documented exception
3. **Use minimal actions** - only what's needed
4. **Add security tags** - automatically done by BaseIAMRole
5. **Monitor Access Analyzer** - check dashboard weekly
6. **Document exceptions** - explain why wildcards are needed
7. **Test in dev first** - never deploy security changes directly to prod

## 🆘 Troubleshooting

### AccessDenied Errors

1. Check CloudWatch Logs for exact denied action
2. Add specific permission using `additionalPolicies`
3. Test and verify

### Permission Boundary Violations

If deployment fails with permission boundary error:
```
Error: Role cannot have permissions beyond the boundary
```

Fix: The requested permission is not allowed by dev boundary. Check `infra/lib/constructs/security/permission-boundaries/dev-boundary.json`

### Access Analyzer Alerts

If you receive critical finding alerts:
1. Check CloudWatch Dashboard for details
2. Review the finding in AWS Console
3. Fix manually or wait for auto-remediation (dev only)
4. Update your IAM policies to prevent recurrence

---

**Last updated**: October 2025
**Maintained by**: Platform Team
