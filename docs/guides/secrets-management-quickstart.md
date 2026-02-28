# Secrets Management Quick Start Guide

Complete guide for using the centralized secrets management infrastructure with AWS Secrets Manager.

## Table of Contents

1. [Deployment](#deployment)
2. [Creating Secrets](#creating-secrets)
3. [Using Secrets in Lambda Functions](#using-secrets-in-lambda-functions)
4. [Testing Rotation](#testing-rotation)
5. [Monitoring & Compliance](#monitoring--compliance)
6. [Migration from Existing Secrets](#migration-from-existing-secrets)
7. [Troubleshooting](#troubleshooting)

---

## Deployment

### 1. Deploy the Secrets Manager Stack

From the `infra` directory:

```bash
cd infra

# Deploy to dev environment
bunx cdk deploy AIStudio-SecretsManagerStack-Dev

# Deploy to prod environment (requires SECURITY_ALERT_EMAIL)
SECURITY_ALERT_EMAIL="security@psd401.ai" bunx cdk deploy AIStudio-SecretsManagerStack-Prod
```

### 2. Verify Deployment

```bash
# Check stack outputs
aws cloudformation describe-stacks \
  --stack-name AIStudio-SecretsManagerStack-Dev \
  --query 'Stacks[0].Outputs'

# List created secrets
aws secretsmanager list-secrets \
  --filters Key=name,Values=aistudio/
```

---

## Creating Secrets

### Option 1: Using the ManagedSecret Construct (Recommended)

Add to your CDK stack:

```typescript
import { SecretsManagerStack } from './lib/secrets-manager-stack'

// In your stack definition
const secretsStack = new SecretsManagerStack(app, 'SecretsManagerStack', {
  deploymentEnvironment: 'dev',
  config: environmentConfig
})

// Create a new API key secret
const stripeKey = secretsStack.createSecret(
  'StripeApiKey',
  'api-keys/stripe',
  SecretType.API_KEY,
  {
    description: 'Stripe API key for payment processing',
    rotationEnabled: false, // Manual rotation for external APIs
    tags: {
      Service: 'Stripe',
      Purpose: 'Payments'
    }
  }
)
```

### Option 2: Using AWS CLI

```bash
# Create a simple API key secret
aws secretsmanager create-secret \
  --name aistudio/dev/api-keys/openai \
  --description "OpenAI API key for GPT models" \
  --secret-string "sk-your-api-key-here" \
  --tags Key=Environment,Value=dev Key=Service,Value=OpenAI

# Create a database secret (JSON format)
aws secretsmanager create-secret \
  --name aistudio/dev/database/app-user \
  --description "Application database credentials" \
  --secret-string '{
    "username": "app_user",
    "password": "initial-password-change-me",
    "host": "your-db.cluster-abc.us-east-1.rds.amazonaws.com",
    "port": 5432,
    "database": "aistudio"
  }' \
  --tags Key=Environment,Value=dev Key=SecretType,Value=database
```

### Option 3: Using AWS Console

1. Go to AWS Secrets Manager console
2. Click "Store a new secret"
3. Choose secret type:
   - **Other type of secret** for API keys
   - **Credentials for RDS database** for database passwords
4. Enter secret value
5. Name: `aistudio/{env}/{type}/{name}` (e.g., `aistudio/dev/api-keys/sendgrid`)
6. Add tags: `Environment`, `Service`, `SecretType`
7. Configure rotation (optional)

---

## Using Secrets in Lambda Functions

### Step 1: Add the Secret Cache Layer to Your Lambda

In your CDK construct:

```typescript
import { SecretsManagerStack } from './lib/secrets-manager-stack'

// Get the secrets stack
const secretsStack = app.node.findChild('SecretsManagerStack') as SecretsManagerStack

// Add cache layer to your Lambda
const myFunction = new lambda.Function(this, 'MyFunction', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('path/to/code'),
  layers: [secretsStack.secretCacheLayer.layer], // Add this line
  environment: {
    // Optional: Override cache TTL
    CACHE_TTL: '3600000' // 1 hour in milliseconds
  }
})

// Grant read permission to the secret
mySecret.grantRead(myFunction)
```

### Step 2: Use Secrets in Your Lambda Code

**For TypeScript/Node.js Lambda**:

```typescript
// Import the cache layer functions
import { getSecret, getDatabaseSecret, getApiKeySecret } from '/opt/nodejs/index'

export const handler = async (event: any) => {
  // Get a database secret (type-safe)
  const dbConfig = await getDatabaseSecret('aistudio/prod/database/master')
  console.log(`Connecting to ${dbConfig.host}:${dbConfig.port}`)

  // Get an API key
  const openaiKey = await getApiKeySecret('aistudio/prod/api-keys/openai')

  // Get any secret (returns parsed JSON or string)
  const customSecret = await getSecret('aistudio/prod/custom/my-secret')

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Success' })
  }
}
```

**For Python Lambda** (without cache layer):

```python
import json
import boto3

secretsmanager = boto3.client('secretsmanager')

def handler(event, context):
    # Get secret
    response = secretsmanager.get_secret_value(
        SecretId='aistudio/prod/database/master'
    )

    secret = json.loads(response['SecretString'])

    # Use secret
    db_config = {
        'host': secret['host'],
        'user': secret['username'],
        'password': secret['password']
    }

    return {'statusCode': 200}
```

---

## Testing Rotation

### Test Database Secret Rotation

```bash
# 1. Create a test database secret
aws secretsmanager create-secret \
  --name aistudio/dev/database/test-rotation \
  --secret-string '{
    "username": "test_user",
    "password": "initial-password",
    "host": "localhost",
    "port": 5432,
    "database": "test_db"
  }'

# 2. Manually trigger rotation
aws secretsmanager rotate-secret \
  --secret-id aistudio/dev/database/test-rotation

# 3. Check rotation status
aws secretsmanager describe-secret \
  --secret-id aistudio/dev/database/test-rotation \
  --query 'RotationEnabled'

# 4. View rotation history
aws secretsmanager list-secret-version-ids \
  --secret-id aistudio/dev/database/test-rotation
```

### Test API Key Rotation

```bash
# 1. Create test API key secret
aws secretsmanager create-secret \
  --name aistudio/dev/api-keys/test-rotation \
  --secret-string "test-api-key-12345"

# 2. Enable rotation (90 days)
aws secretsmanager rotate-secret \
  --secret-id aistudio/dev/api-keys/test-rotation

# 3. Check the new value
aws secretsmanager get-secret-value \
  --secret-id aistudio/dev/api-keys/test-rotation \
  --query 'SecretString' \
  --output text
```

### Test Cache Layer

Create a test Lambda:

```typescript
// test-cache-lambda/index.ts
import { getSecret } from '/opt/nodejs/index'

export const handler = async () => {
  console.time('First call (cache miss)')
  await getSecret('aistudio/dev/api-keys/test')
  console.timeEnd('First call (cache miss)')

  console.time('Second call (cache hit)')
  await getSecret('aistudio/dev/api-keys/test')
  console.timeEnd('Second call (cache hit)')

  return { statusCode: 200 }
}
```

Expected output:
```
First call (cache miss): ~100-200ms
Second call (cache hit): <10ms
```

---

## Monitoring & Compliance

### View Compliance Dashboard

1. Go to CloudWatch Console
2. Navigate to Dashboards
3. Open: `AIStudio-Dev-SecretsCompliance`

**Metrics shown**:
- Total secrets count
- Secrets with/without rotation
- Secrets exceeding maximum age
- Recent rotation failures

### Check Compliance Violations

```bash
# View compliance metrics
aws cloudwatch get-metric-statistics \
  --namespace AIStudio/SecretsCompliance \
  --metric-name SecretsWithoutRotation \
  --start-time $(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 \
  --statistics Sum

# Check CloudWatch logs for compliance scans
aws logs tail /aws/lambda/AIStudio-dev-secret-compliance-auditor --follow
```

### Set Up SNS Alerts

Already configured! Alerts go to the email specified in `SECURITY_ALERT_EMAIL`.

To add additional subscribers:

```bash
# Get the SNS topic ARN
TOPIC_ARN=$(aws cloudformation describe-stacks \
  --stack-name AIStudio-SecretsManagerStack-Dev \
  --query 'Stacks[0].Outputs[?OutputKey==`AlertTopicArn`].OutputValue' \
  --output text)

# Subscribe additional email
aws sns subscribe \
  --topic-arn $TOPIC_ARN \
  --protocol email \
  --notification-endpoint devops@psd401.ai
```

---

## Migration from Existing Secrets

### Step 1: Run Discovery (Dry Run)

```bash
cd infra/scripts/secrets-migration

npm install

# Scan for existing secrets (doesn't make changes)
npm run migrate-secrets -- --environment dev --dry-run
```

### Step 2: Review Migration Plan

Check the generated reports in `migration-reports/`:
- `migration-{timestamp}.json` - List of secrets to migrate (redacted)
- `rollback-{timestamp}.sh` - Rollback script if needed

### Step 3: Execute Migration

```bash
# Execute migration for dev environment
npm run migrate-secrets -- --environment dev --execute

# For production (be careful!)
npm run migrate-secrets -- --environment prod --execute
```

### Step 4: Verify Migration

```bash
# List all migrated secrets
aws secretsmanager list-secrets \
  --filters Key=tag-key,Values=MigratedFrom

# Test Lambda functions still work with new secrets
aws lambda invoke \
  --function-name your-function-name \
  --payload '{"test": true}' \
  response.json
```

### Step 5: Cleanup Old Secrets

After verifying everything works:

```bash
# Remove old SSM parameters
aws ssm delete-parameter --name /old/parameter/path

# Remove environment variables from Lambda
aws lambda update-function-configuration \
  --function-name your-function \
  --environment Variables={}
```

---

## Troubleshooting

### Secret Not Found

```bash
# List all secrets
aws secretsmanager list-secrets --query 'SecretList[].Name'

# Check secret exists with exact name
aws secretsmanager describe-secret --secret-id aistudio/dev/api-keys/openai
```

### Rotation Failed

```bash
# Check rotation Lambda logs
aws logs tail /aws/lambda/AIStudio-dev-aistudio-dev-database-rotation --follow

# Get rotation error details
aws secretsmanager describe-secret \
  --secret-id your-secret-id \
  --query 'RotationRules'

# Manually test rotation Lambda
aws lambda invoke \
  --function-name AIStudio-dev-database-rotation \
  --payload '{
    "Step": "testSecret",
    "SecretId": "your-secret-arn",
    "ClientRequestToken": "test-token"
  }' \
  response.json
```

### Cache Not Working

```bash
# Check Lambda has the layer
aws lambda get-function-configuration \
  --function-name your-function \
  --query 'Layers[].Arn'

# Check Lambda has permission to read secret
aws lambda get-policy --function-name your-function

# View cache statistics in Lambda logs
aws logs filter-log-events \
  --log-group-name /aws/lambda/your-function \
  --filter-pattern "SecretCache"
```

### Permission Denied

```bash
# Check IAM role has permissions
aws iam get-role-policy \
  --role-name your-lambda-role \
  --policy-name SecretsManagerAccess

# Grant read permission to Lambda
aws secretsmanager put-resource-policy \
  --secret-id your-secret-id \
  --resource-policy '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"AWS": "arn:aws:iam::ACCOUNT:role/lambda-role"},
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "*"
    }]
  }'
```

---

## Best Practices

### Naming Convention

```
aistudio/{environment}/{type}/{name}

Examples:
- aistudio/prod/database/master-password
- aistudio/dev/api-keys/openai
- aistudio/staging/oauth/google-client
- aistudio/prod/custom/encryption-key
```

### Tagging Strategy

Always include these tags:
- `Environment`: dev, staging, prod
- `Service`: OpenAI, Stripe, Database, etc.
- `SecretType`: database, api-key, oauth, custom
- `ManagedBy`: terraform, cdk, manual
- `CostCenter`: your cost center code

### Security Guidelines

1. **Never log secret values** - Use `sanitizeForLogging()` in code
2. **Rotate regularly** - Enable automatic rotation where possible
3. **Use least privilege** - Grant only necessary permissions
4. **Monitor access** - Review CloudTrail logs regularly
5. **Test rotation** - Verify rotation works before enabling in prod

### Performance Tips

1. **Use the cache layer** - Reduces latency and costs
2. **Batch secret retrieval** - Get multiple secrets in parallel
3. **Set appropriate TTL** - Balance freshness vs performance
4. **Monitor cache hit ratio** - Aim for >90%

---

## Quick Reference

### Common Commands

```bash
# Create secret
aws secretsmanager create-secret --name NAME --secret-string VALUE

# Get secret
aws secretsmanager get-secret-value --secret-id NAME

# Update secret
aws secretsmanager update-secret --secret-id NAME --secret-string NEW_VALUE

# Rotate secret
aws secretsmanager rotate-secret --secret-id NAME

# Delete secret (with recovery window)
aws secretsmanager delete-secret --secret-id NAME --recovery-window-in-days 7

# List secrets
aws secretsmanager list-secrets
```

### Environment Variables

For Lambda cache layer:
- `CACHE_TTL` - Cache TTL in milliseconds (default: 3600000 = 1 hour)
- `AWS_REGION` - AWS region (auto-set by Lambda)

For rotation handlers:
- `SECRETS_MANAGER_ENDPOINT` - Secrets Manager endpoint (optional)

---

## Getting Help

- **Documentation**: `docs/architecture/adr/ADR-006-centralized-secrets-management.md`
- **AWS Docs**: https://docs.aws.amazon.com/secretsmanager/
- **GitHub Issues**: Report issues at psd401/aistudio.psd401.ai
- **Team**: @krishagel, @devops-team

---

**Last Updated**: October 2024
**Version**: 1.0.0
