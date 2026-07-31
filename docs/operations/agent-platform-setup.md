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
   - App name and visibility:
     - **Dev — `psd-aistudio-dev`:** app name **PSD Agent Dev**; visibility
       limited to the named testers who will use the dev app.
     - **Prod — `aistudio-462612`:** app name **PSD AI Agent**; visibility
       set to the intended domain audience.
   - Avatar URL: (optional, leave blank for now)
   - Description: "Personal AI agent for district staff"
   - Enable **Interactive features**
   - Functionality: **Join spaces and group conversations**
   - Connection settings: **Cloud Pub/Sub**
   - Pub/Sub topic: `projects/<your-project-id>/topics/agent-chat-messages`
   - Logs: **Log errors to Logging**
3. Click **Save**

#### 1.7 Allow the Chat app to operate in spaces

A Chat app can work in 1:1 DMs while Workspace policy still blocks every API
action in a multi-user space. There are two control planes to check:

1. In **Google Admin Console** → **Apps** → **Google Workspace** → **Google
   Chat** → **Chat apps**, select the **top-level organizational unit** and set
   **Allow users to install Chat apps** to **On**. This enables the Chat-app
   capability; access to a specific Marketplace app is still controlled
   separately by the app allowlist in step 2.
2. If the district uses a Google Workspace Marketplace allowlist, go to
   **Apps** → **Google Workspace Marketplace apps** → **Apps list** and add the
   production app by its exact name, **PSD AI Agent**. Apply explicit allow
   entries to the intended **`/Staff`** organizational unit and
   **`/Miscellaneous/Agent Account`**, where OneSync places the `agnt_...`
   identities. Do not allow the app for Students or broaden it to the top-level
   organization without an explicit district policy decision. Google documents
   that an app allowed on a child OU but not its parent can be rejected in
   shared spaces. The router records a room-post 403 and retries the completed
   response against the exact originating space and thread; it never reroutes
   a shared-space answer into a private DM. The unpublished **PSD Agent Dev**
   app does not appear in the Marketplace allowlist; Google permits an
   unpublished development app for up to five named testers while Chat apps
   are enabled.
3. Configure the two apps separately in **GCP Console** → **Google Chat API** →
   **Configuration**:
   - **Dev — `psd-aistudio-dev` / PSD Agent Dev:** enable **Interactive
     features**, select **Join spaces and group conversations**, keep the
     Cloud Pub/Sub topic `projects/psd-aistudio-dev/topics/agent-chat-messages`,
     and keep **Visibility** limited to the named testers. Add every person who
     will mention the app during the live test. Domain-wide visibility is not
     required for a development app.
   - **Prod — `aistudio-462612` / PSD AI Agent:** enable **Interactive
     features**, select **Join spaces and group conversations**, keep the
     configured production Pub/Sub topic, and make the app available to the
     intended domain audience. If Marketplace access is allowlist-only, step 2
     must also be complete.
4. Allow time for Workspace policy propagation. With each app's own service
   account credential and the `chat.bot` scope, call `spaces.get` for a ROOM
   that app has joined:
   - `200` means the app may post the response in the originating room thread.
   - A `403` stating that the organization's administrator restricts the Chat
     app is expected when the app is deliberately allowed only for Staff at a
     child OU and Google rejects app-authenticated shared-space operations.
     Confirm that the router records `ChatPostPermissionDenied` and retries the
     same completed response in the same room thread. It must never look up or
     post to the sender's DM.

   Then @mention the app and confirm the response appears only in the exact
   room thread where the mention originated.

These settings are console-managed. The Google Cloud CLI has no `gcloud chat`
command, and `gcloud workspace-add-ons deployments` manages add-on deployments,
not Chat API configuration or Workspace tenant policy. The Google Terraform
provider manages the surrounding APIs, service accounts, Pub/Sub topics,
subscriptions, and IAM, but has no resource for either setting above. Record
the console state in the private `psd401/psd-gcp-infra` runbook; do not add an
unsupported Terraform workaround or run `terraform apply` for this policy
change.

