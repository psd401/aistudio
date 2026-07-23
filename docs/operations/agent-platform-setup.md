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

### Agent image supply-chain pins (SEC-009)

Every third-party artifact baked into the agent base image is pinned and
verified before use — the container holds IAM reach to `psd-agent-creds/${env}/*`
and `psd-agent/${env}/*`, so build-time substitution is a real compromise
vector. `build-and-push.sh` fails fast if any `BLOCKER(prod)` marker remains in
the Dockerfile (the enforcement gate that keeps these from regressing).

| Artifact | Pin | Verification |
|----------|-----|--------------|
| OpenClaw base | `ghcr.io/openclaw/openclaw@sha256:3814fb…` (2026.6.11) | Immutable digest in `FROM` |
| bun | `1.2.12` | `bun-linux-aarch64.zip` SHA256 vs `BUN_SHA256` ARG |
| uv | `0.7.9` | `uv-aarch64-unknown-linux-gnu.tar.gz` SHA256 vs `UV_SHA256` ARG |
| Google Workspace CLI (`gws`) | `0.22.5` | `.tar.gz` SHA256 vs `GWS_SHA256` ARG |
| GitHub CLI (`gh`) | `2.92.0` | `.tar.gz` SHA256 vs `GH_SHA256` ARG |
| `bedrock-agentcore` (+ closure) | `1.15.1` | `pip install --require-hashes -r requirements-agentcore.txt` |

bun and uv install from their official GitHub release artifacts (no
`curl … | bash`). `bedrock-agentcore` is the official AWS SDK
(`github.com/aws/bedrock-agentcore-sdk-python`); its full transitive closure is
hash-pinned in `requirements-agentcore.txt`, so `--require-hashes` aborts the
build on any mismatch — the image build itself is the supply-chain test.

**Bumping a pinned artifact:**

```bash
# bun — refresh the bun-linux-aarch64.zip line from SHASUMS256.txt:
curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v<VER>/SHASUMS256.txt" | grep bun-linux-aarch64.zip

# uv — refresh from the .sha256 sidecar:
curl -fsSL "https://github.com/astral-sh/uv/releases/download/<VER>/uv-aarch64-unknown-linux-gnu.tar.gz.sha256"

# bedrock-agentcore (+ transitive deps) — regenerate the hashed closure:
cd infra/agent-image
# edit requirements-agentcore.in (top-level pins), then:
uv pip compile --universal --generate-hashes --python-version 3.11 \
  --no-annotate --no-header requirements-agentcore.in -o requirements-agentcore.txt
```

Paste each refreshed hash into the matching `ARG` in the Dockerfile (or commit
the regenerated `requirements-agentcore.txt`). Never hand-edit a hash.

**Bumping the OpenClaw base image (the `FROM` digest):**

This is gated on a regression check, not just a digest swap — see the Dockerfile
header for the full history. The runtime has twice been broken by a new OpenClaw
release (Morning Brief "chat deadline expired"; nested
`/home/node/.openclaw/.openclaw/` ENOENT). Resolve the digest and verify the
workspace double-nesting fix is present — no Docker required, just `curl`/`jq`/`gh`:

```bash
REPO=openclaw/openclaw; TAG=2026.6.11        # target the latest stable release
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:$REPO:pull&service=ghcr.io" | jq -r .token)

# Multi-arch index digest (this is what goes in FROM):
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  "https://ghcr.io/v2/$REPO/manifests/$TAG" | grep -i docker-content-digest

# arm64 sub-digest (record in the header for traceability):
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  "https://ghcr.io/v2/$REPO/manifests/$TAG" \
  | jq -r '.manifests[] | select(.platform.architecture=="arm64") | .digest'

# MANDATORY gate: confirm the workspace double-nesting fix (PR #93520, merge
# commit 52280351bb53) is an ancestor of the target tag. ahead_by==0 ⇒ present.
gh api "repos/$REPO/compare/v$TAG...52280351bb53" --jq '{ahead_by, fix_present: (.ahead_by==0)}'
```

