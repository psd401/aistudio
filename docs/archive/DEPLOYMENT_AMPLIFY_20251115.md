# Deployment Guide

This guide explains how to deploy the AI Studio infrastructure using AWS CDK with ECS Fargate hosting.

## Table of Contents
- [Prerequisites](#prerequisites)
- [Google OAuth Setup](#google-oauth-setup-for-cognito)
- [Cost Allocation Tags](#cost-allocation-tags-for-billing)
- [Initial Setup](#initial-setup)
- [Environment Variables](#environment-variables)
- [Stack Deployment](#stack-deployment)
- [DNS and Certificate Configuration](#dns-and-certificate-configuration)
- [Database Initialization](#database-initialization)
- [Post-Deployment Verification](#post-deployment-verification)
- [First Administrator Setup](#first-administrator-setup)
- [Troubleshooting](#troubleshooting)
- [Clean Up](#clean-up)

---

## Prerequisites

Before deploying, ensure you have:

- **AWS CLI** installed and configured for your target account/role
- **AWS CDK** installed globally: `npm install -g aws-cdk`
- **Node.js 20.x** and npm installed
- **Docker** installed (for building container images)
- **Domain name** with Route 53 hosted zone configured
- **Required AWS Secrets** created in AWS Secrets Manager:
  - `aistudio-dev-google-oauth` (JSON: `{ "clientSecret": "..." }`)
  - `aistudio-prod-google-oauth` (JSON: `{ "clientSecret": "..." }`)
- **Google OAuth client IDs** ready (for dev and prod)
- **AWS account permissions** for CDK deployment

---

## Google OAuth Setup for Cognito

To enable Google login in Cognito:

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a new project (or select existing)
3. Navigate to **APIs & Services > Credentials**
4. Click **Create Credentials > OAuth client ID**
5. Choose **Web application**
6. Configure:
   - **Authorized JavaScript origins:**
     - `http://localhost:3000` (for local development)
     - `https://dev.aistudio.psd401.ai` (or your dev domain)
     - `https://aistudio.psd401.ai` (or your prod domain)
   - **Authorized redirect URIs:**
     - `https://<cognito-domain>/oauth2/idpresponse`
     - Replace `<cognito-domain>` with your Cognito domain (e.g., `aistudio-dev.auth.us-east-1.amazoncognito.com`)
     - You'll find this in Cognito User Pool settings after deployment
7. Save and copy the **Client ID** and **Client Secret**
8. In AWS Secrets Manager, create environment-specific secrets:
   ```bash
   # Dev secret
   aws secretsmanager create-secret \
     --name aistudio-dev-google-oauth \
     --secret-string '{"clientSecret":"YOUR_DEV_CLIENT_SECRET"}'

   # Prod secret
   aws secretsmanager create-secret \
     --name aistudio-prod-google-oauth \
     --secret-string '{"clientSecret":"YOUR_PROD_CLIENT_SECRET"}'
   ```
9. **Note:** Client ID is provided as a CDK parameter during deployment, NOT stored in Secrets Manager

---

## Cost Allocation Tags for Billing

To track costs by project, environment, or owner in AWS Cost Explorer:

1. Go to [AWS Billing Console](https://console.aws.amazon.com/billing/)
2. In the left menu, click **Cost allocation tags**
3. Find your tags (`Project`, `Owner`, `Environment`) in the list
4. Select checkboxes for tags you want to activate
5. Click **Activate**
6. **Note:** Tags may take up to 24 hours to appear in Cost Explorer

> **Important:** CDK applies tags automatically, but you must activate them in the Billing Console for cost reporting.

---

## Initial Setup

### 1. Clone and Install Dependencies

```bash
# Clone repository (if not already done)
cd aistudio

# Install application dependencies
npm install

# Build Lambda functions for processing stacks
npm run build:lambdas

# Navigate to infrastructure directory
cd infra
npm install
```

### 2. Bootstrap CDK Environment

**First-time setup only:**

```bash
cd infra
cdk bootstrap
```

This creates the CDK staging bucket and IAM roles needed for deployments.

### 3. Synthesize Stacks

Validate CDK configuration before deployment:

```bash
cdk synth --context baseDomain=aistudio.psd401.ai
```

Review synthesized CloudFormation templates in `cdk.out/`.

---

## Environment Variables

### ECS Task Environment Variables

The ECS tasks automatically receive environment variables from:

1. **Stack Outputs** (via CloudFormation exports):
   - Cognito User Pool ID and Client ID
   - RDS cluster ARN and secret ARN
   - S3 bucket names
   - SQS queue URLs
   - DynamoDB table names

2. **AWS Secrets Manager** (injected at runtime):
   - `AUTH_SECRET` - NextAuth session encryption key
   - `INTERNAL_API_SECRET` - Internal API authentication

3. **Hardcoded Configuration** (in `ecs-service.ts`):
   - AWS region
   - Database name
   - Queue URLs from stack exports
   - Public Cognito configuration

### Required Secrets in AWS Secrets Manager

Before deployment, create these secrets:

```bash
# Dev environment - NextAuth secret
aws secretsmanager create-secret \
  --name aistudio-dev-auth-secret \
  --secret-string "$(openssl rand -base64 32)" \
  --description "NextAuth secret for dev environment"

# Prod environment - NextAuth secret
aws secretsmanager create-secret \
  --name aistudio-prod-auth-secret \
  --secret-string "$(openssl rand -base64 32)" \
  --description "NextAuth secret for prod environment"
```

**Note:** The `INTERNAL_API_SECRET` is automatically generated by the FrontendStack during deployment.

---

## Stack Deployment

### Deployment Order

Stacks have dependencies and should be deployed in this order:

1. **DatabaseStack** - Creates Aurora Serverless v2 cluster and VPC
2. **AuthStack** - Creates Cognito User Pool and identity provider
3. **StorageStack** - Creates S3 buckets for documents
4. **ProcessingStack** - Creates SQS queues and Lambda functions
5. **DocumentProcessingStack** - Creates document processing pipeline
6. **FrontendStack-ECS** - Creates ECS Fargate service with ALB
7. **SchedulerStack** - Creates scheduled task execution (depends on Frontend)
8. **MonitoringStack** - Creates CloudWatch dashboards and alarms

### Deploy All Development Stacks

```bash
cd infra

cdk deploy \
  AIStudio-DatabaseStack-Dev \
  AIStudio-AuthStack-Dev \
  AIStudio-StorageStack-Dev \
  AIStudio-ProcessingStack-Dev \
  AIStudio-DocumentProcessingStack-Dev \
  AIStudio-FrontendStack-ECS-Dev \
  AIStudio-SchedulerStack-Dev \
  AIStudio-MonitoringStack-Dev \
  --parameters AIStudio-AuthStack-Dev:GoogleClientId=YOUR_DEV_CLIENT_ID \
  --context baseDomain=aistudio.psd401.ai
```

### Deploy All Production Stacks

```bash
cd infra

cdk deploy \
  AIStudio-DatabaseStack-Prod \
  AIStudio-AuthStack-Prod \
  AIStudio-StorageStack-Prod \
  AIStudio-ProcessingStack-Prod \
  AIStudio-DocumentProcessingStack-Prod \
  AIStudio-FrontendStack-ECS-Prod \
  AIStudio-SchedulerStack-Prod \
  AIStudio-MonitoringStack-Prod \
  --parameters AIStudio-AuthStack-Prod:GoogleClientId=YOUR_PROD_CLIENT_ID \
  --context baseDomain=aistudio.psd401.ai
```

### Deploy All Stacks at Once

```bash
cd infra

cdk deploy --all \
  --parameters AIStudio-AuthStack-Dev:GoogleClientId=YOUR_DEV_CLIENT_ID \
  --parameters AIStudio-AuthStack-Prod:GoogleClientId=YOUR_PROD_CLIENT_ID \
  --context baseDomain=aistudio.psd401.ai
```

### Deploy Individual Stack

For incremental updates after initial deployment:

```bash
# Deploy only the Frontend stack after UI changes
cdk deploy AIStudio-FrontendStack-ECS-Dev --context baseDomain=aistudio.psd401.ai

# Deploy only the Database stack for schema changes
cdk deploy AIStudio-DatabaseStack-Dev
```

**Deployment time:** ~3-5 minutes per stack (vs 15-20 minutes for all stacks)

---

## DNS and Certificate Configuration

### Domain Structure

- **Dev environment:** `dev.aistudio.psd401.ai`
- **Prod environment:** `aistudio.psd401.ai` (apex/root domain)

### Automatic Configuration

The `FrontendStack-ECS` automatically:
1. Looks up your Route 53 hosted zone (e.g., `psd401.ai`)
2. Creates an SSL certificate via AWS Certificate Manager
3. Validates the certificate using DNS (automatic)
4. Creates an A record pointing to the Application Load Balancer
5. Configures ALB with HTTPS listener (port 443)
6. Redirects HTTP (port 80) to HTTPS

### Manual DNS Setup (if needed)

If deploying to a subdomain not managed by Route 53:

1. Find your ALB DNS name:
   ```bash
   aws cloudformation describe-stacks \
     --stack-name AIStudio-FrontendStack-ECS-Dev \
     --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerDnsName`].OutputValue' \
     --output text
   ```

2. Create a CNAME record at your DNS provider:
   ```
   Type: CNAME
   Name: dev.aistudio (or your subdomain)
   Value: [ALB DNS name from step 1]
   TTL: 300
   ```

### SSL Certificate Validation

Certificate validation happens automatically via DNS. Monitor progress:

```bash
# Check certificate status
aws acm list-certificates --region us-east-1 \
  --query 'CertificateSummaryList[?DomainName==`dev.aistudio.psd401.ai`]'
```

---

## Database Initialization

### ⚠️ CRITICAL: Database Safety

The database initialization Lambda runs automatically on first deployment. It:
- Checks if database is empty
- Runs initial schema files (001-005) for new databases
- Runs migration files (010+) for existing databases
- Records migrations in `migration_log` table

### Before Deployment Safety Checks

**ALWAYS verify before deploying:**

1. **Check database initialization mode:**
   ```bash
   # Review the db-init-handler to ensure two-mode system is active
   cat infra/database/lambda/db-init-handler.ts | grep -A5 "checkIfDatabaseEmpty"
   ```

2. **Verify Aurora HTTP endpoint is enabled:**
   ```bash
   # Check if HTTP endpoint is enabled
   aws rds describe-db-clusters \
     --db-cluster-identifier [your-cluster-id] \
     --query 'DBClusters[0].EnableHttpEndpoint'
   ```

   If `false`, enable via AWS Console:
   - Navigate to RDS > Databases > [your cluster]
   - Click **Modify**
   - Under **Additional configuration**, enable **Data API**
   - Click **Continue** and **Modify cluster**

3. **Verify SQL files match database structure:**
   - Use MCP tools to inspect current database schema
   - Compare with files in `/infra/database/schema/`
   - Files 001-005 should ONLY run on empty databases
   - Migration files (010+) must be additive only (no destructive operations)

### Migration Process

**For new installations:**
- Initial setup files (001-005) create tables
- Migration files (010+) are skipped

**For existing databases:**
- Initial setup files (001-005) are skipped
- Only new migration files run
- Migrations are tracked in `migration_log` table

### Database Recovery

If database corruption occurs:

1. **Stop all deployments immediately**
2. **Restore from snapshot:**
   ```bash
   aws rds restore-db-cluster-from-snapshot \
     --db-cluster-identifier aistudio-dev-restored \
     --snapshot-identifier [snapshot-id]
   ```
3. **Manually enable HTTP endpoint** on restored cluster (AWS Console)
4. **Verify ALL SQL files** match restored database structure
5. **Only then attempt redeployment**

---

## Post-Deployment Verification

### 1. Verify Stack Outputs

```bash
# Database Stack
aws cloudformation describe-stacks \
  --stack-name AIStudio-DatabaseStack-Dev \
  --query 'Stacks[0].Outputs'

# Auth Stack
aws cloudformation describe-stacks \
  --stack-name AIStudio-AuthStack-Dev \
  --query 'Stacks[0].Outputs'

# Frontend Stack
aws cloudformation describe-stacks \
  --stack-name AIStudio-FrontendStack-ECS-Dev \
  --query 'Stacks[0].Outputs'
```

### 2. Check ECS Service Health

```bash
# List ECS services
aws ecs list-services --cluster aistudio-dev

# Describe service
aws ecs describe-services \
  --cluster aistudio-dev \
  --services aistudio-dev

# Check running tasks
aws ecs list-tasks --cluster aistudio-dev --service-name aistudio-dev
```

### 3. View Container Logs

```bash
# Tail ECS logs
aws logs tail /ecs/aistudio-dev --follow

# Filter for errors
aws logs tail /ecs/aistudio-dev --follow --filter-pattern "ERROR"
```

### 4. Test Application Endpoints

```bash
# Health check
curl https://dev.aistudio.psd401.ai/api/healthz

# Should return: {"status":"healthy"}
```

### 5. Verify File Processing

1. Upload a test document through Admin Repository interface
2. Check CloudWatch logs for FileProcessor Lambda
3. Verify chunks created in database:
   ```sql
   SELECT COUNT(*) FROM document_chunks WHERE document_id = [test-doc-id];
   ```

### 6. Monitor Processing Queues

```bash
# Check SQS queue depth
aws sqs get-queue-attributes \
  --queue-url [queue-url] \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

---

## First Administrator Setup

After deploying, the first user needs administrator privileges:

### 1. Sign Up Through Web Interface

Visit your deployment URL and sign up with Google OAuth.

### 2. Connect to Database

Use AWS RDS Query Editor or PostgreSQL client:

```bash
# Option 1: AWS Console RDS Query Editor
# Navigate to: RDS > Query Editor
# Connect using cluster ARN and secret ARN

# Option 2: psql via bastion host
psql -h [cluster-endpoint] -U postgres -d aistudio
```

### 3. Find Your User ID

```sql
SELECT id, email, cognito_sub
FROM users
WHERE email = 'your-email@example.com';
```

### 4. Create Administrator Role (if needed)

```sql
-- Check if admin role exists
SELECT id FROM roles WHERE name = 'administrator';

-- Create if missing
INSERT INTO roles (name, description)
VALUES ('administrator', 'Administrator role with full access');
```

### 5. Assign Admin Role

```sql
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = 'your-email@example.com'
  AND r.name = 'administrator';
```

### 6. Verify Assignment

```sql
SELECT u.email, r.name
FROM users u
JOIN user_roles ur ON u.id = ur.user_id
JOIN roles r ON ur.role_id = r.id
WHERE u.email = 'your-email@example.com';
```

---

## Troubleshooting

### Common Issues

#### 1. ECS Tasks Not Starting

**Symptoms:** Service shows desired count but no running tasks

**Solutions:**
```bash
# Check task failures
aws ecs describe-tasks \
  --cluster aistudio-dev \
  --tasks [task-arn]

# Common causes:
# - Image pull errors (check ECR permissions)
# - Secrets Manager access denied (check task execution role)
# - Health check failures (check /api/healthz endpoint)
```

#### 2. Database Connection Errors

**Symptoms:** Application logs show "Could not connect to database"

**Solutions:**
- Verify RDS HTTP endpoint is enabled
- Check RDS security group allows traffic from ECS security group
- Verify `RDS_RESOURCE_ARN` and `RDS_SECRET_ARN` environment variables
- Confirm database secret exists in Secrets Manager

#### 3. Authentication Errors

**Symptoms:** "Could not load credentials" or "Invalid JWT token"

**Solutions:**
- Verify `AUTH_SECRET` exists in Secrets Manager
- Check `AUTH_URL` matches deployment domain (e.g., `https://dev.aistudio.psd401.ai`)
- Confirm Cognito callback URLs include deployment domain
- Verify Google OAuth redirect URIs match Cognito domain

#### 4. SSL Certificate Not Validating

**Symptoms:** Certificate stuck in "Pending validation"

**Solutions:**
```bash
# Check DNS records
dig dev.aistudio.psd401.ai

# Verify Route 53 hosted zone
aws route53 list-hosted-zones

# Check certificate validation records
aws acm describe-certificate --certificate-arn [cert-arn]
```

#### 5. Docker Build Failures

**Symptoms:** "Error building Docker image" during deployment

**Solutions:**
- Ensure Docker daemon is running
- Check disk space: `df -h`
- Verify Dockerfile.graviton exists in project root
- Clear Docker cache: `docker system prune -a`

#### 6. Stack Deployment Errors

**Symptoms:** CDK deploy fails with parameter errors

**Solutions:**
- Verify all required parameters are provided
- Check `baseDomain` context variable is set
- Ensure Google Client ID parameter is provided for AuthStack
- Confirm all required secrets exist in Secrets Manager

### Getting Help

For detailed logs and metrics:

1. **CloudWatch Logs:**
   - ECS tasks: `/ecs/aistudio-[env]`
   - Lambda functions: `/aws/lambda/[function-name]`

2. **CloudWatch Dashboards:**
   - Navigate to: CloudWatch > Dashboards > AIStudio-Consolidated-[Environment]

3. **X-Ray Traces:**
   - Navigate to: X-Ray > Traces
   - Filter by service name: `aistudio-[env]`

---

## Clean Up

### Remove All Resources

**Development environment:**
```bash
cd infra

# Destroy all dev stacks
cdk destroy --all \
  --context baseDomain=aistudio.psd401.ai
```

**Specific stack:**
```bash
# Destroy only frontend stack
cdk destroy AIStudio-FrontendStack-ECS-Dev --context baseDomain=aistudio.psd401.ai
```

### Manual Cleanup (if needed)

Some resources may require manual deletion:

1. **ECR Images:**
   ```bash
   # List images
   aws ecr list-images --repository-name aistudio-dev

   # Delete repository (including all images)
   aws ecr delete-repository --repository-name aistudio-dev --force
   ```

2. **RDS Snapshots:**
   ```bash
   # List snapshots
   aws rds describe-db-cluster-snapshots \
     --query 'DBClusterSnapshots[?contains(DBClusterIdentifier, `aistudio-dev`)]'

   # Delete snapshot
   aws rds delete-db-cluster-snapshot --db-cluster-snapshot-identifier [snapshot-id]
   ```

3. **CloudWatch Logs:**
   ```bash
   # Delete log group
   aws logs delete-log-group --log-group-name /ecs/aistudio-dev
   ```

### Cost Considerations

After destroying stacks, verify no resources remain:

```bash
# Check for running ECS tasks
aws ecs list-tasks --cluster aistudio-dev

# Check for active RDS clusters
aws rds describe-db-clusters --query 'DBClusters[?contains(DBClusterIdentifier, `aistudio`)]'

# Check for undeleted S3 buckets
aws s3 ls | grep aistudio
```

---

## Additional Resources

- **Architecture Documentation:** [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Operations Guide:** [OPERATIONS.md](./operations/OPERATIONS.md)
- **CDK Best Practices:** [AWS CDK Guide](https://docs.aws.amazon.com/cdk/latest/guide/)
- **ECS Deployment Guide:** [AWS ECS Documentation](https://docs.aws.amazon.com/ecs/)
- **Next.js Deployment:** [Next.js Deployment Docs](https://nextjs.org/docs/deployment)

---

**Last Updated:** January 2025
**Architecture Version:** ECS Fargate with HTTP/2 Streaming
