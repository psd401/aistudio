# Agent Platform Setup Guide

Complete deployment guide for the PSD AI Agent Platform. This enables staff to interact with a personal AI agent via Google Chat.

**Architecture:** Google Chat → GCP Pub/Sub → SQS → Router Lambda → Bedrock Guardrails → AgentCore → Google Chat API

## Prerequisites

- AWS CLI configured with admin access to the target account
- GCP Console access with Workspace admin privileges
- Docker with ARM64 build support (Docker Desktop on Apple Silicon, or `docker buildx`)
- CDK stacks for DatabaseStack, GuardrailsStack already deployed

## Deployment Sequence

### Phase 1: GCP Setup (Manual — Console)

These steps must be done in the Google Cloud Console. They create the GCP-side infrastructure that sends messages to AWS.

#### 1.1 Create GCP Project

1. Go to [GCP Console](https://console.cloud.google.com) → Create Project
2. Name: `psd-agent-platform` (or your district's naming convention)
3. Note the **Project Number** (numeric, not project ID) — needed for AWS federation

#### 1.2 Enable APIs

```bash
gcloud services enable chat.googleapis.com pubsub.googleapis.com iam.googleapis.com
```

#### 1.3 Create Service Account

```bash
gcloud iam service-accounts create psd-agent-chat \
  --display-name="PSD Agent Chat Bot" \
  --project=psd-agent-platform

# Download the key JSON
gcloud iam service-accounts keys create service-account.json \
  --iam-account=psd-agent-chat@psd-agent-platform.iam.gserviceaccount.com
```

#### 1.4 Configure Domain-Wide Delegation

1. Go to [Admin Console](https://admin.google.com) → Security → API controls → Domain-wide delegation
2. Add the service account client ID
3. Grant scopes:
   - `https://www.googleapis.com/auth/chat.bot` — send/receive Chat messages

#### 1.5 Create Pub/Sub Topic

```bash
gcloud pubsub topics create agent-chat-messages --project=psd-agent-platform
```

#### 1.6 Register Chat App

1. Go to [Google Chat API config](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat)
2. App name: "PSD Agent" (or your district name)
3. Connection settings: **Cloud Pub/Sub**
4. Topic: `projects/psd-agent-platform/topics/agent-chat-messages`
5. Visibility: **Internal — people in your domain**
6. Permissions: **Specific people and groups** or **Everyone in your org**

### Phase 2: AWS Infrastructure Deploy

#### 2.1 Store Google Credentials

The CDK creates an empty secret. Populate it with the service account JSON from step 1.3:

```bash
# After the first CDK deploy (Phase 2.2), populate the secret:
aws secretsmanager put-secret-value \
  --secret-id psd-agent-google-sa-dev \
  --secret-string file://service-account.json \
  --region us-east-1
```

#### 2.2 Deploy CDK Stacks

```bash
cd infra

# First deploy — creates all resources except AgentCore Runtime
# (no image exists yet) and without the GCP bridge (no role yet)
bunx cdk deploy AIStudio-AgentPlatformStack-Dev \
  --context baseDomain=yourdomain.com \
  --context alertEmail=your-team@yourdomain.com
```

Note the outputs:
- `ECRRepositoryUri` — needed for Docker push
- `RouterQueueArn` — needed for GCP bridge
- `RouterQueueUrl` — needed for GCP bridge

#### 2.3 Build and Push Docker Image

```bash
cd infra/agent-image

# Build ARM64 image and push to ECR
./build-and-push.sh 2026-04-16-initial

# Or with a custom environment:
ENVIRONMENT=prod ./build-and-push.sh 2026-04-16-initial
```

#### 2.4 Deploy AgentCore Runtime

Re-deploy the stack with the image tag to create the AgentCore Runtime:

```bash
cd infra
bunx cdk deploy AIStudio-AgentPlatformStack-Dev \
  --context baseDomain=yourdomain.com \
  --context alertEmail=your-team@yourdomain.com \
  --context agentImageTag=2026-04-16-initial
```

The Runtime ID is stored in SSM automatically. The Router Lambda resolves it at runtime.

### Phase 3: Cross-Cloud Bridge (GCP Pub/Sub → AWS SQS)

This connects GCP Pub/Sub to the SQS queue using Workload Identity Federation.

#### 3.1 Create AWS IAM OIDC Provider for GCP

```bash
# Replace <GCP_PROJECT_NUMBER> with your numeric project number from step 1.1
aws iam create-open-id-connect-provider \
  --url https://accounts.google.com \
  --client-id-list <GCP_PROJECT_NUMBER> \
  --thumbprint-list 08745487e891c19e3078c1f2a07e452950ef36f6
```

#### 3.2 Create Bridge IAM Role

```bash
# Replace <AWS_ACCOUNT_ID> and <GCP_PROJECT_NUMBER>
cat > trust-policy.json << 'TRUST'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/accounts.google.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "accounts.google.com:aud": "<GCP_PROJECT_NUMBER>"
        }
      }
    }
  ]
}
TRUST

aws iam create-role \
  --role-name gcp-pubsub-bridge-dev \
  --assume-role-policy-document file://trust-policy.json \
  --tags Key=Environment,Value=dev Key=ManagedBy,Value=manual

# Grant SQS send permission (get queue ARN from CDK output)
cat > sqs-policy.json << 'SQS'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sqs:SendMessage",
      "Resource": "<ROUTER_QUEUE_ARN>"
    }
  ]
}
SQS

aws iam put-role-policy \
  --role-name gcp-pubsub-bridge-dev \
  --policy-name sqs-send \
  --policy-document file://sqs-policy.json

rm trust-policy.json sqs-policy.json
```

#### 3.3 Re-deploy with Bridge Role ARN

```bash
cd infra
BRIDGE_ROLE_ARN=$(aws iam get-role --role-name gcp-pubsub-bridge-dev --query 'Role.Arn' --output text)

bunx cdk deploy AIStudio-AgentPlatformStack-Dev \
  --context baseDomain=yourdomain.com \
  --context alertEmail=your-team@yourdomain.com \
  --context agentImageTag=2026-04-16-initial \
  --context gcpBridgeRoleArn=${BRIDGE_ROLE_ARN}
```

#### 3.4 Create GCP Pub/Sub Push Subscription

```bash
# Replace <ROUTER_QUEUE_URL> with the CDK output value
# Replace <BRIDGE_ROLE_ARN> with the IAM role ARN
gcloud pubsub subscriptions create agent-chat-to-sqs \
  --topic=agent-chat-messages \
  --push-endpoint=https://sqs.us-east-1.amazonaws.com/<AWS_ACCOUNT_ID>/psd-agent-router-dev \
  --push-auth-service-account=psd-agent-chat@psd-agent-platform.iam.gserviceaccount.com \
  --project=psd-agent-platform
```

> **Note:** GCP Pub/Sub push to SQS uses HTTP with IAM authentication. The exact push endpoint format and auth mechanism depend on whether you use a direct push subscription or an intermediary (e.g., EventBridge). If direct HTTP push to SQS isn't supported, use an API Gateway → SQS proxy or a small forwarding Lambda in GCP Cloud Functions.

### Phase 4: Testing

#### 4.1 Lambda Unit Test (No GCP Required)

Test the Lambda in isolation with a synthetic event:

```bash
cd infra/agent-image
./test-lambda.sh                     # Normal message
./test-lambda.sh --guardrail-test    # Should be blocked
./test-lambda.sh --too-long          # Should be rejected (>10K chars)
```

#### 4.2 Verify Telemetry in Aurora

```bash
# Connect to the database (via bastion or local tunnel)
psql $DATABASE_URL -c "SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT 5;"
psql $DATABASE_URL -c "SELECT * FROM agent_sessions ORDER BY created_at DESC LIMIT 5;"
```

#### 4.3 End-to-End Test (Requires GCP Setup Complete)

1. Open Google Chat
2. Search for "PSD Agent" (or your bot name) in the chat app list
3. Send a DM: "Hello, what can you help me with?"
4. Verify:
   - Response appears in Chat within ~10 seconds
   - CloudWatch logs show the full pipeline execution
   - `agent_messages` table has a new row
   - `agent_sessions` table has a new/updated row

#### 4.4 Guardrail Test

1. Send a message that should be blocked by K-12 content filters
2. Verify the safety message appears instead of an agent response
3. Check `agent_messages` for `guardrail_blocked = true`

## Configuration Reference

### CDK Context Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `baseDomain` | Yes | Base domain for the deployment |
| `alertEmail` | No | Email for CloudWatch alarm notifications |
| `agentImageTag` | No | Docker image tag in ECR. Omit on first deploy. |
| `gcpBridgeRoleArn` | No | IAM role ARN for GCP Pub/Sub bridge. Omit until bridge is configured. |

### Environment Variables (Lambda)

| Variable | Source | Description |
|----------|--------|-------------|
| `ENVIRONMENT` | CDK | dev/staging/prod |
| `USERS_TABLE` | CDK | DynamoDB table name |
| `GUARDRAIL_ID` | CDK | Bedrock Guardrail ID |
| `GUARDRAIL_VERSION` | CDK | Guardrail version (DRAFT for dev) |
| `DATABASE_HOST` | CDK | Aurora cluster endpoint |
| `DATABASE_SECRET_ARN` | CDK | Secrets Manager ARN for DB credentials |
| `DATABASE_NAME` | CDK | Database name (default: aistudio) |
| `GOOGLE_CREDENTIALS_SECRET_ARN` | CDK | Secrets Manager ARN for Google SA JSON |
| `GUARDRAIL_FAIL_OPEN` | CDK | 'true' to allow messages when guardrails fail (default: 'false') |
| `ALLOWED_DOMAINS` | CDK | Comma-separated email domains (default: psd401.net) |
| `MAX_MESSAGE_LENGTH` | CDK | Max input chars (default: 10000) |

### Updating the Agent

To update the agent (new model config, system prompt changes, etc.):

```bash
cd infra/agent-image
# Edit Dockerfile, openclaw.json, psd-system-prompt.md as needed
./build-and-push.sh 2026-04-17-update-models

# Redeploy with new image tag
cd ../
bunx cdk deploy AIStudio-AgentPlatformStack-Dev \
  --context agentImageTag=2026-04-17-update-models \
  --context baseDomain=yourdomain.com
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No messages arriving | GCP bridge not configured | Check `GCPBridgeStatus` CDK output |
| Lambda timeout | AgentCore Runtime not deployed | Deploy with `--context agentImageTag=<tag>` |
| "Google credentials secret contains invalid JSON" | Secret not populated | Run `aws secretsmanager put-secret-value` from step 2.1 |
| "Database not configured, skipping telemetry" | DATABASE_HOST not set | Check Lambda env vars in CloudWatch |
| Guardrail blocks everything | GUARDRAIL_FAIL_OPEN=false + guardrail misconfigured | Check guardrail rules in Bedrock console |
| DLQ alarm firing | Messages failing after 3 retries | Check CloudWatch logs for Router Lambda errors |