Then update the `FROM` digest and the header block in `infra/agent-image/Dockerfile`,
and **always** finish with the Morning Brief smoke test (below) — a trivial
"respond OK" prompt masks session-completion regressions.

## Rich Chat output — cards, charts, button callbacks

Phase 1 of native Chat interactivity (#TBD) added two skills and one shared
contract between the agent and the Lambdas that talk to Chat. Reference
material when wiring new skills, debugging missing cards, or extending
interactivity.

### The PSD_AGENT_RICH_V1 envelope

The agent emits a sentinel-wrapped JSON block inside its final reply. The
Router and Cron Lambdas detect it and lift the payload into the
`spaces.messages.create` request alongside the plain-text fallback:

```
<<<PSD_AGENT_RICH_V1>>>
{ "cardsV2": [...], "accessoryWidgets": [...]?, "textFallback": "..."? }
<<<END_PSD_AGENT_RICH_V1>>>
```

- The envelope shape lives in three places that must stay in lockstep:
  - `infra/agent-image/chat_format.py` (`extract_rich_envelope`)
  - `infra/lambdas/agent-router/rich-envelope.ts`
  - `infra/lambdas/agent-cron/rich-envelope.ts` (byte-identical copy)
- Sentinels are deterministic strings, not regex — `JSON.parse` validates
  the payload. Malformed envelopes fall back to plain-text send and log
  `rich_envelope_malformed` at WARNING. Look for that log line first when
  cards stop appearing.
- `text` is always sent for notification previews. When the envelope
  carries `textFallback` and the agent's prose is empty, we use the
  fallback; otherwise prose wins.

### Skills that emit the envelope

- `infra/agent-image/skills/chat-card` — high-level flags (`--title`,
  `--paragraph`, `--kv`, `--button`, `--image`, `--divider`) plus a
  `--card-json` escape hatch for widget types not exposed by flags.
- `infra/agent-image/skills/chat-chart` — chart renderer. `--engine auto`
  routes sensitive data (or anything that trips the inline PII regex) to
  the local matplotlib path; everything else goes to QuickChart.io.

### Button click contract (CARD_CLICKED)

Every button emitted by `chat-card` uses:

```json
{ "onClick": { "action": { "function": "psd-agent", "parameters": [
  { "key": "intent", "value": "<freeform-intent>" },
  { "key": "<extra>", "value": "<extra-value>" }
] } } }
```

Chat delivers the click as a `CARD_CLICKED` event. The Router Lambda
normalises it into a synthesised user MESSAGE of the form
`[button] intent=<intent> key=value key=value` and routes through the
normal agent pipeline — same auth, same allowlist, same thread session
continuity. The agent decides what to do based on the intent name; we
don't dispatch on `intent` Lambda-side.

When testing: send any prompt that exercises the agent's use of
`chat-card --button …`, click the button in Chat, then check the next
event the Router logs — it should appear as `MESSAGE` with the bracketed
intent text.

### Troubleshooting cards

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Card looks like plain text in Chat | Envelope reached Lambda but malformed | Search CloudWatch for `rich_envelope_malformed`; preview field shows the first 200 chars |
| Chart is the wrong type | Agent passed wrong `--type` | Re-read chat-chart SKILL.md; only bar/line/pie/scatter supported in v1 |
| QuickChart image is broken | Spec URL > ~16KB | Cut data points (≤ 50 series points is the design target) |
| Local engine "renderer claimed success but produced no file" | matplotlib install missing from agent image | Rebuild image — matplotlib goes into `/opt/agentcore-venv` |
| Buttons do nothing | CARD_CLICKED event not arriving at Router | Verify `chat.buttonClickedPayload` is in the Pub/Sub event — check Bridge Lambda logs |

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
