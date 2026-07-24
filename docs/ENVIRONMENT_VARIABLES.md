# Environment Variables Documentation

This document provides a comprehensive guide to all environment variables required for the AI Studio application to function properly in AWS Amplify deployment.

## Required Environment Variables

### Authentication Variables

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `AUTH_URL` | The full URL where your app is hosted | `https://dev.yourdomain.com` | ✅ |
| `AUTH_SECRET` | Secret for NextAuth.js session encryption | Generate with: `openssl rand -base64 32` | ✅ |
| `AUTH_COGNITO_CLIENT_ID` | AWS Cognito client ID | From Auth stack outputs | ✅ |
| `AUTH_COGNITO_ISSUER` | AWS Cognito issuer URL | `https://cognito-idp.us-east-1.amazonaws.com/<pool-id>` | ✅ |
| `OIDC_COOKIE_SECRET` | Dedicated oidc-provider cookie encryption/signing key; created and injected by `FrontendStackEcs` | Generate with: `openssl rand -base64 32` | ✅ in production |

### Token Configuration

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `COGNITO_ACCESS_TOKEN_LIFETIME_SECONDS` | Token lifetime for refresh calculations | `3600` (1 hour) | ❌ (defaults to 3600) |

### Public Authentication Variables

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID` | Cognito user pool ID (client-side) | From Auth stack outputs | ✅ |
| `NEXT_PUBLIC_COGNITO_CLIENT_ID` | Cognito client ID (client-side) | From Auth stack outputs | ✅ |
| `NEXT_PUBLIC_COGNITO_DOMAIN` | Cognito domain for OAuth | `aistudio-dev.auth.us-east-1.amazoncognito.com` | ✅ |
| `NEXT_PUBLIC_AWS_REGION` | AWS region for client-side operations | `us-east-1` | ✅ |

### Database Variables

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `RDS_RESOURCE_ARN` | ARN of the RDS Aurora Serverless cluster | `arn:aws:rds:us-east-1:xxx:cluster:aistudio-xxx` | ✅ |
| `RDS_SECRET_ARN` | ARN of the database credentials secret | `arn:aws:secretsmanager:us-east-1:xxx:secret:xxx` | ✅ |
| `RDS_DATABASE_NAME` | Database name | `aistudio` | ❌ (defaults to 'aistudio') |
| `SQL_LOGGING` | Enable/disable SQL query logging | `false` for production, `true` for debugging | ❌ |

### File Processing Variables

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `FILE_PROCESSING_QUEUE_URL` | SQS queue URL for file processing | From ProcessingStack outputs | ✅ |
| `URL_PROCESSOR_FUNCTION_NAME` | Lambda function name for URL processing | From ProcessingStack outputs | ✅ |
| `DOCUMENTS_BUCKET_NAME` | S3 bucket name for document storage | From StorageStack outputs | ✅ |
| `JOB_STATUS_TABLE_NAME` | DynamoDB table for job tracking | From ProcessingStack outputs | ❌ |
| `EMBEDDING_QUEUE_URL` | SQS queue URL for embedding generation | From ProcessingStack outputs | ❌ |
| `EMBEDDING_GENERATOR_FUNCTION_NAME` | Lambda function for embedding generation | From ProcessingStack outputs | ❌ |
| `MAX_FILE_SIZE_MB` | Maximum file size in MB | `100` | ❌ (defaults to 100) |

### AI Provider Settings

> **Important**: AI provider API keys are managed through the database-first settings system. These environment variables serve as fallbacks when database settings are not configured.

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `OPENAI_API_KEY` | OpenAI API key for GPT models | `sk-...` | ❌ (fallback) |
| `GOOGLE_API_KEY` | Google AI API key for Gemini models | Your Google AI key | ❌ (fallback) |
| `BEDROCK_ACCESS_KEY_ID` | AWS access key for Bedrock | AWS access key | ❌ (fallback) |
| `BEDROCK_SECRET_ACCESS_KEY` | AWS secret key for Bedrock | AWS secret key | ❌ (fallback) |
| `BEDROCK_REGION` | AWS region for Bedrock | `us-east-1` | ❌ (fallback) |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key | Your Azure key | ❌ (fallback) |
| `AZURE_OPENAI_RESOURCE_NAME` | Azure OpenAI resource name | Your resource name | ❌ (fallback) |

**Note**: In production, these settings should be managed through the admin interface at `/admin/settings`. The application checks the database first, then falls back to environment variables if not found.

### AWS SDK Variables

> **Important**: AWS Amplify restricts environment variables with the `AWS_` prefix in the console. However, Amplify automatically provides `AWS_REGION` and `AWS_DEFAULT_REGION` at runtime. You only need to set `NEXT_PUBLIC_AWS_REGION` as a fallback.

## Setting Environment Variables in AWS Amplify

### Method 1: AWS Amplify Console (Recommended)

1. Navigate to your AWS Amplify app in the AWS Console
2. Select your app and go to "Environment variables" in the left sidebar
3. Click "Manage variables"
4. Add each variable with its corresponding value
5. Save the changes
6. Redeploy your app for changes to take effect

### Method 2: AWS CLI

```bash
aws amplify update-app \
  --app-id <your-app-id> \
  --environment-variables \
    AUTH_URL=https://dev.yourdomain.com \
    AUTH_SECRET=<your-generated-secret> \
    AUTH_COGNITO_CLIENT_ID=<your-cognito-client-id> \
    AUTH_COGNITO_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/<pool-id> \
    NEXT_PUBLIC_COGNITO_USER_POOL_ID=<your-pool-id> \
    NEXT_PUBLIC_COGNITO_CLIENT_ID=<your-client-id> \
    NEXT_PUBLIC_COGNITO_DOMAIN=<your-cognito-domain> \
    NEXT_PUBLIC_AWS_REGION=us-east-1 \
    RDS_RESOURCE_ARN=<your-rds-arn> \
    RDS_SECRET_ARN=<your-secret-arn> \
    RDS_DATABASE_NAME=aistudio \
    SQL_LOGGING=false \
    FILE_PROCESSING_QUEUE_URL=<your-queue-url> \
    URL_PROCESSOR_FUNCTION_NAME=<your-function-name> \
    DOCUMENTS_BUCKET_NAME=<your-bucket-name> \
    EMBEDDING_QUEUE_URL=<your-embedding-queue-url> \
    EMBEDDING_GENERATOR_FUNCTION_NAME=<your-embedding-function-name> \
    MAX_FILE_SIZE_MB=100
