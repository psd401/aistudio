# IAM Least Privilege Security Enhancement

## Overview

This document describes the comprehensive IAM security enhancement implementation that eliminates overly permissive policies, implements permission boundaries, and establishes continuous compliance monitoring across the AI Studio infrastructure.

## Architecture Components

### 1. BaseIAMRole Construct

The `BaseIAMRole` construct provides a secure foundation for creating IAM roles with built-in security best practices.

#### Features

- ✅ Automatic policy validation before deployment
- ✅ Permission boundary enforcement
- ✅ Mandatory security tags for compliance tracking
- ✅ Least privilege by default
- ✅ Security level inference

#### Usage Example

```typescript
import { BaseIAMRole } from "@/lib/constructs/security"

const lambdaRole = new BaseIAMRole(this, "MyLambdaRole", {
  roleName: "my-function-role",
  service: "lambda.amazonaws.com",
  description: "Execution role for my Lambda function",
  policies: [
    new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
          resources: [`arn:aws:dynamodb:${region}:${account}:table/MyTable`],
        }),
      ],
    }),
  ],
  environment: "dev",
})
```

### 2. ServiceRoleFactory

The `ServiceRoleFactory` provides pre-configured role templates for common AWS services with least privilege permissions.

#### Supported Services

- **Lambda**: Execution roles with CloudWatch Logs, X-Ray, VPC, and resource access
- **ECS**: Task roles and execution roles with ECR, Secrets Manager, and resource access

#### Usage Example

```typescript
import { ServiceRoleFactory } from "@/lib/constructs/security"

// Create Lambda role with specific permissions
const lambdaRole = ServiceRoleFactory.createLambdaRole(this, "ProcessorRole", {
  functionName: "data-processor",
  environment: "prod",
  region: this.region,
  account: this.account,
  vpcEnabled: true,
  s3Buckets: ["my-data-bucket"],
  dynamodbTables: ["my-table"],
  secrets: ["app/database/credentials"],
})

// Create ECS task role
const ecsTaskRole = ServiceRoleFactory.createECSTaskRole(this, "APITaskRole", {
  taskName: "api-server",
  environment: "prod",
  region: this.region,
  account: this.account,
  s3Buckets: ["uploads-bucket"],
  secrets: ["app/api/keys"],
  ecrRepositories: ["api-server"],
})
```

### 3. PolicyValidator

The `PolicyValidator` enforces security rules on all IAM policies before deployment.

#### Validation Rules

1. **NoWildcardResourcesRule** (HIGH severity)
   - Prevents use of `Resource: "*"` except for allowed services (X-Ray, CloudWatch)
   - Enforces specific resource ARNs

2. **MinimalActionsRule** (MEDIUM severity)
   - Prevents overly broad actions like `s3:*`, `iam:*`
   - Requires specific action permissions

3. **RequireConditionsRule** (MEDIUM severity)
   - Requires conditions for sensitive IAM operations
   - Enhances security for create/attach/put operations

4. **NoAdminAccessRule** (CRITICAL severity)
   - Prevents granting full admin access (`Action: "*", Resource: "*"`)
   - Blocks in all cases

5. **ResourceTagRequirementRule** (LOW severity)
   - Recommends tag-based conditions for fine-grained access control
   - Logs warnings for improvement opportunities

#### Validation Behavior

- **CRITICAL/HIGH violations**: Deployment blocked, error thrown
- **MEDIUM/LOW violations**: Warning logged, deployment continues

### 4. Permission Boundaries

Permission boundaries set maximum permissions that IAM roles can have, preventing privilege escalation.

#### Environment-Specific Boundaries

**Development (`dev-boundary.json`)**

The development boundary allows wildcard permissions for several AWS services to support rapid development:

```json
{
  "Action": ["s3:*", "dynamodb:*", "lambda:*", "logs:*", "cloudwatch:*", "ecs:*", "sqs:*", "sns:*"],
  "Resource": "*"
}
```

**Rationale for broad dev permissions:**
- **Rapid Development**: Developers need freedom to experiment and iterate without permission roadblocks
- **Lower Risk**: Dev environment has no production data or critical resources
- **Learning & Testing**: Developers need to test various AWS features and configurations
- **Cost Optimization**: Temporary resources are frequently created and destroyed

**Guardrails in dev boundary:**
- ✅ All IAM operations (CreateRole, AttachPolicy, etc.) are explicitly DENIED
- ✅ AWS billing and cost explorer access is DENIED
- ✅ All AWS Organizations operations are DENIED
- ✅ Most services limited to us-east-1 and us-west-2 regions

