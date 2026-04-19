# Agent Platform Setup Guide

Complete deployment guide for the PSD AI Agent Platform. This enables staff to interact with a personal AI agent via Google Chat.

**Architecture:** Google Chat → GCP Pub/Sub → SQS → Router Lambda → Bedrock Guardrails → AgentCore → Google Chat API

## Prerequisites

- AWS CLI configured with admin access to the target account
- GCP Console access with Workspace admin privileges
- Docker with ARM64 build support (Docker Desktop on Apple Silicon, or `docker buildx`)
- CDK stacks for DatabaseStack, GuardrailsStack already deployed

## Deployment Sequence

### Phase 1: GCP Setup (Console)

All GCP steps are done in the web console. No `gcloud` CLI required.

#### 1.1 Create GCP Project

1. Go to [GCP Console](https://console.cloud.google.com) → **Select a project** (top bar) → **New Project**
2. Name: `psd-agent-platform` (or your district's naming convention)
3. Click **Create**
4. Once created, go to the project **Dashboard** and note the **Project Number** (numeric, not the project ID) — needed for AWS federation in Phase 3

#### 1.2 Enable APIs

1. Go to **APIs & Services** → **Library**
2. Search for and enable each of these:
   - **Google Chat API**
   - **Cloud Pub/Sub API**
   - **Identity and Access Management (IAM) API**

#### 1.3 Create Service Account

1. Go to **IAM & Admin** → **Service Accounts** → **Create Service Account**
2. Name: `psd-agent-chat`
3. Description: "PSD Agent Chat Bot — sends/receives Google Chat messages"
4. Click **Create and Continue** → skip the optional role grants → **Done**
5. Click the new service account → **Keys** tab → **Add Key** → **Create new key** → **JSON** → **Create**
6. Save the downloaded JSON file — this goes into AWS Secrets Manager in Phase 2

#### 1.4 Configure Domain-Wide Delegation

1. On the service account page, copy the **Client ID** (numeric)
2. Go to [Google Admin Console](https://admin.google.com) → **Security** → **Access and data control** → **API controls** → **Manage Domain Wide Delegation**
3. Click **Add new**
4. Client ID: paste the service account client ID
5. OAuth scopes: `https://www.googleapis.com/auth/chat.bot`
6. Click **Authorize**

#### 1.5 Create Pub/Sub Topic

1. Go to **Pub/Sub** → **Topics** → **Create Topic**
2. Topic ID: `agent-chat-messages`
3. Leave defaults, click **Create**

#### 1.6 Register Chat App

1. Go to **APIs & Services** → **Enabled APIs** → click **Google Chat API** → **Configuration** tab
2. Fill in:
   - App name: `PSD Agent` (or your district name)
   - Avatar URL: (optional, leave blank for now)
   - Description: "Personal AI agent for district staff"
   - Enable **Interactive features**
   - Connection settings: **Cloud Pub/Sub**
   - Pub/Sub topic: `projects/<your-project-id>/topics/agent-chat-messages`
   - Visibility: **Make this Chat app available to everyone in [your domain]** (the Router Lambda's `ALLOWED_DOMAINS` handles access control on the AWS side)
   - Logs: **Log errors to Logging**
3. Click **Save**

### Phase 2: AWS Infrastructure Deploy

#### 2.1 Deploy CDK Stacks

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

#### 2.2 Store Google Credentials

The CDK creates an empty secret. Populate it with the service account JSON from step 1.3:

```bash
aws secretsmanager put-secret-value \
  --secret-id psd-agent-google-sa-dev \
  --secret-string file://service-account.json \
  --region us-east-1
```

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

> **CORRECTION (Apr 2026):** The earlier Workload Identity Federation
> approach in this section was a dead-end. GCP Pub/Sub push only sends a
> Google OIDC JWT — it does not perform AWS SigV4 signing, so no IAM role
> swap can authorize it to call SQS directly. The bridge is now an HTTP API
> with a JWT authorizer (issuer = `https://accounts.google.com`) and a tiny
> Lambda forwarder that writes to SQS. If you previously created
> `gcp-pubsub-bridge-dev` IAM role and the OIDC provider for
> `accounts.google.com`, you can delete them — they are unused.

#### 3.1 First Deploy (creates the HTTP API endpoint URL)

The CDK bridge needs to know the JWT audience (which GCP will sign) up front.
The simplest correct value is the API endpoint URL itself, but we don't know
that URL until the API is deployed once. Two-pass deploy:

```bash
cd infra

# Pass 1 — deploy with a placeholder audience to allocate the API URL
bunx cdk deploy AIStudio-AgentPlatformStack-Dev \
  --context baseDomain=yourdomain.com \
  --context alertEmail=your-team@yourdomain.com \
  --context agentImageTag=<current-tag> \
  --context agentImageDigest=<current-digest> \
  --context gcpPubsubAudience=https://placeholder.invalid/chat

# Read the assigned API URL from the stack output
CHAT_BRIDGE_URL=$(aws cloudformation describe-stacks \
  --stack-name AIStudio-AgentPlatformStack-Dev \
  --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='ChatBridgeEndpoint'].OutputValue" \
  --output text)
echo "Bridge URL: ${CHAT_BRIDGE_URL}"
```

#### 3.2 Second Deploy (pin audience to the real URL)

```bash
bunx cdk deploy AIStudio-AgentPlatformStack-Dev \
  --context baseDomain=yourdomain.com \
  --context alertEmail=your-team@yourdomain.com \
  --context agentImageTag=<current-tag> \
  --context agentImageDigest=<current-digest> \
  --context gcpPubsubAudience=${CHAT_BRIDGE_URL}
```

#### 3.3 Create GCP Pub/Sub Subscription

1. In GCP Console, go to **Pub/Sub** → **Subscriptions** → **Create Subscription**
2. Subscription ID: `agent-chat-to-sqs`
3. Select topic: `agent-chat-messages`
4. Delivery type: **Push**
5. Endpoint URL: the `ChatBridgeEndpoint` value from CDK output (`https://…/chat`)
6. Enable authentication: check **Enable authentication**
7. Service account: `psd-agent-chat@<project-id>.iam.gserviceaccount.com`
8. **Audience**: leave blank (defaults to the endpoint URL, which matches the
   `gcpPubsubAudience` we configured). If you set a custom audience, redeploy
   the stack with that value as `gcpPubsubAudience`.
9. Click **Create**

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
| `agentImageDigest` | No | ECR image digest (`sha256:…`). Pin alongside `agentImageTag` so AgentCore receives an immutable identity (tag-only deploys have caused stale containers). |
| `gcpPubsubAudience` | No | The HTTPS URL the GCP Pub/Sub push subscription is configured to call (defaults to the API endpoint URL itself). Required to wire up the JWT authorizer; omit on first deploy to allocate the API URL. |

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
| No messages arriving | Chat bridge not deployed or audience mismatch | Check `ChatBridgeEndpoint` CDK output; confirm Pub/Sub subscription points at this URL and `gcpPubsubAudience` matches the URL the JWT is signed for |
| 401 from chat bridge | JWT audience claim doesn't match `gcpPubsubAudience` | Check API Gateway JWT authorizer logs; redeploy stack with the audience the subscription actually sends |
| Bridge Lambda 5xx | SQS send failing | Check `/aws/lambda/psd-agent-chat-bridge-<env>` logs |
| Lambda timeout | AgentCore Runtime not deployed | Deploy with `--context agentImageTag=<tag>` |
| "Google credentials secret contains invalid JSON" | Secret not populated | Run `aws secretsmanager put-secret-value` from step 2.2 |
| "Database not configured, skipping telemetry" | DATABASE_HOST not set | Check Lambda env vars in CloudWatch |
| Guardrail blocks everything | GUARDRAIL_FAIL_OPEN=false + guardrail misconfigured | Check guardrail rules in Bedrock console |
| DLQ alarm firing | Messages failing after 3 retries | Check CloudWatch logs for Router Lambda errors |
| Pub/Sub push fails to SQS | SQS requires signed requests | Add API Gateway → SQS proxy in front of the queue |
| Migration 065 failed | PL/pgSQL not compatible with RDS Data API | Fixed — redeploy DatabaseStack to retry |