There are two distinct identities that can post to Chat:

- The **Chat app service account** receives mentions and posts router replies
  with the `chat.bot` scope. Workspace app policy can restrict this identity
  in spaces even while its DMs to allowed users work. The router never changes
  the destination on delivery failure: room replies stay bound to their
  originating room and thread.
- The per-user **`agnt_...` Workspace account** is a real delegated user used
  by the `psd-workspace` skill (`--scope agent`). OneSync places these accounts
  in **`/Miscellaneous/Agent Account`**, which has its own explicit
  **PSD AI Agent → Allow app** override. The account is not used for Chat reply
  delivery, and its ability to post or manage memberships does not prove that
  the Chat app identity is allowed.

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

`build-and-push.sh` runs a build-time eval gate (#1161) and refuses to push an
image it could not prove boots and answers a real turn. On a first deploy the
web tier and router Lambda do not exist yet, so the runtime probe cannot run —
pass `ALLOW_UNVERIFIED_IMAGE=1` for this bootstrap build only, and let the gate
run normally on every build after it. See
[Agent Image Build-Time Eval Gate](./agent-image-build-gate.md) for the checks,
how the probe's signed broker context is minted, and the bypass flags.

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
5. In a multi-user test space, @mention the agent in an existing thread and
   verify:
   - The reply appears in the mention's exact thread, not as a new top-level
     message or a private DM.
   - A room-post failure queues the completed response for idempotent retry
     against that same room and thread without rerunning the agent turn.
   - A shared-space request does not volunteer private memory content.
   - Before reading or summarizing the caller's Gmail, Calendar, or Drive, the
     agent asks for confirmation that the result may be shared publicly.

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

#### Dev workspace-generation cutover

Releases that change `lib/agent-workspace/storage-broker.ts`, migration 169, or
the agent image's `workspace_sync.py` require a paused, same-commit cutover.
Do **not** deploy the image or storage broker into a live mixed-version fleet.
AgentCore keeps existing sessions on the image version with which their
microVM was created, so rotating `AGENT_BUILD_TAG` prevents new calls from
reusing an old microVM but does not terminate that old writer.

The hard cutover below deliberately removes and recreates only the
CloudFormation-managed AgentCore Runtime. The workspace bucket and every
object version remain in place. It also preserves the enabled/disabled state
of each user schedule and lets Chat messages wait in SQS while the Router
mapping is disabled.

Build, canary-test, and push the exact-commit image before the maintenance
window. The build gate signs its probe with an empty workspace prefix and
omits `workspace_prefix` from the canary payload; the wrapper's hydrate and
flush paths therefore remain disabled. The probe runs in a short-lived local
container and cannot read or mutate a persistent user workspace. Pushing the
immutable ECR artifact does not update AgentCore.

```bash
set -euo pipefail

git diff --quiet
git diff --cached --quiet
test -z "$(git status --porcelain --untracked-files=all)"

export AWS_REGION=us-east-1
export EXPECTED_AWS_ACCOUNT=390844780692
export ENVIRONMENT=dev
export AGENT_IMAGE_TAG="workspace-generation-$(date -u +%Y%m%dT%H%M%SZ)"
test "$(aws sts get-caller-identity \
  --query Account \
  --output text)" = "$EXPECTED_AWS_ACCOUNT"
cd infra/agent-image
./build-and-push.sh "$AGENT_IMAGE_TAG"
export AGENT_IMAGE_DIGEST="$(aws ecr describe-images \
  --region "$AWS_REGION" \
  --repository-name psd-agent-base-dev \
  --image-ids imageTag="$AGENT_IMAGE_TAG" \
  --query 'imageDetails[0].imageDigest' \
  --output text)"
test -n "$AGENT_IMAGE_DIGEST"
test "$AGENT_IMAGE_DIGEST" != "None"
cd ../..
printf 'AGENT_IMAGE_TAG=%s\nAGENT_IMAGE_DIGEST=%s\n' \
  "$AGENT_IMAGE_TAG" "$AGENT_IMAGE_DIGEST"
```

Record the printed values. Run maintenance steps 1-6 from one shell on that
same clean commit, exporting the recorded tag and digest first if it is a new
shell. `jq`, Bun, Docker, and authenticated AWS/CDK CLIs are required. Do not
run the AgentCore deployment command printed by `build-and-push.sh` until
step 5.

##### 1. Pause every persistent-workspace invocation source

```bash
set -euo pipefail

export AWS_REGION=us-east-1
export EXPECTED_AWS_ACCOUNT=390844780692
export CUTOVER_ENV=dev
export BASE_DOMAIN=aistudio.psd401.ai
export AGENT_STACK=AIStudio-AgentPlatformStack-Dev
export DATABASE_STACK=AIStudio-DatabaseStack-Dev
export FRONTEND_STACK=AIStudio-FrontendStack-ECS-Dev
export SCHEDULE_GROUP=psd-agent-dev
export JOB_CLUSTER=psd-agent-jobs-dev
export ROUTER_FUNCTION=psd-agent-router-dev
export CRON_FUNCTION=psd-agent-cron-dev
export CUTOVER_DIR
CUTOVER_DIR="$(mktemp -d /tmp/psd-agent-dev-cutover.XXXXXX)"

: "${AGENT_IMAGE_TAG:?export the prebuilt candidate tag}"
: "${AGENT_IMAGE_DIGEST:?export the prebuilt candidate digest}"

git diff --quiet
git diff --cached --quiet
test -z "$(git status --porcelain --untracked-files=all)"
test "$(aws sts get-caller-identity \
  --query Account \
  --output text)" = "$EXPECTED_AWS_ACCOUNT"
test "$(aws ecr describe-images \
  --region "$AWS_REGION" \
  --repository-name psd-agent-base-dev \
  --image-ids imageTag="$AGENT_IMAGE_TAG" \
  --query 'imageDetails[0].imageDigest' \
  --output text)" = "$AGENT_IMAGE_DIGEST"

OLD_RUNTIME_ID="$(aws cloudformation describe-stacks \
  --stack-name "$AGENT_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='AgentCoreRuntimeId'].OutputValue | [0]" \
  --output text)"
test -n "$OLD_RUNTIME_ID"
test "$OLD_RUNTIME_ID" != "None"
printf '%s\n' "$OLD_RUNTIME_ID" > "$CUTOVER_DIR/old-runtime-id"

ROUTER_ESM_UUID="$(aws lambda list-event-source-mappings \
  --function-name "$ROUTER_FUNCTION" \
  --query 'EventSourceMappings[0].UUID' \
  --output text)"
ROUTER_ESM_COUNT="$(aws lambda list-event-source-mappings \
  --function-name "$ROUTER_FUNCTION" \
  --query 'length(EventSourceMappings)' \
  --output text)"
test "$ROUTER_ESM_COUNT" = "1"
test -n "$ROUTER_ESM_UUID"
test "$ROUTER_ESM_UUID" != "None"

CRON_ESM_UUID="$(aws lambda list-event-source-mappings \
  --function-name "$CRON_FUNCTION" \
  --query 'EventSourceMappings[0].UUID' \
  --output text)"
CRON_ESM_COUNT="$(aws lambda list-event-source-mappings \
  --function-name "$CRON_FUNCTION" \
  --query 'length(EventSourceMappings)' \
  --output text)"
test "$CRON_ESM_COUNT" = "1"
test -n "$CRON_ESM_UUID"
test "$CRON_ESM_UUID" != "None"

ROUTER_ESM_WAS_ENABLED="$(aws lambda get-event-source-mapping \
  --uuid "$ROUTER_ESM_UUID" --query State --output text)"
CRON_ESM_WAS_ENABLED="$(aws lambda get-event-source-mapping \
  --uuid "$CRON_ESM_UUID" --query State --output text)"
printf '%s\n' "$ROUTER_ESM_WAS_ENABLED" > "$CUTOVER_DIR/router-esm-state"
printf '%s\n' "$CRON_ESM_WAS_ENABLED" > "$CUTOVER_DIR/cron-esm-state"

if [ "$ROUTER_ESM_WAS_ENABLED" = "Enabled" ]; then
  aws lambda update-event-source-mapping \
    --uuid "$ROUTER_ESM_UUID" --no-enabled >/dev/null
fi
if [ "$CRON_ESM_WAS_ENABLED" = "Enabled" ]; then
  aws lambda update-event-source-mapping \
    --uuid "$CRON_ESM_UUID" --no-enabled >/dev/null
fi

while [ "$(aws lambda get-event-source-mapping \
  --uuid "$ROUTER_ESM_UUID" --query State --output text)" != "Disabled" ]; do
  sleep 5
done
while [ "$(aws lambda get-event-source-mapping \
  --uuid "$CRON_ESM_UUID" --query State --output text)" != "Disabled" ]; do
  sleep 5
done
```

The Router has exactly one SQS mapping
(`psd-agent-router-dev`), and Cron has exactly one reconciliation mapping
(`psd-agent-cron-reconciliation-dev`). The count assertions intentionally
abort if that topology changes instead of pausing an arbitrary mapping.

Save and disable only schedules that were enabled when the cutover began:

```bash
: > "$CUTOVER_DIR/enabled-schedules"

list_enabled_agent_schedules() {
  aws scheduler list-schedules \
    --group-name "$SCHEDULE_GROUP" \
    --state ENABLED \
    --query 'Schedules[].Name' \
    --output text |
    tr '\t' '\n' |
    sed '/^$/d'
}

set_agent_schedule_state() {
  schedule_name="$1"
  schedule_state="$2"
  aws scheduler get-schedule \
    --group-name "$SCHEDULE_GROUP" \
    --name "$schedule_name" \
    --output json > "$CUTOVER_DIR/schedule-current.json"
  jq --arg state "$schedule_state" \
    'del(.Arn, .CreationDate, .LastModificationDate) | .State = $state' \
    "$CUTOVER_DIR/schedule-current.json" \
    > "$CUTOVER_DIR/schedule-update.json"
  aws scheduler update-schedule \
    --cli-input-json "file://$CUTOVER_DIR/schedule-update.json" >/dev/null
  test "$(aws scheduler get-schedule \
    --group-name "$SCHEDULE_GROUP" \
    --name "$schedule_name" \
    --query State \
    --output text)" = "$schedule_state"
}

disable_enabled_agent_schedules() {
  list_enabled_agent_schedules > "$CUTOVER_DIR/enabled-now"
  while IFS= read -r schedule_name; do
    [ -n "$schedule_name" ] || continue
    if ! grep -Fqx "$schedule_name" "$CUTOVER_DIR/enabled-schedules"; then
      printf '%s\n' "$schedule_name" >> "$CUTOVER_DIR/enabled-schedules"
    fi
    set_agent_schedule_state "$schedule_name" DISABLED
  done < "$CUTOVER_DIR/enabled-now"
  sort -u "$CUTOVER_DIR/enabled-schedules" \
    -o "$CUTOVER_DIR/enabled-schedules"
}

disable_enabled_agent_schedules
test -z "$(list_enabled_agent_schedules)"
```

##### 2. Drain in-flight old-image work

Disabling an event source prevents new Lambda invocations but does not cancel
one already running. Router and Cron each have a 15-minute timeout. Wait a
full 16 minutes, then wait for every on-demand two-hour job-runner task to
finish naturally. Do not use `ecs stop-task`: killing a task can interrupt its
normal turn-final workspace checkpoint.

```bash
sleep 960

while [ "$(aws ecs list-tasks \
  --cluster "$JOB_CLUSTER" \
  --desired-status RUNNING \
  --query 'length(taskArns)' \
  --output text)" != "0" ]; do
  sleep 30
done

# A turn that was already active could have created a schedule while the first
# snapshot was being disabled. Capture that state, disable it, and give any
# resulting Cron invocation one final full drain window.
disable_enabled_agent_schedules
sleep 960

while [ "$(aws ecs list-tasks \
  --cluster "$JOB_CLUSTER" \
  --desired-status RUNNING \
  --query 'length(taskArns)' \
  --output text)" != "0" ]; do
  sleep 30
done

disable_enabled_agent_schedules
test -z "$(list_enabled_agent_schedules)"
```

If the final assertion finds another enabled schedule, repeat the second
16-minute drain window before continuing. At this point there are no new
Router, scheduled, reconciliation, or promoted-job writers.

##### 3. Remove the old runtime before changing the broker

There is no list-all-runtime-sessions API that can prove every sticky microVM
from every prior image version is gone. Deploying the AgentPlatform template
once **without** image context removes the Runtime through CloudFormation,
which terminates all of those sessions while leaving the S3 workspace bucket
untouched. `--exclusively` is load-bearing: without it, CDK may include stack
dependencies and destroy the required deployment order.

```bash
cd infra
REMOVE_RUNTIME_ASSEMBLY="$CUTOVER_DIR/cdk-remove-runtime"
bunx cdk synth "$AGENT_STACK" \
  --exclusively \
  --quiet \
  --output "$REMOVE_RUNTIME_ASSEMBLY" \
  --context baseDomain="$BASE_DOMAIN"
test "$(jq \
  '[.Resources[] | select(.Type == "AWS::BedrockAgentCore::Runtime")] | length' \
  "$REMOVE_RUNTIME_ASSEMBLY/$AGENT_STACK.template.json")" = "0"
bunx cdk deploy "$AGENT_STACK" \
  --exclusively \
  --context baseDomain="$BASE_DOMAIN"

OLD_RUNTIME_ID="$(cat "$CUTOVER_DIR/old-runtime-id")"
test "$(aws bedrock-agentcore-control list-agent-runtimes \
  --query "length(agentRuntimes[?agentRuntimeId=='$OLD_RUNTIME_ID'])" \
  --output text)" = "0"
test "$(aws cloudformation describe-stacks \
  --stack-name "$AGENT_STACK" \
  --query "length(Stacks[0].Outputs[?OutputKey=='AgentCoreRuntimeId'])" \
  --output text)" = "0"
```

Do not proceed if either assertion fails. A failed deletion means an old image
may still write during its shutdown path.

##### 4. Apply migration 169, then deploy the storage broker

Migration `169-workspace-upload-zero-byte-files.sql` changes the upload
reservation constraint from `expected_bytes > 0` to `expected_bytes >= 0`.
It must be applied from the same commit before the new broker can reserve an
empty regular file.

```bash
bunx cdk synth "$DATABASE_STACK" \
  --exclusively \
  --context baseDomain="$BASE_DOMAIN"
bunx cdk deploy "$DATABASE_STACK" \
  --exclusively \
  --context baseDomain="$BASE_DOMAIN"

DB_CLUSTER_ARN="$(aws ssm get-parameter \
  --name /aistudio/dev/db-cluster-arn \
  --query Parameter.Value \
  --output text)"
DB_SECRET_ARN="$(aws ssm get-parameter \
  --name /aistudio/dev/db-secret-arn \
  --query Parameter.Value \
  --output text)"
test "$(aws rds-data execute-statement \
  --resource-arn "$DB_CLUSTER_ARN" \
  --secret-arn "$DB_SECRET_ARN" \
  --database aistudio \
  --sql "SELECT status FROM migration_log WHERE description = '169-workspace-upload-zero-byte-files.sql' ORDER BY step_number DESC LIMIT 1" \
  --query 'records[0][0].stringValue' \
  --output text)" = "completed"

bunx cdk synth "$FRONTEND_STACK" \
  --exclusively \
  --context baseDomain="$BASE_DOMAIN"
bunx cdk deploy "$FRONTEND_STACK" \
  --exclusively \
  --context baseDomain="$BASE_DOMAIN"
aws ecs wait services-stable \
  --cluster aistudio-dev \
  --services aistudio-dev
```

The exact-commit image is already present in ECR. Do not deploy or invoke it
until the migration assertion and ECS steady-state wait both succeed.

##### 5. Verify the prebuilt image, then recreate AgentCore

```bash
cd agent-image
DISCOVERED_IMAGE_DIGEST="$(aws ecr describe-images \
  --repository-name psd-agent-base-dev \
  --image-ids imageTag="$AGENT_IMAGE_TAG" \
  --query 'imageDetails[0].imageDigest' \
  --output text)"
test -n "$DISCOVERED_IMAGE_DIGEST"
test "$DISCOVERED_IMAGE_DIGEST" != "None"
if [ -n "${AGENT_IMAGE_DIGEST:-}" ]; then
  test "$AGENT_IMAGE_DIGEST" = "$DISCOVERED_IMAGE_DIGEST"
else
  export AGENT_IMAGE_DIGEST="$DISCOVERED_IMAGE_DIGEST"
fi

SOURCE_COMMIT="$(git -C ../.. rev-parse HEAD)"
ECR_URI="$(aws cloudformation describe-stacks \
  --stack-name "$AGENT_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='ECRRepositoryUri'].OutputValue" \
  --output text)"
if ! docker image inspect "$ECR_URI:$AGENT_IMAGE_TAG" >/dev/null 2>&1; then
  ECR_REGISTRY="${ECR_URI%%/*}"
  aws ecr get-login-password |
    docker login --username AWS --password-stdin "$ECR_REGISTRY"
  docker pull "$ECR_URI:$AGENT_IMAGE_TAG"
fi
test "$(docker image inspect "$ECR_URI:$AGENT_IMAGE_TAG" \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" \
  = "$SOURCE_COMMIT"

cd ..
NEW_RUNTIME_ASSEMBLY="$CUTOVER_DIR/cdk-new-runtime"
bunx cdk synth "$AGENT_STACK" \
  --exclusively \
  --quiet \
  --output "$NEW_RUNTIME_ASSEMBLY" \
  --context baseDomain="$BASE_DOMAIN" \
  --context agentImageTag="$AGENT_IMAGE_TAG" \
  --context agentImageDigest="$AGENT_IMAGE_DIGEST"
test "$(jq \
  '[.Resources[] | select(.Type == "AWS::BedrockAgentCore::Runtime")] | length' \
  "$NEW_RUNTIME_ASSEMBLY/$AGENT_STACK.template.json")" = "1"
grep -Fq "$AGENT_IMAGE_DIGEST" \
  "$NEW_RUNTIME_ASSEMBLY/$AGENT_STACK.template.json"
bunx cdk deploy "$AGENT_STACK" \
  --exclusively \
  --context baseDomain="$BASE_DOMAIN" \
  --context agentImageTag="$AGENT_IMAGE_TAG" \
  --context agentImageDigest="$AGENT_IMAGE_DIGEST"

NEW_RUNTIME_ID="$(aws cloudformation describe-stacks \
  --stack-name "$AGENT_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='AgentCoreRuntimeId'].OutputValue | [0]" \
  --output text)"
test -n "$NEW_RUNTIME_ID"
test "$NEW_RUNTIME_ID" != "None"
test "$NEW_RUNTIME_ID" != "$OLD_RUNTIME_ID"
test "$(aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id "$NEW_RUNTIME_ID" \
  --query status \
  --output text)" = "READY"
```

The digest assertion prevents a mutable-tag deployment. Keep all sources
paused if the Runtime is not `READY`.

##### 6. Resume exactly the sources that were enabled

Rediscover event-source UUIDs after the AgentPlatform deployment instead of
assuming CloudFormation retained the old physical mappings:

```bash
ROUTER_ESM_UUID="$(aws lambda list-event-source-mappings \
  --function-name "$ROUTER_FUNCTION" \
  --query 'EventSourceMappings[0].UUID' \
  --output text)"
CRON_ESM_UUID="$(aws lambda list-event-source-mappings \
  --function-name "$CRON_FUNCTION" \
  --query 'EventSourceMappings[0].UUID' \
  --output text)"
test "$(aws lambda list-event-source-mappings \
  --function-name "$ROUTER_FUNCTION" \
  --query 'length(EventSourceMappings)' \
  --output text)" = "1"
test "$(aws lambda list-event-source-mappings \
  --function-name "$CRON_FUNCTION" \
  --query 'length(EventSourceMappings)' \
  --output text)" = "1"

if [ "$(cat "$CUTOVER_DIR/cron-esm-state")" = "Enabled" ]; then
  aws lambda update-event-source-mapping \
    --uuid "$CRON_ESM_UUID" --enabled >/dev/null
  while [ "$(aws lambda get-event-source-mapping \
    --uuid "$CRON_ESM_UUID" --query State --output text)" != "Enabled" ]; do
    sleep 5
  done
fi

while IFS= read -r schedule_name; do
  [ -n "$schedule_name" ] || continue
  set_agent_schedule_state "$schedule_name" ENABLED
done < "$CUTOVER_DIR/enabled-schedules"

if [ "$(cat "$CUTOVER_DIR/router-esm-state")" = "Enabled" ]; then
  aws lambda update-event-source-mapping \
    --uuid "$ROUTER_ESM_UUID" --enabled >/dev/null
  while [ "$(aws lambda get-event-source-mapping \
    --uuid "$ROUTER_ESM_UUID" --query State --output text)" != "Enabled" ]; do
    sleep 5
  done
fi
```

Resume Cron and user schedules before the Router so queued Chat work cannot
overtake a scheduled workspace writer. After the mappings report `Enabled`,
send one DM and one threaded-space message, then verify both exact-destination
replies and a successful `workspace_finalization_confirmed` marker before
ending the maintenance window. If any step fails, leave the sources paused;
SQS retains Router messages for four days and reconciliation messages for two.

#### Image-only update

For an image-only update that does not change the storage broker, its database
contract, or `workspace_sync.py`:

```bash
cd infra/agent-image
# Edit Dockerfile, openclaw.json, psd-system-prompt.md as needed
# The eval gate boot-verifies the image before pushing — see
# docs/operations/agent-image-build-gate.md
./build-and-push.sh 2026-04-17-update-models

# Read the immutable digest printed by the script, then redeploy.
cd ../
bunx cdk deploy AIStudio-AgentPlatformStack-Dev \
  --exclusively \
  --context agentImageTag=2026-04-17-update-models \
  --context agentImageDigest=sha256:<digest-from-build-script> \
  --context baseDomain=yourdomain.com
```

### Agent web search

The agent image explicitly selects OpenClaw's official `parallel-free`
provider for `web_search`. OpenClaw does not auto-detect key-free providers,
so removing `tools.web.search.provider` leaves the tool visible but makes calls
fail with `disabled or no provider available`.

- Provider: `parallel-free`
- API key: none
- Endpoint: `https://search.parallel.ai/mcp` (fixed by the pinned official
  `@openclaw/parallel-plugin`)
- Image config: `infra/agent-image/openclaw.json`
- Supply-chain pin and endpoint assertion: `infra/agent-image/Dockerfile`
- Live regression: `web-search-available` in
  `infra/agent-image/eval/suites/l2-live.yaml`

Run the static contract before building:

```bash
python3 infra/agent-image/check_config_consistency.py
python3 -m unittest infra/agent-image/test_check_config_consistency.py
```

The Docker build then performs fatal plugin-aware `openclaw config validate`.
After deployment, run the L2 live suite or the `web-search-available` task
against the immutable image digest to confirm live results and citations.

### Agent image supply-chain pins (SEC-009)

Every third-party artifact baked into the agent base image is pinned and
verified before use — the container holds IAM reach to `psd-agent-creds/${env}/*`
and `psd-agent/${env}/*`, so build-time substitution is a real compromise
vector. `build-and-push.sh` fails fast if any `BLOCKER(prod)` marker remains in
the Dockerfile (the enforcement gate that keeps these from regressing).

| Artifact | Pin | Verification |
|----------|-----|--------------|
| OpenClaw base | `ghcr.io/openclaw/openclaw@sha256:6a31d4…` (2026.7.1) | Immutable digest in `FROM` |
| amazon-bedrock provider plugin | `2026.7.1` | `npm pack` pin; must stay ≥ the minimum in `check_config_consistency.py` or prompt caching silently turns off |
| Parallel web-search plugin | `2026.7.1` | `npm pack` pin; config gate requires host compatibility, explicit load/enable, and the fixed `https://search.parallel.ai/mcp` endpoint |
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
REPO=openclaw/openclaw; TAG=2026.7.2-beta.5  # exact reviewed release; prefer stable when it contains required fixes
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

# MANDATORY since #1469: confirm the safe settled-post-tool finalization
# (upstream PR #110565) is present. The Docker build also checks its compiled
# diagnostic and tools-disabled continuation prompt.
gh api "repos/$REPO/compare/v$TAG...8636bb6981844e4674ee2cdbc0d8d32aa2a8b816" \
  --jq '{ahead_by, settled_tool_recovery_present: (.ahead_by==0)}'
```

Then update the `FROM` digest and the header block in `infra/agent-image/Dockerfile`,
and **always** finish with the Morning Brief smoke test (below) — a trivial
"respond OK" prompt masks session-completion regressions.

### Direct-AWS skill credential boundary

The pinned OpenClaw release sanitizes the environment for every model-launched
`exec` subprocess. In particular, it removes inherited `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, and the ECS/AgentCore container-
credential URI variables. This is intentional: forwarding those values would
let arbitrary model-authored commands print or reuse the execution-role
credentials.

`psd-tts` and `psd-hyperframes` therefore do not instantiate AWS SDK clients in
the model-facing subprocess. They call two fixed endpoints on the root-owned
loopback relay in `mantle_proxy.py`. The relay inherits the AgentCore execution-
role credential chain, validates bounded operation-specific payloads, and can
only call Polly `SynthesizeSpeech` or the configured HyperFrames Lambda. It
returns synthesized audio or the Lambda result, never credential values or a
caller-selected AWS target. HyperFrames also rejects a model-supplied owner:
the relay resolves `ownerEmail` through the signed
`/api/agent/invocation-identity` web boundary and injects it only after
verification. During a staggered rollout to an older web tier, it authenticates
the installed token and proof through the existing model broker's fixed
unsupported-path response before decoding the owner claim; any 403 or
unexpected response fails closed. Owner resolution has one 30-second total
budget across the dedicated and compatibility routes. The model-facing render
client then allows 825 seconds for owner resolution, Lambda connection, its
780-second response budget, and transport margin. Finalization gives active
privileged requests a matching 830-second drain ceiling while retaining a
separate 120-second workspace-flush budget, so a proxy restart cannot orphan
an accepted Lambda render. Keep future direct-AWS skills behind the same kind
of fixed-operation boundary; do not add AWS credential keys to OpenClaw's exec
allowlist.

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
| Mention in a space gets no room reply; Router logs a `403` | Google Chat rejected the app's post to the originating space/thread | Confirm `ChatPostPermissionDenied` telemetry and the exact-destination delivery retry. The router will not send the answer to a DM. |
| Guardrail blocks everything | GUARDRAIL_FAIL_OPEN=false + guardrail misconfigured | Check guardrail rules in Bedrock console |
| `web_search` reports `disabled or no provider available` | `parallel-free` is not selected or its pinned plugin is missing | Run `check_config_consistency.py`, rebuild the agent image, and run the `web-search-available` L2 task |
| DLQ alarm firing | Messages exhausted the Router retry budget | Check CloudWatch logs for Router Lambda errors and repeated workspace contention |
| Pub/Sub push fails to SQS | SQS requires signed requests | Add API Gateway → SQS proxy in front of the queue |
| Migration 065 failed | PL/pgSQL not compatible with RDS Data API | Fixed — redeploy DatabaseStack to retry |