**Review Schedule:**
- **Quarterly**: Analyze CloudTrail logs to identify unused permissions and tightening opportunities
- **Annual**: Comprehensive security audit of dev boundary permissions

**Production (`prod-boundary.json`)**
- Restrictive permissions with specific actions only (no wildcards)
- Denies dangerous operations (delete cluster, terminate instances)
- Requires MFA for sensitive operations
- Strict region restrictions
- Tag-based conditions enforce governance

#### Deployment

```typescript
import { PermissionBoundaryConstruct } from "@/lib/constructs/security"

// Deploy permission boundary (should be done first)
const boundary = new PermissionBoundaryConstruct(this, "PermissionBoundary", {
  environment: "prod",
})
```

### 5. IAM Access Analyzer

Continuous compliance monitoring with automated remediation for security findings.

#### Features

- Account-level analyzer for detecting external access
- Archive rules for expected findings
- EventBridge integration for real-time alerts
- Automated remediation Lambda
- CloudWatch dashboard for compliance tracking
- SNS alerts for critical findings

#### Deployment

```typescript
import { AccessAnalyzerStack } from "@/lib/stacks/access-analyzer-stack"

new AccessAnalyzerStack(this, "AccessAnalyzer", {
  config: environmentConfig,
  env: { account, region },
})
```

#### Remediation Logic

The remediation Lambda automatically:

1. **Analyzes severity** (CRITICAL, HIGH, MEDIUM, LOW)
2. **Logs metrics** to CloudWatch
3. **Attempts remediation** (only in dev for IAM, controlled for S3)
4. **Sends alerts** via SNS
5. **Updates findings** in Access Analyzer

**Auto-remediation is enabled only in `dev` environment** to prevent accidental production changes.

#### Tag Condition Limitations

**Important**: Not all IAM actions support resource tag conditions. For example, `iam:DeleteRolePolicy` may not respect tag-based conditions in IAM policies.

The Access Analyzer stack uses this condition:
```typescript
conditions: {
  StringEquals: {
    "aws:ResourceTag/Environment": "dev"
  }
}
```

**Defense-in-depth approach:**
1. **IAM Policy Condition**: First layer of protection (may not work for all IAM actions)
2. **Lambda Code Validation**: Explicit tag checking in Python code as fallback
3. **Environment Variable**: Auto-remediation only enabled when `AUTO_REMEDIATE=true`

The remediation Lambda includes explicit tag checking to prevent accidental modification of production resources even if the IAM policy condition fails to restrict access.

**Reference**: [AWS IAM Condition Keys Documentation](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_actions-resources-contextkeys.html)

## Migration Strategy

### Phase 1: Audit (Week 1)

Run the audit script to identify all violations:

```bash
cd infra
bunx ts-node scripts/audit-iam-policies.ts
```

This generates:
- Console report with violation statistics
- JSON report at `infra/audit-report.json`
- Violations sorted by severity

### Phase 2: Deploy Permission Boundaries (Week 2)

1. Deploy permission boundary policies:
   ```bash
   cd infra
   bunx cdk deploy AIStudio-PermissionBoundary-Dev
   bunx cdk deploy AIStudio-PermissionBoundary-Prod
   ```

2. Verify boundaries are created:
   ```bash
   aws iam list-policies --scope Local | grep PermissionBoundary
   ```

### Phase 3: High-Risk Remediation (Week 3)

1. Identify CRITICAL violations from audit report
2. Replace admin access policies with specific permissions
3. Use `ServiceRoleFactory` for standard roles
4. Deploy and test in dev first

### Phase 4: Service Role Migration (Week 4)

Migrate existing roles to use `BaseIAMRole` or `ServiceRoleFactory`:

**Before:**
```typescript
const role = new iam.Role(this, "LambdaRole", {
  assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
})

role.addToPolicy(
  new iam.PolicyStatement({
    actions: ["s3:*"],
    resources: ["*"],
  })
)
```

**After:**
```typescript
const role = ServiceRoleFactory.createLambdaRole(this, "LambdaRole", {
  functionName: "my-function",
  environment: "dev",
  region: this.region,
  account: this.account,
  s3Buckets: ["specific-bucket-name"],
})
```

### Phase 5: Deploy Monitoring (Week 5)

1. Deploy Access Analyzer stack:
   ```bash
   bunx cdk deploy AIStudio-AccessAnalyzer-Dev
   ```

2. Configure SNS email subscription

3. Test remediation with intentional violation

4. Monitor CloudWatch dashboard

### Phase 6: Production Rollout (Week 6)

1. Deploy to production with auto-remediation disabled
2. Monitor for AccessDenied errors in CloudWatch Logs
3. Fine-tune policies based on actual usage
4. Document any exceptions required