```

## Important Notes

### Build Process
- The `amplify.yml` and CDK buildSpec are configured to write environment variables to a `.env` file during build
- This ensures runtime access to these variables in the Next.js application
- The pattern `'^AUTH_|^NEXT_PUBLIC_|^RDS_|^SQL_|^FILE_|^URL_|^DOCUMENTS_|^JOB_|^MAX_|^EMBEDDING_|^OPENAI_|^GOOGLE_|^BEDROCK_|^AZURE_'` captures all required variables
- AWS-prefixed variables cannot be set in the Amplify console but are provided automatically by Amplify at runtime

### AWS Credentials
- AWS Amplify WEB_COMPUTE platform requires **two IAM roles**:
  1. **Service Role**: For build/deploy operations
  2. **SSR Compute Role**: For runtime AWS access (CRITICAL for database connectivity)
- The application uses the AWS SDK credential provider chain to authenticate
- The SSR Compute role must have permissions for:
  - RDS Data API (`rds-data:*`)
  - Secrets Manager (`secretsmanager:GetSecretValue`)
- Without the SSR Compute role, you'll get "Could not load credentials from any providers" errors

### Region Configuration
- The AWS SDK needs region configuration to make API calls
- AWS Amplify automatically provides `AWS_REGION` and `AWS_DEFAULT_REGION` at runtime
- Set `NEXT_PUBLIC_AWS_REGION` in the console as a fallback
- The application checks these in order: `AWS_REGION` (Amplify) → `AWS_DEFAULT_REGION` (Amplify) → `NEXT_PUBLIC_AWS_REGION` (User)

## Troubleshooting

### Common Issues

1. **500 Error on API Routes**
   - Check CloudWatch logs for detailed error messages
   - Verify all required environment variables are set
   - Use the health check endpoint to validate configuration

2. **"Missing required environment variables" Error**
   - Check the specific variables mentioned in the error
   - Ensure variables are properly set in Amplify console
   - Redeploy after adding/updating variables

3. **AWS Credentials Error: "Could not load credentials from any providers"**
   - **Most likely cause**: Missing SSR Compute role
   - Go to Amplify Console → App settings → IAM roles
   - Ensure an SSR Compute role is attached (not just a service role)
   - The SSR Compute role needs RDS Data API and Secrets Manager permissions
   - See `/docs/FIX_SSR_COMPUTE_ROLE.md` for detailed fix instructions

### Health Check
Use the unauthenticated `/api/health` endpoint to verify readiness status for:
- Environment variable configuration
- Database connectivity
- Authentication configuration
- OAuth signing-key availability

The response intentionally exposes only pass/fail status. Resource identifiers,
account details, secret names, database configuration, and exception messages
remain in sanitized server logs and are never returned by the public endpoint.

## Security Best Practices

1. **Never commit environment variables to version control**
2. **Use AWS Secrets Manager for sensitive values**
3. **Rotate AUTH_SECRET periodically**
4. **Use least-privilege IAM policies**
5. **Enable SQL_LOGGING only for debugging, never in production**

## Getting Stack Outputs

To get the required values from your CDK deployment:

```bash
# List all stacks
aws cloudformation list-stacks

# Get specific stack outputs
aws cloudformation describe-stacks \
  --stack-name AIStudio-DatabaseStack-Dev \
  --query 'Stacks[0].Outputs'

aws cloudformation describe-stacks \
  --stack-name AIStudio-AuthStack-Dev \
  --query 'Stacks[0].Outputs'

aws cloudformation describe-stacks \
  --stack-name AIStudio-StorageStack-Dev \
  --query 'Stacks[0].Outputs'

aws cloudformation describe-stacks \
  --stack-name AIStudio-ProcessingStack-Dev \
  --query 'Stacks[0].Outputs'
```

### Key Outputs to Look For:
- **DatabaseStack**: `ClusterArn`, `DbSecretArn`
- **AuthStack**: `UserPoolId`, `UserPoolClientId`, `CognitoDomain`
- **StorageStack**: `DocumentsBucketName`
- **ProcessingStack**: `FileProcessingQueueUrl`, `URLProcessorFunctionName`, `JobStatusTableName`, `EmbeddingQueueUrl`, `EmbeddingGeneratorFunctionName`

## Additional Resources

- [AWS Amplify Environment Variables](https://docs.aws.amazon.com/amplify/latest/userguide/environment-variables.html)
- [NextAuth.js Configuration](https://next-auth.js.org/configuration/options)
- [AWS RDS Data API](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html)