## Audit Script

### Running the Audit

```bash
cd infra
bunx ts-node scripts/audit-iam-policies.ts
```

### Output

- **Console**: Summary statistics and top violations
- **JSON**: Full report at `infra/audit-report.json`

### Interpreting Results

The audit identifies:
- **wildcard-resource**: Uses `Resource: "*"`
- **overly-broad-action**: Uses service-level wildcards (`s3:*`)
- **no-conditions**: Sensitive operations without conditions

Each violation includes:
- File path and line number
- Severity level
- Code snippet
- Suggested fix

## Testing

### Unit Tests

Located in `infra/lib/constructs/security/__tests__/`

Run tests:
```bash
cd infra
npm test -- security
```

### Integration Tests

Test role creation and policy validation:

```typescript
test("BaseIAMRole enforces permission boundaries", () => {
  const stack = new cdk.Stack()
  const role = new BaseIAMRole(stack, "TestRole", {
    roleName: "test-role",
    service: "lambda.amazonaws.com",
    environment: "dev",
  })

  const template = Template.fromStack(stack)
  template.hasResourceProperties("AWS::IAM::Role", {
    PermissionsBoundary: {
      "Fn::Sub":
        "arn:aws:iam::${AWS::AccountId}:policy/AIStudio-PermissionBoundary-dev",
    },
  })
})
```

## Best Practices

### 1. Always Use ServiceRoleFactory

For standard Lambda and ECS roles, use the factory:

```typescript
// ✅ Good
const role = ServiceRoleFactory.createLambdaRole(this, "Role", {...})

// ❌ Avoid
const role = new iam.Role(this, "Role", {...})
```

### 2. Specify Exact Resources

```typescript
// ✅ Good
resources: [`arn:aws:s3:::my-bucket/*`]

// ❌ Avoid
resources: ["*"]
```

### 3. Use Minimal Actions

```typescript
// ✅ Good
actions: ["s3:GetObject", "s3:PutObject"]

// ❌ Avoid
actions: ["s3:*"]
```

### 4. Add Security Tags

Tags are automatically added by `BaseIAMRole`:
- `Environment`: dev/staging/prod
- `SecurityLevel`: low/medium/high/critical
- `ManagedBy`: BaseIAMRole
- `LastReviewed`: ISO date
- `ComplianceRequired`: true

### 5. Monitor Access Analyzer

Check the dashboard regularly:
- CloudWatch Dashboard: `IAM-Compliance-{env}`
- SNS alerts for critical findings
- Review findings in AWS Console

## Troubleshooting

### Policy Validation Errors

**Error**: `Policy validation failed: Statement 0 contains wildcard resource "*"`

**Solution**: Replace wildcard with specific ARN:
```typescript
// Before
resources: ["*"]

// After
resources: [`arn:aws:dynamodb:${region}:${account}:table/MyTable`]
```

### Permission Boundary Not Found

**Error**: `Permission boundary AIStudio-PermissionBoundary-dev not found`

**Solution**: Deploy permission boundary first:
```bash
bunx cdk deploy AIStudio-PermissionBoundary-Dev
```

### Access Denied Errors

**Symptom**: Lambda or ECS task fails with `AccessDenied`

**Solution**:
1. Check CloudWatch Logs for exact denied action
2. Add specific permission to role:
   ```typescript
   additionalPolicies: [
     new iam.PolicyDocument({
       statements: [
         new iam.PolicyStatement({
           actions: ["service:SpecificAction"],
           resources: ["specific-arn"],
         }),
       ],
     }),
   ]
   ```

### Remediation Lambda Failures

**Symptom**: CloudWatch alarm for remediation failures

**Solution**:
1. Check Lambda logs in CloudWatch
2. Verify Lambda has required permissions
3. Check if finding is from a non-dev environment (auto-remediation disabled)

## Compliance Metrics

Track security posture with CloudWatch metrics:

- `AccessAnalyzerFindings`: Total active findings
- `CriticalFindings`: Findings with critical severity
- `AutomaticRemediations`: Successful auto-remediations
- `RemediationFailures`: Failed remediation attempts

View in dashboard: `IAM-Compliance-{environment}`

## Additional Resources

- [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [IAM Permission Boundaries](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)
- [IAM Access Analyzer](https://docs.aws.amazon.com/IAM/latest/UserGuide/what-is-access-analyzer.html)
- [Least Privilege Principle](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/permissions-management.html)

## Support

For issues or questions:
- GitHub Issues: https://github.com/psd401/aistudio.psd401.ai/issues
- Security Team: @security-team
- Platform Team: @platform-team
